import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { db } from '../../db/client';
import { chunks, decisionCitations, decisions, documents } from '../../db/schema';
import type { Lang } from '../../interfaces/types';
import { langSchema } from '../../utils/schemas';
import { segmentsOf } from '../anonymisation/anonymisation.service';
import type { Segment } from '../anonymisation/mentions';
import type { ActCode } from './acts';
import type { DetectionFlag } from './detector';
import { articleKey, gradeCitation, versionKey, type ArticleIndex } from './grading';

// What the link-citations job and the publish step read and write. The pure parts (detector, grading) know nothing
// of the database; this file feeds them.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type LinkingSubject = {
  decisionId: string;
  status: 'draft' | 'in_review' | 'published' | 'rejected';
  decisionDate: string | null;
  language: Lang;
  /** The decision's sections in reading order. Never the caption: it is never published. */
  segments: Segment[];
};

export async function loadForLinking(decisionId: string): Promise<LinkingSubject | null> {
  const [row] = await db
    .select({ status: decisions.status, decisionDate: decisions.decisionDate, documentId: decisions.documentId, language: documents.language })
    .from(decisions)
    .innerJoin(documents, eq(documents.id, decisions.documentId))
    .where(eq(decisions.id, decisionId));
  if (!row) return null;
  const parts = await db
    .select({ id: chunks.id, articleRef: chunks.articleRef, part: chunks.part, content: chunks.content })
    .from(chunks)
    .where(eq(chunks.documentId, row.documentId));
  return {
    decisionId, status: row.status, decisionDate: row.decisionDate,
    language: langSchema.parse(row.language), segments: segmentsOf(null, parts),
  };
}

/** The act versions held by a statute, and their articles, for the acts given. */
export async function loadArticleIndex(codes: readonly ActCode[], executor: Executor = db): Promise<ArticleIndex> {
  const versions = new Set<string>();
  const articles = new Set<string>();
  if (codes.length === 0) return { versions, articles };
  const rows = await executor
    .selectDistinct({ code: documents.actCode, version: documents.actVersion, ref: chunks.articleRef })
    .from(documents)
    .leftJoin(chunks, eq(chunks.documentId, documents.id))
    .where(and(eq(documents.kind, 'statute'), inArray(documents.actCode, [...codes])));
  for (const r of rows) {
    if (r.code === null || r.version === null) continue;
    versions.add(versionKey(r.code, r.version));
    if (r.ref !== null) articles.add(articleKey(r.code, r.version, r.ref));
  }
  return { versions, articles };
}

export type NewCitation = Omit<typeof decisionCitations.$inferInsert, 'id' | 'createdAt' | 'decisionId'>;

/**
 * Replaces what the rules and the LLM found for a decision; a reviewer's rows are kept. The decision row is locked,
 * so two overlapping runs of the job (pg-boss runs a job at least once) can't both insert.
 */
export async function replaceDetectedCitations(decisionId: string, rows: NewCitation[]): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ id: decisions.id }).from(decisions).where(eq(decisions.id, decisionId)).for('update');
    if (!locked) return false;
    await tx.delete(decisionCitations)
      .where(and(eq(decisionCitations.decisionId, decisionId), ne(decisionCitations.method, 'reviewer')));
    if (rows.length > 0) await tx.insert(decisionCitations).values(rows.map((r) => ({ ...r, decisionId })));
    return true;
  });
}

/**
 * Grades a decision's detected citations again, with the date it is published with (the job may have run before
 * extraction filled it, or a reviewer may have corrected it). No LLM: only the version and confidence can change.
 * Called inside the publish transaction, which holds the decision row lock.
 */
export async function regradeCitations(tx: Tx, decisionId: string, decisionDate: string): Promise<void> {
  const rows = await tx.select().from(decisionCitations)
    .where(and(eq(decisionCitations.decisionId, decisionId), ne(decisionCitations.method, 'reviewer')));
  const codes = [...new Set(rows.flatMap((r) => (r.actCode ? [r.actCode] : [])))];
  const index = await loadArticleIndex(codes, tx);
  for (const r of rows) {
    if (r.method === 'reviewer') continue; // excluded by the query; narrows the type for gradeCitation
    // range_not_expanded is only ever recorded as the reason, which is how it is found again here
    const flags: DetectionFlag[] = r.reason === 'range_not_expanded' ? ['range_not_expanded'] : [];
    const grade = gradeCitation(
      { articleRef: r.articleRef, actCode: r.actCode, actSource: r.actSource, versionHint: r.versionHint, flags, method: r.method },
      decisionDate, index,
    );
    if (grade.actVersion !== r.actVersion || grade.confidence !== r.confidence || grade.reason !== r.reason) {
      await tx.update(decisionCitations).set(grade).where(eq(decisionCitations.id, r.id));
    }
  }
}

/** Grades every detected citation of every decision again: after a statute version is uploaded, for instance. */
export async function regradeAllCitations(): Promise<number> {
  const rows = await db
    .selectDistinct({ id: decisions.id })
    .from(decisions)
    .innerJoin(decisionCitations, eq(decisionCitations.decisionId, decisions.id))
    .where(isNotNull(decisions.decisionDate));
  for (const r of rows) {
    await db.transaction(async (tx) => {
      // Read the date under the lock: a reviewer may be changing it
      const [locked] = await tx.select({ date: decisions.decisionDate }).from(decisions).where(eq(decisions.id, r.id)).for('update');
      if (locked?.date) await regradeCitations(tx, r.id, locked.date);
    });
  }
  return rows.length;
}
