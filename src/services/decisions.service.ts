import type { z } from 'zod';
import { db } from '../db/client';
import { chunks, decisions, documents } from '../db/schema';
import { env } from '../config/env';
import type { PageText } from '../interfaces/types';
import type { createDecisionSchema, decisionSchema } from '../utils/schemas';
import { HttpError } from '../utils/http-error';
import { embeddingText } from './chunker.service';
import { chunkDecision } from './decision-chunker.service';
import { embedDocuments } from './embeddings.service';
import { extractPages } from './documents.service';

export type CreateDecisionInput = z.output<typeof createDecisionSchema>;
export type DecisionView = z.input<typeof decisionSchema>;

/** "CCJA > Première chambre > Arrêt n° 045/2019": the start of every chunk's section path. No party names. */
export const decisionPathPrefix = (i: Pick<CreateDecisionInput, 'court' | 'chamber' | 'caseNumber' | 'title'>): string =>
  [i.court, i.chamber, i.caseNumber].filter(Boolean).join(' > ') || i.title;

/**
 * Stores a contributed decision as a DRAFT: document (kind 'decision') + decision row + chunks, in one transaction.
 * The chunks are embedded now, so publishing later is a status change, not an ingest that can fail.
 * A draft is invisible to every search (searchableDocuments in search.service.ts), so nothing here
 * refreshes lexeme_stats: publishing will.
 *
 * `contributorId` is an api_keys id: the legacy ADMIN_API_KEY, which has none, can't contribute.
 */
export async function ingestDecision(input: CreateDecisionInput, contributorId: string): Promise<DecisionView> {
  const { pages, pageCount } = await readDecision(input);
  const drafts = chunkDecision(pages, { lang: input.language, pathPrefix: decisionPathPrefix(input) });
  if (drafts.length === 0) {
    throw new HttpError(422, 'No text could be extracted from this decision (a scanned PDF needs OCR, which is not supported yet)');
  }
  const embeddings = await embedDocuments(drafts.map(embeddingText));

  return db.transaction(async (tx) => {
    const [doc] = await tx.insert(documents)
      .values({ kind: 'decision', title: input.title, language: input.language, sourceUrl: input.sourceUrl, pageCount })
      .returning({ id: documents.id, title: documents.title });

    const [decision] = await tx.insert(decisions)
      .values({
        documentId: doc.id,
        court: input.court, country: input.country, chamber: input.chamber,
        caseNumber: input.caseNumber, decisionDate: input.decisionDate,
        generatedBy: 'reviewer', // typed by a person; AI extraction will set 'ai'
        status: 'draft',
        sourceName: input.sourceName, sourceUrl: input.sourceUrl,
        contributedBy: contributorId,
      })
      .returning();

    await tx.insert(chunks).values(drafts.map((c, i) => ({
      ...c, documentId: doc.id, lang: input.language,
      embedding: embeddings[i], embeddingModel: env.EMBEDDING_MODEL,
    })));

    return {
      id: decision.id,
      documentId: doc.id,
      title: doc.title,
      language: input.language,
      status: decision.status,
      court: decision.court,
      country: decision.country,
      chamber: decision.chamber,
      caseNumber: decision.caseNumber,
      decisionDate: decision.decisionDate,
      sourceName: decision.sourceName,
      sourceUrl: decision.sourceUrl,
      chunkCount: drafts.length,
      createdAt: decision.createdAt,
    };
  });
}

async function readDecision(input: CreateDecisionInput): Promise<{ pages: PageText[]; pageCount: number }> {
  if (input.file) {
    const { totalPages, pages } = await extractPages(input.file);
    return { pages, pageCount: totalPages };
  }
  // The schema guarantees exactly one of file or text; pasted text has no pages, so it is "page 1"
  return { pages: [{ page: 1, text: input.text ?? '' }], pageCount: 1 };
}
