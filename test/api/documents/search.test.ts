// test/services/search.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { detectLanguage, hybridSearch, rrf, searchByKeywords, searchByVector } from '../../../src/services/search.service';
import { embedQuery } from '../../../src/services/embeddings.service';
import { db, sql } from '../../../src/db/client';
import { chunks, documents } from '../../../src/db/schema';

// Never call the embedding provider in tests: the query vector is chosen by each test.
vi.mock('../../src/services/embeddings.service', () => ({
  embedQuery: vi.fn(),
  embedDocuments: vi.fn(),
  EMBEDDING_MODEL: 'test-model',
  DIMENSIONS: 1536,
}));

// ─── Unit tests: pure functions, no database ─────────────────────────────────

const item = (id: string) => ({ id });

describe('rrf', () => {
  it('an item found by both searches beats items found by only one', () => {
    const out = rrf([[item('a'), item('both')], [item('both'), item('b')]]);
    expect(out[0].id).toBe('both');
  });

  it('keeps the order of the other list when one list is empty', () => {
    const out = rrf([[item('a'), item('b'), item('c')], []]);
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('never returns the same id twice', () => {
    const out = rrf([[item('a'), item('b')], [item('b'), item('a')], [item('a')]]);
    const ids = out.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('breaks ties by first appearance, so results are stable', () => {
    // 'a' and 'x' are both rank 1 in one list: equal scores
    const out = rrf([[item('a')], [item('x')]]);
    expect(out.map((x) => x.id)).toEqual(['a', 'x']);
    expect(out[0].rrfScore).toBe(out[1].rrfScore);
  });

  it('a lower weight makes a list count less', () => {
    // Without weights 'kw' (rank 1 in list 2) ties with 'vec' (rank 1 in list 1); with weight 0.5 it loses
    const out = rrf([[item('vec')], [item('kw')]], { weights: [1, 0.5] });
    expect(out.map((x) => x.id)).toEqual(['vec', 'kw']);
    expect(out[1].rrfScore).toBeCloseTo(out[0].rrfScore / 2);
  });

  it('uses 1 / (k + rank) with k = 60 by default', () => {
    const [first] = rrf([[item('a')]]);
    expect(first.rrfScore).toBeCloseTo(1 / 61);
  });
});

describe('detectLanguage', () => {
  it('detects French questions', () => {
    expect(detectLanguage("Le mineur non émancipé peut-il avoir la qualité de commerçant ?")).toBe('fr');
    expect(detectLanguage("Quelles sont les mentions obligatoires des statuts d'une société ?")).toBe('fr');
  });
  it('detects English questions', () => {
    expect(detectLanguage('What is the maximum duration of a company under OHADA law?')).toBe('en');
    expect(detectLanguage('How does the AUDCG define the status of an Entreprenant?')).toBe('en');
  });
  it('falls back to French when it cannot tell', () => {
    expect(detectLanguage('RCCM SARL')).toBe('fr');
  });
});

// ─── Integration tests: real Postgres + pgvector (CI sets RUN_DB_TESTS=1) ───

const DIMS = 1536;
/** A vector pointing in exactly one direction: two different axes have similarity 0. */
const axis = (i: number) => Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0));

describe.skipIf(!process.env.RUN_DB_TESTS)('search against Postgres', () => {
  let docId = '';

  beforeAll(async () => {
    const [doc] = await db
      .insert(documents)
      .values({ title: 'Search test fixture', language: 'fr', pageCount: 1 })
      .returning({ id: documents.id });
    docId = doc.id;

    await db.insert(chunks).values([
      {
        documentId: docId, articleRef: '7', part: 0, pageStart: 1, pageEnd: 1, lang: 'fr',
        content: "Art.7.- Le mineur, sauf s'il est émancipé, ne peut avoir la qualité de commerçant.",
        embedding: axis(0), embeddingModel: 'test-model',
      },
      {
        documentId: docId, articleRef: '16', part: 0, pageStart: 1, pageEnd: 1, lang: 'fr',
        content: 'Art.16.- Les obligations nées à l’occasion de leur commerce entre commerçants se prescrivent par cinq ans.',
        embedding: axis(1), embeddingModel: 'test-model',
      },
      {
        documentId: docId, articleRef: '28', part: 0, pageStart: 1, pageEnd: 1, lang: 'en',
        content: 'ARTICLE 28\nThe duration of the company may not exceed ninety-nine years.',
        embedding: axis(2), embeddingModel: 'test-model',
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(chunks).where(eq(chunks.documentId, docId));
    await db.delete(documents).where(eq(documents.id, docId));
    await sql.end();
  });

  it('vector search returns the chunk whose vector matches the question first', async () => {
    vi.mocked(embedQuery).mockResolvedValueOnce(axis(1));
    const results = await searchByVector('prescription', 3);
    expect(results[0].articleRef).toBe('16');
    expect(results[0].similarity).toBeCloseTo(1);
  });

  it('keyword search uses French stemming ("commerçants" finds "commerçant")', async () => {
    const results = await searchByKeywords('mineur commerçants');
    expect(results[0].articleRef).toBe('7');
  });

  it('keyword search matches any word, not all of them', async () => {
    const results = await searchByKeywords('Quelle est la durée de prescription entre commerçants ?');
    expect(results.map((r) => r.articleRef)).toContain('16');
  });

  it('keyword search uses English stemming for English chunks', async () => {
    const results = await searchByKeywords('company durations');
    expect(results.map((r) => r.articleRef)).toEqual(['28']);
  });

  it('keyword search can be limited to one language', async () => {
    const results = await searchByKeywords('company durations', 20, 'fr');
    expect(results).toEqual([]);
  });

  it('keyword search returns nothing for unrelated words', async () => {
    expect(await searchByKeywords('photosynthèse chlorophylle')).toEqual([]);
  });

  it('hybrid search ranks first the chunk found by both searches', async () => {
    vi.mocked(embedQuery).mockResolvedValueOnce(axis(0));
    const { results, topSimilarity } = await hybridSearch('mineur émancipé', 3);
    expect(results[0].articleRef).toBe('7');
    expect(topSimilarity).toBeCloseTo(1);
  });
});