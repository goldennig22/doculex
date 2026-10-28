import { readFileSync } from 'node:fs';
import { sql } from '../db/client';
import { searchByVector } from '../services/search.service';

type Q = {
  id: number;
  question: string;
  category: 'in_document' | 'out_of_document';
  expected_articles?: string[];
  expected_title?: string;
};
const { rag_test_questions: questions } =
  JSON.parse(readFileSync('eval/questions.json', 'utf8')) as { rag_test_questions: Q[] };
const K = 5;

async function main() {
  let hits = 0, total = 0;
  for (const q of questions) {                         // one at a time: gentle on rate limits
    const results = await searchByVector(q.question, K);
    const top = results[0]?.similarity ?? 0;
    const got = results.map((r) => r.articleRef).join(', ');

    if (q.category === 'out_of_document') {
      console.log(`OUT  #${q.id}  top=${top.toFixed(3)}  got [${got}]`);
      continue;
    }
    total++;
    const rank = results.findIndex((r) =>q.expected_articles?.includes(r.articleRef)
      && (!q.expected_title || r.documentTitle === q.expected_title)
    );
    if (rank >= 0) hits++;
    console.log(`${rank >= 0 ? 'HIT ' : 'MISS'} #${q.id}  art. ${q.expected_articles?.toString()}  ` +
      `rank=${rank >= 0 ? rank + 1 : '-'}  top=${top.toFixed(3)}  got [${got}]`);
  }
  console.log(`\nHit@${K}: ${hits}/${total}`);
}

main().finally(() => sql.end());