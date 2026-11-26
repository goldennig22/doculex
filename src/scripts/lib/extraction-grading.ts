// Pure grading for eval-extraction.ts. No LLM judge: exact fields are compared after normalisation;
// subject and headnote are printed for a person to judge (--judge asks y/n for the subject).
import { z } from 'zod';
import { OUTCOMES, type DecisionMetadata } from '../../services/decision-extraction.service';

export const EXACT_FIELDS = ['court', 'country', 'chamber', 'caseNumber', 'decisionDate', 'outcome'] as const;
export type ExactField = (typeof EXACT_FIELDS)[number];

/** One hand-labelled decision. Every field is required: null means "the text does not say it". */
export const EvalDecision = z.object({
  id: z.number().int(),
  file: z.string().describe('PDF or .txt, relative to the project root'),
  language: z.enum(['fr', 'en']),
  notes: z.string().optional(),
  expected: z.object({
    court: z.string().nullable(),
    country: z.string().nullable(),
    chamber: z.string().nullable(),
    caseNumber: z.string().nullable(),
    decisionDate: z.iso.date().nullable(),
    outcome: z.enum(OUTCOMES).nullable(),
    subject: z.string().nullable().describe('What you would write; shown next to the model\'s for judging'),
  }),
});
export type EvalDecision = z.infer<typeof EvalDecision>;
export const EvalFile = z.object({ decisions: z.array(EvalDecision) });

export type FieldVerdict =
  | 'correct'   // same value as the label, or both null
  | 'missed'    // null, but the label has a value (cautious: a person fills it in)
  | 'invented'  // a value, but the label is null: the model guessed. The number "must not guess" is about
  | 'wrong';    // both have a value and they differ (often the right kind of value from the wrong passage)

const plain = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** "Arrêt N° 045/2019" and "arrêt n°045/2019" compare equal; so do "045/2019" and "Arrêt n° 045/2019". */
const caseKey = (s: string) => (s.match(/\d+(?:\s*\/\s*\d+)*/g) ?? []).map((m) => m.replace(/\s+/g, '')).join(' ');

export function normalizeField(field: ExactField, value: string): string {
  if (field === 'caseNumber') return caseKey(value);
  if (field === 'country') return value.trim().toUpperCase();
  return plain(value);
}

export function gradeField(field: ExactField, actual: string | null, expected: string | null): FieldVerdict {
  if (actual === null) return expected === null ? 'correct' : 'missed';
  if (expected === null) return 'invented';
  return normalizeField(field, actual) === normalizeField(field, expected) ? 'correct' : 'wrong';
}

export type DecisionGrade = Record<ExactField, FieldVerdict>;

export const gradeDecision = (actual: DecisionMetadata, expected: EvalDecision['expected']): DecisionGrade => ({
  court: gradeField('court', actual.court, expected.court),
  country: gradeField('country', actual.country, expected.country),
  chamber: gradeField('chamber', actual.chamber, expected.chamber),
  caseNumber: gradeField('caseNumber', actual.caseNumber, expected.caseNumber),
  decisionDate: gradeField('decisionDate', actual.decisionDate, expected.decisionDate),
  outcome: gradeField('outcome', actual.outcome, expected.outcome),
});

export type FieldSummary = Record<FieldVerdict, number> & { total: number };

/** Per field: how many of each verdict. Decisions that errored are left out (counted separately by the script). */
export function summarizeFields(grades: DecisionGrade[]): Record<ExactField, FieldSummary> {
  const empty = (): FieldSummary => ({ correct: 0, missed: 0, invented: 0, wrong: 0, total: 0 });
  const out: Record<ExactField, FieldSummary> = {
    court: empty(), country: empty(), chamber: empty(), caseNumber: empty(), decisionDate: empty(), outcome: empty(),
  };
  for (const g of grades) {
    for (const f of EXACT_FIELDS) {
      out[f][g[f]]++;
      out[f].total++;
    }
  }
  return out;
}
