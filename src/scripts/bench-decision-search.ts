// Decision search: "filter then vector" (exact) against "vector then filter" (HNSW), measured instead of guessed.
//
//   npm run decisions:bench-search                      speed and recall of each strategy, per filter
//   npm run decisions:bench-search -- --explain          + EXPLAIN (ANALYZE, BUFFERS) of the API's real queries
//   npm run decisions:bench-search -- --runs 50 --k 10
//
// Needs published decisions (src/scripts/ingest-decisions.ts) and the questions in eval/decision-search.json.
// Query embeddings are computed once with the real provider and cached in eval/.cache/ (gitignored).
//
// Strategies, each returning the k best DECISIONS for a question under a filter:
//   exact            the API's query (rankDecisions): filter the decisions, score every one of their chunks. The reference.
//   hnsw             one query, the filter in the WHERE, HNSW forced, iterative scan off: the filtered-HNSW trap.
//   hnsw-iterative   the same with hnsw.iterative_scan = relaxed_order (pgvector >= 0.8).
//   overfetch-N      the k×N nearest chunks of ALL documents by HNSW, then filter and group: "vector then filter".
// The HNSW strategies run with enable_seqscan = off, to push the planner toward the index as on a large table. It can
// still refuse: with a selective filter it starts from the decisions' partial indexes and scores their chunks exactly.
// The "hnsw" column says which plan really ran. Recall is measured against exact; time is Postgres's execution time.
//
// Second part, when questions are labelled (expectedCaseNumbers): does keyword search help on decisions?
//   vector           ranked by meaning only
//   vector+case      + a case number found in q is pinned first (what the API does)
//   hybrid           RRF of vector and full-text (keyword weight 0.5, as for statutes)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { sql as dsql, type SQL } from 'drizzle-orm';
import { db, sql } from '../db/client';
import { chunks, decisions, documents } from '../db/schema';
import { embedQuery, EMBEDDING_MODEL } from '../services/embeddings.service';
import { rrf, searchByKeywords } from '../services/search.service';
import {
  decisionFilters, decisionStats, newestPageQuery, rankDecisions, rankedPageQuery, type DecisionFilters,
} from '../services/decision-search.service';
import { caseKey, firstPerKey, mean, percentile, recallAtK, reciprocalRank } from './lib/search-bench';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    k: { type: 'string', default: '10' },
    runs: { type: 'string', default: '20' },
    warmup: { type: 'string', default: '3' },
    overfetch: { type: 'string', default: '5,20,50' },
    explain: { type: 'boolean', default: false },
    questions: { type: 'string', default: 'eval/decision-search.json' },
  },
  strict: true,
});
const K = Number(values.k);
const RUNS = Number(values.runs);
const WARMUP = Number(values.warmup);
const OVERFETCH = values.overfetch.split(',').map(Number);
/** Chunk-level strategies fetch this many chunks per wanted decision, since one decision has several close chunks. */
const CHUNKS_PER_DECISION = 5;

const QuestionsFile = z.object({
  questions: z.array(z.object({
    id: z.number(),
    q: z.string(),
    expectedCaseNumbers: z.array(z.string()).default([]),
  })),
});

// ─── Embeddings, cached ──────────────────────────────────────────────────────

const CACHE = 'eval/.cache/query-embeddings.json';
async function embedAll(questions: string[]): Promise<Map<string, number[]>> {
  const cache: Record<string, number[]> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
  const key = (q: string) => `${EMBEDDING_MODEL}|${q}`;
  const missing = questions.filter((q) => !cache[key(q)]);
  for (const q of missing) cache[key(q)] = await embedQuery(q); // one paid call per new question
  if (missing.length) {
    mkdirSync('eval/.cache', { recursive: true });
    writeFileSync(CACHE, JSON.stringify(cache));
    console.log(`embedded ${missing.length} new question(s), cached in ${CACHE}`);
  }
  return new Map(questions.map((q) => [q, cache[key(q)]]));
}

// ─── Strategies ──────────────────────────────────────────────────────────────

/**
 * A strategy is its SQL and the session settings it runs under. Its timing is Postgres's own Execution Time (EXPLAIN
 * ANALYZE), not the client's stopwatch: on Docker for Windows the round trips (BEGIN, SET, the ~30 kB vector, COMMIT)
 * cost ~50 ms and would hide every difference between strategies.
 */
type Strategy = {
  name: string;
  settings: string[];
  query: (v: number[], f: DecisionFilters) => SQL;
  /** Rows in the query's order to the k best decision ids */
  ids: (rows: Record<string, unknown>[]) => string[];
};

const vectorOf = (v: number[]) => dsql`${JSON.stringify(v)}::vector`;
const byDecision = (rows: Record<string, unknown>[]) =>
  firstPerKey([...rows].sort((a, b) => Number(a.distance) - Number(b.distance)), (r) => String(r.decisionId)).slice(0, K);

const exact: Strategy = {
  name: 'exact',
  settings: [],
  // q = '' so no case number is pinned: pure vector ranking, comparable with the others
  query: (v, f) => rankedPageQuery(v, '', f, K, 0),
  ids: (rows) => rows.map((r) => String(r.id)),
};

function hnswInWhere(iterative: boolean): Strategy {
  return {
    name: iterative ? 'hnsw-iterative' : 'hnsw',
    settings: ['enable_seqscan = off', `hnsw.iterative_scan = ${iterative ? 'relaxed_order' : 'off'}`],
    query: (v, f) => dsql`
      SELECT ${decisions.id} AS "decisionId", ${chunks.embedding} <=> ${vectorOf(v)} AS "distance"
      FROM ${chunks}
      JOIN ${decisions} ON ${decisions.documentId} = ${chunks.documentId}
      JOIN ${documents} ON ${documents.id} = ${decisions.documentId}
      WHERE ${decisionFilters(f)} AND ${chunks.embedding} IS NOT NULL
      ORDER BY ${chunks.embedding} <=> ${vectorOf(v)}
      LIMIT ${K * CHUNKS_PER_DECISION}`,
    ids: byDecision, // relaxed_order: rows may be slightly out of order
  };
}

function overfetch(n: number): Strategy {
  return {
    name: `overfetch-${n}`,
    // HNSW returns at most ef_search rows: below k×n, the over-fetch would silently be capped
    settings: ['enable_seqscan = off', `hnsw.ef_search = ${Math.min(1000, Math.max(40, K * n))}`],
    query: (v, f) => dsql`
      WITH top AS (
        SELECT ${chunks.documentId} AS document_id, ${chunks.embedding} <=> ${vectorOf(v)} AS distance
        FROM ${chunks} WHERE ${chunks.embedding} IS NOT NULL
        ORDER BY ${chunks.embedding} <=> ${vectorOf(v)} LIMIT ${K * n}
      )
      SELECT ${decisions.id} AS "decisionId", top.distance AS "distance" FROM top
      JOIN ${decisions} ON ${decisions.documentId} = top.document_id
      JOIN ${documents} ON ${documents.id} = ${decisions.documentId}
      WHERE ${decisionFilters(f)}
      ORDER BY top.distance`,
    ids: byDecision,
  };
}

/** Runs a strategy's query under its settings: the ids it returns, the server's execution time, the plan's indexes. */
async function measure(s: Strategy, v: number[], f: DecisionFilters) {
  return db.transaction(async (tx) => {
    for (const setting of s.settings) await tx.execute(dsql.raw(`SET LOCAL ${setting}`));
    const rows = await tx.execute<Record<string, unknown>>(s.query(v, f));
    const [explained] = await tx.execute<{ 'QUERY PLAN': [{ 'Execution Time': number; Plan: unknown }] }>(
      dsql`EXPLAIN (ANALYZE, FORMAT JSON) ${s.query(v, f)}`);
    const [plan] = explained['QUERY PLAN'];
    return { ids: s.ids([...rows]), ms: plan['Execution Time'], usedHnsw: JSON.stringify(plan.Plan).includes('chunks_embedding_hnsw') };
  });
}

// ─── Filters, chosen from the data so each one matches something ─────────────

async function filterCases(): Promise<{ name: string; f: DecisionFilters }[]> {
  const stats = await decisionStats();
  const cases: { name: string; f: DecisionFilters }[] = [{ name: 'none', f: {} }];
  const court = stats.byCourt[0]?.court;
  const country = stats.byCountry.find((c) => c.country !== null)?.country ?? undefined;
  const year = stats.byYear.slice().sort((a, b) => b.count - a.count)[0]?.year;
  if (court) cases.push({ name: `court=${court}`, f: { court } });
  if (country) cases.push({ name: `country=${country}`, f: { country } });
  if (year) cases.push({ name: `year=${year}`, f: { year } });
  if (court && year) cases.push({ name: `court+year`, f: { court, year } });
  const [cited] = await sql<{ act: string; article: string; n: number }[]>`
    SELECT dc.act_code AS act, dc.article_ref AS article, count(DISTINCT d.id)::int AS n
    FROM decision_citations dc JOIN decisions d ON d.id = dc.decision_id
    WHERE d.status = 'published' AND dc.act_code IS NOT NULL AND dc.confidence <> 'low'
    GROUP BY 1, 2 ORDER BY n DESC LIMIT 1`;
  if (cited) {
    cases.push({ name: `act=${cited.act}&article=${cited.article}`, f: { act: cited.act as DecisionFilters['act'], article: cited.article } });
  }
  return cases;
}

// ─── Measuring ───────────────────────────────────────────────────────────────

async function speedAndRecall(questions: string[], vectors: Map<string, number[]>) {
  const strategies = [exact, hnswInWhere(false), hnswInWhere(true), ...OVERFETCH.map(overfetch)];
  const cases = await filterCases();
  const [{ total }] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM decisions WHERE status = 'published'`;
  const [{ chunkCount }] = await sql<{ chunkCount: number }[]>`SELECT count(*)::int AS "chunkCount" FROM chunks WHERE embedding IS NOT NULL`;
  console.log(`\n${total} published decisions, ${chunkCount} embedded chunks in all; k=${K}, ${questions.length} questions, ${RUNS} timed runs each`);
  console.log('ms = Postgres execution time (EXPLAIN ANALYZE), without the network; hnsw = share of runs whose plan used the HNSW index\n');

  for (const { name, f } of cases) {
    const [{ n }] = await db.execute<{ n: number }>(dsql`
      SELECT count(*)::int AS n FROM ${decisions} JOIN ${documents} ON ${documents.id} = ${decisions.documentId}
      WHERE ${decisionFilters(f)}`);
    console.log(`filter ${name}: ${n} decisions (${((100 * n) / Math.max(1, total)).toFixed(1)}%)`);
    console.log('  strategy           recall@k  returned  p50 ms  p95 ms  hnsw');

    const truth = new Map<string, string[]>();
    for (const q of questions) truth.set(q, (await measure(exact, vectors.get(q)!, f)).ids);

    for (const s of strategies) {
      const recalls: number[] = [];
      const returned: number[] = [];
      const ms: number[] = [];
      let hnswRuns = 0;
      for (const q of questions) {
        const v = vectors.get(q)!;
        for (let i = 0; i < WARMUP; i++) await measure(s, v, f);
        let got: string[] = [];
        for (let i = 0; i < RUNS; i++) {
          const r = await measure(s, v, f);
          ms.push(r.ms);
          if (r.usedHnsw) hnswRuns++;
          got = r.ids;
        }
        const reference = truth.get(q)!;
        recalls.push(recallAtK(got, reference, K));
        returned.push(reference.length === 0 ? 1 : got.length / Math.min(K, reference.length));
      }
      console.log(`  ${s.name.padEnd(18)} ${mean(recalls).toFixed(3).padStart(8)}  ${(100 * mean(returned)).toFixed(0).padStart(7)}%`
        + `  ${percentile(ms, 50).toFixed(2).padStart(6)}  ${percentile(ms, 95).toFixed(2).padStart(6)}`
        + `  ${((100 * hnswRuns) / ms.length).toFixed(0).padStart(3)}%`);
    }
    console.log('');
  }
}

async function explain(q: string, v: number[]) {
  console.log(`\nEXPLAIN (ANALYZE, BUFFERS) of the API's queries, for "${q}"`);
  for (const { name, f } of await filterCases()) {
    for (const [label, query] of [
      ['with q', rankedPageQuery(v, q, f, 20, 0)],
      ['without q', newestPageQuery(f, 20, 0)],
    ] as [string, SQL][]) {
      await db.execute(query); // warm the cache first: the second run is the one that matters
      const plan = await db.execute<{ 'QUERY PLAN': string }>(dsql`EXPLAIN (ANALYZE, BUFFERS) ${query}`);
      console.log(`\n── filter ${name}, ${label}`);
      for (const row of plan) console.log(row['QUERY PLAN']);
    }
  }
}

// ─── Keyword search on decisions: does it help? ──────────────────────────────

async function keywordQuality(labelled: { q: string; expected: Set<string> }[], vectors: Map<string, number[]>) {
  if (labelled.length === 0) {
    console.log('\nNo labelled question (expectedCaseNumbers) yet: skipping the vector vs keyword comparison.');
    return;
  }
  const caseOf = new Map((await sql<{ id: string; caseNumber: string | null }[]>`
    SELECT id, case_number AS "caseNumber" FROM decisions WHERE status = 'published'`).map((r) => [r.id, caseKey(r.caseNumber)]));
  const docToDecision = new Map((await sql<{ id: string; documentId: string }[]>`
    SELECT id, document_id AS "documentId" FROM decisions WHERE status = 'published'`).map((r) => [r.documentId, r.id]));
  const asCases = (ids: string[]) => ids.map((id) => caseOf.get(id) ?? `?${id}`);

  const modes: Record<string, (q: string, v: number[]) => Promise<string[]>> = {
    'vector': async (_, v) => (await rankDecisions(v, '', {}, 1, K)).items.map((d) => d.id),
    'vector+case': async (q, v) => (await rankDecisions(v, q, {}, 1, K)).items.map((d) => d.id),
    'hybrid': async (q, v) => {
      const vector = (await rankDecisions(v, '', {}, 1, 50)).items.map((d) => ({ id: d.id }));
      const keywordChunks = await searchByKeywords(q, 100, undefined, { kinds: ['decision'] });
      const keyword = firstPerKey(keywordChunks, (c) => docToDecision.get(c.documentId) ?? c.documentId).map((id) => ({ id }));
      return rrf([vector, keyword], { weights: [1, 0.5] }).map((r) => r.id).slice(0, K);
    },
  };

  console.log(`\nVector vs keyword on ${labelled.length} labelled question(s), k=${K}`);
  console.log('  mode           hit@k    MRR');
  for (const [name, run] of Object.entries(modes)) {
    const hits: number[] = [];
    const rr: number[] = [];
    for (const { q, expected } of labelled) {
      const ranked = asCases(await run(q, vectors.get(q)!));
      rr.push(reciprocalRank(ranked, expected));
      hits.push(rr[rr.length - 1] > 0 ? 1 : 0);
    }
    console.log(`  ${name.padEnd(13)} ${mean(hits).toFixed(3).padStart(6)}  ${mean(rr).toFixed(3).padStart(6)}`);
  }
}

async function main() {
  const [{ published }] = await sql<{ published: number }[]>`SELECT count(*)::int AS published FROM decisions WHERE status = 'published'`;
  if (published === 0) {
    console.error('No published decision: ingest and publish some first (src/scripts/ingest-decisions.ts).');
    process.exitCode = 1;
    return;
  }
  const { questions } = QuestionsFile.parse(JSON.parse(readFileSync(values.questions, 'utf8')));
  const texts = questions.map((x) => x.q);
  const vectors = await embedAll(texts);

  await speedAndRecall(texts, vectors);
  if (values.explain) await explain(texts[0], vectors.get(texts[0])!);
  await keywordQuality(
    questions.filter((x) => x.expectedCaseNumbers.length > 0).map((x) => ({
      q: x.q, expected: new Set(x.expectedCaseNumbers.map((c) => caseKey(c) ?? c)),
    })),
    vectors,
  );
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => sql.end());
