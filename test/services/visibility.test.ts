import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, sql } from '../../src/db/client';
import { apiKeys, chunks, decisions, documents } from '../../src/db/schema';
import { embedDocuments, embedQuery } from '../../src/services/embeddings.service';
import { createApiKey, findActiveKey, revokeApiKey } from '../../src/services/api-keys.service';
import { getArticleParts, searchByKeywords, searchByVector } from '../../src/services/search.service';
import { getDocuments, refreshLexemeStats } from '../../src/services/documents.service';
import { ingestDecision } from '../../src/services/decisions.service';

// Never call the embedding provider: each test chooses the vectors.
vi.mock('../../src/services/embeddings.service', () => ({
  embedQuery: vi.fn(),
  embedDocuments: vi.fn(),
  EMBEDDING_MODEL: 'test-model',
  DIMENSIONS: 1536,
}));
// ingestDecision enqueues the extraction job in its transaction; pg-boss's schema isn't in the test database
vi.mock('../../src/jobs/queue', () => ({ enqueueExtraction: vi.fn(), enqueueAnonymisation: vi.fn(), enqueueEmbedding: vi.fn(), enqueueCitationLinking: vi.fn() }));

const DIMS = 1536;
/** Two different axes have similarity 0; the same axis has similarity 1. */
const axis = (i: number) => Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0));
const DECISION_AXIS = 700; // far from the axes the other suites use
const BOTH = { kinds: ['statute' as const, 'decision' as const] };

const JUDGMENT = [
  "La Cour Commune de Justice et d'Arbitrage a rendu l'Arrêt suivant :",
  'Sur le recours formé par la Société Alpha SA en cassation de l\'arrêt de la Cour d\'appel du Littoral ;',
  "Attendu, selon l'arrêt attaqué, que la Société Alpha SA a assigné la Société Gamma SARL en paiement ;",
  'Sur le premier moyen, tiré de la violation de l\'article 7 de l\'Acte uniforme portant sur le droit commercial général',
  "Attendu qu'il est fait grief à l'arrêt d'avoir retenu la qualité de commerçant d'un mineur ; Mais attendu que le défendeur était émancipé ;",
  'PAR CES MOTIFS :',
  'Rejette le pourvoi.',
  'Ainsi fait, jugé et prononcé.',
].join('\n');

describe.skipIf(!process.env.RUN_DB_TESTS)('API keys against Postgres', () => {
  const ids: string[] = [];
  afterAll(async () => {
    if (ids.length) await db.delete(apiKeys).where(inArray(apiKeys.id, ids));
  });

  it('finds a key by its hash, never stores it, and forgets it once revoked', async () => {
    const key = await createApiKey('reviewer', 'test-reviewer');
    ids.push(key.id);

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(Object.values(row)).not.toContain(key.plaintext);

    expect(await findActiveKey(key.plaintext)).toEqual({ id: key.id, role: 'reviewer', label: 'test-reviewer' });
    expect(await revokeApiKey(key.id)).toBe(true);
    expect(await findActiveKey(key.plaintext)).toBeNull();
    expect(await revokeApiKey(key.id)).toBe(false); // already revoked
  });
});

describe.skipIf(!process.env.RUN_DB_TESTS)('unpublished decisions are invisible to every search', () => {
  let contributorId = '';
  let reviewerId = '';
  let decisionId = '';
  let documentId = '';

  beforeAll(async () => {
    contributorId = (await createApiKey('contributor', 'test-contributor')).id;
    reviewerId = (await createApiKey('reviewer', 'test-reviewer-2')).id;

    // Every chunk of the decision gets the same vector, which is also the question's: similarity 1.0
    vi.mocked(embedDocuments).mockImplementation(async (texts: string[]) => texts.map(() => axis(DECISION_AXIS)));
    const stored = await ingestDecision(
      { text: JUDGMENT, title: 'CCJA, arrêt de test', language: 'fr', sourceName: 'test' },
      contributorId,
    );
    decisionId = stored.id;
    documentId = stored.documentId;
  });

  afterAll(async () => {
    if (documentId) await db.delete(documents).where(eq(documents.id, documentId)); // cascades to decision + chunks
    await db.delete(apiKeys).where(inArray(apiKeys.id, [contributorId, reviewerId].filter(Boolean)));
    await refreshLexemeStats();
    await sql.end();
  });

  it('stores the contribution as a draft, chunked by section', async () => {
    const [decision] = await db.select().from(decisions).where(eq(decisions.id, decisionId));
    expect(decision).toMatchObject({ status: 'draft', contributedBy: contributorId, reviewedBy: null });

    const stored = await db.select({ ref: chunks.articleRef }).from(chunks).where(eq(chunks.documentId, documentId));
    expect(stored.map((c) => c.ref).sort()).toEqual(['dispositif', 'faits', 'moyen-1', 'procedure']);
  });

  it('vector search skips a draft even at similarity 1.0', async () => {
    vi.mocked(embedQuery).mockResolvedValue(axis(DECISION_AXIS));
    const hits = await searchByVector('qualité de commerçant d\'un mineur émancipé', 20, BOTH);
    expect(hits.map((h) => h.documentId)).not.toContain(documentId);
  });

  it('keyword search, getArticleParts and the public document routes skip it too', async () => {
    await refreshLexemeStats();
    expect((await searchByKeywords('mineur émancipé pourvoi', 50, undefined, BOTH)).map((h) => h.documentId))
      .not.toContain(documentId);
    expect(await getArticleParts([{ documentId, articleRef: 'moyen-1' }], BOTH)).toEqual([]);
    expect(await getDocuments(documentId)).toBeNull();
  });

  it('the database refuses to publish an unreviewed or incomplete decision', async () => {
    const publish = (values: Partial<typeof decisions.$inferInsert>) =>
      // No caption and detection done, as a real publish has: each case must fail for its own reason
      db.update(decisions)
        .set({ status: 'published', publishedAt: new Date(), captionText: null, anonymisationStatus: 'done', ...values })
        .where(eq(decisions.id, decisionId));

    await expect(publish({ court: 'CCJA', decisionDate: '2019-02-28' })).rejects.toThrow(); // no reviewer
    await expect(publish({ reviewedBy: reviewerId })).rejects.toThrow(); // no court, no date
    await expect(publish({ reviewedBy: contributorId, court: 'CCJA', decisionDate: '2019-02-28' })).rejects.toThrow(); // own upload
    await expect(publish({ reviewedBy: reviewerId, court: 'CCJA', decisionDate: '2019-02-28', anonymisationStatus: 'pending' }))
      .rejects.toThrow(); // names never detected
  });

  it('once published, it is searchable, but /ask (statutes only) still never sees it', async () => {
    await db.update(decisions)
      .set({
        status: 'published', publishedAt: new Date(), reviewedBy: reviewerId, court: 'CCJA', decisionDate: '2019-02-28',
        captionText: null, anonymisationStatus: 'done',
      })
      .where(eq(decisions.id, decisionId));

    vi.mocked(embedQuery).mockResolvedValue(axis(DECISION_AXIS));
    const withDecisions = await searchByVector('qualité de commerçant', 20, BOTH);
    expect(withDecisions[0].documentId).toBe(documentId);
    expect(withDecisions[0].similarity).toBeCloseTo(1);

    const statutesOnly = await searchByVector('qualité de commerçant', 20); // the default scope, used by /ask
    expect(statutesOnly.map((h) => h.documentId)).not.toContain(documentId);

    expect(await getDocuments(documentId)).toMatchObject({ id: documentId, kind: 'decision' });
  });
});
