import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq, inArray, like, sql as dsql } from 'drizzle-orm';
import { db, sql } from '../../src/db/client';
import { apiKeys, chunks, decisionCitations, decisionReports, decisions, documents } from '../../src/db/schema';
import { createApiKey } from '../../src/services/api-keys.service';
import { MAX_AUTO_TAKEDOWNS_PER_DAY, reportDecision } from '../../src/services/decision-report.service';
import { getForReview, listReviewQueue, publishDecision, reviewDecision } from '../../src/services/decision-review.service';
import { searchDecisions } from '../../src/services/decision-search.service';
import { runNotifyReport } from '../../src/jobs/notify-report.job';
import { enqueueReportNotification } from '../../src/jobs/queue';
import type { DecisionStatus } from '../../src/services/decision-status';

// The takedown path against real Postgres. pg-boss is not in the test database: the enqueue functions are spies.
vi.mock('../../src/jobs/queue', () => ({
  enqueueExtraction: vi.fn(), enqueueAnonymisation: vi.fn(), enqueueEmbedding: vi.fn(), enqueueCitationLinking: vi.fn(),
  enqueueReportNotification: vi.fn(),
}));
vi.mock('../../src/services/embeddings.service', () => ({
  embedQuery: vi.fn(), embedDocuments: vi.fn(), EMBEDDING_MODEL: 'test-model', DIMENSIONS: 1536,
}));

const DIMS = 1536;
const AXIS = 960; // an axis no other suite uses
const vector = Array.from({ length: DIMS }, (_, j) => (j === AXIS ? 1 : 0));
const COURT = 'Cour de test (signalements)';
const TITLE_PREFIX = 'Signalement test';

describe.skipIf(!process.env.RUN_DB_TESTS)('reports and takedowns against Postgres', () => {
  let contributorId = '';
  let reviewerId = '';
  const documentIds: string[] = [];

  /** A decision in the given status that satisfies every CHECK (a published one is complete and anonymised). */
  async function insertDecision(status: DecisionStatus, name: string): Promise<string> {
    const published = status === 'published';
    const [doc] = await db.insert(documents)
      .values({ kind: 'decision', title: `${TITLE_PREFIX} ${name}`, language: 'fr' })
      .returning({ id: documents.id });
    documentIds.push(doc.id);
    const [row] = await db.insert(decisions).values({
      documentId: doc.id, court: COURT, decisionDate: '2016-05-10', caseNumber: `Arrêt n° ${name}`,
      headnote: `Chapeau ${name}`, status, sourceName: 'test', contributedBy: contributorId,
      anonymisationStatus: published || status === 'in_review' ? 'done' : 'pending',
      reviewedBy: published ? reviewerId : null, publishedAt: published ? new Date() : null,
    }).returning({ id: decisions.id });
    await db.insert(chunks).values({
      documentId: doc.id, articleRef: 'moyen-1', part: 0, pageStart: 1, pageEnd: 1, lang: 'fr',
      content: `Attendu que la Cour ${name} applique l'article 49.`, embedding: vector,
    });
    return row.id;
  }
  const statusOf = async (id: string) => (await db.select({ s: decisions.status }).from(decisions).where(eq(decisions.id, id)))[0].s;
  const reportsOf = (id: string) => db.select().from(decisionReports).where(eq(decisionReports.decisionId, id));
  const publicIds = async () => (await searchDecisions({ q: undefined, subject: undefined, court: COURT, page: 1, limit: 50 })).items.map((d) => d.id);
  /** Brings today's automatic takedowns to exactly `n`, by adding or deleting fixture rows. */
  async function setTakedownsToday(n: number, onDecision: string): Promise<void> {
    await db.delete(decisionReports).where(and(eq(decisionReports.tookDown, true), dsql`${decisionReports.createdAt} > now() - interval '24 hours'`));
    if (n > 0) {
      await db.insert(decisionReports).values(Array.from({ length: n }, () => ({
        decisionId: onDecision, reason: 'personal_data' as const, tookDown: true,
      })));
    }
  }

  beforeAll(async () => {
    // A crashed earlier run may have left takedowns from the last 24 h, which would open the breaker
    await db.delete(documents).where(like(documents.title, `${TITLE_PREFIX} %`));
    contributorId = (await createApiKey('contributor', 'test-report-contributor')).id;
    reviewerId = (await createApiKey('reviewer', 'test-report-reviewer')).id;
  });
  beforeEach(async () => {
    vi.mocked(enqueueReportNotification).mockReset().mockResolvedValue('job-1');
  });
  afterAll(async () => {
    if (documentIds.length) await db.delete(documents).where(inArray(documents.id, documentIds));
    await db.delete(apiKeys).where(inArray(apiKeys.id, [contributorId, reviewerId].filter(Boolean)));
    await sql.end();
  });

  it('personal_data takes a published decision offline at once, stores the report and enqueues the notice in the same transaction', async () => {
    const id = await insertDecision('published', '096/2015');
    const holder = await insertDecision('published', 'holder-1');
    await setTakedownsToday(0, holder);
    expect(await publicIds()).toContain(id);

    const outcome = await reportDecision(id, { reason: 'personal_data', message: 'Le nom du gérant apparaît en clair au moyen 1.' });

    expect(outcome).toMatchObject({ tookDown: true, breakerOpen: false });
    expect(await statusOf(id)).toBe('in_review');
    expect(await publicIds()).not.toContain(id); // gone from every search: searchableDocuments reads the status
    const [report] = await reportsOf(id);
    expect(report).toMatchObject({ id: outcome.reportId, reason: 'personal_data', tookDown: true, resolvedAt: null });
    const [reportId, tx] = vi.mocked(enqueueReportNotification).mock.calls[0];
    expect(reportId).toBe(outcome.reportId);
    expect(tx).toBeDefined();
  });

  it('other reasons are stored and notified, and the decision stays published', async () => {
    const id = await insertDecision('published', 'wrong-date');
    const outcome = await reportDecision(id, { reason: 'wrong_metadata', message: "L'arrêt date du 10 mai 2016." });
    expect(outcome).toMatchObject({ tookDown: false, breakerOpen: false });
    expect(await statusOf(id)).toBe('published');
    expect((await reportsOf(id))[0]).toMatchObject({ reason: 'wrong_metadata', tookDown: false });
    expect(enqueueReportNotification).toHaveBeenCalledTimes(1);
  });

  it.each(['draft', 'in_review', 'rejected'] as const)('a %s decision answers 404, like an unknown id, and nothing is stored', async (status) => {
    const id = await insertDecision(status, `not-public-${status}`);
    await expect(reportDecision(id, { reason: 'personal_data' })).rejects.toMatchObject({ statusCode: 404, message: 'Decision not found' });
    expect(await reportsOf(id)).toEqual([]);
    expect(enqueueReportNotification).not.toHaveBeenCalled();
  });

  it('an unknown id answers 404', async () => {
    await expect(reportDecision('00000000-0000-4000-8000-000000000000', { reason: 'other' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it(`the breaker: past ${MAX_AUTO_TAKEDOWNS_PER_DAY} takedowns in 24 h, a personal_data report is stored but takes nothing down`, async () => {
    const holder = await insertDecision('published', 'holder-2');
    const id = await insertDecision('published', 'after-breaker');
    await setTakedownsToday(MAX_AUTO_TAKEDOWNS_PER_DAY, holder);

    const outcome = await reportDecision(id, { reason: 'personal_data' });

    expect(outcome).toMatchObject({ tookDown: false, breakerOpen: true });
    expect(await statusOf(id)).toBe('published');
    expect((await reportsOf(id))[0]).toMatchObject({ tookDown: false });
    expect(enqueueReportNotification).toHaveBeenCalledTimes(1); // you still hear about it
    await setTakedownsToday(0, holder);
  });

  it('two reports at the same moment with one takedown left: exactly one takes its decision down (advisory lock)', async () => {
    const holder = await insertDecision('published', 'holder-3');
    const a = await insertDecision('published', 'race-a');
    const b = await insertDecision('published', 'race-b');
    await setTakedownsToday(MAX_AUTO_TAKEDOWNS_PER_DAY - 1, holder);

    const outcomes = await Promise.all([
      reportDecision(a, { reason: 'personal_data' }),
      reportDecision(b, { reason: 'personal_data' }),
    ]);

    expect(outcomes.filter((o) => o.tookDown)).toHaveLength(1);
    expect(outcomes.filter((o) => o.breakerOpen)).toHaveLength(1);
    expect([await statusOf(a), await statusOf(b)].sort()).toEqual(['in_review', 'published']);
    await setTakedownsToday(0, holder);
  });

  it('after a takedown: the review view and the queue show the report, and publishing again resolves it', async () => {
    const id = await insertDecision('published', 'republish');
    const holder = await insertDecision('published', 'holder-4');
    await setTakedownsToday(0, holder);
    const [docRow] = await db.select({ documentId: decisions.documentId }).from(decisions).where(eq(decisions.id, id));
    const [chunk] = await db.select({ id: chunks.id }).from(chunks).where(eq(chunks.documentId, docRow.documentId));
    await db.insert(decisionCitations).values({
      decisionId: id, chunkId: chunk.id, actCode: 'AUPSRVE', actVersion: '1998', articleRef: '49', rawText: "l'article 49 de l'AUPSRVE",
      actSource: 'explicit', method: 'rule', confidence: 'high',
    });
    await reportDecision(id, { reason: 'personal_data', contact: 'lecteur@example.org' });

    const view = await getForReview(id);
    expect(view).toMatchObject({ status: 'in_review', openReports: 1 });
    expect(view.publishedAt).not.toBeNull(); // it was public until the report
    expect(view.citations).toEqual([expect.objectContaining({ segment: 'moyen-1', actCode: 'AUPSRVE', articleRef: '49', confidence: 'high' })]);

    const queue = await listReviewQueue(reviewerId);
    const mine = queue.filter((q) => q.title.startsWith(TITLE_PREFIX));
    expect(mine[0]).toMatchObject({ id, openReports: 1, ownUpload: false }); // reported decisions first
    expect((await listReviewQueue(contributorId)).find((q) => q.id === id)?.ownUpload).toBe(true);

    const republished = await publishDecision(id, reviewerId);
    expect(republished).toMatchObject({ status: 'published', openReports: 0 });
    const [report] = await reportsOf(id);
    expect(report.resolvedBy).toBe(reviewerId);
    expect(report.resolvedAt).not.toBeNull();
    expect(await publicIds()).toContain(id);
  });

  it('rejecting a taken-down decision resolves its reports too', async () => {
    const id = await insertDecision('published', 'reject-after');
    const holder = await insertDecision('published', 'holder-5');
    await setTakedownsToday(0, holder);
    await reportDecision(id, { reason: 'personal_data' });
    await reviewDecision(id, reviewerId, { status: 'rejected' });
    expect((await reportsOf(id))[0].resolvedBy).toBe(reviewerId);
  });

  it('PATCH still refuses to change a published decision: only a report takes one down', async () => {
    const id = await insertDecision('published', 'patch-refused');
    await expect(reviewDecision(id, reviewerId, { status: 'in_review' })).rejects.toMatchObject({ statusCode: 409 });
  });

  describe('the notification job', () => {
    const okFetch = () => vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));

    it('sends the reason, the title and the review path, never the message or the contact', async () => {
      const id = await insertDecision('published', 'notify');
      const { reportId } = await reportDecision(id, {
        reason: 'wrong_text', message: 'Monsieur TCHOUPO est nommé au moyen 1.', contact: 'lecteur@example.org',
      });
      const send = okFetch();

      expect(await runNotifyReport(reportId, { url: 'https://ntfy.example/secret-topic', send })).toEqual({ status: 'sent' });

      const [url, init] = send.mock.calls[0];
      expect(url).toBe('https://ntfy.example/secret-topic');
      const body = String(init?.body);
      expect(body).toContain(`report "wrong_text" on "${TITLE_PREFIX} notify"`);
      expect(body).toContain('Still published.');
      expect(body).toContain(`GET /api/decisions/${id}`);
      expect(body).toContain('a message and a contact address');
      expect(body).not.toContain('TCHOUPO');
      expect(body).not.toContain('lecteur@example.org');
    });

    it('a non-2xx answer throws, so pg-boss retries', async () => {
      const id = await insertDecision('published', 'notify-fail');
      const { reportId } = await reportDecision(id, { reason: 'other' });
      const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('down', { status: 503 }));
      await expect(runNotifyReport(reportId, { url: 'https://ntfy.example/t', send })).rejects.toThrow('503');
    });

    it('without a URL (development) the notice is printed, not dropped', async () => {
      const id = await insertDecision('published', 'notify-dev');
      const { reportId } = await reportDecision(id, { reason: 'other' });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await runNotifyReport(reportId, { url: undefined, send: okFetch() })).toEqual({ status: 'logged', reason: 'no_notify_url' });
      expect(warn.mock.calls[0][0]).toContain('report "other"');
      warn.mockRestore();
    });

    it('a report whose decision was deleted is skipped', async () => {
      const id = await insertDecision('published', 'notify-gone');
      const { reportId } = await reportDecision(id, { reason: 'other' });
      await db.delete(decisions).where(eq(decisions.id, id));
      expect(await runNotifyReport(reportId, { url: 'https://ntfy.example/t', send: okFetch() })).toEqual({ status: 'skipped', reason: 'gone' });
    });
  });
});
