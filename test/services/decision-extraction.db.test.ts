import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client';
import { apiKeys, decisions, documents } from '../../src/db/schema';
import { embedDocuments } from '../../src/services/embeddings.service';
import { createApiKey } from '../../src/services/api-keys.service';
import {
  ingestDecision, loadForExtraction, markNeedsManualEntry, saveExtraction,
} from '../../src/services/decisions.service';
import type { DecisionMetadata } from '../../src/services/decision-extraction.service';
import { enqueueExtraction } from '../../src/jobs/queue';
import { CAPTION, CHUNKS } from '../fixtures/ccja-judgment';

// The SQL behind the extraction job, against real Postgres. No LLM, no embedding provider, no pg-boss
// (its schema isn't in the test database): enqueueExtraction is a spy that sees the transaction.
vi.mock('../../src/services/embeddings.service', () => ({
  embedQuery: vi.fn(),
  embedDocuments: vi.fn(),
  EMBEDDING_MODEL: 'test-model',
  DIMENSIONS: 1536,
}));
vi.mock('../../src/jobs/queue', () => ({ enqueueExtraction: vi.fn() }));

const DIMS = 1536;
const axis = (i: number) => Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0));
const JUDGMENT = [CAPTION, ...[...CHUNKS].reverse().map((c) => c.content)].join('\n');
const TITLE = 'CCJA, arrêt de test (extraction)';

const AI: DecisionMetadata = {
  court: 'CCJA', country: null, chamber: 'Première chambre', caseNumber: 'Arrêt N° 045/2019',
  decisionDate: '2019-02-28', subject: "Qualité de commerçant d'un mineur émancipé", outcome: 'rejet',
  headnote: 'Trois phrases. Deux. Une.',
};

describe.skipIf(!process.env.RUN_DB_TESTS)('decision extraction against Postgres', () => {
  let contributorId = '';
  let reviewerId = '';
  const documentIds: string[] = [];

  const upload = async (extra: { court?: string; chamber?: string } = {}) => {
    const stored = await ingestDecision({ text: JUDGMENT, title: TITLE, language: 'fr', sourceName: 'test', ...extra }, contributorId);
    documentIds.push(stored.documentId);
    return stored;
  };
  const rowOf = async (id: string) => (await db.select().from(decisions).where(eq(decisions.id, id)))[0];

  beforeAll(async () => {
    contributorId = (await createApiKey('contributor', 'test-extraction-contributor')).id;
    reviewerId = (await createApiKey('reviewer', 'test-extraction-reviewer')).id;
  });
  beforeEach(() => {
    vi.mocked(enqueueExtraction).mockReset().mockResolvedValue('job-1');
    vi.mocked(embedDocuments).mockImplementation(async (texts: string[]) => texts.map(() => axis(701)));
  });
  afterAll(async () => {
    // Documents first: decisions cascade from them, and they reference the keys
    if (documentIds.length) await db.delete(documents).where(inArray(documents.id, documentIds));
    await db.delete(apiKeys).where(inArray(apiKeys.id, [contributorId, reviewerId]));
  });

  it('upload stores the caption, status pending, and enqueues the job inside the transaction', async () => {
    const stored = await upload();

    expect(stored.extractionStatus).toBe('pending');
    expect(enqueueExtraction).toHaveBeenCalledTimes(1);
    const [decisionId, tx] = vi.mocked(enqueueExtraction).mock.calls[0];
    expect(decisionId).toBe(stored.id);
    expect(tx).not.toBe(db); // the transaction, not the pool: the job commits with the row, or not at all

    const row = await rowOf(stored.id);
    expect(row.captionText).toContain('Arrêt N° 045/2019');
    expect(row.extractionStatus).toBe('pending');
  });

  it('no decision without its job: if enqueueing fails, the upload is rolled back', async () => {
    vi.mocked(enqueueExtraction).mockRejectedValueOnce(new Error('pgboss.job: relation does not exist'));
    const before = await db.select({ id: documents.id }).from(documents).where(eq(documents.title, TITLE));

    await expect(upload()).rejects.toThrow('pgboss.job');

    const after = await db.select({ id: documents.id }).from(documents).where(eq(documents.title, TITLE));
    expect(after.length).toBe(before.length);
  });

  it('loadForExtraction returns the language, the caption and every chunk', async () => {
    const stored = await upload();
    const subject = await loadForExtraction(stored.id);
    expect(subject).toMatchObject({ decisionId: stored.id, language: 'fr', extractionStatus: 'pending' });
    expect(subject?.captionText).toContain('CCJA');
    expect(subject?.chunks.map((c) => c.articleRef).sort()).toEqual(['dispositif', 'faits', 'moyen-1', 'procedure']);
    expect(await loadForExtraction('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('fills empty fields, never overwrites what the contributor typed, marks generated_by ai, clears the caption', async () => {
    const stored = await upload({ chamber: 'Chambre saisie par le contributeur' });

    expect(await saveExtraction(stored.id, AI)).toBe(true);

    const row = await rowOf(stored.id);
    expect(row).toMatchObject({
      court: 'CCJA', chamber: 'Chambre saisie par le contributeur', caseNumber: 'Arrêt N° 045/2019',
      decisionDate: '2019-02-28', outcome: 'rejet', subject: AI.subject, headnote: AI.headnote, country: null,
      generatedBy: 'ai', extractionStatus: 'done', extractionError: null, captionText: null,
    });
  });

  it('keeps generated_by reviewer when the AI filled nothing new', async () => {
    const stored = await upload({ court: 'CCJA' });
    const onlyCourt: DecisionMetadata = { ...AI, chamber: null, caseNumber: null, decisionDate: null, subject: null, outcome: null, headnote: null };

    expect(await saveExtraction(stored.id, onlyCourt)).toBe(true);
    expect((await rowOf(stored.id)).generatedBy).toBe('reviewer');
  });

  it('is safe to run twice: the second write changes nothing', async () => {
    const stored = await upload();
    expect(await saveExtraction(stored.id, AI)).toBe(true);
    expect(await saveExtraction(stored.id, { ...AI, caseNumber: 'Arrêt N° 999/2019', outcome: 'cassation' })).toBe(false);

    expect(await rowOf(stored.id)).toMatchObject({ caseNumber: 'Arrêt N° 045/2019', outcome: 'rejet' });
  });

  it('two overlapping writes: exactly one wins', async () => {
    const stored = await upload();
    const results = await Promise.all([
      saveExtraction(stored.id, AI),
      saveExtraction(stored.id, { ...AI, caseNumber: 'Arrêt N° 999/2019' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('manual entry keeps the caption for the reviewer, and never undoes a successful run', async () => {
    const failed = await upload();
    expect(await markNeedsManualEntry(failed.id, 'bad output')).toBe(true);
    expect(await rowOf(failed.id)).toMatchObject({ extractionStatus: 'needs_manual_entry', extractionError: 'bad output' });
    expect((await rowOf(failed.id)).captionText).toContain('CCJA');

    const done = await upload();
    await saveExtraction(done.id, AI);
    expect(await markNeedsManualEntry(done.id, 'late dead letter')).toBe(false);
    expect((await rowOf(done.id)).extractionStatus).toBe('done');
  });

  it('the database refuses to publish a decision that still has its caption', async () => {
    const stored = await upload({ court: 'CCJA' });
    const publish = (captionText?: null) => db.update(decisions)
      .set({ status: 'published', publishedAt: new Date(), reviewedBy: reviewerId, decisionDate: '2019-02-28', ...(captionText === null ? { captionText } : {}) })
      .where(eq(decisions.id, stored.id));

    await expect(publish()).rejects.toThrow();
    await expect(publish(null)).resolves.toBeDefined();
  });
});
