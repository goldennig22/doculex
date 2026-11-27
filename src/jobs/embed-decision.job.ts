import { embedMissingChunks } from '../services/decisions.service';

/**
 * The embed-decision job: embeds the chunks of a document whose text changed (anonymisation, a reviewer's edit).
 * Idempotent: it only touches chunks with no embedding, and only if their text is still the one it embedded.
 * Provider errors reject, so pg-boss retries.
 */
export async function runEmbedDecision(documentId: string): Promise<{ embedded: number; stale: number }> {
  return embedMissingChunks(documentId);
}
