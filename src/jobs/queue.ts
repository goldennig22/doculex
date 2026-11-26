import { PgBoss, fromDrizzle, type DrizzleTransactionLike } from 'pg-boss';
import { sql as drizzleSql } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../config/env';

/** The job functions, passed in by server.ts: importing them here would make a cycle (job → service → queue). */
export type QueueHandlers = {
  extractDecision: (decisionId: string, signal: AbortSignal) => Promise<unknown>;
  extractionFailed: (decisionId: string, reason: string) => Promise<void>;
};

// Background jobs, in the same Postgres as the data (schema "pgboss", created by start()).
// Same database = a job can be sent inside the transaction that creates its row: both commit, or neither.

export const EXTRACT_DECISION = 'extract-decision';
/** Receives a copy of each extract-decision job that failed all its retries. */
export const EXTRACT_DECISION_DEAD = 'extract-decision-dead';

const ExtractDecisionJob = z.object({ decisionId: z.uuid() });
export type ExtractDecisionJob = z.infer<typeof ExtractDecisionJob>;

const boss = new PgBoss({ connectionString: env.DATABASE_URL, max: 3, application_name: 'doculex-queue' });

// PgBoss is an EventEmitter: an 'error' event with no listener would crash the process
boss.on('error', (err) => console.error('[queue]', err));

/**
 * Creates the queues and starts the worker. Called from server.ts only: tests and scripts build the app
 * without a worker, so importing this module never connects to anything.
 */
export async function startQueue(handlers: QueueHandlers): Promise<void> {
  await boss.start();

  await boss.createQueue(EXTRACT_DECISION_DEAD, { retryLimit: 3, retryDelay: 60 });
  await boss.createQueue(EXTRACT_DECISION, {
    retryLimit: 3,          // provider errors (timeout, 429, 5xx) retry; bad model output does not (handled in the job)
    retryDelay: 30,
    retryBackoff: true,     // 30 s, 60 s, 120 s…
    // Above the worst case of the fallback chain (3 models × timeout + retries). If a job outlives this,
    // pg-boss hands it to another worker while the first is still running: the handler must be idempotent anyway.
    expireInSeconds: 300,
    deadLetter: EXTRACT_DECISION_DEAD,
  });

  // The handler's return value is stored as the job's `output` (model, tokens, cost) in pgboss.job
  await boss.work(EXTRACT_DECISION, async ([job]) => {
    const { decisionId } = ExtractDecisionJob.parse(job.data);
    return handlers.extractDecision(decisionId, job.signal);
  });

  // Retries exhausted: the decision must not stay 'pending' forever
  await boss.work(EXTRACT_DECISION_DEAD, async ([job]) => {
    const { decisionId } = ExtractDecisionJob.parse(job.data);
    await handlers.extractionFailed(decisionId, 'Extraction failed after all retries; see pgboss.job for the error');
  });
}

/** Lets a running job finish (up to 30 s); a job still running after that expires and is retried. */
export async function stopQueue(): Promise<void> {
  await boss.stop({ graceful: true, timeout: 30_000 });
}

/**
 * Enqueues metadata extraction for a decision. Pass the transaction that inserts the decision:
 * the job then only exists if the decision does, and no worker can pick it up before the commit.
 */
export async function enqueueExtraction(decisionId: string, tx: DrizzleTransactionLike): Promise<string | null> {
  const data: ExtractDecisionJob = { decisionId };
  return boss.send(EXTRACT_DECISION, data, { db: fromDrizzle(tx, drizzleSql) });
}
