import { PgBoss, fromDrizzle, type DrizzleTransactionLike } from 'pg-boss';
import { sql as drizzleSql } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../config/env';

/** The job functions, passed in by server.ts: importing them here would make a cycle (job → service → queue). */
export type QueueHandlers = {
  extractDecision: (decisionId: string, signal: AbortSignal) => Promise<unknown>;
  extractionFailed: (decisionId: string, reason: string) => Promise<void>;
  anonymiseDecision: (decisionId: string, signal: AbortSignal) => Promise<unknown>;
  anonymisationFailed: (decisionId: string) => Promise<unknown>;
  embedDecision: (documentId: string) => Promise<unknown>;
  linkCitations: (decisionId: string, signal: AbortSignal) => Promise<unknown>;
};

// Background jobs, in the same Postgres as the data (schema "pgboss", created by start()).
// Same database = a job can be sent inside the transaction that creates its row: both commit, or neither.

export const EXTRACT_DECISION = 'extract-decision';
/** Receives a copy of each extract-decision job that failed all its retries. */
export const EXTRACT_DECISION_DEAD = 'extract-decision-dead';
/** Detects natural persons' names in a decision and replaces them with placeholders. */
export const ANONYMISE_DECISION = 'anonymise-decision';
export const ANONYMISE_DECISION_DEAD = 'anonymise-decision-dead';
/** Re-embeds the chunks of a document whose embedding was cleared because their text changed. */
export const EMBED_DECISION = 'embed-decision';
/** Finds the articles a decision cites and links them to the statutes (rules, then the LLM for the leftovers). */
export const LINK_CITATIONS = 'link-citations';

const DecisionJob = z.object({ decisionId: z.uuid() });
export type ExtractDecisionJob = z.infer<typeof DecisionJob>;
const EmbedJob = z.object({ documentId: z.uuid() });

const boss = new PgBoss({ connectionString: env.DATABASE_URL, max: 3, application_name: 'doculex-queue' });

// PgBoss is an EventEmitter: an 'error' event with no listener would crash the process
boss.on('error', (err) => console.error('[queue]', err));

/** Provider errors (timeout, 429, 5xx) retry; bad model output does not (handled in the jobs). */
const LLM_JOB = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,     // 30 s, 60 s, 120 s…
  // Above the worst case of the fallback chain (3 models × timeout + retries). If a job outlives this,
  // pg-boss hands it to another worker while the first is still running: the handler must be idempotent anyway.
  expireInSeconds: 300,
};

/**
 * Creates the queues and starts the worker. Called from server.ts only: tests and scripts build the app
 * without a worker, so importing this module never connects to anything.
 */
export async function startQueue(handlers: QueueHandlers): Promise<void> {
  await boss.start();

  await boss.createQueue(EXTRACT_DECISION_DEAD, { retryLimit: 3, retryDelay: 60 });
  await boss.createQueue(EXTRACT_DECISION, { ...LLM_JOB, deadLetter: EXTRACT_DECISION_DEAD });
  await boss.createQueue(ANONYMISE_DECISION_DEAD, { retryLimit: 3, retryDelay: 60 });
  // Detection makes one LLM call per ~12k tokens of decision: a long one takes several
  await boss.createQueue(ANONYMISE_DECISION, { ...LLM_JOB, expireInSeconds: 900, deadLetter: ANONYMISE_DECISION_DEAD });
  // No dead letter: if every retry fails, the embeddings stay NULL, publish answers 409 and enqueues a new job
  await boss.createQueue(EMBED_DECISION, { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 300 });
  // No dead letter: the rules' links are saved before the LLM call, so a job that fails every retry leaves the
  // unresolved references 'low', which is where a reviewer looks anyway
  await boss.createQueue(LINK_CITATIONS, LLM_JOB);

  // The handler's return value is stored as the job's `output` (model, tokens, cost) in pgboss.job
  await boss.work(EXTRACT_DECISION, async ([job]) => {
    const { decisionId } = DecisionJob.parse(job.data);
    return handlers.extractDecision(decisionId, job.signal);
  });

  // Retries exhausted: the decision must not stay 'pending' forever
  await boss.work(EXTRACT_DECISION_DEAD, async ([job]) => {
    const { decisionId } = DecisionJob.parse(job.data);
    await handlers.extractionFailed(decisionId, 'Extraction failed after all retries; see pgboss.job for the error');
  });

  await boss.work(ANONYMISE_DECISION, async ([job]) => {
    const { decisionId } = DecisionJob.parse(job.data);
    return handlers.anonymiseDecision(decisionId, job.signal);
  });

  // Retries exhausted: the rules still run (free, no provider), and a reviewer must read the whole text
  await boss.work(ANONYMISE_DECISION_DEAD, async ([job]) => {
    const { decisionId } = DecisionJob.parse(job.data);
    return handlers.anonymisationFailed(decisionId);
  });

  await boss.work(EMBED_DECISION, async ([job]) => {
    const { documentId } = EmbedJob.parse(job.data);
    return handlers.embedDecision(documentId);
  });

  await boss.work(LINK_CITATIONS, async ([job]) => {
    const { decisionId } = DecisionJob.parse(job.data);
    return handlers.linkCitations(decisionId, job.signal);
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

/** Enqueues name detection for a decision, in the transaction that inserts it (same reasons as enqueueExtraction). */
export async function enqueueAnonymisation(decisionId: string, tx: DrizzleTransactionLike): Promise<string | null> {
  return boss.send(ANONYMISE_DECISION, { decisionId }, { db: fromDrizzle(tx, drizzleSql) });
}

/**
 * Enqueues re-embedding of a document's chunks that have no embedding. Pass the transaction that cleared them, so
 * the job never runs before the new text is committed. Without a transaction (publish found NULL embeddings and
 * nothing will change them otherwise), it is sent on its own.
 */
/**
 * Enqueues citation linking, in the transaction where the anonymisation job saves its result: the job then never
 * reads the text before its names are replaced, and the LLM pass never sees a clear name.
 */
export async function enqueueCitationLinking(decisionId: string, tx: DrizzleTransactionLike): Promise<string | null> {
  return boss.send(LINK_CITATIONS, { decisionId }, { db: fromDrizzle(tx, drizzleSql) });
}

export async function enqueueEmbedding(documentId: string, tx?: DrizzleTransactionLike): Promise<string | null> {
  return boss.send(EMBED_DECISION, { documentId }, tx ? { db: fromDrizzle(tx, drizzleSql) } : {});
}
