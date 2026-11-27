// Pure grading for eval-anonymisation.ts. A missed name is a published name, so recall is the number that matters;
// "extra" mentions only cost a reviewer a click, "wrongly hidden" ones (a judge, a kept name) cost a correction.
import { z } from 'zod';
import { locateForms, type DetectedMention, type Segment, type Span } from '../../services/anonymisation/mentions';

/**
 * One labelled decision, in eval/persons.local.json (gitignored: real names are personal data, never in git).
 * persons: every natural person, as the list of forms written in the text. keep: names that must stay (judges, clerks).
 */
export const PersonsLabel = z.object({
  id: z.number().int(),
  file: z.string().describe('PDF or .txt, relative to the project root'),
  language: z.enum(['fr', 'en']),
  persons: z.array(z.array(z.string().min(2)).min(1)),
  keep: z.array(z.string().min(2)).default([]),
});
export type PersonsLabel = z.infer<typeof PersonsLabel>;
export const PersonsFile = z.object({ decisions: z.array(PersonsLabel) });

export type AnonymisationGrade = {
  /** Occurrences of labelled names in the text (overlapping forms counted once). */
  total: number;
  /** Covered by at least one detected mention. */
  covered: number;
  /** Not covered: they would be published. */
  missed: (Span & { context: string })[];
  /** Detected mentions over a name that must stay. */
  wronglyHidden: number;
  /** Detected mentions over nothing labelled: the reviewer puts them back. */
  extra: number;
};

const overlaps = (a: Span, b: Span) => a.segmentId === b.segmentId && a.start < b.end && b.start < a.end;

/** Overlapping occurrences of different forms ("TCHOUPO" inside "TCHOUPO Jean-Marie") count as one. */
function occurrences(segments: Segment[], forms: string[]): Span[] {
  const spans = locateForms(segments, forms).sort((a, b) => a.segmentId.localeCompare(b.segmentId) || a.start - b.start);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && overlaps(last, s)) last.end = Math.max(last.end, s.end);
    else merged.push({ segmentId: s.segmentId, start: s.start, end: s.end });
  }
  return merged;
}

/** `detected`: mentions with offsets in the ORIGINAL texts (buildMentions output, before applyMentions). */
export function gradeAnonymisation(
  segments: Segment[], detected: Pick<DetectedMention, 'segmentId' | 'start' | 'end'>[], label: Pick<PersonsLabel, 'persons' | 'keep'>,
): AnonymisationGrade {
  const names = occurrences(segments, label.persons.flat());
  const kept = occurrences(segments, label.keep);
  const text = new Map(segments.map((s) => [s.id, s.text]));

  const missed = names
    .filter((n) => !detected.some((d) => overlaps(d, n)))
    .map((n) => {
      const t = text.get(n.segmentId) ?? '';
      return { ...n, context: t.slice(Math.max(0, n.start - 40), n.end + 40).replace(/\s+/g, ' ') };
    });
  return {
    total: names.length,
    covered: names.length - missed.length,
    missed,
    wronglyHidden: detected.filter((d) => kept.some((k) => overlaps(d, k))).length,
    extra: detected.filter((d) => !names.some((n) => overlaps(d, n)) && !kept.some((k) => overlaps(d, k))).length,
  };
}

export type ModeSummary = { total: number; covered: number; wronglyHidden: number; extra: number; recall: number | null };

export function summarize(grades: AnonymisationGrade[]): ModeSummary {
  const sum = (f: (g: AnonymisationGrade) => number) => grades.reduce((n, g) => n + f(g), 0);
  const total = sum((g) => g.total);
  const covered = sum((g) => g.covered);
  return { total, covered, wronglyHidden: sum((g) => g.wronglyHidden), extra: sum((g) => g.extra), recall: total ? covered / total : null };
}
