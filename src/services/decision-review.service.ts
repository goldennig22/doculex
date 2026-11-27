import type { z } from 'zod';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { chunks, decisions, documents, nameMentions } from '../db/schema';
import { langSchema, type reviewPatchSchema, type reviewViewSchema } from '../utils/schemas';
import { HttpError } from '../utils/http-error';
import { enqueueEmbedding } from '../jobs/queue';
import { sectionRank } from './decision-chunker.service';
import { refreshLexemeStats } from './documents.service';
import { assertTransition } from './decision-status';
import {
  CAPTION_SEGMENT, anonymiseFreeText, locateForms, nextFreePlaceholder, replaceSpan,
} from './anonymisation/mentions';
import { findLeaks, nameHash } from './anonymisation/names';
import { regradeCitations } from './citations/citations.service';

// The human step between upload and publication: a reviewer fixes the metadata, confirms or corrects each name
// mention, then publishes. Every function locks the decision row (SELECT … FOR UPDATE) for its whole transaction:
// two reviewers editing one decision would otherwise corrupt each other's mention offsets.

export type ReviewPatch = z.output<typeof reviewPatchSchema>;
export type ReviewView = z.input<typeof reviewViewSchema>;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockDecision(tx: Tx, decisionId: string) {
  const [row] = await tx
    .select({
      id: decisions.id, documentId: decisions.documentId, status: decisions.status,
      anonymisationStatus: decisions.anonymisationStatus, contributedBy: decisions.contributedBy,
      caption: decisions.captionText, court: decisions.court, chamber: decisions.chamber,
      caseNumber: decisions.caseNumber, decisionDate: decisions.decisionDate,
      subject: decisions.subject, headnote: decisions.headnote, title: documents.title,
    })
    .from(decisions)
    .innerJoin(documents, eq(documents.id, decisions.documentId))
    .where(eq(decisions.id, decisionId))
    .for('update');
  if (!row) throw new HttpError(404, 'Decision not found');
  return row;
}

type Locked = Awaited<ReturnType<typeof lockDecision>>;

/** Four eyes, checked here so it is a 403, not the 500 of the decisions_reviewer_not_contributor CHECK. */
function assertNotContributor(row: Locked, reviewerId: string): void {
  if (row.contributedBy === reviewerId) throw new HttpError(403, 'Nobody reviews their own upload');
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────────

const CONTEXT_CHARS = 60;

/** A boolean, so the 1536 floats of each vector are not read just to test them for NULL. */
const notEmbedded = sql<boolean>`${chunks.embedding} IS NULL`;

/** Everything a reviewer needs: metadata, the whole anonymised text, and each mention with its context. */
export async function getForReview(decisionId: string): Promise<ReviewView> {
  const [row] = await db
    .select({ d: decisions, title: documents.title, language: documents.language })
    .from(decisions)
    .innerJoin(documents, eq(documents.id, decisions.documentId))
    .where(eq(decisions.id, decisionId));
  if (!row) throw new HttpError(404, 'Decision not found');
  const d = row.d;

  const parts = (await db
    .select({ id: chunks.id, ref: chunks.articleRef, part: chunks.part, text: chunks.content, missing: notEmbedded })
    .from(chunks)
    .where(eq(chunks.documentId, d.documentId)))
    .sort((a, b) => sectionRank(a.ref) - sectionRank(b.ref) || a.part - b.part);
  const mentions = await db.select().from(nameMentions).where(eq(nameMentions.decisionId, decisionId));

  const position = new Map(parts.map((p, i) => [p.id, { index: i + 1, p }]));
  const located = mentions.map((m) => {
    const chunk = m.chunkId ? position.get(m.chunkId) : undefined;
    const text = chunk ? chunk.p.text : d.captionText ?? '';
    return {
      order: chunk?.index ?? 0,
      view: {
        id: m.id,
        placeholder: m.placeholder,
        segment: chunk ? (chunk.p.part > 0 ? `${chunk.p.ref} (part ${chunk.p.part + 1})` : chunk.p.ref) : CAPTION_SEGMENT,
        start: m.start,
        end: m.end,
        context: text.slice(Math.max(0, m.start - CONTEXT_CHARS), m.end + CONTEXT_CHARS),
        original: m.originalText,
        source: m.source,
        confirmed: m.confirmed,
      },
    };
  }).sort((a, b) => a.order - b.order || a.view.start - b.view.start);

  return {
    id: d.id,
    documentId: d.documentId,
    title: row.title,
    language: langSchema.parse(row.language),
    status: d.status,
    anonymisationStatus: d.anonymisationStatus,
    extractionStatus: d.extractionStatus,
    court: d.court,
    country: d.country,
    chamber: d.chamber,
    caseNumber: d.caseNumber,
    decisionDate: d.decisionDate,
    subject: d.subject,
    outcome: d.outcome,
    headnote: d.headnote,
    caption: d.captionText,
    sections: parts.map((p) => ({ ref: p.ref, part: p.part, text: p.text })),
    unconfirmedMentions: mentions.filter((m) => !m.confirmed).length,
    pendingEmbeddings: parts.filter((p) => p.missing).length,
    mentions: located.map((m) => m.view),
    publishedAt: d.publishedAt,
  };
}

// ── Reviewing ────────────────────────────────────────────────────────────────────────────────────────

type MentionRow = typeof nameMentions.$inferSelect;
/** A mention being edited in memory. `id` is undefined for a new one. */
type Working = Omit<MentionRow, 'id' | 'chunkId' | 'decisionId'> & { id?: string; segmentId: string; dirty: boolean };
type SegmentState = { text: string; changed: boolean };

/**
 * Applies a reviewer's patch, in this order: draft → in_review (only after a failed detection), metadata, mention
 * actions, added names, the "I checked everything" flag, then rejection. All or nothing, in one transaction.
 * Every text edit goes through replaceSpan, which moves the offsets of the mentions after it. A chunk whose text
 * changed loses its embedding, and a re-embedding job is sent in the same transaction.
 */
export async function reviewDecision(decisionId: string, reviewerId: string, patch: ReviewPatch): Promise<ReviewView> {
  await db.transaction(async (tx) => {
    const row = await lockDecision(tx, decisionId);
    assertNotContributor(row, reviewerId);
    if (row.status === 'published' || row.status === 'rejected') {
      throw new HttpError(409, `A ${row.status} decision can't be changed`);
    }
    if (patch.status === 'published') {
      throw new HttpError(409, 'Publish with POST /api/decisions/:decisionId/publish: it checks that every name is confirmed');
    }

    // Any other requested status ("draft", or one the decision can't reach) is a 409, checked before any write
    if (patch.status === 'draft') assertTransition(row.status, 'draft');

    let status = row.status;
    if (patch.status === 'in_review') {
      assertTransition(status, 'in_review');
      // After a successful detection the job has already moved it; while detection runs, there is nothing to review
      if (row.anonymisationStatus === 'pending') throw new HttpError(409, 'Name detection has not run yet');
      status = 'in_review';
    }

    const edits = patch.metadata || patch.mentions || patch.addMentions || patch.anonymisationChecked;
    if (edits && status !== 'in_review') {
      throw new HttpError(409, 'Names and metadata are reviewed once the decision is in review');
    }

    // Texts: the caption and every chunk, by segment id
    const parts = await tx
      .select({ id: chunks.id, content: chunks.content, sectionPath: chunks.sectionPath })
      .from(chunks).where(eq(chunks.documentId, row.documentId));
    const segments = new Map<string, SegmentState>(parts.map((p) => [p.id, { text: p.content, changed: false }]));
    if (row.caption !== null) segments.set(CAPTION_SEGMENT, { text: row.caption, changed: false });
    const sectionPaths = new Map(parts.map((p) => [p.id, p.sectionPath]));

    const rows = await tx.select().from(nameMentions).where(eq(nameMentions.decisionId, decisionId));
    let working: Working[] = rows.map((r) => ({
      id: r.id, segmentId: r.chunkId ?? CAPTION_SEGMENT, start: r.start, end: r.end, placeholder: r.placeholder,
      originalHash: r.originalHash, originalText: r.originalText, source: r.source, confirmed: r.confirmed,
      confirmedBy: r.confirmedBy, dirty: false,
    }));
    const deleted: string[] = [];

    /** Replaces one span of a segment and moves the other mentions of that segment. */
    const edit = (segmentId: string, target: { start: number; end: number }, replacement: string): void => {
      const seg = segments.get(segmentId);
      if (!seg) throw new Error(`Mention points at a segment that no longer exists: ${segmentId}`);
      const same = working.filter((m) => m.segmentId === segmentId);
      const result = replaceSpan(seg.text, same, target, replacement);
      const moved = new Map(same.map((m, i) => [m, result.mentions[i]]));
      working = working.map((m) => {
        const next = moved.get(m);
        if (!next || (next.start === m.start && next.end === m.end)) return m;
        return { ...next, dirty: true };
      });
      segments.set(segmentId, { text: result.text, changed: true });
    };

    // Metadata: what the reviewer types wins. The title is the document's.
    const meta = { ...patch.metadata };
    const free = {
      title: meta.title ?? row.title,
      subject: meta.subject !== undefined ? meta.subject : row.subject,
      headnote: meta.headnote !== undefined ? meta.headnote : row.headnote,
    };

    for (const action of patch.mentions ?? []) {
      const m = working.find((w) => w.id === action.id);
      if (!m) throw new HttpError(404, `Mention ${action.id} not found in this decision`);
      if (action.action === 'confirm') {
        if (m.confirmed) continue;
        Object.assign(m, { confirmed: true, originalText: null, confirmedBy: reviewerId, dirty: true });
      } else if (action.action === 'not_a_person') {
        if (m.confirmed || m.originalText === null) {
          throw new HttpError(409, `Mention ${action.id} is confirmed: its original text was erased`);
        }
        edit(m.segmentId, m, m.originalText);
        const target = working.find((w) => w.id === action.id)!;
        working = working.filter((w) => w !== target);
        deleted.push(action.id);
      } else {
        edit(m.segmentId, m, action.placeholder);
        const target = working.find((w) => w.id === action.id)!;
        Object.assign(target, { placeholder: action.placeholder, dirty: true });
      }
    }

    for (const [i, added] of (patch.addMentions ?? []).entries()) {
      const used = new Set(working.map((w) => w.placeholder));
      const placeholder = added.placeholder ?? nextFreePlaceholder(used);
      let replaced = 0;
      for (const [segmentId, seg] of segments) {
        const hits = locateForms([{ id: segmentId, text: seg.text }], [added.surface])
          .filter((h) => !working.some((w) => w.segmentId === segmentId && h.start < w.end && w.start < h.end))
          .sort((a, b) => b.start - a.start); // right to left: each edit moves only what is after it
        for (const h of hits) {
          working.push({
            segmentId, start: h.start, end: h.end, placeholder, originalHash: nameHash(decisionId, h.surface),
            originalText: null, source: 'reviewer', confirmed: true, confirmedBy: reviewerId, dirty: true,
          });
          edit(segmentId, h, placeholder);
          replaced++;
        }
      }
      const person = [{ placeholder, forms: [added.surface] }];
      for (const key of ['title', 'subject', 'headnote'] as const) {
        const text = free[key];
        if (text === null) continue;
        const next = anonymiseFreeText(text, person);
        if (next !== text) { free[key] = next; replaced++; }
      }
      for (const [id, path] of sectionPaths) {
        if (path === null) continue;
        const next = anonymiseFreeText(path, person);
        if (next !== path) { sectionPaths.set(id, next); segments.get(id)!.changed = true; replaced++; }
      }
      // Never echo the name: error messages are logged
      if (replaced === 0) throw new HttpError(422, `addMentions[${i}] was not found in the decision`);
    }

    let anonymisationStatus = row.anonymisationStatus;
    if (patch.anonymisationChecked && anonymisationStatus === 'needs_manual_review') anonymisationStatus = 'done';

    // ── Write ──
    const rejecting = patch.status === 'rejected';
    if (rejecting) assertTransition(status, 'rejected');

    await tx.update(decisions).set({
      ...(meta.court !== undefined ? { court: meta.court } : {}),
      ...(meta.country !== undefined ? { country: meta.country } : {}),
      ...(meta.chamber !== undefined ? { chamber: meta.chamber } : {}),
      ...(meta.caseNumber !== undefined ? { caseNumber: meta.caseNumber } : {}),
      ...(meta.decisionDate !== undefined ? { decisionDate: meta.decisionDate } : {}),
      ...(meta.outcome !== undefined ? { outcome: meta.outcome } : {}),
      subject: free.subject,
      headnote: free.headnote,
      anonymisationStatus,
      status: rejecting ? 'rejected' : status,
      // Rejected: the names have no reason to stay, in the caption or in the unconfirmed mentions (below)
      captionText: rejecting ? null : segments.get(CAPTION_SEGMENT)?.text ?? row.caption,
      ...(rejecting ? { reviewedBy: reviewerId } : {}),
    }).where(eq(decisions.id, decisionId));
    if (free.title !== row.title) await tx.update(documents).set({ title: free.title }).where(eq(documents.id, row.documentId));

    let reembed = false;
    for (const [id, seg] of segments) {
      if (id === CAPTION_SEGMENT || !seg.changed) continue;
      await tx.update(chunks)
        .set({ content: seg.text, sectionPath: sectionPaths.get(id) ?? null, embedding: null, embeddingModel: null })
        .where(eq(chunks.id, id));
      reembed = true;
    }

    if (deleted.length > 0) await tx.delete(nameMentions).where(inArray(nameMentions.id, deleted));
    for (const m of working) {
      const values = {
        chunkId: m.segmentId === CAPTION_SEGMENT ? null : m.segmentId,
        start: m.start, end: m.end, placeholder: m.placeholder, originalHash: m.originalHash,
        originalText: rejecting ? null : m.originalText, source: m.source, confirmed: m.confirmed, confirmedBy: m.confirmedBy,
      };
      if (m.id === undefined) await tx.insert(nameMentions).values({ decisionId, ...values });
      else if (m.dirty || (rejecting && m.originalText !== null)) {
        await tx.update(nameMentions).set(values).where(eq(nameMentions.id, m.id));
      }
    }
    if (reembed && !rejecting) await enqueueEmbedding(row.documentId, tx);
  });
  return getForReview(decisionId);
}

// ── Publishing ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Publishes a decision, or says why not (409), checking in this order: four eyes (403), the transition, detection
 * done, every mention confirmed, court and date, every chunk embedded again, and no hashed name left in any published
 * field. Then the caption and every clear name are erased, in the same transaction as the status change.
 * Missing embeddings: a re-embedding job is enqueued, so retrying a minute later works.
 */
export async function publishDecision(decisionId: string, reviewerId: string): Promise<ReviewView> {
  let missingEmbeddingsOf: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const row = await lockDecision(tx, decisionId);
      assertNotContributor(row, reviewerId);
      assertTransition(row.status, 'published');
      if (row.anonymisationStatus !== 'done') {
        throw new HttpError(409, row.anonymisationStatus === 'pending'
          ? 'Name detection has not run yet'
          : 'Name detection failed: read the whole text, then send anonymisationChecked: true');
      }

      const [{ n: unconfirmed }] = await tx.select({ n: count() }).from(nameMentions)
        .where(and(eq(nameMentions.decisionId, decisionId), eq(nameMentions.confirmed, false)));
      if (unconfirmed > 0) throw new HttpError(409, `${unconfirmed} name mention(s) are not confirmed yet`);

      if (row.court === null || row.decisionDate === null) {
        throw new HttpError(409, 'Court and decision date are required before publishing');
      }

      const parts = await tx
        .select({ ref: chunks.articleRef, part: chunks.part, content: chunks.content, sectionPath: chunks.sectionPath, missing: notEmbedded })
        .from(chunks).where(eq(chunks.documentId, row.documentId));
      const pending = parts.filter((p) => p.missing).length;
      if (pending > 0) {
        missingEmbeddingsOf = row.documentId;
        throw new HttpError(409, `${pending} section(s) are being embedded again after their text changed; retry in a minute`);
      }

      const hashes = new Set((await tx.select({ h: nameMentions.originalHash }).from(nameMentions)
        .where(eq(nameMentions.decisionId, decisionId))).map((r) => r.h));
      const label = (p: { ref: string; part: number }) => (p.part > 0 ? `${p.ref} (part ${p.part + 1})` : p.ref);
      const leaks = findLeaks([
        { field: 'title', text: row.title },
        { field: 'court', text: row.court },
        { field: 'chamber', text: row.chamber },
        { field: 'caseNumber', text: row.caseNumber },
        { field: 'subject', text: row.subject },
        { field: 'headnote', text: row.headnote },
        ...parts.flatMap((p) => [
          { field: label(p), text: p.content },
          { field: `${label(p)} (section path)`, text: p.sectionPath },
        ]),
      ], hashes, decisionId);
      if (leaks.length > 0) throw new HttpError(409, `A name that was anonymised still appears in: ${leaks.join(', ')}`);

      // The citation job may have run before the date was known, or with a date the reviewer corrected since:
      // grade the links again with the final date, in the same transaction as the status change
      await regradeCitations(tx, decisionId, row.decisionDate);

      // Every mention is confirmed here, so none holds a clear name (name_mentions_confirmed_no_clear)
      await tx.update(decisions)
        .set({ status: 'published', publishedAt: new Date(), reviewedBy: reviewerId, captionText: null })
        .where(eq(decisions.id, decisionId));
    });
  } catch (err) {
    if (missingEmbeddingsOf) await enqueueEmbedding(missingEmbeddingsOf);
    throw err;
  }
  await refreshLexemeStats(); // AFTER the commit, so the view sees the decision as searchable
  return getForReview(decisionId);
}
