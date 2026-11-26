import { NoObjectGeneratedError } from 'ai';
import { buildExtractionInput, extractMetadata } from '../services/decision-extraction.service';
import { loadForExtraction, markNeedsManualEntry, saveExtraction } from '../services/decisions.service';

// The extract-decision job: what the pg-boss worker runs for each uploaded decision (wired in src/jobs/queue.ts).
//
// pg-boss is at-least-once: a job can run twice (it expired while still running, the process died before
// pg-boss recorded the completion, it was enqueued twice). Running it twice must equal running it once:
//   1. skip a decision that is no longer 'pending' (saves the LLM call);
//   2. write with a conditional UPDATE (… WHERE extraction_status = 'pending'): if two runs overlap,
//      both may pay for the LLM, but only one writes. Step 1 alone can't stop that: both pass the check.
//   3. no transaction is held open across the LLM call (up to ~90 s with the fallback chain).

export type ExtractionRunResult =
  | { status: 'done'; model: string; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; dropped: string[] }
  | { status: 'skipped'; reason: 'not_found' | 'not_pending' | 'lost_race' }
  | { status: 'needs_manual_entry'; reason: string };

/**
 * Resolves on success, on skip, and on unusable model output (NoObjectGeneratedError: retrying would mostly pay
 * for the same failure, so a person types the fields). Rejects on provider errors (timeout, 429, 5xx), so that
 * pg-boss retries. The returned value is stored as the job's `output` in pgboss.job: model, tokens, cost.
 */
export async function runDecisionExtraction(decisionId: string, signal?: AbortSignal): Promise<ExtractionRunResult> {
  const subject = await loadForExtraction(decisionId);
  if (!subject) return { status: 'skipped', reason: 'not_found' };          // deleted after the upload
  if (subject.extractionStatus !== 'pending') return { status: 'skipped', reason: 'not_pending' };

  const input = buildExtractionInput(subject.captionText, subject.chunks);

  let result: Awaited<ReturnType<typeof extractMetadata>>;
  try {
    result = await extractMetadata(input, subject.language, signal);
  } catch (err) {
    if (!NoObjectGeneratedError.isInstance(err)) throw err;                  // provider error: let pg-boss retry
    const reason = `The model's output did not match the extraction schema: ${err.message}`;
    console.warn(`[extract] decision ${decisionId}: ${reason}`, { text: err.text?.slice(0, 500) });
    const marked = await markNeedsManualEntry(decisionId, reason);
    return marked ? { status: 'needs_manual_entry', reason } : { status: 'skipped', reason: 'lost_race' };
  }

  const saved = await saveExtraction(decisionId, result.metadata);
  if (!saved) return { status: 'skipped', reason: 'lost_race' };
  return {
    status: 'done',
    model: result.model,
    inputTokens: result.usage.inputTokens ?? null,
    outputTokens: result.usage.outputTokens ?? null,
    costUsd: result.costUsd,
    dropped: result.dropped.map((d) => `${d.field}: ${d.reason}`),
  };
}

/** Dead-letter handler: every retry failed. A no-op if the decision is no longer pending. */
export async function markExtractionFailed(decisionId: string, reason: string): Promise<void> {
  await markNeedsManualEntry(decisionId, reason);
}
