import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { db, sql } from '../../src/db/client';
import { apiKeys, chunks, decisionCitations, decisions, documents } from '../../src/db/schema';
import { buildApp } from '../../src/app';
import { createApiKey } from '../../src/services/api-keys.service';
import {
  loadArticleIndex, regradeCitations, replaceDetectedCitations,
} from '../../src/services/citations/citations.service';
import { articleKey, versionKey } from '../../src/services/citations/grading';

// The article page and citation storage against real Postgres. Nothing here calls a provider: the LLM and the
// embeddings are mocked, and the page never asks the LLM anything.
vi.mock('../../src/services/llm.service', () => ({ generateObjectWithFallback: vi.fn() }));
vi.mock('../../src/services/embeddings.service', () => ({
  embedQuery: vi.fn(), embedDocuments: vi.fn(), EMBEDDING_MODEL: 'test-model', DIMENSIONS: 1536,
}));
vi.mock('../../src/jobs/queue', () => ({
  enqueueExtraction: vi.fn(), enqueueAnonymisation: vi.fn(), enqueueEmbedding: vi.fn(), enqueueCitationLinking: vi.fn(),
}));

// An act version no real database of this project holds in English, so the UNIQUE (act, version, language) can't clash
const ACT = { actCode: 'AUDCG' as const, actVersion: '1997' };

describe('GET /api/articles/:documentId/:articleRef (no database needed)', () => {
  const app = buildApp();
  afterAll(() => app.close());

  it.each([['abc'], ['7%20foo'], ['-1']])('422 for an article ref that is not one (%s)', async (ref) => {
    const res = await app.inject({ method: 'GET', url: `/api/articles/0b6c4a8e-1f2d-4c3b-9a8e-7d6c5b4a3f2e/${ref}` });
    expect(res.statusCode).toBe(422);
  });

  it('422 for a document id that is not a uuid', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/articles/abc/7' })).statusCode).toBe(422);
  });
});

describe.skipIf(!process.env.RUN_DB_TESTS)('article page and citations against Postgres', () => {
  let app: FastifyInstance;
  let contributorId = '';
  let reviewerId = '';
  let statuteId = '';
  const documentIds: string[] = [];
  const decisionOf: Record<string, string> = {};

  async function decision(label: string, status: 'draft' | 'in_review' | 'published' | 'rejected', decisionDate: string,
    cites: { articleRef: string; confidence: 'high' | 'medium' | 'low'; rawText: string }[]) {
    const [doc] = await db.insert(documents)
      .values({ kind: 'decision', title: `CCJA, arrêt de test ${label}`, language: 'fr' }).returning({ id: documents.id });
    documentIds.push(doc.id);
    const published = status === 'published';
    const [row] = await db.insert(decisions).values({
      documentId: doc.id, court: 'CCJA', decisionDate, status, sourceName: 'test', contributedBy: contributorId,
      headnote: `Chapeau ${label}`, outcome: 'rejet',
      anonymisationStatus: published ? 'done' : 'pending',
      reviewedBy: published ? reviewerId : null,
      publishedAt: published ? new Date() : null,
    }).returning({ id: decisions.id });
    decisionOf[label] = row.id;
    if (cites.length) {
      await db.insert(decisionCitations).values(cites.map((c) => ({
        decisionId: row.id, ...ACT, articleRef: c.articleRef, rawText: c.rawText,
        actSource: 'explicit' as const, method: 'rule' as const, confidence: c.confidence,
      })));
    }
    return row.id;
  }

  beforeAll(async () => {
    app = buildApp();
    contributorId = (await createApiKey('contributor', 'test-articles-contributor')).id;
    reviewerId = (await createApiKey('reviewer', 'test-articles-reviewer')).id;

    const [statute] = await db.insert(documents)
      .values({ kind: 'statute', title: 'Uniform Act on General Commercial Law (test)', language: 'en', pageCount: 3, ...ACT })
      .returning({ id: documents.id });
    statuteId = statute.id;
    documentIds.push(statuteId);
    await db.insert(chunks).values([
      { documentId: statuteId, articleRef: '7', part: 0, pageStart: 2, pageEnd: 2, lang: 'en', content: 'Article 7, first part.', sectionPath: 'Book 1 > Title 2' },
      { documentId: statuteId, articleRef: '7', part: 1, pageStart: 2, pageEnd: 3, lang: 'en', content: 'Article 7, second part.', sectionPath: 'Book 1 > Title 2' },
      { documentId: statuteId, articleRef: '8', part: 0, pageStart: 3, pageEnd: 3, lang: 'en', content: 'Article 8.' },
      { documentId: statuteId, articleRef: '12 bis', part: 0, pageStart: 3, pageEnd: 3, lang: 'en', content: 'Article 12 bis.' },
    ]);

    await decision('2019', 'published', '2019-02-28', [
      { articleRef: '7', confidence: 'high', rawText: "l'article 7 de l'AUDCG" },
      { articleRef: '7', confidence: 'high', rawText: "l'article 7 susvisé" },
    ]);
    await decision('2021', 'published', '2021-05-10', [{ articleRef: '7', confidence: 'medium', rawText: "l'article 7" }]);
    await decision('low-only', 'published', '2022-01-01', [{ articleRef: '7', confidence: 'low', rawText: "l'article 7" }]);
    await decision('other-article', 'published', '2023-01-01', [{ articleRef: '8', confidence: 'high', rawText: "l'article 8 de l'AUDCG" }]);
    for (const status of ['draft', 'in_review', 'rejected'] as const) {
      await decision(status, status, '2024-01-01', [{ articleRef: '7', confidence: 'high', rawText: "l'article 7 de l'AUDCG" }]);
    }
  });

  afterAll(async () => {
    await app?.close();
    if (documentIds.length) await db.delete(documents).where(inArray(documents.id, documentIds)); // cascades
    await db.delete(apiKeys).where(inArray(apiKeys.id, [contributorId, reviewerId].filter(Boolean)));
    await sql.end();
  });

  const page = (ref: string, documentId = statuteId) => app.inject({ method: 'GET', url: `/api/articles/${documentId}/${ref}` });

  it('returns every part of the article and the published decisions citing it, newest first', async () => {
    const res = await page('7');
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.article).toMatchObject({
      articleRef: '7', pageStart: 2, pageEnd: 3, text: 'Article 7, first part.\n\nArticle 7, second part.',
    });
    expect(data.article.parts.map((p: { part: number }) => p.part)).toEqual([0, 1]);
    expect(data.decisions.map((d: { id: string }) => d.id)).toEqual([decisionOf['2021'], decisionOf['2019']]);
    expect(data.decisions[1]).toMatchObject({
      court: 'CCJA', decisionDate: '2019-02-28', headnote: 'Chapeau 2019', confidence: 'high',
      citedAs: ["l'article 7 de l'AUDCG", "l'article 7 susvisé"],
    });
    expect(data.decisions[0].confidence).toBe('medium');
  });

  it('never shows an unpublished decision, nor a low-confidence link', async () => {
    const ids = (await page('7')).json().data.decisions.map((d: { id: string }) => d.id);
    for (const hidden of ['draft', 'in_review', 'rejected', 'low-only', 'other-article']) {
      expect(ids).not.toContain(decisionOf[hidden]);
    }
  });

  it('normalises the article ref: 12BIS is "12 bis"', async () => {
    const res = await page('12BIS');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.article.articleRef).toBe('12 bis');
  });

  it('404 for an article the statute does not have, and for a decision\'s document id', async () => {
    expect((await page('705')).statusCode).toBe(404);
    const [d] = await db.select({ documentId: decisions.documentId }).from(decisions).where(eq(decisions.id, decisionOf['2019']));
    expect((await page('7', d.documentId)).statusCode).toBe(404);
  });

  it('loads which act versions and articles the statutes hold', async () => {
    const index = await loadArticleIndex(['AUDCG']);
    expect(index.versions.has(versionKey('AUDCG', '1997'))).toBe(true);
    expect(index.articles.has(articleKey('AUDCG', '1997', '12 bis'))).toBe(true);
    expect(index.articles.has(articleKey('AUDCG', '1997', '705'))).toBe(false);
  });

  it('replaces the job\'s rows on a rerun but keeps a reviewer\'s, then grades again with the final date', async () => {
    const id = await decision('rerun', 'in_review', '2008-06-12', []);
    await db.insert(decisionCitations).values({
      decisionId: id, ...ACT, articleRef: '8', rawText: 'added by hand', method: 'reviewer', confidence: 'high',
    });
    // The job ran before the date was known: version_unknown
    const fromJob = {
      actCode: 'AUDCG' as const, actVersion: null, articleRef: '7', rawText: "l'article 7 de l'AUDCG",
      actSource: 'explicit' as const, method: 'rule' as const, confidence: 'low' as const, reason: 'version_unknown' as const,
    };
    expect(await replaceDetectedCitations(id, [fromJob])).toBe(true);
    expect(await replaceDetectedCitations(id, [fromJob])).toBe(true); // a second run of the same job

    const rows = () => db.select().from(decisionCitations).where(eq(decisionCitations.decisionId, id));
    expect((await rows()).map((r) => r.method).sort()).toEqual(['reviewer', 'rule']);

    await db.transaction((tx) => regradeCitations(tx, id, '2008-06-12'));
    const rule = (await rows()).find((r) => r.method === 'rule')!;
    expect(rule).toMatchObject({ actVersion: '1997', confidence: 'high', reason: null });
  });
});
