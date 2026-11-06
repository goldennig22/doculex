// src/scripts/eval-retrieval.ts
// Usage:
//   npx tsx --env-file=.env src/scripts/eval-retrieval.ts --mode vector
//   npx tsx --env-file=.env src/scripts/eval-retrieval.ts --mode keyword
//   npx tsx --env-file=.env src/scripts/eval-retrieval.ts --mode hybrid --kw-weight 0.5 --same-lang
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { sql } from '../db/client';
import { detectLanguage, hybridSearch, searchByKeywords, searchByVector } from '../services/search.service';
import type { SearchResult } from '../interfaces/documents';

type Q = {
  id: number;
  question: string;
  category: 'in_document' | 'out_of_document';
  expected_articles?: string[];
  expected_title?: string;
};

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    mode: { type: 'string', default: 'hybrid' },
    'kw-weight': { type: 'string', default: '0.5' },
    'same-lang': { type: 'boolean', default: false },
    k: { type: 'string', default: '5' },
  },
  strict: true,
});

const mode = values.mode as 'vector' | 'keyword' | 'hybrid';
const K = Number(values.k);
const keywordWeight = Number(values['kw-weight']);
const sameLanguageOnly = values['same-lang'];

const { rag_test_questions: questions } =
  JSON.parse(readFileSync('eval/questions.json', 'utf8')) as { rag_test_questions: Q[] };

async function search(question: string): Promise<{ results: SearchResult[]; top: number }> {
  if (mode === 'vector') {
    const results = await searchByVector(question, K);
    return { results, top: results[0]?.similarity ?? 0 };
  }
  if (mode === 'keyword') {
    const lang = sameLanguageOnly ? detectLanguage(question) : undefined;
    return { results: await searchByKeywords(question, K, lang), top: 0 };
  }
  const res = await hybridSearch(question, K, { keywordWeight, sameLanguageOnly });
  return { results: res.results, top: res.topSimilarity }; // raw vector similarity, not RRF
}

async function main() {
  console.log(`mode=${mode} k=${K}` + (mode === 'hybrid' ? ` kw-weight=${keywordWeight} same-lang=${sameLanguageOnly}` : ''));
  let hits = 0, total = 0;

  for (const q of questions) {
    const { results, top } = await search(q.question);
    const got = results.map((r) => `${r.articleRef}${r.documentTitle.startsWith('UNIFORM') ? 'e' : 'f'}`).join(', ');

    if (q.category === 'out_of_document') {
      console.log(`OUT  #${q.id}  top=${top.toFixed(3)}  got [${got}]`);
      continue;
    }
    total++;
    const rank = results.findIndex(
      (r) => q.expected_articles?.includes(r.articleRef) && (!q.expected_title || r.documentTitle === q.expected_title),
    );
    if (rank >= 0) hits++;
    console.log(
      `${rank >= 0 ? 'HIT ' : 'MISS'} #${q.id}  art. ${q.expected_articles?.join(',')}  ` +
        `rank=${rank >= 0 ? rank + 1 : '-'}  top=${top.toFixed(3)}  got [${got}]`,
    );
  }
  console.log(`\nHit@${K}: ${hits}/${total}`);
}

main().finally(() => sql.end());