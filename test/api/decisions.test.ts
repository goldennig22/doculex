import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import formAutoContent from 'form-auto-content';
import { buildApp } from '../../src/app';
import { env } from '../../src/config/env';
import { findActiveKey, generateApiKey } from '../../src/services/api-keys.service';
import { ingestDecision } from '../../src/services/decisions.service';
import { HttpError } from '../../src/utils/http-error';

// No Postgres, no PDF parser, no embedding provider: the key lookup and the ingest are mocked.
// hasRole, API_KEY_FORMAT and generateApiKey stay real.
vi.mock('../../src/services/api-keys.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/api-keys.service')>()),
  findActiveKey: vi.fn(),
}));
vi.mock('../../src/services/decisions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/decisions.service')>()),
  ingestDecision: vi.fn(),
}));

const URL = '/api/decisions';
const KEY_ID = '5b0c9f3e-2d41-4a7b-8e6f-1c2d3e4f5a6b';
const CONTRIBUTOR_KEY = generateApiKey().plaintext;
const fakePdf = Buffer.from('%PDF-1.4\n% test fixture\n');
const file = (value: Buffer, filename = 'arret.pdf', contentType = 'application/pdf') => ({
  value, options: { filename, contentType },
});
const fields = (extra: Record<string, unknown> = {}) => ({
  title: 'CCJA, 1re ch., arrêt n° 000/2019', language: 'fr', sourceName: 'Ohadata', file: file(fakePdf), ...extra,
});
const JUDGMENT_TEXT = "Sur le recours formé par la Société Alpha SA… Attendu, selon l'arrêt attaqué, que… ".repeat(5);

const stored = {
  id: '8d1f0c2e-4b7a-4e19-9c3d-5a6b7c8d9e0f', documentId: '2a9e7c41-6f3b-4d8a-b1c5-0e2f4a6b8c9d',
  title: 'CCJA, 1re ch., arrêt n° 000/2019', language: 'fr' as const, status: 'draft' as const,
  court: null, country: null, chamber: null, caseNumber: null, decisionDate: null,
  sourceName: 'Ohadata', sourceUrl: null, extractionStatus: 'pending' as const, chunkCount: 5, createdAt: new Date('2026-11-26T09:12:00Z'),
};

function post(body: Record<string, unknown>, apiKey: string | null = CONTRIBUTOR_KEY) {
  // Leave out fields set to undefined, as a client that doesn't send them would.
  // forceMultiPart: without a file the helper would send urlencoded (a 415), but `curl -F text=…` sends multipart
  const form = formAutoContent(
    Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)),
    { forceMultiPart: true },
  );
  return app.inject({
    method: 'POST', url: URL, payload: form.payload,
    headers: { ...form.headers, ...(apiKey ? { 'x-api-key': apiKey } : {}) },
  });
}

let app: FastifyInstance;
beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findActiveKey).mockResolvedValue({ id: KEY_ID, role: 'contributor', label: 'law-clinic-1' });
  vi.mocked(ingestDecision).mockResolvedValue(stored);
});

describe('POST /api/decisions: authentication (401)', () => {
  it('returns 401 without a key, before reading the body', async () => {
    const res = await app.inject({
      method: 'POST', url: URL, payload: 'not multipart', headers: { 'content-type': 'multipart/form-data; boundary=----x' },
    });
    expect(res.statusCode).toBe(401);
    expect(ingestDecision).not.toHaveBeenCalled();
  });

  it('returns 401 for a malformed key without querying the database', async () => {
    const res = await post(fields(), 'not-a-doculex-key');
    expect(res.statusCode).toBe(401);
    expect(findActiveKey).not.toHaveBeenCalled();
  });

  it('returns 401 for an unknown or revoked key', async () => {
    vi.mocked(findActiveKey).mockResolvedValueOnce(null);
    const res = await post(fields());
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ status: 'failed', message: 'Invalid or missing API key' });
  });

  it('refuses the legacy ADMIN_API_KEY: a decision must record which key contributed it', async () => {
    const res = await post(fields(), env.ADMIN_API_KEY);
    expect(res.statusCode).toBe(401);
    expect(ingestDecision).not.toHaveBeenCalled();
  });

  it('returns 401 before 422: an anonymous client never sees the validation rules', async () => {
    const res = await post({ language: 'xx' }, null);
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/decisions: contributing', () => {
  it('stores a draft and records the contributing key', async () => {
    const res = await post(fields({ court: 'CCJA', country: 'cm', decisionDate: '2019-02-28' }));

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'success', data: { status: 'draft', chunkCount: 5 } });
    const [input, contributorId] = vi.mocked(ingestDecision).mock.calls[0];
    expect(contributorId).toBe(KEY_ID);
    expect(input).toMatchObject({ court: 'CCJA', country: 'CM', decisionDate: '2019-02-28', sourceName: 'Ohadata' });
    expect(Buffer.isBuffer(input.file)).toBe(true);
  });

  it('accepts a reviewer or admin key too: higher roles include contributor', async () => {
    vi.mocked(findActiveKey).mockResolvedValueOnce({ id: KEY_ID, role: 'reviewer', label: 'reviewer-1' });
    expect((await post(fields())).statusCode).toBe(201);
  });

  it('accepts pasted text instead of a PDF', async () => {
    const res = await post(fields({ file: undefined, text: JUDGMENT_TEXT }));
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(ingestDecision).mock.calls[0][0]).toMatchObject({ text: JUDGMENT_TEXT.trim() });
  });

  it('passes on a 422 from the service (no text in the PDF)', async () => {
    vi.mocked(ingestDecision).mockRejectedValueOnce(new HttpError(422, 'No text could be extracted from this decision'));
    const res = await post(fields());
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toBe('No text could be extracted from this decision');
  });
});

describe('POST /api/decisions: validation (422)', () => {
  it.each([
    ['both a file and text', fields({ text: JUDGMENT_TEXT }), 'file'],
    ['neither a file nor text', fields({ file: undefined }), 'file'],
    ['a file that is not a PDF', fields({ file: file(Buffer.from('hello'), 'a.txt', 'text/plain') }), 'file'],
    ['no source', fields({ sourceName: undefined }), 'sourceName'],
    ['a date that is not YYYY-MM-DD', fields({ decisionDate: '28/02/2019' }), 'decisionDate'],
    ['a country that is not an ISO code', fields({ country: 'Cameroun' }), 'country'],
  ])('rejects %s', async (_name, body, field) => {
    const res = await post(body);
    expect(res.statusCode).toBe(422);
    expect(res.json().errors).toHaveProperty(field);
    expect(ingestDecision).not.toHaveBeenCalled();
  });
});
