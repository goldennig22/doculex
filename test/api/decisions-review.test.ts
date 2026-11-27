import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { env } from '../../src/config/env';
import { findActiveKey, generateApiKey } from '../../src/services/api-keys.service';
import { getForReview, publishDecision, reviewDecision, type ReviewView } from '../../src/services/decision-review.service';
import { HttpError } from '../../src/utils/http-error';

// The review routes without Postgres: the key lookup and the review service are mocked. What is tested here is the
// HTTP layer (roles, validation, status codes); the rules themselves run against Postgres in decision-review.db.test.ts.
vi.mock('../../src/services/api-keys.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/api-keys.service')>()),
  findActiveKey: vi.fn(),
}));
vi.mock('../../src/services/decision-review.service', () => ({
  getForReview: vi.fn(), reviewDecision: vi.fn(), publishDecision: vi.fn(),
}));

const ID = '8d1f0c2e-4b7a-4e19-9c3d-5a6b7c8d9e0f';
const MENTION = '3f6c1a2b-9d8e-4f70-8a1b-2c3d4e5f6a7b';
const REVIEWER_ID = '5b0c9f3e-2d41-4a7b-8e6f-1c2d3e4f5a6b';
const KEY = generateApiKey().plaintext;

const VIEW: ReviewView = {
  id: ID, documentId: '2a9e7c41-6f3b-4d8a-b1c5-0e2f4a6b8c9d', title: 'CCJA, arrêt n° 045/2019', language: 'fr',
  status: 'in_review', anonymisationStatus: 'done', extractionStatus: 'done',
  court: 'CCJA', country: null, chamber: null, caseNumber: null, decisionDate: '2019-02-28',
  subject: null, outcome: 'rejet', headnote: null, caption: 'Affaire : Monsieur X', sections: [],
  unconfirmedMentions: 1, pendingEmbeddings: 0, publishedAt: null, citations: [], openReports: 0,
  mentions: [{
    id: MENTION, placeholder: 'X', segment: 'caption', start: 19, end: 20, context: 'Affaire : Monsieur X',
    original: 'TCHOUPO Jean-Marie', source: 'both', confirmed: false,
  }],
};

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
  vi.mocked(findActiveKey).mockResolvedValue({ id: REVIEWER_ID, role: 'reviewer', label: 'reviewer-1' });
  vi.mocked(getForReview).mockResolvedValue(VIEW);
  vi.mocked(reviewDecision).mockResolvedValue(VIEW);
  vi.mocked(publishDecision).mockResolvedValue({ ...VIEW, status: 'published', caption: null, publishedAt: new Date() });
});

const patch = (payload: unknown, apiKey: string | null = KEY) => app.inject({
  method: 'PATCH', url: `/api/decisions/${ID}`, payload: payload as object,
  headers: apiKey ? { 'x-api-key': apiKey } : {},
});

describe('review routes: who may call them', () => {
  it.each([
    ['GET', `/api/decisions/${ID}`],
    ['PATCH', `/api/decisions/${ID}`],
    ['POST', `/api/decisions/${ID}/publish`],
  ] as const)('%s %s: 401 without a key, 401 with the legacy key, 403 for a contributor', async (method, url) => {
    expect((await app.inject({ method, url })).statusCode).toBe(401);
    expect((await app.inject({ method, url, headers: { 'x-api-key': env.ADMIN_API_KEY } })).statusCode).toBe(401);

    vi.mocked(findActiveKey).mockResolvedValueOnce({ id: REVIEWER_ID, role: 'contributor', label: 'clinic-1' });
    const res = await app.inject({ method, url, headers: { 'x-api-key': KEY }, ...(method === 'PATCH' ? { payload: { status: 'rejected' } } : {}) });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('This action requires the reviewer role');
    expect(reviewDecision).not.toHaveBeenCalled();
    expect(publishDecision).not.toHaveBeenCalled();
  });

  it('401 comes before 422: an anonymous client never sees the validation rules', async () => {
    expect((await patch({ mentions: 'nope' }, null)).statusCode).toBe(401);
  });

  it('an admin key may review (higher roles include reviewer)', async () => {
    vi.mocked(findActiveKey).mockResolvedValueOnce({ id: REVIEWER_ID, role: 'admin', label: 'admin-1' });
    expect((await app.inject({ method: 'GET', url: `/api/decisions/${ID}`, headers: { 'x-api-key': KEY } })).statusCode).toBe(200);
  });
});

describe('PATCH /api/decisions/:decisionId', () => {
  it('passes the body and the reviewer key id to the service', async () => {
    const body = { mentions: [{ id: MENTION, action: 'confirm' }], metadata: { country: 'cm', headnote: 'Trois phrases.' } };
    const res = await patch(body);
    expect(res.statusCode).toBe(200);
    expect(reviewDecision).toHaveBeenCalledWith(ID, REVIEWER_ID, {
      mentions: [{ id: MENTION, action: 'confirm' }], metadata: { country: 'CM', headnote: 'Trois phrases.' },
    });
  });

  it.each([
    ['an empty body', {}, 'status'],
    ['an unknown action', { mentions: [{ id: MENTION, action: 'delete' }] }, 'mentions'],
    ['a mention id that is not a uuid', { mentions: [{ id: '42', action: 'confirm' }] }, 'mentions'],
    ['a placeholder that is not a letter', { mentions: [{ id: MENTION, action: 'reassign', placeholder: 'Jean' }] }, 'mentions'],
    ['an unknown status', { status: 'archived' }, 'status'],
    ['an unknown field', { reviewedBy: REVIEWER_ID }, ''],
    ['a metadata field that is not editable', { metadata: { status: 'published' } }, 'metadata'],
    ['a one-letter name to add', { addMentions: [{ surface: 'X' }] }, 'addMentions'],
  ])('422 for %s', async (_name, body, field) => {
    const res = await patch(body);
    expect(res.statusCode).toBe(422);
    if (field) expect(res.json().errors).toHaveProperty(field);
    expect(reviewDecision).not.toHaveBeenCalled();
  });

  it('a 422 for a non-uuid decision id, before any database call', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/decisions/abc', payload: { status: 'rejected' }, headers: { 'x-api-key': KEY } });
    expect(res.statusCode).toBe(422);
  });

  it.each([
    [409, "A decision can't go from published to in_review"],
    [404, 'Decision not found'],
    [403, 'Nobody reviews their own upload'],
  ])('passes on a %i from the service', async (code, message) => {
    vi.mocked(reviewDecision).mockRejectedValueOnce(new HttpError(code, message));
    const res = await patch({ status: 'in_review' });
    expect(res.statusCode).toBe(code);
    expect(res.json()).toMatchObject({ status: 'failed', message });
  });
});

describe('POST /api/decisions/:decisionId/publish', () => {
  it('publishes with the reviewer key id', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/decisions/${ID}/publish`, headers: { 'x-api-key': KEY } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'published', caption: null });
    expect(publishDecision).toHaveBeenCalledWith(ID, REVIEWER_ID);
  });

  it('a 409 while mentions are unconfirmed', async () => {
    vi.mocked(publishDecision).mockRejectedValueOnce(new HttpError(409, '1 name mention(s) are not confirmed yet'));
    const res = await app.inject({ method: 'POST', url: `/api/decisions/${ID}/publish`, headers: { 'x-api-key': KEY } });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('1 name mention(s) are not confirmed yet');
  });
});
