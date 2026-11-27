// src/scripts/eval-retrieval.ts
// Usage:
//   npx tsx --env-file=.env src/scripts/eval-retrieval.ts --mode vector
//   npx tsx --env-file=.env src/scripts/eval-retrieval.ts --mode keyword
//   npx tsx --env-file=.env src/scripts/eval-retrieval.ts --mode hybrid --kw-weight 0.5 --same-lang
//   npx tsx --env-file=.env src/scripts/eval-retrieval.ts --mode vector --kinds statute,decision
// --kinds: what is searched (default statute: the v1 corpus, what /ask searches today).
// Case-law questions: "decision hit" = a chunk of the expected decision in the top k (needs decision in --kinds);
// "article hit" = an expected article in the top k, for the questions that have one.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import { db, sql } from '../db/client';
import { decisions } from '../db/schema';
import { detectLanguage, hybridSearch, searchByKeywords, searchByVector } from '../services/search.service';
import type { DocumentKind, SearchResult } from '../interfaces/types';
import { matchesCaseNumber, type EvalQuestion } from './lib/answer-grading';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    mode: { type: 'string', default: 'vector' },
    'kw-weight': { type: 'string', default: '0.5' },
    'same-lang': { type: 'boolean', default: false },
    k: { type: 'string', default: '5' },
    kinds: { type: 'string', default: 'statute' },
  },
  strict: true,
});

const mode = z.enum(['vector', 'keyword', 'hybrid']).parse(values.mode);
const K = Number(values.k);
const keywordWeight = Number(values['kw-weight']);
const sameLanguageOnly = values['same-lang'];
const kinds: DocumentKind[] = z.array(z.enum(['statute', 'decision'])).min(1).parse(values.kinds.split(','));

const { rag_test_questions: questions } =
  JSON.parse(readFileSync('eval/questions.json', 'utf8')) as { rag_test_questions: EvalQuestion[] };

async function search(question: string): Promise<{ results: SearchResult[]; top: number }> {
  if (mode === 'vector') {
    const results = await searchByVector(question, K, { kinds });
    return { results, top: results[0]?.similarity ?? 0 };
  }
  if (mode === 'keyword') {
    const lang = sameLanguageOnly ? detectLanguage(question) : undefined;
    return { results: await searchByKeywords(question, K, lang, { kinds }), top: 0 };
  }
  const res = await hybridSearch(question, K, { keywordWeight, sameLanguageOnly, kinds });
  return { results: res.results, top: res.topSimilarity }; // raw vector similarity, not RRF
}

/** Case number of each decision document in the results, one query for the whole list */
async function caseNumbers(results: SearchResult[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(results.map((r) => r.documentId))];
  if (ids.length === 0) return new Map();
  const rows = await db.select({ documentId: decisions.documentId, caseNumber: decisions.caseNumber })
    .from(decisions).where(inArray(decisions.documentId, ids));
  return new Map(rows.map((r) => [r.documentId, r.caseNumber]));
}

const shortLabel = (r: SearchResult, cases: Map<string, string | null>): string => {
  if (cases.has(r.documentId)) return `[${cases.get(r.documentId)?.match(/\d+\/\d{4}/)?.[0] ?? '?'} ${r.articleRef}]`;
  if (r.documentTitle.startsWith('UNIFORM')) return `${r.articleRef}e`;
  return `${r.articleRef}${r.documentTitle.includes('recouvrement') ? 'r' : 'f'}`; // r: AUPSRVE
};

type Cell = { hits: number; total: number };
const bump = (table: Record<string, Cell>, key: string, hit: boolean) => {
  const cell = (table[key] ??= { hits: 0, total: 0 });
  cell.total++;
  if (hit) cell.hits++;
};
const show = (table: Record<string, Cell>) =>
  Object.entries(table).sort().map(([k, c]) => `${k} ${c.hits}/${c.total}`).join('  ');

async function main() {
  console.log(`mode=${mode} k=${K} kinds=${kinds.join(',')}` +
    (mode === 'hybrid' ? ` kw-weight=${keywordWeight} same-lang=${sameLanguageOnly}` : ''));
  const articleHits: Record<string, Cell> = {};
  const decisionHits: Record<string, Cell> = {};

  for (const q of questions) {
    const { results, top } = await search(q.question);
    const cases = await caseNumbers(results);
    const got = results.map((r) => shortLabel(r, cases)).join(', ');

    if (q.category === 'out_of_document') {
      console.log(`OUT  #${q.id}  top=${top.toFixed(3)}  got [${got}]`);
      continue;
    }
    const cell = `${q.category}/${q.language}`;
    const articleRank = results.findIndex(
      (r) => q.expected_articles?.includes(r.articleRef) && (!q.expected_title || r.documentTitle === q.expected_title),
    );
    const hasArticle = (q.expected_articles ?? []).length > 0;
    if (hasArticle) bump(articleHits, cell, articleRank >= 0);

    if (q.category === 'in_document') {
      console.log(
        `${articleRank >= 0 ? 'HIT ' : 'MISS'} #${q.id}  art. ${q.expected_articles?.join(',')}  ` +
          `rank=${articleRank >= 0 ? articleRank + 1 : '-'}  top=${top.toFixed(3)}  got [${got}]`,
      );
      continue;
    }
    const expected = q.expected_case_numbers ?? [];
    const decisionRank = results.findIndex((r) => matchesCaseNumber(expected, cases.get(r.documentId) ?? null));
    bump(decisionHits, cell, decisionRank >= 0);
    console.log(
      `${decisionRank >= 0 ? 'HIT ' : 'MISS'} #${q.id}  case ${expected.join(',')} rank=${decisionRank >= 0 ? decisionRank + 1 : '-'}` +
        (hasArticle ? `  art. ${q.expected_articles?.join(',')} rank=${articleRank >= 0 ? articleRank + 1 : '-'}` : '') +
        `  top=${top.toFixed(3)}  got [${got}]`,
    );
  }
  console.log(`\nArticle Hit@${K} by category/language:  ${show(articleHits)}`);
  console.log(`Decision Hit@${K} by category/language: ${show(decisionHits)}`);
}

main().finally(() => sql.end());