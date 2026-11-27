import { env } from '../config/env';
import { loadReportNotice, reportNotificationText } from '../services/decision-report.service';

export type NotifyResult = { status: 'sent' } | { status: 'logged'; reason: 'no_notify_url' } | { status: 'skipped'; reason: 'gone' };

/**
 * Sends one report's notice to NOTIFY_URL as a plain-text POST (an ntfy topic URL takes it as is).
 * A network error or a non-2xx answer throws, so pg-boss retries it (queue.ts). Outside production NOTIFY_URL may be
 * unset (env.ts refuses to boot without it in production): the notice is then printed, never dropped silently.
 */
export async function runNotifyReport(
  reportId: string,
  { url = env.NOTIFY_URL, send = fetch }: { url?: string; send?: typeof fetch } = {}, // tests pass their own
): Promise<NotifyResult> {
  const notice = await loadReportNotice(reportId);
  if (!notice) return { status: 'skipped', reason: 'gone' }; // the decision was deleted, its reports with it
  const text = reportNotificationText(notice);

  if (!url) {
    console.warn(`[notify-report] NOTIFY_URL is not set; the notice was:\n${text}`);
    return { status: 'logged', reason: 'no_notify_url' };
  }
  const res = await send(url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8', ...(notice.tookDown ? { priority: 'high' } : {}) },
    body: text,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Notification service answered ${res.status}`);
  return { status: 'sent' };
}
