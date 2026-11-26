// src/scripts/eval-extraction.ts
// Extraction evaluation: runs the real metadata extraction (LLM, so it costs money) on hand-labelled decisions
// in eval/decisions.json. It calls the extraction directly, without the queue or the database: it measures the
// prompt and the verification, not the plumbing.
// Usage:
//   npm run decisions:evaluate-extraction
//   npm run decisions:evaluate-extraction -- --ids 1,4        only these decisions
//   npm run decisions:evaluate-extraction -- --judge          ask y/n for each subject (otherwise printed only)
//   npm run decisions:evaluate-extraction -- --out eval/results/extraction.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import type { PageText } from '../interfaces/types';
import { sql } from '../db/client';
import { extractPages } from '../services/documents.service';
import { chunkDecision, findCaption } from '../services/decision-chunker.service';
import { buildExtractionInput, extractMetadata, type ExtractionResult } from '../services/decision-extraction.service';
import {
  EXACT_FIELDS, EvalFile, gradeDecision, summarizeFields, type DecisionGrade, type EvalDecision,
} from './lib/extraction-grading';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    ids: { type: 'string' },
    judge: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
  strict: true,
});

const { decisions: all } = EvalFile.parse(JSON.parse(readFileSync('eval/decisions.json', 'utf8')));
if (all.length === 0) {
  console.error('eval/decisions.json has no decisions yet: label some first (see "_how_to_label" in the file).');
  process.exit(1);
}
const wanted = values.ids ? new Set(values.ids.split(',').map(Number)) : null;
const decisions = wanted ? all.filter((d) => wanted.has(d.id)) : all;

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '-');
const usd = (n: number | null) => (n === null ? '$?' : `$${n.toFixed(5)}`);

/** The same steps as an upload, without the database: pages → caption + chunks → model input. */
async function inputFor(d: EvalDecision): Promise<string> {
  const pages: PageText[] = extname(d.file).toLowerCase() === '.pdf'
    ? (await extractPages(readFileSync(d.file))).pages
    : [{ page: 1, text: readFileSync(d.file, 'utf8') }];
  const chunks = chunkDecision(pages, { lang: d.language, pathPrefix: '' });
  return buildExtractionInput(findCaption(pages, d.language), chunks);
}

type Outcome = {
  id: number;
  result: ExtractionResult | null;
  grade: DecisionGrade | null;
  subjectOk: boolean | null;   // null: not judged
  error: string | null;
};

async function main() {
  const rl = values.judge ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const outcomes: Outcome[] = [];

  for (const d of decisions) {
    try {
      const result = await extractMetadata(await inputFor(d), d.language);
      const grade = gradeDecision(result.metadata, d.expected);

      console.log(`\n── #${d.id} ${d.file}  ${result.model}  ${usd(result.costUsd)}`);
      for (const f of EXACT_FIELDS) {
        const mark = grade[f] === 'correct' ? '  ' : '✗ ';
        console.log(`${mark}${f.padEnd(13)} ${grade[f].padEnd(9)} got ${JSON.stringify(result.metadata[f])}  expected ${JSON.stringify(d.expected[f])}`);
      }
      for (const x of result.dropped) console.log(`  dropped      ${x.field}: ${x.reason}`);
      console.log(`  subject      got      ${JSON.stringify(result.metadata.subject)}`);
      console.log(`               yours    ${JSON.stringify(d.expected.subject)}`);
      console.log(`  headnote     ${result.metadata.headnote ?? 'null'}`);

      let subjectOk: boolean | null = null;
      if (rl) subjectOk = (await rl.question('  subject OK? [y/n] ')).trim().toLowerCase().startsWith('y');
      outcomes.push({ id: d.id, result, grade, subjectOk, error: null });
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.log(`\n── #${d.id} ${d.file}  ERROR ${error}`);
      outcomes.push({ id: d.id, result: null, grade: null, subjectOk: null, error });
    }
  }
  rl?.close();

  // ── Summary ──
  const graded = outcomes.flatMap((o) => (o.grade ? [o.grade] : []));
  const fields = summarizeFields(graded);
  console.log(`\n══ ${decisions.length} decisions, ${graded.length} extracted, ${outcomes.length - graded.length} errors`);
  console.log('field          correct   missed  invented  wrong');
  for (const f of EXACT_FIELDS) {
    const s = fields[f];
    console.log(`${f.padEnd(13)}  ${`${s.correct}/${s.total}`.padEnd(6)} ${pct(s.correct, s.total).padStart(4)}  ${String(s.missed).padStart(5)}  ${String(s.invented).padStart(8)}  ${String(s.wrong).padStart(5)}`);
  }
  const invented = EXACT_FIELDS.reduce((n, f) => n + fields[f].invented, 0);
  console.log(`Guesses (a value where the label is null): ${invented}`);

  const judged = outcomes.filter((o) => o.subjectOk !== null);
  if (judged.length) console.log(`Subject judged right: ${judged.filter((o) => o.subjectOk).length}/${judged.length}`);

  const costs = outcomes.flatMap((o) => (o.result?.costUsd != null ? [o.result.costUsd] : []));
  const total = costs.reduce((a, b) => a + b, 0);
  console.log(`Cost: ${usd(total)} for ${costs.length} priced calls (${usd(costs.length ? total / costs.length : null)} each)`);

  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, JSON.stringify({ ranAt: new Date().toISOString(), outcomes, fields }, null, 2));
    console.log(`Wrote ${values.out}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end()); // documents.service imports the db client; it never connects here, but end it anyway
