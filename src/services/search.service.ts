import { cosineDistance, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { embedQuery } from './embeddings.service';
import { chunks, documents } from '../db/schema';
import { db } from '../db/client';
import type { SearchResult } from '../interfaces/documents';

export type Lang = 'fr' | 'en';

// ─── Pure helpers (unit-tested, no database) ─────────────────────────────────

const FR_WORDS = new Set([
  'le', 'la', 'les', 'des', 'du', 'de', 'est', 'une', 'un', 'et', 'en', 'que', 'qui', 'quel', 'quelle',
  'quels', 'quelles', 'dans', 'pour', 'au', 'aux', 'sur', 'par', 'ne', 'pas', 'peut', 'sont', 'selon',
  'qu', 'd', 'l', 's', 'ou', 'son', 'sa', 'ses', 'cette', 'ce', 'lorsque', 'doit',
]);
const EN_WORDS = new Set([
  'the', 'of', 'is', 'are', 'what', 'which', 'who', 'how', 'under', 'an', 'and', 'for', 'does', 'do',
  'can', 'to', 'in', 'on', 'by', 'with', 'be', 'shall', 'may', 'its', 'their', 'this', 'that', 'when', 'must',
]);

/** Cheap language guess for a question: counts common French vs English words. */
export function detectLanguage(text: string): Lang {
  let fr = 0, en = 0;
  for (const w of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (FR_WORDS.has(w)) fr++;
    if (EN_WORDS.has(w)) en++;
  }
  return en > fr ? 'en' : 'fr';
}

/**
 * Weighted Reciprocal Rank Fusion: score = Σ weight_i / (k + rank_i).
 * Only positions matter, never raw scores. Ties keep first-seen order (stable sort).
 */
export function rrf<T extends { id: string }>(
  lists: T[][],
  { k = 60, weights }: { k?: number; weights?: number[] } = {},
): (T & { rrfScore: number })[] {
  const scores = new Map<string, { item: T; score: number }>();
  lists.forEach((list, li) => {
    const w = weights?.[li] ?? 1;
    list.forEach((item, rank) => {
      const entry = scores.get(item.id) ?? { item, score: 0 };
      entry.score += w / (k + rank + 1);
      scores.set(item.id, entry);
    });
  });
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({ ...item, rrfScore: score }));
}

// ─── Queries ─────────────────────────────────────────────────────────────────

const CONFIG: Record<Lang, string> = { fr: 'french', en: 'english' };

// OR the words together: plainto_tsquery ANDs every word, so a full question matches nothing.
const MAX_DF = 0.1; // drop words found in more than 10% of chunks; tune with the eval

const tsq = (lang: Lang, q: string): SQL => sql`(
  SELECT coalesce(string_agg(quote_literal(u.lexeme), ' | '), '')::tsquery
  FROM unnest(to_tsvector(${sql.raw(`'${CONFIG[lang]}'`)}, ${q})) AS u
  WHERE u.lexeme NOT IN (
    SELECT word FROM lexeme_stats
    WHERE ndoc > (SELECT count(*)::float8 * ${MAX_DF}::float8 FROM chunks)
  )
)`;

export async function searchByVector(question: string, k = 8): Promise<SearchResult[]> {
  const q = await embedQuery(question);
  const distance = cosineDistance(chunks.embedding, q);

  return db
    .select({
      id: chunks.id,
      articleRef: chunks.articleRef,
      pageStart: chunks.pageStart,
      content: chunks.content,
      similarity: sql<number>`1 - (${distance})`,
      documentTitle: documents.title,
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(isNotNull(chunks.embedding))
    .orderBy(distance) // ascending DISTANCE, so Postgres can use the HNSW index
    .limit(k);
}

/**
 * Full-text search. With `lang`, only chunks written in that language are searched:
 * French words in a question cannot meaningfully match an English text, and vice versa.
 */
export async function searchByKeywords(question: string, k = 20, lang?: Lang): Promise<SearchResult[]> {
  const langs: Lang[] = lang ? [lang] : ['fr', 'en'];
  const match = sql.join(
    langs.map((l) => sql`(${chunks.lang} = ${l} AND ${chunks.contentTsv} @@ ${tsq(l, question)})`),
    sql` OR `,
  );
  // normalization 1: divide by 1 + log(length), so long articles don't win just by being long
  const rank = sql<number>`ts_rank_cd(${chunks.contentTsv},
    CASE WHEN ${chunks.lang} = 'en' THEN ${tsq('en', question)} ELSE ${tsq('fr', question)} END, 1)`;

  return db
    .select({
      id: chunks.id,
      articleRef: chunks.articleRef,
      pageStart: chunks.pageStart,
      content: chunks.content,
      documentTitle: documents.title,
      rank,
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(match)
    .orderBy(sql`${rank} DESC`)
    .limit(k);
}

export type HybridOptions = {
  keywordWeight?: number; // 1 = equal to vector; lower = keyword list counts less
  sameLanguageOnly?: boolean; // experiment: keyword search only in the question's language
};

export async function hybridSearch(
  question: string,
  k = 8,
  { keywordWeight = 0.5, sameLanguageOnly = false }: HybridOptions = {},
) {
  const lang = detectLanguage(question);
  const [vector, keyword] = await Promise.all([
    searchByVector(question, 20),
    searchByKeywords(question, 20, sameLanguageOnly ? lang : undefined),
  ]);
  return {
    results: dedupeByArticle(rrf([vector, keyword], { weights: [1, keywordWeight] })).slice(0, k),
    topSimilarity: vector[0]?.similarity ?? 0, // raw cosine of the best vector match: used for found:false
    lang,
  };
}

/** Keeps the best-ranked chunk of each article, so long articles don't fill the list. */
export function dedupeByArticle<T extends { articleRef: string; documentTitle: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((r) => {
    const key = `${r.documentTitle}::${r.articleRef}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}