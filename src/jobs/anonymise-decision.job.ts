import { NoObjectGeneratedError } from 'ai';
import { detectByRules } from '../services/anonymisation/rules';
import { detectWithLlm, type LlmDetection } from '../services/anonymisation/llm-detection';
import {
  loadForAnonymisation, planAnonymisation, saveAnonymisation, segmentsOf, type AnonymisationSubject,
} from '../services/anonymisation/anonymisation.service';

// The anonymise-decision job: detects natural persons' names in an uploaded decision (rules, then the LLM), replaces
// them with placeholders and records each mention for a reviewer to confirm. Wired in src/jobs/queue.ts.
//
// Idempotent like the extraction job: it skips a decision that is no longer 'pending', and saveAnonymisation writes
// with UPDATE … WHERE anonymisation_status = 'pending', so of two overlapping runs only one writes.
//
// Nothing here logs or returns a name: the result is stored as the job's output in pgboss.job.

export type AnonymisationRunResult =
  | {
    status: 'done' | 'needs_manual_review';
    persons: number; mentions: number; droppedForms: number;
    models: string[]; inputTokens: number; outputTokens: number; costUsd: number | null;
  }
  | { status: 'skipped'; reason: 'not_found' | 'not_pending' | 'lost_race' };

const NO_LLM: LlmDetection = { persons: [], droppedForms: 0, models: [], inputTokens: 0, outputTokens: 0, costUsd: 0 };

async function anonymise(subject: AnonymisationSubject, llm: LlmDetection, status: 'done' | 'needs_manual_review'): Promise<AnonymisationRunResult> {
  const segments = segmentsOf(subject.caption, subject.chunks);
  const plan = planAnonymisation(subject, segments.flatMap(detectByRules), llm.persons, status);
  if (!(await saveAnonymisation(subject, plan))) return { status: 'skipped', reason: 'lost_race' };
  return {
    status,
    persons: plan.persons.length,
    mentions: plan.mentions.length,
    droppedForms: llm.droppedForms,
    models: llm.models,
    inputTokens: llm.inputTokens,
    outputTokens: llm.outputTokens,
    costUsd: llm.costUsd,
  };
}

/**
 * Resolves on success, on skip, and on unusable model output: then the rules alone are applied and the decision is
 * marked needs_manual_review (retrying would mostly pay for the same failure). Rejects on provider errors, so pg-boss
 * retries; after the last retry, anonymisationFailed runs.
 */
export async function runAnonymisation(decisionId: string, signal?: AbortSignal): Promise<AnonymisationRunResult> {
  const subject = await loadForAnonymisation(decisionId);
  if (!subject) return { status: 'skipped', reason: 'not_found' };
  if (subject.anonymisationStatus !== 'pending') return { status: 'skipped', reason: 'not_pending' };

  let llm: LlmDetection;
  try {
    llm = await detectWithLlm(segmentsOf(subject.caption, subject.chunks), subject.language, signal);
  } catch (err) {
    if (!NoObjectGeneratedError.isInstance(err)) throw err; // provider error: let pg-boss retry
    // Not err.text: the model's output is a list of names
    console.warn(`[anonymise] decision ${decisionId}: unusable model output, rules only; needs manual review`);
    return anonymise(subject, NO_LLM, 'needs_manual_review');
  }
  return anonymise(subject, llm, 'done');
}

/** Dead-letter handler: every retry failed. The rules still run (free, no provider); a reviewer reads the rest. */
export async function anonymisationFailed(decisionId: string): Promise<AnonymisationRunResult> {
  const subject = await loadForAnonymisation(decisionId);
  if (!subject) return { status: 'skipped', reason: 'not_found' };
  if (subject.anonymisationStatus !== 'pending') return { status: 'skipped', reason: 'not_pending' };
  return anonymise(subject, NO_LLM, 'needs_manual_review');
}
