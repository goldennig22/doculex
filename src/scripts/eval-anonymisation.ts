// src/scripts/eval-anonymisation.ts
// Detection eval: on hand-labelled decisions, how many name occurrences each pass would leave in the published text.
// Three modes from ONE LLM call per decision: rules only, LLM only, both (what the job does). Calls the LLM: costs money.
// Labels live in eval/persons.local.json, which is gitignored: they are the real names of real parties.
// Usage:
//   npm run decisions:evaluate-anonymisation
//   npm run decisions:evaluate-anonymisation -- --ids 1,4
//   npm run decisions:evaluate-anonymisation -- --out eval/results/anonymisation.json   (counts only, never names)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { parseArgs } from 'node:util';
import type { PageText } from '../interfaces/types';
import { sql } from '../db/client';
import { extractPages } from '../services/documents.service';
import { chunkDecision, findCaption } from '../services/decision-chunker.service';
import { segmentsOf } from '../services/anonymisation/anonymisation.service';
import { detectByRules } from '../services/anonymisation/rules';
import { detectWithLlm } from '../services/anonymisation/llm-detection';
import { buildMentions, type Segment } from '../services/anonymisation/mentions';
import { gradeAnonymisation, PersonsFile, summarize, type AnonymisationGrade, type PersonsLabel } from './lib/anonymisation-grading';

const LABELS = 'eval/persons.local.json';
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { ids: { type: 'string' }, out: { type: 'string' } },
  strict: true,
});

if (!existsSync(LABELS)) {
  console.error(`${LABELS} not found. Create it (it is gitignored) with:
{ "decisions": [ { "id": 1, "file": "eval/decisions/arret.pdf", "language": "fr",
    "persons": [["TCHOUPO Jean-Marie", "TCHOUPO"], ["NKOUM Paul"]], "keep": ["names of the judges"] } ] }`);
  process.exit(1);
}
const { decisions: all } = PersonsFile.parse(JSON.parse(readFileSync(LABELS, 'utf8')));
const wanted = values.ids ? new Set(values.ids.split(',').map(Number)) : null;
const labels = wanted ? all.filter((d) => wanted.has(d.id)) : all;

/** The same steps as an upload: NFC pages → caption + chunks → segments in reading order. */
async function segmentsFor(d: PersonsLabel): Promise<Segment[]> {
  const raw: PageText[] = extname(d.file).toLowerCase() === '.pdf'
    ? (await extractPages(readFileSync(d.file))).pages
    : [{ page: 1, text: readFileSync(d.file, 'utf8') }];
  const pages = raw.map((p) => ({ ...p, text: p.text.normalize('NFC') }));
  const parts = chunkDecision(pages, { lang: d.language, pathPrefix: '' })
    .map((c, i) => ({ id: `${c.articleRef}#${c.part}#${i}`, articleRef: c.articleRef, part: c.part, content: c.content }));
  return segmentsOf(findCaption(pages, d.language), parts);
}

const MODES = ['rules', 'llm', 'both'] as const;
type Mode = (typeof MODES)[number];
const pct = (r: number | null) => (r === null ? '-' : `${(r * 100).toFixed(1)}%`);

async function main() {
  const grades: Record<Mode, AnonymisationGrade[]> = { rules: [], llm: [], both: [] };
  let cost = 0;
  let errors = 0;

  for (const d of labels) {
    try {
      const segments = await segmentsFor(d);
      const rule = segments.flatMap(detectByRules);
      const llm = await detectWithLlm(segments, d.language);
      cost += llm.costUsd ?? 0;
      const detected: Record<Mode, ReturnType<typeof buildMentions>['mentions']> = {
        rules: buildMentions(segments, rule, []).mentions,
        llm: buildMentions(segments, [], llm.persons).mentions,
        both: buildMentions(segments, rule, llm.persons).mentions,
      };
      console.log(`\n── #${d.id} ${d.file}  ${llm.models.join(', ')}  dropped forms: ${llm.droppedForms}`);
      for (const mode of MODES) {
        const g = gradeAnonymisation(segments, detected[mode], d);
        grades[mode].push(g);
        console.log(`  ${mode.padEnd(5)} ${g.covered}/${g.total} covered, ${g.wronglyHidden} wrongly hidden, ${g.extra} extra`);
        // Printed to this terminal only (the labels are local anyway), never written to --out
        if (mode === 'both') for (const m of g.missed) console.log(`    MISSED in ${m.segmentId.split('#')[0]}: …${m.context}…`);
      }
    } catch (err) {
      errors++;
      console.error(`#${d.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\n── Summary (recall = name occurrences replaced; a miss is a published name)');
  const summary = Object.fromEntries(MODES.map((m) => [m, summarize(grades[m])]));
  for (const m of MODES) {
    const s = summary[m];
    console.log(`  ${m.padEnd(5)} recall ${pct(s.recall).padStart(6)}  (${s.covered}/${s.total})  wrongly hidden ${s.wronglyHidden}  extra ${s.extra}`);
  }
  console.log(`  decisions ${labels.length - errors}/${labels.length}, LLM cost $${cost.toFixed(4)}`);

  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, JSON.stringify({ summary, errors, costUsd: cost }, null, 2));
    console.log(`  written to ${values.out}`);
  }
}

main().finally(() => sql.end());
