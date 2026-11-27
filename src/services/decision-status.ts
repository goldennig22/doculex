import { decisionStatus } from '../db/schema';
import { HttpError } from '../utils/http-error';

export type DecisionStatus = (typeof decisionStatus.enumValues)[number];

/**
 * The only moves a decision can make. draft → in_review is made by the anonymisation job once names are detected
 * (or by a reviewer after detection failed). published → in_review is a takedown, made only by a personal-data report
 * (decision-report.service.ts): PATCH refuses any change to a published decision before it gets here. rejected is final.
 */
export const TRANSITIONS: Record<DecisionStatus, readonly DecisionStatus[]> = {
  draft: ['in_review'],
  in_review: ['published', 'rejected'],
  published: ['in_review'],
  rejected: [],
};

export const canTransition = (from: DecisionStatus, to: DecisionStatus): boolean => TRANSITIONS[from].includes(to);

/** 409 for any other move, including staying where it is: a client that asks for it has a stale view. */
export function assertTransition(from: DecisionStatus, to: DecisionStatus): void {
  if (!canTransition(from, to)) throw new HttpError(409, `A decision can't go from ${from} to ${to}`);
}
