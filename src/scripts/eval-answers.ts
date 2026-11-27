// src/scripts/eval-answers.ts
// Answer-level evaluation: runs the real /ask pipeline (embeddings + LLM, so it costs money) on eval/questions.json.
// Usage:
//   npm run documents:evaluate-answers
//   npm run documents:evaluate-answers -- --ids 1,2,14        only these questions
//   npm run documents:evaluate-answers -- --show-all          print every answer, not only the ones to review
//   npm run documents:evaluate-answers -- --out eval/results/answers.json
// Every question also writes a row to the queries table of the database in DATABASE_URL.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { sql } from '../db/client';
import { env } from '../config/env';
import { answerQuestion } from '../services/ask.service';
import type { AskResult } from '../interfaces/types';
import { errorGrade, gradeAnswer, summarize, type EvalQuestion, type Grade } from './lib/answer-grading';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    ids: { type: 'string' },
    'show-all': { type: 'boolean', default: false },
    out: { type: 'string' },
  },
  strict: true,
});

const { rag_test_questions: all } =
  JSON.parse(readFileSync('eval/questions.json', 'utf8')) as { rag_test_questions: EvalQuestion[] };
const wanted = values.ids ? new Set(values.ids.split(',').map(Number)) : null;
const questions = wanted ? all.filter((q) => wanted.has(q.id)) : all;

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '-');
const usd = (n: number | null) => (n === null ? '$?' : `$${n.toFixed(5)}`);
const by = (counts: Record<string, number>) =>
  Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';

const LABEL: Record<Grade['verdict'], string> = {
  correct: 'CORRECT', wrong_article: 'WRONG-ART', missed: 'MISSED', article_only: 'ART-ONLY',
  refused: 'REFUSED', answered: 'ANSWERED', error: 'ERROR',
};
const NEEDS_REVIEW = new Set<Grade['verdict']>(['wrong_article', 'missed', 'answered', 'error']);
const CAT: Record<EvalQuestion['category'], string> = { in_document: 'IN ', out_of_document: 'OUT', case_law: 'LAW' };

function printLine(q: EvalQuestion, g: Grade, top: number | null) {
  const cat = CAT[q.category];
  const articles = `expects ${q.expected_articles?.join(',') || '-'}  cites ${g.citedArticles.join(',') || '-'}`;
  const detail = q.category === 'out_of_document'
    ? `stopped=${g.stoppedAt ?? '-'}`
    : q.category === 'case_law'
      ? `case ${q.expected_case_numbers?.join(',')}  ${articles}  stopped=${g.stoppedAt ?? '-'}`
      : `${articles}  retrieved=${g.retrieved ? 'yes' : 'no'}`;
  console.log(
    `${LABEL[g.verdict].padEnd(9)} #${String(q.id).padEnd(3)} ${q.language} ${cat} ${detail}  ` +
      `top=${top?.toFixed(3) ?? '-'}  ${g.model ?? '-'}  ${g.latencyMs ?? '-'}ms  ${usd(g.costUsd)}` +
      (g.languageOk === false ? '  WRONG LANGUAGE' : ''),
  );
}

function printReview(q: EvalQuestion, result: AskResult | null, error: unknown) {
  console.log(`\n── #${q.id} ${q.question}`);
  if (q.expected_answer_summary) console.log(`   expected: ${q.expected_answer_summary}`);
  if (error) {
    console.log(`   error:    ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!result) return;
  const { response, trace } = result;
  console.log(`   answer:   ${response.found ? response.answer : `(refused at ${trace.stoppedAt})`}`);
  for (const c of response.citations) console.log(`   cites:    art. ${c.article} p.${c.pages.join('-')}: "${c.quote}"`);
  console.log(`   sources:  ${trace.sourceArticles.map((s) => s.article).join(', ') || '(none: stopped before the LLM)'}`);
}

async function main() {
  console.log(`eval-answers  questions=${questions.length}  MIN_SIMILARITY=${env.MIN_SIMILARITY}  ` +
    `models=${env.LLM_MODEL} → ${env.LLM_2ND_MODEL} → ${env.LLM_FALLBACK_MODEL}\n`);

  const grades: Grade[] = [];
  const review: { q: EvalQuestion; result: AskResult | null; error: unknown }[] = [];

  // One at a time: parallel calls would hit provider rate limits and distort the latency numbers
  for (const q of questions) {
    let result: AskResult | null = null;
    let error: unknown = null;
    try {
      result = await answerQuestion(q.question);
    } catch (err) {
      error = err; // counted as an error and printed below; the run goes on with the next question
    }
    const g = result ? gradeAnswer(q, result) : errorGrade(q);
    grades.push(g);
    printLine(q, g, result?.trace.topSimilarity ?? null);
    if (values['show-all'] || NEEDS_REVIEW.has(g.verdict)) review.push({ q, result, error });
  }

  if (review.length) {
    console.log(`\n═══ ${values['show-all'] ? 'All answers' : 'To review'} (${review.length}) ═══`);
    for (const r of review) printReview(r.q, r.result, r.error);
  }

  const s = summarize(grades);
  const i = s.inDocument, o = s.outOfDocument;
  console.log('\n═══ Summary ═══');
  console.log(`In-document     correct ${i.correct}/${i.total} (${pct(i.correct, i.total)})  ` +
    `wrong article ${i.wrongArticle}  missed: ${by(i.missedBy)}  errors ${i.errors}`);
  console.log(`                misses with an expected article in the sources: ${i.missesWithArticleRetrieved}/${i.misses} ` +
    '(generation misses; the rest are retrieval misses)');
  console.log(`Out-of-document refused ${o.refused}/${o.total} (${pct(o.refused, o.total)}): ${by(o.refusedBy)}  ` +
    `answered ${o.answered}  errors ${o.errors}`);
  const c = s.caseLaw;
  if (c.total) {
    console.log(`Case law        cites the decision ${c.correct}/${c.total}  article only ${c.articleOnly}  ` +
      `wrong article ${c.wrongArticle}  missed: ${by(c.missedBy)}  errors ${c.errors}`);
  }
  console.log(`By category × language (success = correct / refused / correct or article only): ` +
    Object.entries(s.byCategoryLanguage).map(([k, v]) => `${k} ${v.ok}/${v.total}`).join('  '));
  console.log(`Language        ${s.language.ok}/${s.language.answered} answers in the language of the question`);
  console.log(`Latency         mean ${s.latencyMs.mean ?? '-'}ms  p50 ${s.latencyMs.p50 ?? '-'}ms  p95 ${s.latencyMs.p95 ?? '-'}ms`);
  console.log(`Cost            total ${usd(s.cost.totalUsd)}  mean per LLM call ${usd(s.cost.meanPerLlmCallUsd)}  ` +
    `(${s.cost.llmCalls} LLM calls, ${s.cost.unpricedCalls} without a price in prices.ts)`);
  console.log(`Models          ${by(s.models)}`);

  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, JSON.stringify({ ranAt: new Date().toISOString(), minSimilarity: env.MIN_SIMILARITY, summary: s, grades }, null, 2));
    console.log(`\nWrote ${values.out}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
