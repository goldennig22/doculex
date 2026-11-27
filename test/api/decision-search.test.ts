import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import { db, sql } from '../../src/db/client';
import { apiKeys, chunks, decisionCitations, decisions, documents } from '../../src/db/schema';
import { buildApp } from '../../src/app';
import { createApiKey } from '../../src/services/api-keys.service';
import { embedQuery } from '../../src/services/embeddings.service';
import { searchByEmbedding } from '../../src/services/search.service';
import { caseNumberPattern, sectionLabel, totalPages } from '../../src/services/decision-search.service';
import { mergeBySimilarity, type RankedDecision } from '../../src/services/search-all.service';

// Search over published decisions against real Postgres. The embedding provider is mocked: embedQuery returns the
// unit vector on axis Q, and each fixture chunk is cos(θ)·Q + sin(θ)·B, so its similarity to q is exactly cos(θ).
vi.mock('../../src/services/embeddings.service', () => ({
  embedQuery: vi.fn(), embedDocuments: vi.fn(), EMBEDDING_MODEL: 'test-model', DIMENSIONS: 1536,
}));
vi.mock('../../src/jobs/queue', () => ({
  enqueueExtraction: vi.fn(), enqueueAnonymisation: vi.fn(), enqueueEmbedding: vi.fn(), enqueueCitationLinking: vi.fn(),
}));

const DIMS = 1536;
const Q = 950;  // axes no other suite uses: the test files share one database and run in parallel
const B = 951;
/** A unit vector whose cosine similarity to axis Q is exactly `similarity`. */
const towardQ = (similarity: number) => Array.from({ length: DIMS }, (_, j) =>
  j === Q ? similarity : j === B ? Math.sqrt(1 - similarity ** 2) : 0);

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('caseNumberPattern', () => {
  const matches = (q: string, stored: string) => {
    const p = caseNumberPattern(q);
    return p !== null && new RegExp(p).test(stored);
  };

  it.each([
    ['arrêt n° 45/2019', 'Arrêt N° 045/2019'],
    ['045/2019', 'Arrêt n° 45/2019'],
    ['Arrêt n°045 / 2019 du 28 février', 'Arrêt n° 045/2019'],
    ['210/2019', 'Arrêt n° 210/2019/PC'],
  ])('%s finds %s', (q, stored) => expect(matches(q, stored)).toBe(true));

  it.each([
    ['45/2019', 'Arrêt n° 145/2019'],   // another number that ends the same
    ['45/2019', 'Arrêt n° 45/2018'],
    ['14/2019', 'Arrêt n° 145/2019'],
  ])('%s does not find %s', (q, stored) => expect(matches(q, stored)).toBe(false));

  it('is null for a question with no case number', () => {
    expect(caseNumberPattern('résiliation du bail commercial')).toBeNull();
    expect(caseNumberPattern('article 7')).toBeNull();
    expect(caseNumberPattern('1/2 du capital')).toBeNull(); // a fraction, not a year
  });
});

describe('pagination and labels', () => {
  it.each([[0, 20, 0], [7, 3, 3], [6, 3, 2], [1, 50, 1]])('total %i by %i is %i pages', (total, limit, pages) =>
    expect(totalPages(total, limit)).toBe(pages));

  it('labels later parts of a section like the review view', () => {
    expect(sectionLabel('moyen-1', 0)).toBe('moyen-1');
    expect(sectionLabel('moyen-1', 1)).toBe('moyen-1 (part 2)');
  });
});

describe('mergeBySimilarity', () => {
  const article = (ref: string, similarity: number) => ({
    type: 'article' as const, similarity, documentId: '00000000-0000-4000-8000-000000000001', documentTitle: 'AUDCG',
    articleRef: ref, pageStart: 1, snippet: '',
  });
  const decision = (id: string, similarity: number, pinned = false): RankedDecision => ({
    item: {
      type: 'decision', similarity, id, documentId: id, title: id, language: 'fr', court: 'CCJA', country: null,
      chamber: null, caseNumber: null, decisionDate: '2019-01-01', subject: null, outcome: null, headnote: null,
      section: 'faits', snippet: '',
    },
    pinned,
  });
  const order = (items: ReturnType<typeof mergeBySimilarity>) =>
    items.map((i) => (i.type === 'article' ? `a${i.articleRef}` : i.id));

  it('orders both types by similarity, not by alternation', () => {
    expect(order(mergeBySimilarity([article('7', 0.9), article('8', 0.85)], [decision('d1', 0.5)], 10)))
      .toEqual(['a7', 'a8', 'd1']);
  });

  it('puts a decision whose case number is in q first, then cuts at the limit', () => {
    expect(order(mergeBySimilarity([article('7', 0.9)], [decision('d1', 0.8), decision('d2', 0.2, true)], 2)))
      .toEqual(['d2', 'a7']);
  });
});

// ─── HTTP, no database ───────────────────────────────────────────────────────

describe('GET /api/decisions validation (no database needed)', () => {
  const app = buildApp();
  afterAll(() => app.close());

  it.each([
    ['article without act', 'article=7', 'act'],
    ['version without act', 'version=1997', 'act'],
    ['limit above 50', 'limit=51', 'limit'],
    ['page 0', 'page=0', 'page'],
    ['a country that is not a code', 'country=Cameroun', 'country'],
    ['an unknown outcome', 'outcome=gagne', 'outcome'],
    ['an article that is not one', 'act=AUDCG&article=abc', 'article'],
  ])('422 for %s', async (_, query, field) => {
    const res = await app.inject({ method: 'GET', url: `/api/decisions?${query}` });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors).toHaveProperty(field);
  });

  it('422 for /api/search without q', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/search' })).statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/api/search?q=%20' })).statusCode).toBe(422);
  });
});

// ─── Against Postgres ────────────────────────────────────────────────────────

type Fixture = {
  court: string; country: string | null; date: string;
  outcome: 'cassation' | 'rejet' | 'irrecevabilite' | 'autre'; subject: string | null; caseNumber: string | null;
  /** Similarity of the best chunk to q; the other chunk is far */
  best: number; bestSection: 'faits' | 'moyen-1';
  cites?: { articleRef: string; confidence: 'high' | 'medium' | 'low' }[];
};

const ALPHA = 'Cour de test Alpha';
const BETA = 'Cour de test Beta';
const GAMMA = 'Cour de test Gamma';

// Seven published decisions. 1983-01-01, 1983-12-31 and 1984-01-01 are the year filter's boundaries.
const PUBLISHED: Record<string, Fixture> = {
  A1: { court: ALPHA, country: null, date: '1983-01-01', outcome: 'rejet', subject: 'Nantissement du fonds de commerce',
    caseNumber: 'Arrêt n° 045/1983', best: 0.9, bestSection: 'moyen-1', cites: [{ articleRef: '153', confidence: 'high' }] },
  A2: { court: ALPHA, country: null, date: '1983-12-31', outcome: 'cassation', subject: 'Saisie-attribution des créances',
    caseNumber: 'Arrêt n° 210/1983', best: 0.8, bestSection: 'faits', cites: [{ articleRef: '154', confidence: 'high' }] },
  A3: { court: ALPHA, country: null, date: '1984-01-01', outcome: 'cassation', subject: 'Injonction de payer',
    caseNumber: 'Arrêt n° 001/1984', best: 0.7, bestSection: 'moyen-1', cites: [{ articleRef: '153', confidence: 'medium' }] },
  B1: { court: BETA, country: 'ZZ', date: '1983-06-15', outcome: 'irrecevabilite', subject: 'Nantissement des créances',
    caseNumber: 'Arrêt n° 12/1983', best: 0.6, bestSection: 'faits', cites: [{ articleRef: '153', confidence: 'low' }] },
  B2: { court: BETA, country: 'ZZ', date: '1984-03-10', outcome: 'cassation', subject: null,
    caseNumber: null, best: 0.5, bestSection: 'faits' },
  G1: { court: GAMMA, country: 'ZY', date: '1984-07-07', outcome: 'rejet', subject: 'Saisie conservatoire',
    caseNumber: 'Arrêt n° 77/1984', best: 0.4, bestSection: 'moyen-1' },
  G2: { court: GAMMA, country: 'ZY', date: '1984-11-05', outcome: 'autre', subject: null,
    caseNumber: null, best: 0.3, bestSection: 'faits' },
};

// Each unpublished one matches every filter A1 matches, carries A1's case number and is the CLOSEST to q (1.0):
// if one ever appears, the leak is in the SQL, not an accident of ranking.
const UNPUBLISHED = ['draft', 'in_review', 'rejected'] as const;
const unpublishedFixture: Fixture = { ...PUBLISHED.A1, date: '1983-05-05', best: 1 };

describe.skipIf(!process.env.RUN_DB_TESTS)('decision search against Postgres', () => {
  let app: FastifyInstance;
  let contributorId = '';
  let reviewerId = '';
  const documentIds: string[] = [];
  const id: Record<string, string> = {};        // fixture label → decision id
  const label: Record<string, string> = {};     // decision id → fixture label
  let unpublishedIds: string[] = [];

  async function insertDecision(name: string, f: Fixture, status: 'published' | typeof UNPUBLISHED[number]) {
    const published = status === 'published';
    const [doc] = await db.insert(documents)
      .values({ kind: 'decision', title: `${f.court}, arrêt de test ${name}`, language: 'fr' })
      .returning({ id: documents.id });
    documentIds.push(doc.id);
    const [row] = await db.insert(decisions).values({
      documentId: doc.id, court: f.court, country: f.country, decisionDate: f.date, outcome: f.outcome,
      subject: f.subject, caseNumber: f.caseNumber, headnote: `Chapeau ${name}`, status,
      sourceName: 'test', contributedBy: contributorId, anonymisationStatus: published ? 'done' : 'pending',
      reviewedBy: published ? reviewerId : null, publishedAt: published ? new Date() : null,
    }).returning({ id: decisions.id });
    const other = f.bestSection === 'faits' ? 'moyen-1' : 'faits';
    await db.insert(chunks).values([
      { documentId: doc.id, articleRef: f.bestSection, part: 0, pageStart: 1, pageEnd: 1, lang: 'fr',
        content: `Section ${f.bestSection} de ${name}`, embedding: towardQ(f.best) },
      { documentId: doc.id, articleRef: other, part: 0, pageStart: 1, pageEnd: 1, lang: 'fr',
        content: `Section ${other} de ${name}`, embedding: towardQ(0.05) },
    ]);
    if (f.cites?.length) {
      await db.insert(decisionCitations).values(f.cites.map((c) => ({
        decisionId: row.id, actCode: 'AUPSRVE' as const, actVersion: '1998', articleRef: c.articleRef,
        rawText: `l'article ${c.articleRef} de l'AUPSRVE`, actSource: 'explicit' as const, method: 'rule' as const,
        confidence: c.confidence,
      })));
    }
    id[name] = row.id;
    label[row.id] = name;
    return row.id;
  }

  beforeAll(async () => {
    app = buildApp();
    contributorId = (await createApiKey('contributor', 'test-search-contributor')).id;
    reviewerId = (await createApiKey('reviewer', 'test-search-reviewer')).id;
    for (const [name, f] of Object.entries(PUBLISHED)) await insertDecision(name, f, 'published');
    unpublishedIds = await Promise.all(UNPUBLISHED.map((s) => insertDecision(s, unpublishedFixture, s)));
    vi.mocked(embedQuery).mockResolvedValue(towardQ(1));
  });

  afterAll(async () => {
    await app?.close();
    if (documentIds.length) await db.delete(documents).where(inArray(documents.id, documentIds)); // cascades
    await db.delete(apiKeys).where(inArray(apiKeys.id, [contributorId, reviewerId].filter(Boolean)));
    await sql.end();
  });

  async function search(query: string) {
    const res = await app.inject({ method: 'GET', url: `/api/decisions?${query}` });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as {
      items: { id: string; match: { similarity: number; section: string; caseNumber: boolean } | null }[];
      page: number; limit: number; total: number; totalPages: number;
    };
    for (const item of data.items) expect(unpublishedIds, `${query} returned an unpublished decision`).not.toContain(item.id);
    return { ...data, labels: data.items.map((i) => label[i.id] ?? `other:${i.id}`) };
  }

  describe('each filter', () => {
    it('court: exact value, newest first', async () => {
      expect((await search(`court=${encodeURIComponent(ALPHA)}`)).labels).toEqual(['A3', 'A2', 'A1']);
    });

    it('country: normalised to upper case', async () => {
      expect((await search('country=zz')).labels).toEqual(['B2', 'B1']);
    });

    it('year: 1 January and 31 December are in, 1 January of the next year is out', async () => {
      expect((await search('year=1983')).labels).toEqual(['A2', 'B1', 'A1']);
      expect((await search('year=1984')).labels).toEqual(['G2', 'G1', 'B2', 'A3']);
    });

    it('outcome', async () => {
      expect((await search('outcome=cassation&year=1984')).labels).toEqual(['B2', 'A3']);
      expect((await search('outcome=rejet&year=1983')).labels).toEqual(['A1']);
    });

    it('subject: words in the decision\'s language (stemmed), and a quoted phrase', async () => {
      expect((await search('subject=nantissements&year=1983')).labels).toEqual(['B1', 'A1']);
      expect((await search(`subject=${encodeURIComponent('"saisie-attribution"')}`)).labels).toEqual(['A2']);
    });

    it('act + article: high and medium links only, never low', async () => {
      expect((await search('act=AUPSRVE&article=153')).labels).toEqual(['A3', 'A1']); // B1's link is low
      expect((await search('act=AUPSRVE&article=153&version=1998')).labels).toEqual(['A3', 'A1']);
      expect((await search('act=AUPSRVE&article=153&version=2050')).labels).toEqual([]);
      expect((await search('act=AUPSRVE&article=154')).labels).toEqual(['A2']);
    });

    it('filters combine with AND', async () => {
      expect((await search(`court=${encodeURIComponent(ALPHA)}&outcome=cassation&year=1983`)).labels).toEqual(['A2']);
    });

    it('a blank text filter is no filter (a cleared search field)', async () => {
      expect((await search(`court=${encodeURIComponent(ALPHA)}&subject=&q=`)).labels).toEqual(['A3', 'A2', 'A1']);
    });
  });

  describe('pagination', () => {
    const alpha = `court=${encodeURIComponent(ALPHA)}`;

    it('full pages, then the last partial page', async () => {
      expect(await search(`${alpha}&limit=2&page=1`)).toMatchObject({ labels: ['A3', 'A2'], total: 3, totalPages: 2, page: 1, limit: 2 });
      expect(await search(`${alpha}&limit=2&page=2`)).toMatchObject({ labels: ['A1'], total: 3, totalPages: 2 });
    });

    it('a page beyond the end is 200 with no items and the real total', async () => {
      expect(await search(`${alpha}&limit=2&page=3`)).toMatchObject({ labels: [], total: 3, totalPages: 2, page: 3 });
      expect(await search(`${alpha}&limit=2&page=999`)).toMatchObject({ labels: [], total: 3 });
    });

    it('no match at all: total 0, zero pages', async () => {
      expect(await search('country=ZX')).toMatchObject({ labels: [], total: 0, totalPages: 0 });
    });

    it('pages of a ranked search do not overlap', async () => {
      const p1 = await search('q=nantissement&year=1984&limit=2&page=1');
      const p2 = await search('q=nantissement&year=1984&limit=2&page=2');
      expect([...p1.labels, ...p2.labels]).toEqual(['A3', 'B2', 'G1', 'G2']);
    });
  });

  describe('with q', () => {
    it('ranks by the closest section of each decision, and says which one', async () => {
      const res = await search(`q=nantissement&court=${encodeURIComponent(ALPHA)}`);
      expect(res.labels).toEqual(['A1', 'A2', 'A3']);
      expect(res.items[0].match).toMatchObject({ section: 'moyen-1', caseNumber: false });
      expect(res.items[0].match?.similarity).toBeCloseTo(0.9, 5);
      expect(res.items[1].match).toMatchObject({ section: 'faits' });
      expect(res.items[1].match?.similarity).toBeCloseTo(0.8, 5);
    });

    it('q orders the decisions, it does not remove any: same total as without q', async () => {
      const without = await search('year=1983');
      const withQ = await search('year=1983&q=une%20question%20sans%20rapport');
      expect(withQ.total).toBe(without.total);
      expect(withQ.labels).toEqual(['A1', 'A2', 'B1']);
    });

    it('a case number in q comes first, whatever its padding; the unpublished copies of it never do', async () => {
      const res = await search(`q=${encodeURIComponent('arrêt 210/1983')}&court=${encodeURIComponent(ALPHA)}`);
      expect(res.labels).toEqual(['A2', 'A1', 'A3']);
      expect(res.items[0].match).toMatchObject({ caseNumber: true });
      // A1 and all three unpublished fixtures hold n° 045/1983
      expect((await search('q=45/1983&year=1983')).labels[0]).toBe('A1');
    });
  });

  describe('drafts never appear', () => {
    it('not with every filter they match, nor when they are the closest to q', async () => {
      // search() fails on any unpublished id; these are the queries each of them matches best
      await search(`court=${encodeURIComponent(ALPHA)}&year=1983&outcome=rejet&subject=nantissement&act=AUPSRVE&article=153&q=x`);
      await search('q=45/1983&limit=50');
    });

    it('not in GET /api/search', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=45/1983&limit=50' });
      expect(res.statusCode).toBe(200);
      for (const unpublished of unpublishedIds) expect(res.body).not.toContain(unpublished);
    });

    it('not in GET /api/stats', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/stats' });
      expect(res.statusCode).toBe(200);
      const stats = res.json().data;
      // 1983 holds A1, A2, B1: the three unpublished fixtures (1983-05-05, Alpha) would make it 6 and Alpha 6
      expect(stats.byYear).toEqual(expect.arrayContaining([{ year: 1983, count: 3 }, { year: 1984, count: 4 }]));
      expect(stats.byCourt).toEqual(expect.arrayContaining([
        { court: ALPHA, count: 3 }, { court: BETA, count: 2 }, { court: GAMMA, count: 2 },
      ]));
      expect(stats.byCountry).toEqual(expect.arrayContaining([{ country: 'ZZ', count: 2 }, { country: 'ZY', count: 2 }]));
      expect(stats.total).toBeGreaterThanOrEqual(7);
    });
  });

  describe('GET /api/search: articles and decisions in one list', () => {
    let statuteId = '';
    beforeAll(async () => {
      const [statute] = await db.insert(documents)
        .values({ kind: 'statute', title: 'Acte uniforme de test (recherche)', language: 'fr' })
        .returning({ id: documents.id });
      statuteId = statute.id;
      documentIds.push(statuteId);
      await db.insert(chunks).values([
        // Two parts of one article: it appears once, with its best part
        { documentId: statuteId, articleRef: '153', part: 0, pageStart: 9, pageEnd: 9, lang: 'fr', content: 'Article 153, partie 1.', embedding: towardQ(0.85) },
        { documentId: statuteId, articleRef: '153', part: 1, pageStart: 9, pageEnd: 9, lang: 'fr', content: 'Article 153, partie 2.', embedding: towardQ(0.84) },
      ]);
    });

    type Item = { type: 'article' | 'decision'; id?: string; documentId: string; articleRef?: string; similarity: number };
    const mine = (items: Item[]) => items
      .map((i) => (i.type === 'article' ? (i.documentId === statuteId ? `art.${i.articleRef}` : null) : label[i.id ?? '']))
      .filter((x): x is string => Boolean(x));

    it('merges both types by similarity, each with its type, one entry per article', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=nantissement&limit=50' });
      expect(res.statusCode, res.body).toBe(200);
      const items = res.json().data as Item[];
      expect(mine(items).slice(0, 4)).toEqual(['A1', 'art.153', 'A2', 'A3']);
      expect(items.filter((i) => i.documentId === statuteId)).toHaveLength(1);
      for (let i = 1; i < items.length; i++) expect(items[i - 1].similarity).toBeGreaterThanOrEqual(items[i].similarity);
    });

    it('a decision whose case number is in q comes before everything', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=001%2F1984&limit=50' });
      expect(mine(res.json().data)[0]).toBe('A3');
    });
  });

  it('a decisions-only vector search finds a decision even when many statute chunks are closer', async () => {
    // The filtered-HNSW trap: the 40 nearest chunks are all statutes, so without an iterative scan a decisions-only
    // search could come back empty. At this table size the planner may scan sequentially anyway; the EXPLAIN in the
    // README shows the indexed case.
    const [statute] = await db.insert(documents)
      .values({ kind: 'statute', title: 'Acte uniforme de test (HNSW)', language: 'fr' }).returning({ id: documents.id });
    documentIds.push(statute.id);
    await db.insert(chunks).values(Array.from({ length: 60 }, (_, i) => ({
      documentId: statute.id, articleRef: String(1000 + i), part: 0, pageStart: 1, pageEnd: 1, lang: 'fr',
      content: `Article ${1000 + i}.`, embedding: towardQ(0.99),
    })));
    const hits = await searchByEmbedding(towardQ(1), 5, { kinds: ['decision'] });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.documentId).not.toBe(statute.id);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].similarity!).toBeGreaterThanOrEqual(hits[i].similarity!);
  });
});
