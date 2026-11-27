import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { chunks, decisions, documents, nameMentions } from '../../db/schema';
import type { Lang } from '../../interfaces/types';
import { langSchema } from '../../utils/schemas';
import { enqueueCitationLinking, enqueueEmbedding } from '../../jobs/queue';
import { sectionRank } from '../decision-chunker.service';
import {
  CAPTION_SEGMENT, anonymiseFreeText, applyMentions, buildMentions,
  type Candidate, type DetectedMention, type Person, type Segment,
} from './mentions';
import { nameHash } from './names';

// What the anonymise-decision job reads and writes. Same rules as the extraction job:
// only a 'pending' decision is written, with a conditional UPDATE, and no transaction is held across the LLM call.

export type SubjectChunk = { id: string; articleRef: string; part: number; content: string; sectionPath: string | null };
export type AnonymisationSubject = {
  decisionId: string;
  documentId: string;
  language: Lang;
  title: string;
  anonymisationStatus: 'pending' | 'done' | 'needs_manual_review';
  caption: string | null;
  chunks: SubjectChunk[];
};

export async function loadForAnonymisation(decisionId: string): Promise<AnonymisationSubject | null> {
  const [row] = await db
    .select({
      documentId: decisions.documentId,
      anonymisationStatus: decisions.anonymisationStatus,
      caption: decisions.captionText,
      language: documents.language,
      title: documents.title,
    })
    .from(decisions)
    .innerJoin(documents, eq(documents.id, decisions.documentId))
    .where(eq(decisions.id, decisionId));
  if (!row) return null;

  const parts = await db
    .select({ id: chunks.id, articleRef: chunks.articleRef, part: chunks.part, content: chunks.content, sectionPath: chunks.sectionPath })
    .from(chunks)
    .where(eq(chunks.documentId, row.documentId));

  return { decisionId, ...row, language: langSchema.parse(row.language), chunks: parts };
}

/** Caption first, then the chunks in reading order: placeholders are given by first appearance in this order. */
export function segmentsOf(caption: string | null, parts: Pick<SubjectChunk, 'id' | 'articleRef' | 'part' | 'content'>[]): Segment[] {
  const ordered = [...parts].sort((a, b) => sectionRank(a.articleRef) - sectionRank(b.articleRef) || a.part - b.part);
  return [
    ...(caption ? [{ id: CAPTION_SEGMENT, text: caption }] : []),
    ...ordered.map((c) => ({ id: c.id, text: c.content })),
  ];
}

export type AnonymisationPlan = {
  status: 'done' | 'needs_manual_review';
  persons: Person[];
  caption: string | null;
  /** Only the chunks whose content or section path changed. */
  chunks: { id: string; content: string; sectionPath: string | null }[];
  title: string;
  /** Offsets on the placeholders, in the new texts; `surface` is the clear name. */
  mentions: DetectedMention[];
};

/** Pure: detection results → the texts and mention rows to write. */
export function planAnonymisation(
  subject: AnonymisationSubject, rule: Candidate[], llm: { forms: string[] }[], status: AnonymisationPlan['status'],
): AnonymisationPlan {
  const segments = segmentsOf(subject.caption, subject.chunks);
  const { persons, mentions: found } = buildMentions(segments, rule, llm);
  const { texts, mentions } = applyMentions(segments, found);

  const changed: AnonymisationPlan['chunks'] = [];
  for (const c of subject.chunks) {
    const content = texts.get(c.id) ?? c.content;
    const sectionPath = c.sectionPath === null ? null : anonymiseFreeText(c.sectionPath, persons);
    if (content !== c.content || sectionPath !== c.sectionPath) changed.push({ id: c.id, content, sectionPath });
  }
  return {
    status,
    persons,
    caption: subject.caption === null ? null : texts.get(CAPTION_SEGMENT) ?? subject.caption,
    chunks: changed,
    title: anonymiseFreeText(subject.title, persons),
    mentions,
  };
}

/**
 * Writes the plan once, in one transaction:
 *   - the decision, only if still 'pending' (a second run of the job changes nothing); with 'done' it moves to
 *     in_review, ready for a reviewer; with 'needs_manual_review' it stays a draft until a reviewer takes it;
 *   - the anonymised caption, chunks (embedding cleared: it was computed from the clear names), title, and the
 *     subject/headnote if extraction already wrote them;
 *   - one name_mentions row per occurrence, unconfirmed, with the clear name and its HMAC;
 *   - a re-embedding job, sent in the same transaction.
 * Returns false when the decision was no longer pending (another run won, or it was deleted).
 */
export async function saveAnonymisation(subject: AnonymisationSubject, plan: AnonymisationPlan): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [won] = await tx.update(decisions)
      .set({
        anonymisationStatus: plan.status,
        ...(plan.status === 'done' ? { status: 'in_review' as const } : {}),
        captionText: plan.caption,
      })
      .where(and(
        eq(decisions.id, subject.decisionId),
        eq(decisions.anonymisationStatus, 'pending'),
        eq(decisions.status, 'draft'),
      ))
      .returning({ subject: decisions.subject, headnote: decisions.headnote });
    if (!won) return false;

    // Extraction runs alongside and may have written these already, from the clear text
    const subjectText = won.subject === null ? null : anonymiseFreeText(won.subject, plan.persons);
    const headnote = won.headnote === null ? null : anonymiseFreeText(won.headnote, plan.persons);
    if (subjectText !== won.subject || headnote !== won.headnote) {
      await tx.update(decisions).set({ subject: subjectText, headnote }).where(eq(decisions.id, subject.decisionId));
    }

    for (const c of plan.chunks) {
      await tx.update(chunks)
        .set({ content: c.content, sectionPath: c.sectionPath, embedding: null, embeddingModel: null })
        .where(eq(chunks.id, c.id));
    }
    if (plan.title !== subject.title) {
      await tx.update(documents).set({ title: plan.title }).where(eq(documents.id, subject.documentId));
    }
    if (plan.mentions.length > 0) {
      await tx.insert(nameMentions).values(plan.mentions.map((m) => ({
        decisionId: subject.decisionId,
        chunkId: m.segmentId === CAPTION_SEGMENT ? null : m.segmentId,
        start: m.start,
        end: m.end,
        placeholder: m.placeholder,
        originalHash: nameHash(subject.decisionId, m.surface),
        originalText: m.surface,
        source: m.source,
      })));
    }
    if (plan.chunks.length > 0) await enqueueEmbedding(subject.documentId, tx);
    // Only now is the text anonymised: the citation job (and its LLM pass) never reads a clear name
    await enqueueCitationLinking(subject.decisionId, tx);
    return true;
  });
}
