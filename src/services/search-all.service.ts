import type { z } from 'zod';
import type { searchItemSchema } from '../utils/schemas';
import { embedQuery } from './embeddings.service';
import { dedupeByArticle, searchByEmbedding } from './search.service';
import { rankDecisions } from './decision-search.service';

// GET /api/search: statute articles and published decisions in one list, for a single search box.

export type SearchItem = z.input<typeof searchItemSchema>;
type ArticleItem = Extract<SearchItem, { type: 'article' }>;
type DecisionItem = Extract<SearchItem, { type: 'decision' }>;
/** pinned: q contains the decision's case number */
export type RankedDecision = { item: DecisionItem; pinned: boolean };

const SNIPPET_CHARS = 300;
/** A long article has several chunks: fetch more than `limit` so that, once grouped per article, `limit` remain. */
const CHUNKS_PER_ARTICLE = 3;

/**
 * Merges the two lists by raw cosine similarity. Both scores come from the same model and the same query vector, so
 * they are comparable. Not RRF: on two lists with no item in common, RRF only looks at positions and reduces to strict
 * alternation (article, decision, article…), however weak the fifth decision is. A decision whose case number is in q
 * comes first, as in GET /api/decisions.
 * Pure, so the ordering rule is unit-tested without a database.
 */
export function mergeBySimilarity(articles: ArticleItem[], decisions: RankedDecision[], limit: number): SearchItem[] {
  const pinned = decisions.filter((d) => d.pinned).map((d) => d.item);
  const rest: SearchItem[] = [...articles, ...decisions.filter((d) => !d.pinned).map((d) => d.item)];
  return [...pinned, ...rest.sort((a, b) => b.similarity - a.similarity)].slice(0, limit);
}

/** One embedding call for both searches. */
export async function searchAll(q: string, limit: number): Promise<SearchItem[]> {
  const embedding = await embedQuery(q);
  const [chunkHits, decisionPage] = await Promise.all([
    searchByEmbedding(embedding, limit * CHUNKS_PER_ARTICLE, { kinds: ['statute'] }),
    rankDecisions(embedding, q, {}, 1, limit),
  ]);

  const articles: ArticleItem[] = dedupeByArticle(chunkHits).map((h) => ({
    type: 'article',
    similarity: h.similarity ?? 0,
    documentId: h.documentId,
    documentTitle: h.documentTitle,
    articleRef: h.articleRef,
    pageStart: h.pageStart,
    snippet: h.content.slice(0, SNIPPET_CHARS),
  }));

  // A published decision always has embedded chunks (publish waits for them), so match is set; skip one that isn't
  const decisions = decisionPage.items.flatMap(({ match, ...d }): RankedDecision[] => match ? [{
    item: { type: 'decision', similarity: match.similarity, ...d, section: match.section, snippet: match.snippet },
    pinned: match.caseNumber,
  }] : []);

  return mergeBySimilarity(articles, decisions, limit);
}
