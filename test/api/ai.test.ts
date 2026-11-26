import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { askQuestion } from '../../src/services/ask.service';
import { ASK_RATE_LIMIT } from '../../src/routes/ai';

vi.mock('../../src/services/ask.service', () => ({ askQuestion: vi.fn() }));

const Q1 = "Quelles sont les conditions requises pour qu'une personne physique ait la qualité de commerçant ?";
const notFound = { found: false, answer: null, citations: [], confidence: null, language: 'fr' as const };

let app: FastifyInstance;
const ask = (payload: unknown, remoteAddress = '10.0.0.1') =>
  app.inject({ method: 'POST', url: '/api/ai/ask', payload: payload as object, remoteAddress });

// A new app per test: the rate-limit counters live in memory, in the app instance
beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(askQuestion).mockResolvedValue(notFound);
  app = buildApp();
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe('POST /api/ai/ask: validation', () => {
  it('returns 422 when the question is missing', async () => {
    const res = await ask({});
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ status: 'failed', errors: { question: expect.anything() } });
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it('returns 422 for a question that is only spaces', async () => {
    expect((await ask({ question: '    ' })).statusCode).toBe(422);
  });

  it('returns 422 for a question over 1000 characters', async () => {
    expect((await ask({ question: 'a'.repeat(1001) })).statusCode).toBe(422);
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it('returns 200 with the service result for a valid question', async () => {
    const res = await ask({ question: Q1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'success', data: notFound });
    expect(askQuestion).toHaveBeenCalledWith(Q1);
  });
});

describe('POST /api/ai/ask: rate limit', () => {
  it(`allows ${ASK_RATE_LIMIT.max} requests per minute per IP, then returns 429`, async () => {
    for (let i = 0; i < ASK_RATE_LIMIT.max; i++) {
      expect((await ask({ question: Q1 })).statusCode).toBe(200);
    }
    const res = await ask({ question: Q1 });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ status: 'failed', requestId: expect.any(String) });
    expect(res.headers['retry-after']).toBeDefined();
    expect(askQuestion).toHaveBeenCalledTimes(ASK_RATE_LIMIT.max); // the 11th never reached the LLM
  });

  it('counts invalid requests too: the limit runs before validation', async () => {
    for (let i = 0; i < ASK_RATE_LIMIT.max; i++) await ask({});
    expect((await ask({ question: Q1 })).statusCode).toBe(429);
  });

  it('counts each IP separately', async () => {
    for (let i = 0; i < ASK_RATE_LIMIT.max; i++) await ask({ question: Q1 }, '10.0.0.1');
    expect((await ask({ question: Q1 }, '10.0.0.1')).statusCode).toBe(429);
    expect((await ask({ question: Q1 }, '10.0.0.2')).statusCode).toBe(200);
  });

  it('does not limit other routes', async () => {
    for (let i = 0; i < ASK_RATE_LIMIT.max + 1; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/no-such-route', remoteAddress: '10.0.0.1' });
      expect(res.statusCode).not.toBe(429);
    }
  });
});

describe('error handler', () => {
  it('returns a 500 with a request id and no SQL, params or stack', async () => {
    // What Drizzle throws: the SQL and params in the message, the Postgres error in `cause`
    const pgError = Object.assign(new Error('relation "queries" does not exist'), { code: '42P01' });
    vi.mocked(askQuestion).mockRejectedValueOnce(
      new Error('Failed query: insert into "queries" ("question") values ($1)\nparams: secret question', { cause: pgError }),
    );

    const res = await ask({ question: Q1 });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ status: 'failed', message: 'Internal server error', requestId: expect.any(String) });
    for (const leak of ['Failed query', 'insert into', 'secret question', '42P01', 'at ']) {
      expect(res.body).not.toContain(leak);
    }
  });

  it('returns 422 with the errors by field when the body fails its schema', async () => {
    const res = await ask({ question: 'a' });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      status: 'failed',
      message: 'Validation failed',
      errors: { question: [expect.any(String)] },
      requestId: expect.any(String),
    });
  });

  it('returns a 500, not a 422, when our own response does not match its schema', async () => {
    // A ZodError raised while checking the response is a server bug: it must never look like the client's fault
    vi.mocked(askQuestion).mockResolvedValueOnce({ ...notFound, confidence: 'certain' } as never);

    const res = await ask({ question: Q1 });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ status: 'failed', message: 'Internal server error', requestId: expect.any(String) });
  });

  it("keeps Fastify's own 4xx message, in the same shape", async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/ai/ask', headers: { 'content-type': 'application/json' }, payload: '{"question": ',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: 'failed', requestId: expect.any(String) });
    expect(res.json().message).not.toBe('Internal server error');
  });
});
