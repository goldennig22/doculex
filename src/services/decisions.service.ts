import type { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { chunks, decisions, documents } from '../db/schema';
import { env } from '../config/env';
import type { Lang, PageText } from '../interfaces/types';
import { langSchema, type createDecisionSchema, type decisionSchema } from '../utils/schemas';
import { HttpError } from '../utils/http-error';
import { embeddingText } from './chunker.service';
import { chunkDecision, findCaption } from './decision-chunker.service';
import type { ChunkText, DecisionMetadata } from './decision-extraction.service';
import { enqueueExtraction } from '../jobs/queue';
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
        generatedBy: 'reviewer', // typed by a person; the extraction job sets 'ai' if it fills a field
        captionText: findCaption(pages, input.language), // for the extraction job; see the schema
        extractionStatus: 'pending',
        status: 'draft',
        sourceName: input.sourceName, sourceUrl: input.sourceUrl,
        contributedBy: contributorId,
      })
      .returning();

    await tx.insert(chunks).values(drafts.map((c, i) => ({
      ...c, documentId: doc.id, lang: input.language,
      embedding: embeddings[i], embeddingModel: env.EMBEDDING_MODEL,
    })));

    // Same transaction: the job exists only if the decision does, and no worker sees it before the commit
    await enqueueExtraction(decision.id, tx);

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
      extractionStatus: decision.extractionStatus,
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

// ── AI metadata extraction (used by src/jobs/extract-decision.job.ts) ──────────────────────────────

export type ExtractionSubject = {
  decisionId: string;
  language: Lang;
  extractionStatus: 'pending' | 'done' | 'needs_manual_entry';
  captionText: string | null;
  chunks: ChunkText[];
};

/** What the job needs to extract a decision's metadata; null when the decision was deleted after the upload. */
export async function loadForExtraction(decisionId: string): Promise<ExtractionSubject | null> {
  const [row] = await db
    .select({
      documentId: decisions.documentId,
      extractionStatus: decisions.extractionStatus,
      captionText: decisions.captionText,
      language: documents.language,
    })
    .from(decisions)
    .innerJoin(documents, eq(documents.id, decisions.documentId))
    .where(eq(decisions.id, decisionId));
  if (!row) return null;

  const parts = await db
    .select({ articleRef: chunks.articleRef, part: chunks.part, content: chunks.content })
    .from(chunks)
    .where(eq(chunks.documentId, row.documentId));

  return {
    decisionId,
    language: langSchema.parse(row.language),
    extractionStatus: row.extractionStatus,
    captionText: row.captionText,
    chunks: parts,
  };
}

/** `value` as a typed parameter: postgres-js sends strings untyped, and COALESCE(enum, text) would fail. */
const param = (value: string | null, type: 'text' | 'date' | 'decision_outcome') => sql`${value}::${sql.raw(type)}`;

/**
 * Writes the AI's metadata, once. Two rules, both in the one UPDATE:
 *   - AI never overwrites a person: each column keeps its value when it has one (COALESCE);
 *   - only a 'pending' decision is written: a second run of the job (pg-boss is at-least-once) changes nothing.
 * generated_by becomes 'ai' only if the AI filled at least one empty column. The caption is cleared: its job is done.
 * Returns false when the decision was no longer pending (another run won, or it was deleted).
 */
export async function saveExtraction(decisionId: string, m: DecisionMetadata): Promise<boolean> {
  const fields = [
    [decisions.court, param(m.court, 'text')],
    [decisions.country, param(m.country, 'text')],
    [decisions.chamber, param(m.chamber, 'text')],
    [decisions.caseNumber, param(m.caseNumber, 'text')],
    [decisions.decisionDate, param(m.decisionDate, 'date')],
    [decisions.subject, param(m.subject, 'text')],
    [decisions.outcome, param(m.outcome, 'decision_outcome')],
    [decisions.headnote, param(m.headnote, 'text')],
  ] as const;
  const fill = (i: number) => sql`coalesce(${fields[i][0]}, ${fields[i][1]})`;
  // Column references on the right of SET read the row as it was before this UPDATE
  const aiFilledOne = sql.join(fields.map(([col, value]) => sql`(${col} is null and ${value} is not null)`), sql` or `);

  const updated = await db.update(decisions)
    .set({
      court: fill(0), country: fill(1), chamber: fill(2), caseNumber: fill(3),
      decisionDate: fill(4), subject: fill(5), outcome: fill(6), headnote: fill(7),
      generatedBy: sql`case when ${aiFilledOne} then 'ai'::generated_by else ${decisions.generatedBy} end`,
      extractionStatus: 'done',
      extractionError: null,
      captionText: null,
    })
    .where(and(eq(decisions.id, decisionId), eq(decisions.extractionStatus, 'pending')))
    .returning({ id: decisions.id });
  return updated.length > 0;
}

/**
 * A person has to type the metadata: the model's output was unusable, or every retry failed.
 * The caption is kept, since the reviewer needs it. Only a 'pending' decision changes, so a late failure
 * never overwrites a run that succeeded. Returns false when nothing changed.
 */
export async function markNeedsManualEntry(decisionId: string, reason: string): Promise<boolean> {
  const updated = await db.update(decisions)
    .set({ extractionStatus: 'needs_manual_entry', extractionError: reason })
    .where(and(eq(decisions.id, decisionId), eq(decisions.extractionStatus, 'pending')))
    .returning({ id: decisions.id });
  return updated.length > 0;
}
