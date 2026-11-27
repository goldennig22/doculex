import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { generateText } from 'ai';
import { db, sql } from '../../src/db/client';
import { apiKeys, chunks, decisionCitations, decisions, documents, nameMentions } from '../../src/db/schema';
import { buildApp } from '../../src/app';
import { embedDocuments, embedQuery } from '../../src/services/embeddings.service';
import { createApiKey } from '../../src/services/api-keys.service';
import { ingestDecision } from '../../src/services/decisions.service';
import { getForReview, publishDecision, reviewDecision } from '../../src/services/decision-review.service';
import { nameHash, normaliseName } from '../../src/services/anonymisation/names';
import { runAnonymisation } from '../../src/jobs/anonymise-decision.job';
import { runEmbedDecision } from '../../src/jobs/embed-decision.job';
import { enqueueEmbedding } from '../../src/jobs/queue';
import type { DetectedPersons } from '../../src/services/anonymisation/llm-detection';
import { FAITS, JUDGMENT_WITH_PERSONS, LLM_PERSONS, PARTY_NAMES } from '../fixtures/ccja-judgment-persons';

// Anonymisation and review against real Postgres. The LLM (generateText) and the embedding provider are mocked;
// pg-boss is not in the test database, so the enqueue functions are spies that see the transaction.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}));
vi.mock('../../src/services/embeddings.service', () => ({
  embedQuery: vi.fn(),
  embedDocuments: vi.fn(),
  EMBEDDING_MODEL: 'test-model',
  DIMENSIONS: 1536,
}));
vi.mock('../../src/jobs/queue', () => ({
  enqueueExtraction: vi.fn(), enqueueAnonymisation: vi.fn(), enqueueEmbedding: vi.fn(), enqueueCitationLinking: vi.fn(),
  enqueueReportNotification: vi.fn(),
}));

const DIMS = 1536;
const axis = (i: number) => Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0));
const TITLE = 'CCJA, arrêt TCHOUPO c/ Société Gamma SARL';
const llmSays = (output: DetectedPersons) => vi.mocked(generateText).mockResolvedValue(
  { output, usage: { inputTokens: 3000, outputTokens: 80 } } as unknown as Awaited<ReturnType<typeof generateText>>);

/** Every word of a fixture name found in a payload, compared as names are (case, accents, punctuation). */
function leakedNames(payload: string): string[] {
  const text = ` ${normaliseName(payload)} `;
  return PARTY_NAMES.filter((name) => text.includes(` ${normaliseName(name)} `));
}

describe.skipIf(!process.env.RUN_DB_TESTS)('anonymisation and review against Postgres', () => {
  let contributorId = '';
  let reviewer = { id: '', plaintext: '' };
  const documentIds: string[] = [];

  /** Upload as a contributor; with `detect`, run the anonymisation job as the worker would. */
  async function upload({ text = JUDGMENT_WITH_PERSONS, detect = true } = {}) {
    const stored = await ingestDecision(
      { text, title: TITLE, language: 'fr', sourceName: 'test', court: 'CCJA', decisionDate: '2019-02-28' },
      contributorId,
    );
    documentIds.push(stored.documentId);
    if (detect) expect(await runAnonymisation(stored.id)).toMatchObject({ status: 'done' });
    return stored;
  }
  const decisionRow = async (id: string) => (await db.select().from(decisions).where(eq(decisions.id, id)))[0];
  const mentionsOf = (id: string) => db.select().from(nameMentions).where(eq(nameMentions.decisionId, id));
  const chunksOf = (documentId: string) => db.select().from(chunks).where(eq(chunks.documentId, documentId));
  const confirmAll = async (id: string) => {
    const ms = await mentionsOf(id);
    return reviewDecision(id, reviewer.id, { mentions: ms.map((m) => ({ id: m.id, action: 'confirm' as const })) });
  };

  beforeAll(async () => {
    contributorId = (await createApiKey('contributor', 'test-anonymisation-contributor')).id;
    reviewer = await createApiKey('reviewer', 'test-anonymisation-reviewer');
  });
  beforeEach(() => {
    vi.mocked(enqueueEmbedding).mockReset().mockResolvedValue('job-1');
    vi.mocked(embedDocuments).mockImplementation(async (texts: string[]) => texts.map(() => axis(702)));
    llmSays(LLM_PERSONS);
  });
  afterAll(async () => {
    if (documentIds.length) await db.delete(documents).where(inArray(documents.id, documentIds));
    await db.delete(apiKeys).where(inArray(apiKeys.id, [contributorId, reviewer.id].filter(Boolean)));
    await sql.end();
  });

  describe('detection (the anonymise-decision job)', () => {
    it('replaces every name, stores each mention unconfirmed with its HMAC, clears the embeddings, moves to in_review', async () => {
      const stored = await upload();

      const row = await decisionRow(stored.id);
      expect(row).toMatchObject({ status: 'in_review', anonymisationStatus: 'done' });
      expect(row.captionText).toContain('Affaire : Monsieur X (Conseil : Maître Y)');

      const parts = await chunksOf(stored.documentId);
      expect(leakedNames(parts.map((p) => `${p.content}\n${p.sectionPath}`).join('\n'))).toEqual([]);
      expect(parts.every((p) => p.embedding === null)).toBe(true); // computed from the clear names
      const [documentId, tx] = vi.mocked(enqueueEmbedding).mock.calls[0];
      expect(documentId).toBe(stored.documentId);
      expect(tx).toBeDefined(); // sent in the transaction that cleared them, not on its own
      expect((await db.select().from(documents).where(eq(documents.id, stored.documentId)))[0].title)
        .toBe('CCJA, arrêt X c/ Société Gamma SARL');

      const ms = await mentionsOf(stored.id);
      expect(ms.length).toBeGreaterThanOrEqual(8);
      for (const m of ms) {
        expect(m).toMatchObject({ confirmed: false, confirmedBy: null });
        expect(m.originalText).not.toBeNull();
        expect(m.originalHash).toBe(nameHash(stored.id, m.originalText!));
      }
    });

    it('placeholders are stable per decision: one person is X in every section, another is Y, then Z', async () => {
      const stored = await upload();
      const byLetter = new Map<string, Set<string>>();
      for (const m of await mentionsOf(stored.id)) {
        byLetter.set(m.placeholder, (byLetter.get(m.placeholder) ?? new Set()).add(normaliseName(m.originalText!)));
      }
      expect(Object.fromEntries([...byLetter].map(([k, v]) => [k, [...v].sort()]))).toEqual({
        X: ['tchoupo', 'tchoupo jean marie'],
        Y: ['nkoum paul'],
        Z: ['ngo biyong esther'],
      });
      // In the text: the same letter wherever the person is named, the quote in the grounds included
      const parts = await chunksOf(stored.documentId);
      const text = (ref: string) => parts.find((p) => p.articleRef === ref)!.content;
      expect(text('procedure')).toContain('formé par Monsieur X, assisté de Maître Y');
      expect(text('faits')).toContain('le sieur X en paiement');
      expect(text('moyen-1')).toContain('« X, émancipé par jugement du 3 mars 2014');
      expect(text('dispositif')).toContain('Rejette le pourvoi formé par Monsieur X');
    });

    it('a second run of the job changes nothing', async () => {
      const stored = await upload();
      const before = await mentionsOf(stored.id);
      expect(await runAnonymisation(stored.id)).toEqual({ status: 'skipped', reason: 'not_pending' });
      expect((await mentionsOf(stored.id)).length).toBe(before.length);
    });
  });

  describe('review', () => {
    it('publish is refused with 409 while any mention is unconfirmed, and nothing changes', async () => {
      const stored = await upload();
      const ms = await mentionsOf(stored.id);
      await reviewDecision(stored.id, reviewer.id, { mentions: ms.slice(1).map((m) => ({ id: m.id, action: 'confirm' as const })) });

      await expect(publishDecision(stored.id, reviewer.id))
        .rejects.toMatchObject({ statusCode: 409, message: '1 name mention(s) are not confirmed yet' });
      const row = await decisionRow(stored.id);
      expect(row).toMatchObject({ status: 'in_review', publishedAt: null, reviewedBy: null });
      expect(row.captionText).not.toBeNull();
    });

    it('confirming erases the clear name and keeps the hash', async () => {
      const stored = await upload();
      const view = await confirmAll(stored.id);
      expect(view.unconfirmedMentions).toBe(0);
      for (const m of await mentionsOf(stored.id)) {
        expect(m).toMatchObject({ confirmed: true, originalText: null, confirmedBy: reviewer.id });
        expect(m.originalHash).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(view.mentions.every((m) => m.original === null)).toBe(true);
    });

    it('the database refuses a confirmed mention that still holds the clear name', async () => {
      const stored = await upload();
      const [m] = await mentionsOf(stored.id);
      await expect(db.update(nameMentions).set({ confirmed: true }).where(eq(nameMentions.id, m.id))).rejects.toThrow();
    });

    it('not_a_person puts the original back and moves the offsets of the next mention in the same section', async () => {
      const stored = await upload();
      const procedure = (await chunksOf(stored.documentId)).find((p) => p.articleRef === 'procedure')!;
      const inProcedure = (await mentionsOf(stored.id)).filter((m) => m.chunkId === procedure.id).sort((a, b) => a.start - b.start);
      expect(inProcedure.map((m) => m.placeholder)).toEqual(['X', 'Y']);
      vi.mocked(enqueueEmbedding).mockClear();

      await reviewDecision(stored.id, reviewer.id, { mentions: [{ id: inProcedure[0].id, action: 'not_a_person' }] });

      const after = (await chunksOf(stored.documentId)).find((p) => p.id === procedure.id)!;
      expect(after.content).toContain('formé par Monsieur TCHOUPO Jean-Marie, assisté de Maître Y');
      expect(after.embedding).toBeNull();
      expect(enqueueEmbedding).toHaveBeenCalledTimes(1);
      const [y] = (await mentionsOf(stored.id)).filter((m) => m.chunkId === procedure.id);
      expect(y.id).toBe(inProcedure[1].id);
      expect(y.start).toBe(inProcedure[1].start + 'TCHOUPO Jean-Marie'.length - 1);
      expect(after.content.slice(y.start, y.end)).toBe('Y');
    });

    it('addMentions replaces every occurrence of a missed name with a new letter, confirmed, with no clear text', async () => {
      llmSays(LLM_PERSONS); // does not list the witness
      const text = JUDGMENT_WITH_PERSONS.replace(FAITS, `${FAITS}\nque FOTSO, témoin, a confirmé ces faits ;`);
      const stored = await upload({ text });
      const faits = () => chunksOf(stored.documentId).then((ps) => ps.find((p) => p.articleRef === 'faits')!);
      expect((await faits()).content).toContain('que FOTSO, témoin');

      const view = await reviewDecision(stored.id, reviewer.id, { addMentions: [{ surface: 'FOTSO' }] });

      expect((await faits()).content).toContain('que A, témoin');
      expect(view.mentions.find((m) => m.placeholder === 'A')).toMatchObject({ source: 'reviewer', confirmed: true, original: null });
      await expect(reviewDecision(stored.id, reviewer.id, { addMentions: [{ surface: 'ABSENT' }] }))
        .rejects.toMatchObject({ statusCode: 422, message: 'addMentions[0] was not found in the decision' });
    });

    it('nobody reviews or publishes their own upload: 403, not the CHECK\'s 500', async () => {
      const stored = await upload();
      await expect(reviewDecision(stored.id, contributorId, { status: 'rejected' })).rejects.toMatchObject({ statusCode: 403 });
      await expect(publishDecision(stored.id, contributorId)).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('illegal status transitions are refused with 409', () => {
    it('a draft (detection not run) cannot be published, reviewed, or moved to in_review', async () => {
      const stored = await upload({ detect: false });
      await expect(publishDecision(stored.id, reviewer.id))
        .rejects.toMatchObject({ statusCode: 409, message: "A decision can't go from draft to published" });
      await expect(reviewDecision(stored.id, reviewer.id, { metadata: { headnote: 'Trois phrases.' } }))
        .rejects.toMatchObject({ statusCode: 409 });
      await expect(reviewDecision(stored.id, reviewer.id, { status: 'in_review' }))
        .rejects.toMatchObject({ statusCode: 409, message: 'Name detection has not run yet' });
      await expect(reviewDecision(stored.id, reviewer.id, { status: 'draft' })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('in_review → in_review, and publishing through PATCH, are refused', async () => {
      const stored = await upload();
      await expect(reviewDecision(stored.id, reviewer.id, { status: 'in_review' }))
        .rejects.toMatchObject({ statusCode: 409, message: "A decision can't go from in_review to in_review" });
      await expect(reviewDecision(stored.id, reviewer.id, { status: 'published' })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('rejected is final: the caption and every clear name are erased, and nothing moves it again', async () => {
      const stored = await upload();
      await reviewDecision(stored.id, reviewer.id, { status: 'rejected' });

      const row = await decisionRow(stored.id);
      expect(row).toMatchObject({ status: 'rejected', captionText: null, reviewedBy: reviewer.id });
      expect((await mentionsOf(stored.id)).every((m) => m.originalText === null)).toBe(true);
      await expect(reviewDecision(stored.id, reviewer.id, { status: 'in_review' })).rejects.toMatchObject({ statusCode: 409 });
      await expect(publishDecision(stored.id, reviewer.id)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('the full path: in_review → published, then published is final', async () => {
      const stored = await upload();
      await confirmAll(stored.id);

      // The text changed, so the chunks wait for their new embedding; publish says so and enqueues the job
      vi.mocked(enqueueEmbedding).mockClear();
      await expect(publishDecision(stored.id, reviewer.id)).rejects.toMatchObject({ statusCode: 409 });
      expect(enqueueEmbedding).toHaveBeenCalledWith(stored.documentId);
      expect(await runEmbedDecision(stored.documentId)).toEqual({ embedded: 4, stale: 0 });

      // Extraction ran alongside and wrote the headnote from the clear text: the leak check finds the hashed name
      await db.update(decisions).set({ headnote: 'La Cour relève que le sieur Tchoupo était émancipé.' }).where(eq(decisions.id, stored.id));
      await expect(publishDecision(stored.id, reviewer.id))
        .rejects.toMatchObject({ statusCode: 409, message: 'A name that was anonymised still appears in: headnote' });
      await reviewDecision(stored.id, reviewer.id, { metadata: { headnote: 'La Cour relève que le défendeur était émancipé.' } });

      const published = await publishDecision(stored.id, reviewer.id);
      expect(published).toMatchObject({ status: 'published', caption: null, unconfirmedMentions: 0 });
      expect(await decisionRow(stored.id)).toMatchObject({ status: 'published', reviewedBy: reviewer.id, captionText: null });

      await expect(publishDecision(stored.id, reviewer.id))
        .rejects.toMatchObject({ statusCode: 409, message: "A decision can't go from published to published" });
      await expect(reviewDecision(stored.id, reviewer.id, { status: 'rejected' }))
        .rejects.toMatchObject({ statusCode: 409, message: "A published decision can't be changed" });
      await expect(reviewDecision(stored.id, reviewer.id, { metadata: { headnote: 'TCHOUPO' } }))
        .rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('no fixture party name in any published API response', () => {
    let app: FastifyInstance;
    const routes: string[] = [];
    const responses: { route: string; body: string }[] = [];
    const reviewerHeaders = () => ({ 'x-api-key': reviewer.plaintext });
    let publishedId = '';

    // Every /api route must be in one of these lists. A new route fails the coverage test until someone decides
    // whether its responses can contain decision text, and if so, adds it to the scan.
    const SCANNED = [
      'GET /api/documents', 'GET /api/documents/:documentId/show',
      'GET /api/decisions/:decisionId', 'PATCH /api/decisions/:decisionId', 'POST /api/decisions/:decisionId/publish',
      'GET /api/decisions', 'GET /api/search', 'GET /api/articles/:documentId/:articleRef',
      'GET /api/decisions/queue', 'POST /api/decisions/:decisionId/report',
    ];
    const EXEMPT: Record<string, string> = {
      'GET /api/health': 'no document content',
      'POST /api/ai/ask': 'statutes only: searchableDocuments() never returns a decision (visibility.test.ts)',
      'POST /api/decisions': 'returns a draft just uploaded, before detection; contributor only',
      'POST /api/documents/upload': 'statutes, admin only',
      'DELETE /api/documents/:documentId/delete': 'returns the id only',
      'GET /api/stats': 'counts by court, country and year: no decision text',
    };

    beforeAll(async () => {
      app = buildApp({ checks: { database: async () => ({ status: 'up', latencyMs: 1 }), llm: async () => ({ status: 'up', latencyMs: 1 }) } });
      app.addHook('onRoute', (r) => {
        for (const m of [r.method].flat()) if (m !== 'HEAD' && r.url.startsWith('/api')) routes.push(`${m} ${r.url}`);
      });
      await app.ready();

      // The whole review through HTTP, keeping every response once the decision is published
      vi.mocked(embedDocuments).mockImplementation(async (texts: string[]) => texts.map(() => axis(702)));
      llmSays(LLM_PERSONS);
      const stored = await upload();
      const view = (await app.inject({ method: 'GET', url: `/api/decisions/${stored.id}`, headers: reviewerHeaders() })).json().data;
      const confirmed = await app.inject({
        method: 'PATCH', url: `/api/decisions/${stored.id}`, headers: reviewerHeaders(),
        payload: { mentions: view.mentions.map((m: { id: string }) => ({ id: m.id, action: 'confirm' })) },
      });
      expect(confirmed.statusCode).toBe(200);
      await runEmbedDecision(stored.documentId);

      const keep = async (route: string, res: Awaited<ReturnType<FastifyInstance['inject']>>, status = 200) => {
        expect(res.statusCode, `${route}: ${res.body}`).toBe(status);
        responses.push({ route, body: res.body });
      };
      await keep('POST /api/decisions/:decisionId/publish',
        await app.inject({ method: 'POST', url: `/api/decisions/${stored.id}/publish`, headers: reviewerHeaders() }));
      await keep('GET /api/documents', await app.inject({ method: 'GET', url: '/api/documents' }));
      await keep('GET /api/documents/:documentId/show', await app.inject({ method: 'GET', url: `/api/documents/${stored.documentId}/show` }));
      await keep('GET /api/decisions/:decisionId',
        await app.inject({ method: 'GET', url: `/api/decisions/${stored.id}`, headers: reviewerHeaders() }));
      // The public search routes, each with the published decision in its results (checked below)
      vi.mocked(embedQuery).mockResolvedValue(axis(702));
      await keep('GET /api/decisions', await app.inject({ method: 'GET', url: '/api/decisions?court=CCJA&limit=50' }));
      await keep('GET /api/decisions', await app.inject({ method: 'GET', url: '/api/decisions?q=commer%C3%A7ant&limit=50' }));
      await keep('GET /api/search', await app.inject({ method: 'GET', url: '/api/search?q=commer%C3%A7ant&limit=50' }));
      // The article page lists the decisions citing it, with their headnotes: link the published one to an article
      const [statute] = await db.insert(documents).values({
        kind: 'statute', title: 'Acte uniforme de test (scan)', language: 'fr', actCode: 'AUSCGIE', actVersion: '2014',
      }).returning({ id: documents.id });
      documentIds.push(statute.id);
      await db.insert(chunks).values({ documentId: statute.id, articleRef: '7', pageStart: 1, pageEnd: 1, content: 'Article 7.' });
      await db.insert(decisionCitations).values({
        decisionId: stored.id, actCode: 'AUSCGIE', actVersion: '2014', articleRef: '7', rawText: "l'article 7",
        actSource: 'explicit', method: 'rule', confidence: 'high',
      });
      await keep('GET /api/articles/:documentId/:articleRef',
        await app.inject({ method: 'GET', url: `/api/articles/${statute.id}/7` }));
      publishedId = stored.id;
      // Titles of every decision waiting for review (other tests' ones too): detection anonymised them
      await keep('GET /api/decisions/queue', await app.inject({ method: 'GET', url: '/api/decisions/queue', headers: reviewerHeaders() }));
      // Not personal_data: the decision stays published, so the PATCH below still meets a published decision
      await keep('POST /api/decisions/:decisionId/report', await app.inject({
        method: 'POST', url: `/api/decisions/${stored.id}/report`, payload: { reason: 'wrong_metadata', message: 'La date est fausse.' },
      }), 202);

      await keep('PATCH /api/decisions/:decisionId', await app.inject({
        method: 'PATCH', url: `/api/decisions/${stored.id}`, headers: reviewerHeaders(), payload: { status: 'rejected' },
      }), 409);
    });
    afterAll(async () => {
      await app.close();
    });

    it('the scanner finds a planted name in any case, with punctuation (so a pass means something)', () => {
      expect(leakedNames(JSON.stringify({ headnote: 'le sieur Tchoupo, émancipé' }))).toEqual(['TCHOUPO']);
      expect(leakedNames('{"caption":"Dame NGO  BIYONG-ESTHER"}')).toEqual(['NGO BIYONG', 'BIYONG', 'Esther']);
      expect(leakedNames(JSON.stringify({ text: 'le sieur X et Dame Z' }))).toEqual([]);
    });

    it('the published decision appears in the public listing (the scan saw it)', () => {
      const listing = responses.find((r) => r.route === 'GET /api/documents')!;
      expect(listing.body).toContain('CCJA, arrêt X c/ Société Gamma SARL');
    });

    it('the published decision is in every public search response (the scan saw it)', () => {
      for (const route of ['GET /api/decisions', 'GET /api/search', 'GET /api/articles/:documentId/:articleRef']) {
        for (const r of responses.filter((x) => x.route === route)) expect(r.body, route).toContain(publishedId);
      }
    });

    it.each(SCANNED)('%s contains no fixture party name', (route) => {
      const scanned = responses.filter((r) => r.route === route);
      expect(scanned.length, `no response kept for ${route}`).toBeGreaterThan(0);
      for (const r of scanned) expect(leakedNames(r.body), r.body).toEqual([]);
    });

    it('every /api route is either scanned or exempt with a reason', () => {
      const unclassified = routes.filter((r) => !SCANNED.includes(r) && !(r in EXEMPT));
      expect(unclassified).toEqual([]);
      expect(routes).toEqual(expect.arrayContaining(SCANNED));
    });

    it('getForReview of the published decision holds no clear name either (no original, no caption)', async () => {
      const id = JSON.parse(responses.find((r) => r.route === 'GET /api/decisions/:decisionId')!.body).data.id;
      expect(leakedNames(JSON.stringify(await getForReview(id)))).toEqual([]);
    });
  });
});
