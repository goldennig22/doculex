import type { z } from 'zod';
import { and, count, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { decisionReports, decisions, documents } from '../db/schema';
import type { reportDecisionSchema } from '../utils/schemas';
import { HttpError } from '../utils/http-error';
import { enqueueReportNotification } from '../jobs/queue';
import { refreshLexemeStats } from './documents.service';
import { assertTransition } from './decision-status';

// The takedown path: anyone may report a published decision (POST /api/decisions/:id/report, no key).
//
// A personal-data report takes the decision offline AT ONCE, before anyone checks it: a name left visible is the
// project's biggest legal risk, and a wrongful takedown only costs a re-publication. Other reasons are stored and
// notified, and the decision stays up.
//
// The route is public, so takedowns are also a way to empty the site: with 5 reports per hour per IP, four IPs take
// 100 decisions offline in 5 hours. The breaker caps automatic takedowns at MAX_AUTO_TAKEDOWNS_PER_DAY over the last
// 24 hours; past it, reports are still stored and notified ("breaker open") and a person decides.

export type ReportInput = z.output<typeof reportDecisionSchema>;
export type ReportOutcome = { reportId: string; tookDown: boolean; breakerOpen: boolean };

export const MAX_AUTO_TAKEDOWNS_PER_DAY = 5;

/** One key for every takedown: two reports on two decisions must not both count 4 and both take down. */
const TAKEDOWN_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('doculex:decision-takedown'))`;

/**
 * Stores a report and, for personal data, takes the decision back to in_review. One transaction: the decision row is
 * locked (a reviewer publishing it at the same moment waits), the report, the status change and the notification job
 * commit together or not at all.
 *
 * 404 for anything but a published decision, the same as an unknown id: a draft's id must not be confirmed to exist.
 * The caller answers the same 202 whatever happened (`tookDown` is for the notification and the tests).
 */
export async function reportDecision(decisionId: string, input: ReportInput): Promise<ReportOutcome> {
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx.select({ status: decisions.status }).from(decisions)
      .where(eq(decisions.id, decisionId)).for('update');
    if (!row || row.status !== 'published') throw new HttpError(404, 'Decision not found');

    let tookDown = false;
    let breakerOpen = false;
    if (input.reason === 'personal_data') {
      await tx.execute(TAKEDOWN_LOCK);
      const [{ n }] = await tx.select({ n: count() }).from(decisionReports).where(and(
        eq(decisionReports.tookDown, true),
        gt(decisionReports.createdAt, sql`now() - interval '24 hours'`),
      ));
      breakerOpen = n >= MAX_AUTO_TAKEDOWNS_PER_DAY;
      if (!breakerOpen) {
        assertTransition(row.status, 'in_review');
        await tx.update(decisions).set({ status: 'in_review' }).where(eq(decisions.id, decisionId));
        tookDown = true;
      }
    }

    const [report] = await tx.insert(decisionReports).values({
      decisionId, reason: input.reason, message: input.message, contact: input.contact, tookDown,
    }).returning({ id: decisionReports.id });
    await enqueueReportNotification(report.id, tx);
    return { reportId: report.id, tookDown, breakerOpen };
  });

  // AFTER the commit, as publishDecision does: the view must stop counting the decision's words
  if (outcome.tookDown) await refreshLexemeStats();
  return outcome;
}

// ── The notification (src/jobs/notify-report.job.ts) ─────────────────────────────────────────────────

export type ReportNotice = {
  decisionId: string;
  title: string;
  reason: ReportInput['reason'];
  tookDown: boolean;
  hasMessage: boolean;
  hasContact: boolean;
};

/** What the job sends; null when the decision (and its reports) was deleted since. */
export async function loadReportNotice(reportId: string): Promise<ReportNotice | null> {
  const [row] = await db
    .select({
      decisionId: decisionReports.decisionId, title: documents.title, reason: decisionReports.reason,
      tookDown: decisionReports.tookDown,
      hasMessage: sql<boolean>`${decisionReports.message} IS NOT NULL`,
      hasContact: sql<boolean>`${decisionReports.contact} IS NOT NULL`,
    })
    .from(decisionReports)
    .innerJoin(decisions, eq(decisions.id, decisionReports.decisionId))
    .innerJoin(documents, eq(documents.id, decisions.documentId))
    .where(eq(decisionReports.id, reportId));
  return row ?? null;
}

/**
 * The notification text. Never the reporter's message or contact: the message may hold the very name being reported,
 * and the notification service is a third party. They are read in the review view or the database.
 * The title is already public (it passed the publish-time leak check).
 */
export function reportNotificationText(n: ReportNotice): string {
  const what = n.tookDown
    ? 'Taken offline (now in_review).'
    : n.reason === 'personal_data'
      ? `NOT taken offline: more than ${MAX_AUTO_TAKEDOWNS_PER_DAY} takedowns in 24 h (breaker open). Check it yourself.`
      : 'Still published.';
  const extras = [n.hasMessage ? 'a message' : null, n.hasContact ? 'a contact address' : null].filter(Boolean);
  return [
    `DocuLex: report "${n.reason}" on "${n.title}"`,
    what,
    extras.length ? `The report has ${extras.join(' and ')} (read them in the database, never here).` : 'No message.',
    `Review: GET /api/decisions/${n.decisionId}`,
  ].join('\n');
}
