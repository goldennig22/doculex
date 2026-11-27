import { NoObjectGeneratedError } from 'ai';
import type { ActCode } from '../services/citations/acts';
import { detectInDecision, type SegmentCitation } from '../services/citations/detector';
import { gradeCitation, type ArticleIndex } from '../services/citations/grading';
import { excerptAround, linkWithLlm, type LinkingItem, type LlmLinking } from '../services/citations/llm-linking';
import {
  loadArticleIndex, loadForLinking, replaceDetectedCitations, type NewCitation,
} from '../services/citations/citations.service';

// The link-citations job: finds the articles a decision cites (rules), asks the LLM only about the references the
// rules left without an act, grades each link and stores them all, the unresolved ones included ('low', for review).
// Enqueued by the anonymisation job when it saves, so the LLM only ever reads anonymised text. Wired in queue.ts.
//
// Idempotent: each run replaces the rule and LLM rows of the decision (reviewer rows stay), under the decision lock.
// The rules' rows are saved BEFORE the LLM call: if the provider never answers, the decision still has its links.

export type LinkingRunResult =
  | {
    status: 'done';
    citations: number; low: number;
    sentToLlm: number; resolvedByLlm: number; droppedByLlm: number;
    model: string | null; inputTokens: number; outputTokens: number; costUsd: number | null;
  }
  | { status: 'skipped'; reason: 'not_found' | 'rejected' };

/** One LLM question per mention, not per article: "articles 13 à 15" is one span. */
const spanKey = (c: Pick<SegmentCitation, 'segmentId' | 'start'>) => `${c.segmentId}:${c.start}`;

/** Pure: detected citations (plus the acts the LLM found, by span) to graded rows. */
export function toCitationRows(
  detected: readonly SegmentCitation[],
  llmActs: ReadonlyMap<string, ActCode>,
  decisionDate: string | null,
  index: ArticleIndex,
): NewCitation[] {
  return detected.map((c) => {
    const llmAct = c.actCode === null ? llmActs.get(spanKey(c)) : undefined;
    const input = llmAct
      ? { ...c, actCode: llmAct, actSource: null, method: 'llm' as const }
      : { ...c, method: 'rule' as const };
    const grade = gradeCitation(input, decisionDate, index);
    return {
      chunkId: c.segmentId,
      actCode: input.actCode,
      articleRef: c.articleRef,
      rawText: c.rawText,
      actSource: input.actSource,
      versionHint: c.versionHint,
      method: input.method,
      ...grade,
    };
  });
}

const codesOf = (detected: readonly SegmentCitation[], extra: Iterable<ActCode> = []) =>
  [...new Set([...detected.flatMap((c) => (c.actCode ? [c.actCode] : [])), ...extra])];

/**
 * Resolves on success, on skip, and on unusable model output (the rules' rows stay, unresolved ones 'low').
 * Rejects on provider errors so pg-boss retries; the rules' rows are saved by then.
 */
export async function runCitationLinking(decisionId: string, signal?: AbortSignal): Promise<LinkingRunResult> {
  const subject = await loadForLinking(decisionId);
  if (!subject) return { status: 'skipped', reason: 'not_found' };
  if (subject.status === 'rejected') return { status: 'skipped', reason: 'rejected' };

  const detected = detectInDecision(subject.segments);
  let rows = toCitationRows(detected, new Map(), subject.decisionDate, await loadArticleIndex(codesOf(detected)));
  if (!(await replaceDetectedCitations(decisionId, rows))) return { status: 'skipped', reason: 'not_found' };

  const textOf = new Map(subject.segments.map((s) => [s.id, s.text]));
  const spans = new Map<string, SegmentCitation>();
  for (const c of detected) if (c.actCode === null && !spans.has(spanKey(c))) spans.set(spanKey(c), c);
  const summary = (llm: LlmLinking | null): LinkingRunResult => ({
    status: 'done',
    citations: rows.length,
    low: rows.filter((r) => r.confidence === 'low').length,
    sentToLlm: llm ? spans.size : 0,
    resolvedByLlm: llm?.resolved.size ?? 0,
    droppedByLlm: llm?.dropped ?? 0,
    model: llm?.model ?? null,
    inputTokens: llm?.inputTokens ?? 0,
    outputTokens: llm?.outputTokens ?? 0,
    costUsd: llm ? llm.costUsd : 0,
  });
  if (spans.size === 0) return summary(null);

  const keys = [...spans.keys()];
  const items: LinkingItem[] = keys.map((key, i) => {
    const c = spans.get(key)!;
    return { id: i + 1, rawText: c.rawText, excerpt: excerptAround(textOf.get(c.segmentId)!, c.start, c.end) };
  });

  let llm: LlmLinking;
  try {
    llm = await linkWithLlm(items, subject.language, signal);
  } catch (err) {
    if (!NoObjectGeneratedError.isInstance(err)) throw err; // provider error: let pg-boss retry
    console.warn(`[citations] decision ${decisionId}: unusable model output; ${spans.size} reference(s) stay unresolved`);
    return summary(null);
  }
  if (llm.resolved.size > 0) {
    const llmActs = new Map([...llm.resolved].map(([id, code]) => [keys[id - 1], code]));
    const index = await loadArticleIndex(codesOf(detected, llm.resolved.values()));
    rows = toCitationRows(detected, llmActs, subject.decisionDate, index);
    await replaceDetectedCitations(decisionId, rows);
  }
  return summary(llm);
}
