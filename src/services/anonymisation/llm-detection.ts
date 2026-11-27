import { z } from 'zod';
import type { Lang } from '../../interfaces/types';
import { costUsd } from '../../config/prices';
import { estimateTokens } from '../chunker.service';
import { generateObjectWithFallback } from '../llm.service';
import { locateForms, type Segment } from './mentions';
import { stripTitle } from './rules';

// Pass 2 of detection: the LLM lists the natural persons it finds, as names copied verbatim. No offsets: a model
// sees tokens, not UTF-16 code units, and an offset that is "almost right" replaces "NGUÉM" and publishes "Dame XA".
// We need every occurrence anyway, so the server finds them (locateForms). A form that isn't in the text is dropped.

export const DetectedPersons = z.object({
  persons: z.array(z.object({
    forms: z.array(z.string()).describe(
      'Every way this person\'s name is written in the text, each copied character for character, without the title '
      + '(no M., Mme, Maître, le sieur, Dame): e.g. ["TCHOUPO Jean-Marie", "TCHOUPO"].'),
    role: z.enum(['party', 'counsel', 'witness', 'other']).describe(
      'party (and their family), counsel (lawyer, notary, bailiff), witness or expert, other'),
  })),
});
export type DetectedPersons = z.infer<typeof DetectedPersons>;

export const DETECTION_SYSTEM = `You find the names of natural persons in one court decision (OHADA business law), so they can be anonymised before publication.
List every natural person named in the text:
- the parties and their family members, legal representatives, managers and employees named as individuals;
- lawyers, notaries, bailiffs, experts, witnesses;
- the trader behind a sole proprietorship: "Établissements KAMGA" or "Ets KAMGA" names a person (list "KAMGA"), unless a company form follows it (SA, SARL, SAS, SNC, GIE).
Never list:
- companies and other legal persons (Société Gamma SARL, a bank, an association), the State, ministries, public bodies;
- courts, and the judges, court clerks (greffiers), prosecutors and advocates general who sit in this case: their names stay public;
- functions without a name ("le Président", "le défendeur", "sa mère").
For each person, give every form of the name that appears in the text, each copied exactly as written, without the title. Include the short forms the text uses (the surname alone).
Missing a person is much worse than listing one too many: a person reviews every name you list.`;

/** Per call. Chunks are at most ~800 tokens, so a 30-page decision takes a few calls; nothing is ever cut. */
export const MAX_DETECTION_TOKENS = 12_000;

/** Segments packed in reading order into batches under maxTokens. A segment is never split across two calls. */
export function detectionBatches(segments: Segment[], maxTokens = MAX_DETECTION_TOKENS): Segment[][] {
  const batches: Segment[][] = [];
  let current: Segment[] = [];
  let size = 0;
  for (const s of segments) {
    const cost = estimateTokens(s.text);
    if (current.length > 0 && size + cost > maxTokens) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(s);
    size += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export const detectionPrompt = (batch: Segment[], language: Lang): string =>
  `<decision>\n${batch.map((s) => s.text).join('\n\n')}\n</decision>\n<language>${language}</language>`;

/**
 * Keeps only forms that occur in the batch, titles stripped. Returns how many were dropped, never which:
 * the result ends up in the job's output (pgboss.job), and a dropped form is a name.
 */
export function verifyPersons(out: DetectedPersons, batch: Segment[]): { persons: { forms: string[] }[]; droppedForms: number } {
  let droppedForms = 0;
  const persons: { forms: string[] }[] = [];
  for (const p of out.persons) {
    const forms = p.forms.map(stripTitle).filter((f) => {
      const ok = f.length >= 2 && locateForms(batch, [f]).length > 0;
      if (!ok) droppedForms++;
      return ok;
    });
    if (forms.length > 0) persons.push({ forms });
  }
  return { persons, droppedForms };
}

export type LlmDetection = {
  persons: { forms: string[] }[];
  droppedForms: number;
  models: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
};

/**
 * The LLM pass over a whole decision, verified. Throws what the fallback chain throws (NoObjectGeneratedError for
 * unusable output, a provider error otherwise); the job decides what each means. Persons from different batches are
 * not merged here: buildMentions groups them by shared forms.
 */
export async function detectWithLlm(segments: Segment[], language: Lang, signal?: AbortSignal): Promise<LlmDetection> {
  const result: LlmDetection = { persons: [], droppedForms: 0, models: [], inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const batch of detectionBatches(segments)) {
    const { output, usage, modelName } = await generateObjectWithFallback({
      label: '[anonymise]',
      system: DETECTION_SYSTEM,
      prompt: detectionPrompt(batch, language),
      schema: DetectedPersons,
      timeoutMs: 30_000,
      signal,
    });
    const verified = verifyPersons(output, batch);
    result.persons.push(...verified.persons);
    result.droppedForms += verified.droppedForms;
    if (!result.models.includes(modelName)) result.models.push(modelName);
    result.inputTokens += usage.inputTokens ?? 0;
    result.outputTokens += usage.outputTokens ?? 0;
    const cost = costUsd(modelName, usage.inputTokens, usage.outputTokens);
    result.costUsd = result.costUsd === null || cost === null ? null : result.costUsd + cost;
  }
  return result;
}
