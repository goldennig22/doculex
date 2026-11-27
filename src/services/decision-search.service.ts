import type { z } from 'zod';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { chunks, decisionCitations, decisions, documents } from '../db/schema';
import type {
  decisionHitSchema, decisionSearchPageSchema, decisionSearchQuerySchema, decisionStatsSchema,
} from '../utils/schemas';
import { embedQuery } from './embeddings.service';
import { searchableDocuments } from './search.service';

// Search over PUBLISHED decisions: filters, optional free text, pagination.
//
// Ranking with q is "filter, then exact vector": the filters select the decisions, then EVERY chunk of those decisions
// is scored and each decision keeps its closest one. No HNSW. Measured (README, "Filtered vector search"): over-fetching
// with HNSW then filtering fell to 0.28 recall with a filter matching 5% of decisions, and with any filter on decisions
// the planner chose filter-first by itself. Exact is also the only way to know each decision's best section.
// Its cost is the unfiltered case (GET /api/search, or no filter at all): every decision chunk is scored, 27 ms for
// ~1,200 chunks and linear. When `npm run decisions:bench-search` shows it above ~100 ms, rank unfiltered searches
// with HNSW + hnsw.iterative_scan instead (1.00 recall, 3.5 ms on the same data).

export type DecisionSearchQuery = z.output<typeof decisionSearchQuerySchema>;
export type DecisionFilters = Partial<Omit<DecisionSearchQuery, 'q' | 'page' | 'limit'>>;
export type DecisionHit = z.input<typeof decisionHitSchema>;
export type DecisionPage = z.input<typeof decisionSearchPageSchema>;
export type DecisionStats = z.input<typeof decisionStatsSchema>;

const SNIPPET_CHARS = 300;

// ─── Pure helpers (unit-tested, no database) ─────────────────────────────────

/**
 * A case number typed in q ("arrêt n° 45/2019", "045/2019") as a Postgres regex that matches the stored
 * caseNumber whatever its zero-padding ("Arrêt N° 045/2019"). Keyword search can't do this: the French tsvector keeps
 * "045/2019" as one token, so "45/2019" never matches it. null when q holds no case number.
 */
export function caseNumberPattern(q: string): string | null {
  const m = /(?:^|[^\d/])0*(\d{1,4})\s*\/\s*((?:19|20)\d{2})(?![\d])/.exec(q);
  if (!m) return null;
  return `(^|[^0-9])0*${m[1]}/${m[2]}([^0-9]|$)`;
}

/** "moyen-1", or "moyen-1 (part 2)" for the second part of a long section. Same labels as the review view. */
export const sectionLabel = (ref: string, part: number): string => (part > 0 ? `${ref} (part ${part + 1})` : ref);

export const totalPages = (total: number, limit: number): number => Math.ceil(total / limit);

// ─── SQL pieces ──────────────────────────────────────────────────────────────

const textConfig = sql`(CASE WHEN ${documents.language} = 'en' THEN 'english' ELSE 'french' END)::regconfig`;

/**
 * The WHERE of every query here. `status = 'published'` is stated literally, besides searchableDocuments (the one
 * definition of visible, which never widens it): the partial indexes (WHERE status = 'published') are only usable
 * when the query repeats their predicate word for word.
 */
export function decisionFilters(f: DecisionFilters): SQL {
  const conditions: SQL[] = [
    sql`${decisions.status} = 'published'`,
    searchableDocuments(['decision']),
  ];
  if (f.court) conditions.push(sql`${decisions.court} = ${f.court}`);
  if (f.country) conditions.push(sql`${decisions.country} = ${f.country}`);
  if (f.year) {
    // A range, not extract(year …) = 2019: a function of the column can't use an index on the column
    conditions.push(sql`${decisions.decisionDate} >= ${`${f.year}-01-01`}::date`);
    conditions.push(sql`${decisions.decisionDate} < ${`${f.year + 1}-01-01`}::date`);
  }
  if (f.outcome) conditions.push(sql`${decisions.outcome} = ${f.outcome}::decision_outcome`);
  if (f.subject) {
    // Free text written by the extraction LLM: words, not equality. websearch syntax: "quoted phrase", -word, or
    conditions.push(sql`to_tsvector(${textConfig}, coalesce(${decisions.subject}, ''))
      @@ websearch_to_tsquery(${textConfig}, ${f.subject})`);
  }
  if (f.act) {
    // Same links as the article page: 'low' ones wait for a reviewer and are never shown
    const citation: SQL[] = [
      sql`${decisionCitations.decisionId} = ${decisions.id}`,
      sql`${decisionCitations.actCode} = ${f.act}`,
      sql`${decisionCitations.confidence} <> 'low'`,
    ];
    if (f.article) citation.push(sql`${decisionCitations.articleRef} = ${f.article}`);
    if (f.version) citation.push(sql`${decisionCitations.actVersion} = ${f.version}`);
    conditions.push(sql`EXISTS (SELECT 1 FROM ${decisionCitations} WHERE ${sql.join(citation, sql` AND `)})`);
  }
  return sql.join(conditions, sql` AND `);
}

const fromPublished = (f: DecisionFilters) =>
  sql`FROM ${decisions} JOIN ${documents} ON ${documents.id} = ${decisions.documentId} WHERE ${decisionFilters(f)}`;

/** Columns of a hit, aliased in camelCase so a row is already shaped like DecisionHit. */
const hitColumns = sql`
  ${decisions.id} AS "id", ${decisions.documentId} AS "documentId", ${documents.title} AS "title",
  ${documents.language} AS "language", ${decisions.court} AS "court", ${decisions.country} AS "country",
  ${decisions.chamber} AS "chamber", ${decisions.caseNumber} AS "caseNumber", ${decisions.decisionDate} AS "decisionDate",
  ${decisions.subject} AS "subject", ${decisions.outcome} AS "outcome", ${decisions.headnote} AS "headnote"`;

type HitRow = Omit<DecisionHit, 'match'>;
type RankedRow = HitRow & {
  caseMatch: boolean;
  section: string | null;
  part: number | null;
  snippet: string | null;
  similarity: number | null;
};

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Published decisions matching the filters. */
export async function countDecisions(f: DecisionFilters): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n ${fromPublished(f)}`);
  return row.n;
}

/**
 * One page of published decisions matching the filters.
 * - Without an embedding: newest first. `DESC NULLS LAST, id` is exactly the order of decisions_published_date, so
 *   Postgres can read the page off the index; a bare `DESC` means NULLS FIRST and could not use it. id breaks ties,
 *   or a decision could appear on two pages.
 * - With one: a decision whose case number is in q first, then by its closest section, then newest first.
 *   q orders the matching decisions; it never removes one, so `total` is the same with or without q.
 */
export async function rankDecisions(
  embedding: number[] | null, q: string | undefined, f: DecisionFilters, page: number, limit: number,
): Promise<DecisionPage> {
  const offset = (page - 1) * limit;
  const [total, items] = await Promise.all([
    countDecisions(f),
    embedding ? rankedPage(embedding, q ?? '', f, limit, offset) : newestPage(f, limit, offset),
  ]);
  return { items, page, limit, total, totalPages: totalPages(total, limit) };
}

/** The page query without q. Exported so the benchmark can EXPLAIN exactly what the API runs. */
export const newestPageQuery = (f: DecisionFilters, limit: number, offset: number): SQL => sql`
    SELECT ${hitColumns} ${fromPublished(f)}
    ORDER BY ${decisions.decisionDate} DESC NULLS LAST, ${decisions.id}
    LIMIT ${limit} OFFSET ${offset}`;

async function newestPage(f: DecisionFilters, limit: number, offset: number): Promise<DecisionHit[]> {
  const rows = await db.execute<HitRow>(newestPageQuery(f, limit, offset));
  return rows.map((r) => toHit(r, null));
}

/** The page query with q (see rankDecisions). Exported for the benchmark's EXPLAIN. */
export function rankedPageQuery(embedding: number[], q: string, f: DecisionFilters, limit: number, offset: number): SQL {
  const vector = sql`${JSON.stringify(embedding)}::vector`;
  const pattern = caseNumberPattern(q);
  const caseMatch = pattern ? sql`coalesce(${decisions.caseNumber} ~ ${pattern}, false)` : sql`false`;

  // DISTINCT ON keeps the first row of each document in the ORDER BY: its closest chunk. The ORDER BY starts with
  // document_id, which also guarantees the HNSW index is never used here (it can only serve ORDER BY distance).
  return sql`
    WITH filtered AS (
      SELECT ${hitColumns}, ${caseMatch} AS "caseMatch" ${fromPublished(f)}
    ), best AS (
      SELECT DISTINCT ON (${chunks.documentId})
        ${chunks.documentId} AS "documentId", ${chunks.articleRef} AS "section", ${chunks.part} AS "part",
        left(${chunks.content}, ${SNIPPET_CHARS}) AS "snippet", ${chunks.embedding} <=> ${vector} AS "distance"
      FROM ${chunks}
      WHERE ${chunks.documentId} IN (SELECT "documentId" FROM filtered) AND ${chunks.embedding} IS NOT NULL
      ORDER BY ${chunks.documentId}, ${chunks.embedding} <=> ${vector}
    )
    SELECT filtered.*, best."section", best."part", best."snippet", 1 - best."distance" AS "similarity"
    FROM filtered LEFT JOIN best ON best."documentId" = filtered."documentId"
    ORDER BY filtered."caseMatch" DESC, best."distance" ASC NULLS LAST, filtered."decisionDate" DESC NULLS LAST, filtered."id"
    LIMIT ${limit} OFFSET ${offset}`;
}

async function rankedPage(
  embedding: number[], q: string, f: DecisionFilters, limit: number, offset: number,
): Promise<DecisionHit[]> {
  const rows = await db.execute<RankedRow>(rankedPageQuery(embedding, q, f, limit, offset));
  return rows.map((r) => toHit(r, r.section === null || r.similarity === null ? null : {
    similarity: r.similarity,
    section: sectionLabel(r.section, r.part ?? 0),
    snippet: r.snippet ?? '',
    caseNumber: r.caseMatch,
  }));
}

function toHit(r: HitRow, match: DecisionHit['match']): DecisionHit {
  return {
    id: r.id, documentId: r.documentId, title: r.title, language: r.language, court: r.court, country: r.country,
    chamber: r.chamber, caseNumber: r.caseNumber, decisionDate: r.decisionDate, subject: r.subject,
    outcome: r.outcome, headnote: r.headnote, match,
  };
}

/** GET /api/decisions: embeds q (one provider call) when there is one. */
export async function searchDecisions({ q, page, limit, ...filters }: DecisionSearchQuery): Promise<DecisionPage> {
  const embedding = q ? await embedQuery(q) : null;
  return rankDecisions(embedding, q, filters, page, limit);
}

/**
 * Counts of published decisions by court, by country and by year, in one scan: GROUPING SETS computes the three
 * GROUP BYs (and the grand total, the empty set) together. GROUPING(col) is 1 when col is NOT part of the row's
 * grouping set: that is how a CCJA row (country NULL, grouped by country) is told apart from a court or year row.
 */
export async function decisionStats(): Promise<DecisionStats> {
  const rows = await db.execute<{
    byCourt: boolean; byCountry: boolean; byYear: boolean;
    court: string | null; country: string | null; year: number | null; n: number;
  }>(sql`
    SELECT GROUPING(court) = 0 AS "byCourt", GROUPING(country) = 0 AS "byCountry", GROUPING(year) = 0 AS "byYear",
      court, country, year, count(*)::int AS n
    FROM (
      SELECT ${decisions.court} AS court, ${decisions.country} AS country,
        extract(year FROM ${decisions.decisionDate})::int AS year
      ${fromPublished({})}
    ) published
    GROUP BY GROUPING SETS ((court), (country), (year), ())
    ORDER BY n DESC, court, country, year DESC`);

  const stats: DecisionStats = { total: 0, byCourt: [], byCountry: [], byYear: [] };
  for (const r of rows) {
    // court and year are never NULL once published (decisions_published_complete)
    if (r.byCourt && r.court !== null) stats.byCourt.push({ court: r.court, count: r.n });
    else if (r.byCountry) stats.byCountry.push({ country: r.country, count: r.n });
    else if (r.byYear && r.year !== null) stats.byYear.push({ year: r.year, count: r.n });
    else if (!r.byCourt && !r.byCountry && !r.byYear) stats.total = r.n;
  }
  stats.byYear.sort((a, b) => b.year - a.year);
  return stats;
}
