import { cosineDistance, eq, isNotNull, sql, type SQL, and, asc, or, inArray } from 'drizzle-orm';
import { embedQuery } from './embeddings.service';
import { chunks, decisions, documents } from '../db/schema';
import { db } from '../db/client';
import type { DocumentKind, Lang, SearchResult } from '../interfaces/types';

// ─── What may be searched ────────────────────────────────────────────────────

/**
 * Which kinds of document a search covers. It can only NARROW what is searchable, never widen it:
 * a draft, in-review or rejected decision is excluded whatever the caller passes.
 * Default: statutes only, so every v1 caller (/ask, the eval scripts) behaves exactly as before.
 */
export type SearchScope = { kinds?: DocumentKind[] };
const STATUTES_ONLY: DocumentKind[] = ['statute'];

/**
 * The one definition of "searchable": a statute, or a decision a reviewer has published.
 * Every query that reads chunks or documents for the public goes through it, inside the SQL:
 * filtering after the search would still let a draft take a top-5 place and set topSimilarity (layer 1).
 * The lexeme_stats view repeats it (drizzle/0012_lexeme_stats_searchable.sql): change both together.
 */
export const searchableDocuments = (kinds: DocumentKind[] = STATUTES_ONLY): SQL => sql`(${inArray(documents.kind, kinds)}
  AND (${documents.kind} = 'statute' OR EXISTS (
    SELECT 1 FROM ${decisions} WHERE ${decisions.documentId} = ${documents.id} AND ${decisions.status} = 'published')))`;

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
    WHERE ndoc > (
      SELECT count(*)::float8 * ${MAX_DF}::float8 FROM ${chunks}
      INNER JOIN ${documents} ON ${chunks.documentId} = ${documents.id}
      WHERE ${searchableDocuments(['statute', 'decision'])}
    )
  )
)`;

export async function searchByVector(question: string, k = 8, scope: SearchScope = {}): Promise<SearchResult[]> {
  return searchByEmbedding(await embedQuery(question), k, scope);
}

/**
 * The k chunks nearest to an embedding, within the scope. Takes the vector so a caller that runs several searches
 * for one question (GET /api/search) pays for one embedding call.
 *
 * Filtered HNSW: the index returns its ef_search (40) nearest candidates, THEN Postgres applies the WHERE. When every
 * one of those 40 is filtered out (a decisions-only search whose nearest chunks are all statute articles), the result
 * is EMPTY, not just short. Measured on the two Acts: a filter to Livre 8 (69 of 1,226 chunks) with a query about share
 * transfers returned 0 rows, and still 0 with ef_search = 200. pgvector >= 0.8's iterative scan keeps reading the
 * graph until k rows pass the filter. relaxed_order may return them slightly out of distance order, so they are
 * sorted again here. SET LOCAL needs the transaction: a plain SET would stay on the pooled connection.
 */
export async function searchByEmbedding(q: number[], k = 8, { kinds }: SearchScope = {}): Promise<SearchResult[]> {
  const distance = cosineDistance(chunks.embedding, q);

  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    return tx
      .select({
        id: chunks.id,
        articleRef: chunks.articleRef,
        pageStart: chunks.pageStart,
        content: chunks.content,
        similarity: sql<number>`1 - (${distance})`,
        documentTitle: documents.title,
        documentId: documents.id,
      })
      .from(chunks)
      .innerJoin(documents, eq(chunks.documentId, documents.id))
      .where(and(isNotNull(chunks.embedding), searchableDocuments(kinds)))
      .orderBy(distance) // ascending DISTANCE, so Postgres can use the HNSW index
      .limit(k);
  });
  return rows.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Full-text search. With `lang`, only chunks written in that language are searched:
 * French words in a question cannot meaningfully match an English text, and vice versa.
 */
export async function searchByKeywords(
  question: string, k = 20, lang?: Lang, { kinds }: SearchScope = {},
): Promise<SearchResult[]> {
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
      documentId: documents.id,
      rank,
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(and(sql`(${match})`, searchableDocuments(kinds)))
    .orderBy(sql`${rank} DESC`)
    .limit(k);
}

export type HybridOptions = {
  keywordWeight?: number; // 1 = equal to vector; lower = keyword list counts less
  sameLanguageOnly?: boolean; // experiment: keyword search only in the question's language
} & SearchScope;

export async function hybridSearch(
  question: string,
  k = 8,
  { keywordWeight = 0.5, sameLanguageOnly = false, kinds }: HybridOptions = {},
) {
  const lang = detectLanguage(question);
  const [vector, keyword] = await Promise.all([
    searchByVector(question, 20, { kinds }),
    searchByKeywords(question, 20, sameLanguageOnly ? lang : undefined, { kinds }),
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

/** Same scope rule as the searches: a caller that guesses a draft's document id still gets nothing. */
export async function getArticleParts(keys: { documentId: string; articleRef: string }[], { kinds }: SearchScope = {}) {
  if (keys.length === 0) return [];
  return db
    .select({
      documentId: chunks.documentId, articleRef: chunks.articleRef, part: chunks.part,
      pageStart: chunks.pageStart, pageEnd: chunks.pageEnd,
      sectionPath: chunks.sectionPath, content: chunks.content,
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(and(
      searchableDocuments(kinds),
      or(...keys.map((k) => and(eq(chunks.documentId, k.documentId), eq(chunks.articleRef, k.articleRef)))),
    ))
    .orderBy(asc(chunks.documentId), asc(chunks.articleRef), asc(chunks.part));
}