import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import formAutoContent from 'form-auto-content';
import { buildApp } from '../../src/app';
import { env } from '../../src/config/env';
import { findActiveKey, generateApiKey } from '../../src/services/api-keys.service';
import { HttpError } from '../../src/utils/http-error';
import type { Role } from '../../src/interfaces/types';

// The authorization matrix: every route × every caller, one expected status each. This file tests the GATE only
// (requireRole, route schema order), not what a service does. Every service is mocked to throw HttpError(418):
// a 418 means "authenticated, authorized, validated, and the service was reached". Service-level refusals
// (own upload 403, unpublished id 404, illegal transition 409) are tested against Postgres in the *.db.test.ts files.

const REACHED = 418;
const reached = () => { throw new HttpError(REACHED, 'reached the service'); };

vi.mock('../../src/services/api-keys.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/api-keys.service')>()),
  findActiveKey: vi.fn(),
}));
vi.mock('../../src/services/documents.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/documents.service')>()),
  getDocuments: vi.fn(), ingestDocument: vi.fn(), deleteDocument: vi.fn(),
}));
vi.mock('../../src/services/ask.service', () => ({ askQuestion: vi.fn() }));
vi.mock('../../src/services/articles.service', () => ({ getArticlePage: vi.fn() }));
vi.mock('../../src/services/decisions.service', () => ({ ingestDecision: vi.fn() }));
vi.mock('../../src/services/decision-review.service', () => ({
  getForReview: vi.fn(), reviewDecision: vi.fn(), publishDecision: vi.fn(), listReviewQueue: vi.fn(),
}));
vi.mock('../../src/services/decision-report.service', () => ({ reportDecision: vi.fn() }));
vi.mock('../../src/services/decision-search.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/decision-search.service')>()),
  searchDecisions: vi.fn(), decisionStats: vi.fn(),
}));
vi.mock('../../src/services/search-all.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/search-all.service')>()),
  searchAll: vi.fn(),
}));

import { deleteDocument, getDocuments, ingestDocument } from '../../src/services/documents.service';
import { askQuestion } from '../../src/services/ask.service';
import { getArticlePage } from '../../src/services/articles.service';
import { ingestDecision } from '../../src/services/decisions.service';
import { getForReview, listReviewQueue, publishDecision, reviewDecision } from '../../src/services/decision-review.service';
import { reportDecision } from '../../src/services/decision-report.service';
import { decisionStats, searchDecisions } from '../../src/services/decision-search.service';
import { searchAll } from '../../src/services/search-all.service';

// ── Callers ──────────────────────────────────────────────────────────────────────────────────────────

type Caller = 'anonymous' | 'malformed' | 'revoked' | 'legacy' | Role;
const CALLERS: readonly Caller[] = ['anonymous', 'malformed', 'revoked', 'legacy', 'contributor', 'reviewer', 'admin'];

const KEYS: Record<Role | 'revoked', string> = {
  contributor: generateApiKey().plaintext,
  reviewer: generateApiKey().plaintext,
  admin: generateApiKey().plaintext,
  revoked: generateApiKey().plaintext, // well-formed, but findActiveKey finds no active row
};
const ROLE_OF = new Map<string, Role>([
  [KEYS.contributor, 'contributor'], [KEYS.reviewer, 'reviewer'], [KEYS.admin, 'admin'],
]);

const headerFor = (c: Caller): Record<string, string> => {
  switch (c) {
    case 'anonymous': return {};
    case 'malformed': return { 'x-api-key': 'not-a-key' };
    case 'legacy': return { 'x-api-key': env.ADMIN_API_KEY };
    default: return { 'x-api-key': KEYS[c] };
  }
};

// ── Routes, each with a request that passes validation ───────────────────────────────────────────────

const ID = '8d1f0c2e-4b7a-4e19-9c3d-5a6b7c8d9e0f';
const PDF = Buffer.from('%PDF-1.4\n%fake but starts like a PDF\n');

type RouteCase = { name: string; request: () => InjectOptions };

const multipart = (method: 'POST', url: string, fields: Record<string, unknown>) => (): InjectOptions => {
  const form = formAutoContent(fields);
  return { method, url, payload: form.payload, headers: form.headers as Record<string, string> };
};

const ROUTES = {
  health: { name: 'GET /api/health', request: () => ({ method: 'GET', url: '/api/health' }) },
  listDocuments: { name: 'GET /api/documents', request: () => ({ method: 'GET', url: '/api/documents' }) },
  showDocument: { name: 'GET /api/documents/:id/show', request: () => ({ method: 'GET', url: `/api/documents/${ID}/show` }) },
  uploadDocument: {
    name: 'POST /api/documents/upload',
    request: multipart('POST', '/api/documents/upload', {
      file: { value: PDF, options: { filename: 'audcg.pdf', contentType: 'application/pdf' } },
      title: 'AUDCG 2010', language: 'fr', actCode: 'AUDCG', actVersion: '2010',
    }),
  },
  deleteDocument: { name: 'DELETE /api/documents/:id/delete', request: () => ({ method: 'DELETE', url: `/api/documents/${ID}/delete` }) },
  ask: {
    name: 'POST /api/ai/ask',
    request: () => ({ method: 'POST', url: '/api/ai/ask', payload: { question: 'Qui a la qualité de commerçant ?' } }),
  },
  article: { name: 'GET /api/articles/:documentId/:ref', request: () => ({ method: 'GET', url: `/api/articles/${ID}/7` }) },
  searchAll: { name: 'GET /api/search', request: () => ({ method: 'GET', url: '/api/search?q=bail%20commercial' }) },
  stats: { name: 'GET /api/stats', request: () => ({ method: 'GET', url: '/api/stats' }) },
  searchDecisions: { name: 'GET /api/decisions', request: () => ({ method: 'GET', url: '/api/decisions?act=AUDCG&article=7' }) },
  createDecision: {
    name: 'POST /api/decisions',
    // With a file: form-auto-content sends text-only fields urlencoded, which this multipart route answers 415
    request: multipart('POST', '/api/decisions', {
      file: { value: PDF, options: { filename: 'J-16-196.pdf', contentType: 'application/pdf' } },
      title: 'CCJA, 1re ch., arrêt n° 096/2015', language: 'fr', sourceName: 'Ohadata',
    }),
  },
  showDecision: { name: 'GET /api/decisions/:id', request: () => ({ method: 'GET', url: `/api/decisions/${ID}` }) },
  reviewDecision: {
    name: 'PATCH /api/decisions/:id',
    request: () => ({ method: 'PATCH', url: `/api/decisions/${ID}`, payload: { status: 'rejected' } }),
  },
  publishDecision: { name: 'POST /api/decisions/:id/publish', request: () => ({ method: 'POST', url: `/api/decisions/${ID}/publish` }) },
  reviewQueue: { name: 'GET /api/decisions/queue', request: () => ({ method: 'GET', url: '/api/decisions/queue' }) },
  reportDecision: {
    name: 'POST /api/decisions/:id/report',
    request: () => ({ method: 'POST', url: `/api/decisions/${ID}/report`, payload: { reason: 'personal_data' } }),
  },
} satisfies Record<string, RouteCase>;

// ── The matrix ───────────────────────────────────────────────────────────────────────────────────────

const PUBLIC = Object.fromEntries(CALLERS.map((c) => [c, REACHED])) as Record<Caller, number>;
/** A key is required: anonymous and bad keys 401, roles below `need` 403. */
const needs = (need: Role, { legacy = false } = {}): Record<Caller, number> => {
  const rank: Record<Role, number> = { contributor: 1, reviewer: 2, admin: 3 };
  return {
    anonymous: 401, malformed: 401, revoked: 401,
    legacy: legacy ? REACHED : 401,
    contributor: rank.contributor >= rank[need] ? REACHED : 403,
    reviewer: rank.reviewer >= rank[need] ? REACHED : 403,
    admin: REACHED,
  };
};

// Public routes ignore the key entirely: a revoked or malformed key on a public route is NOT a 401.
// /health is the exception to the 418 sentinel: its checks are injected, so it answers 200.
const MATRIX: Array<[RouteCase, Record<Caller, number>]> = [
  [ROUTES.health, Object.fromEntries(CALLERS.map((c) => [c, 200])) as Record<Caller, number>],
  [ROUTES.listDocuments, PUBLIC],
  [ROUTES.showDocument, PUBLIC],
  [ROUTES.uploadDocument, needs('admin', { legacy: true })],
  [ROUTES.deleteDocument, needs('admin', { legacy: true })],
  [ROUTES.ask, PUBLIC],
  [ROUTES.article, PUBLIC],
  [ROUTES.searchAll, PUBLIC],
  [ROUTES.stats, PUBLIC],
  [ROUTES.searchDecisions, PUBLIC],
  [ROUTES.createDecision, needs('contributor')],
  [ROUTES.showDecision, needs('reviewer')],
  [ROUTES.reviewDecision, needs('reviewer')],
  [ROUTES.publishDecision, needs('reviewer')],
  [ROUTES.reviewQueue, needs('reviewer')],
  [ROUTES.reportDecision, PUBLIC],
];

// Each case from its own address: the matrix is about the gate, not the rate limits (tested below)
const CASES = MATRIX.flatMap(([route, expected]) => CALLERS.map((caller) => [route.name, caller, expected[caller], route] as const))
  .map((c, i) => [...c, `10.0.${Math.floor(i / 250)}.${i % 250}`] as const);

let app: FastifyInstance;
beforeAll(async () => {
  const up = async () => ({ status: 'up' as const, latencyMs: 1 });
  app = buildApp({ checks: { database: up, llm: up } });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findActiveKey).mockImplementation(async (key: string) => {
    const role = ROLE_OF.get(key);
    return role ? { id: `00000000-0000-4000-8000-00000000000${role.length}`, role, label: `${role}-test` } : null;
  });
  for (const fn of [getDocuments, ingestDocument, deleteDocument, askQuestion, getArticlePage, ingestDecision,
    getForReview, reviewDecision, publishDecision, listReviewQueue, reportDecision, searchDecisions, decisionStats, searchAll]) {
    vi.mocked(fn).mockImplementation(reached);
  }
});

describe('authorization matrix: route × caller → status', () => {
  it.each(CASES)('%s as %s → %i', async (_name, caller, expected, route, ip) => {
    const req = route.request();
    const res = await app.inject({ ...req, headers: { ...(req.headers ?? {}), ...headerFor(caller) }, remoteAddress: ip });
    expect(res.statusCode).toBe(expected);
  });
});

describe('order of checks', () => {
  it('401 and 403 come before validation: a refused caller never sees a 422', async () => {
    for (const caller of ['anonymous', 'contributor'] as const) {
      const res = await app.inject({
        method: 'PATCH', url: `/api/decisions/${ID}`, payload: { mentions: 'nope' }, headers: headerFor(caller),
      });
      expect(res.statusCode).toBe(caller === 'anonymous' ? 401 : 403);
    }
  });

  it('a refused caller never reaches a service', async () => {
    await app.inject({ method: 'GET', url: `/api/decisions/${ID}`, headers: headerFor('contributor') });
    await app.inject({ ...ROUTES.createDecision.request(), headers: { ...ROUTES.createDecision.request().headers, ...headerFor('anonymous') } });
    expect(getForReview).not.toHaveBeenCalled();
    expect(ingestDecision).not.toHaveBeenCalled();
  });
});

describe('POST /api/decisions/:id/report: input and limits', () => {
  // Its own app: the 5 / hour bucket must not be shared with the matrix above
  let reportApp: FastifyInstance;
  beforeAll(async () => {
    reportApp = buildApp();
    await reportApp.ready();
  });
  afterAll(async () => {
    await reportApp.close();
  });
  const send = (payload: unknown, ip = '203.0.113.1') => reportApp.inject({
    method: 'POST', url: `/api/decisions/${ID}/report`, payload: payload as object, remoteAddress: ip,
  });

  it('202 with only the report id, the same body whether or not the decision was taken down', async () => {
    const bodies = [];
    for (const [tookDown, ip] of [[true, '203.0.113.10'], [false, '203.0.113.11']] as const) {
      vi.mocked(reportDecision).mockResolvedValueOnce({ reportId: '0b7e3c55-1f2a-4d6e-9a8b-7c6d5e4f3a2b', tookDown, breakerOpen: false });
      const res = await send({ reason: 'personal_data' }, ip);
      expect(res.statusCode).toBe(202);
      bodies.push(res.json());
    }
    expect(bodies[0]).toEqual({ status: 'success', data: { reportId: '0b7e3c55-1f2a-4d6e-9a8b-7c6d5e4f3a2b' } });
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it.each([
    ['an unknown reason', { reason: 'spam' }, 'reason'],
    ['a message over 2000 characters', { reason: 'other', message: 'x'.repeat(2001) }, 'message'],
    ['a contact that is not an address', { reason: 'other', contact: 'call me' }, 'contact'],
    ['an unknown field', { reason: 'other', name: 'TCHOUPO' }, undefined],
  ])('422 for %s, and the service is never called', async (_label, payload, field) => {
    const res = await send(payload, '203.0.113.20');
    expect(res.statusCode).toBe(422);
    if (field) expect(res.json().errors).toHaveProperty(field);
    expect(reportDecision).not.toHaveBeenCalled();
  });

  it('413 for a body over 4 KB, before validation', async () => {
    const res = await send({ reason: 'other', message: 'x'.repeat(5000) }, '203.0.113.30');
    expect(res.statusCode).toBe(413);
  });

  it('429 on the 6th report in an hour from one address; another address is not affected', async () => {
    vi.mocked(reportDecision).mockResolvedValue({ reportId: '0b7e3c55-1f2a-4d6e-9a8b-7c6d5e4f3a2b', tookDown: false, breakerOpen: false });
    for (let i = 0; i < 5; i++) expect((await send({ reason: 'other' }, '203.0.113.40')).statusCode).toBe(202);
    const sixth = await send({ reason: 'other' }, '203.0.113.40');
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();
    expect((await send({ reason: 'other' }, '203.0.113.41')).statusCode).toBe(202);
  });
});

describe('POST /api/decisions: the upload limit counts per key, not per address', () => {
  let uploadApp: FastifyInstance;
  beforeAll(async () => {
    uploadApp = buildApp();
    await uploadApp.ready();
  });
  afterAll(async () => {
    await uploadApp.close();
  });

  it('one key from 31 addresses gets 30; a second key still gets through', async () => {
    const upload = (key: string, ip: string) => {
      const req = ROUTES.createDecision.request();
      return uploadApp.inject({ ...req, headers: { ...req.headers, 'x-api-key': key }, remoteAddress: ip });
    };
    for (let i = 0; i < 30; i++) expect((await upload(KEYS.contributor, `198.51.100.${i}`)).statusCode).toBe(REACHED);
    expect((await upload(KEYS.contributor, '198.51.100.200')).statusCode).toBe(429);
    expect((await upload(KEYS.reviewer, '198.51.100.200')).statusCode).toBe(REACHED);
  });
});

describe('the global ceiling', () => {
  it('a route without its own limit answers 429 past 300 requests a minute from one address', async () => {
    const ceilingApp = buildApp({ checks: { database: async () => ({ status: 'up', latencyMs: 1 }), llm: async () => ({ status: 'up', latencyMs: 1 }) } });
    await ceilingApp.ready();
    const hit = () => ceilingApp.inject({ method: 'GET', url: '/api/health', remoteAddress: '192.0.2.7' });
    for (let i = 0; i < 300; i++) expect((await hit()).statusCode).toBe(200);
    expect((await hit()).statusCode).toBe(429);
    await ceilingApp.close();
  });
});

describe('GET /review (the reviewers\' page)', () => {
  it('is public and static (it holds no data), and asks search engines not to index it', async () => {
    const res = await app.inject({ method: 'GET', url: '/review', remoteAddress: '192.0.2.50' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.body).toContain('/api/decisions/queue');
    expect(findActiveKey).not.toHaveBeenCalled();
  });
});
