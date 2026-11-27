// Bulk-ingest a folder of decision PDFs through the production path, for the search benchmark and the evals.
//
//   npx tsx --env-file=.env src/scripts/ingest-decisions.ts --dir eval/decisions-pdf
//   npx tsx --env-file=.env src/scripts/ingest-decisions.ts --dir eval/decisions-pdf --publish-unreviewed
//
// Name each file by its reference (J-16-120.pdf), NEVER by its parties: the name is kept in sourceName, which is
// published. Each <name>.pdf may have a <name>.json beside it: { "sourceUrl", "court", "country", "chamber", "caseNumber",
// "decisionDate" }; anything missing is extracted by the LLM job. The folder holds clear party names: keep it out of
// git (eval/decisions-pdf/ is in .gitignore).
//
// It starts the real queue with the real job handlers (like server.ts), uploads each PDF with ingestDecision, then waits
// until name detection, metadata extraction and citation linking have run. Every job calls the LLM: paid calls.
//
// --publish-unreviewed confirms EVERY detected name mention and publishes, with no person reading the text. That is
// the four-eyes review skipped on purpose, for a LOCAL benchmark database only: refused when NODE_ENV=production.
// The publish-time checks still run: a decision whose headnote or title still holds a detected name stays in review.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { and, eq, inArray, sql as dsql } from 'drizzle-orm';
import { db, sql } from '../db/client';
import { apiKeys, decisions, nameMentions } from '../db/schema';
import { env } from '../config/env';
import { startQueue, stopQueue, LINK_CITATIONS } from '../jobs/queue';
import { markExtractionFailed, runDecisionExtraction } from '../jobs/extract-decision.job';
import { anonymisationFailed, runAnonymisation } from '../jobs/anonymise-decision.job';
import { runEmbedDecision } from '../jobs/embed-decision.job';
import { runCitationLinking } from '../jobs/link-citations.job';
import { runNotifyReport } from '../jobs/notify-report.job';
import { createApiKey } from '../services/api-keys.service';
import { ingestDecision } from '../services/decisions.service';
import { getForReview, publishDecision, reviewDecision } from '../services/decision-review.service';
import { HttpError } from '../utils/http-error';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    dir: { type: 'string' },
    'source-name': { type: 'string', default: 'Ohadata' },
    'publish-unreviewed': { type: 'boolean', default: false },
    'timeout-min': { type: 'string', default: '30' },
  },
  strict: true,
});

const Sidecar = z.object({
  sourceUrl: z.url().optional(),
  court: z.string().optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  chamber: z.string().optional(),
  caseNumber: z.string().optional(),
  decisionDate: z.iso.date().optional(),
}).strict();

const CONTRIBUTOR_LABEL = 'bulk-ingest-contributor';
const REVIEWER_LABEL = 'bulk-ingest-reviewer';

async function keyId(role: 'contributor' | 'reviewer', label: string): Promise<string> {
  const [existing] = await db.select({ id: apiKeys.id }).from(apiKeys)
    .where(and(eq(apiKeys.label, label), dsql`${apiKeys.revokedAt} IS NULL`));
  return existing?.id ?? (await createApiKey(role, label)).id;
}

/** A title without party names: they are in the file name and the caption, never in what gets published. */
const neutralTitle = (court: string | null, caseNumber: string | null, date: string | null, file: string) =>
  [court ?? 'Décision', caseNumber, date ? `du ${date}` : null].filter(Boolean).join(', ') || `Décision ${file}`;

async function waitForJobs(ids: string[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ pending }] = await db.select({ pending: dsql<number>`count(*)::int` }).from(decisions).where(and(
      inArray(decisions.id, ids),
      dsql`(${decisions.anonymisationStatus} = 'pending' OR ${decisions.extractionStatus} = 'pending')`,
    ));
    // Citation linking is enqueued when detection saves: wait for those jobs too
    const [{ linking }] = await sql<{ linking: number }[]>`
      SELECT count(*)::int AS linking FROM pgboss.job
      WHERE name = ${LINK_CITATIONS} AND data->>'decisionId' = ANY(${ids}) AND state IN ('created', 'retry', 'active')`;
    console.log(`  waiting: ${pending} decision(s) still detecting or extracting, ${linking} citation job(s) running`);
    if (pending === 0 && linking === 0) return;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error('Timed out waiting for the jobs; run the script again with the same folder to continue');
}

async function publishUnreviewed(decisionId: string, file: string, reviewerId: string): Promise<string> {
  const view = await getForReview(decisionId);
  if (view.status !== 'in_review') return `skipped (${view.status})`;
  if (view.anonymisationStatus !== 'done') return 'left in review: name detection failed, a person must read it';
  if (!view.court || !view.decisionDate) return 'left in review: court or date missing';
  const mentions = await db.select({ id: nameMentions.id }).from(nameMentions)
    .where(and(eq(nameMentions.decisionId, decisionId), eq(nameMentions.confirmed, false)));
  await reviewDecision(decisionId, reviewerId, {
    metadata: { title: neutralTitle(view.court, view.caseNumber, view.decisionDate, file) },
    ...(mentions.length ? { mentions: mentions.map((m) => ({ id: m.id, action: 'confirm' as const })) } : {}),
  });
  try {
    await publishDecision(decisionId, reviewerId);
    return `published (${mentions.length} mention(s) confirmed unread)`;
  } catch (err) {
    if (err instanceof HttpError) return `left in review: ${err.message}`;
    throw err;
  }
}

async function main() {
  if (!values.dir) throw new Error('--dir is required');
  if (values['publish-unreviewed'] && env.NODE_ENV === 'production') {
    throw new Error('--publish-unreviewed skips the human review: never on a production database');
  }
  const files = readdirSync(values.dir).filter((f) => extname(f).toLowerCase() === '.pdf').sort();
  if (files.length === 0) throw new Error(`No PDF in ${values.dir}`);

  const contributorId = await keyId('contributor', CONTRIBUTOR_LABEL);
  const reviewerId = await keyId('reviewer', REVIEWER_LABEL);
  await startQueue({
    extractDecision: runDecisionExtraction, extractionFailed: markExtractionFailed,
    anonymiseDecision: runAnonymisation, anonymisationFailed,
    embedDecision: runEmbedDecision, linkCitations: runCitationLinking,
    notifyReport: (reportId) => runNotifyReport(reportId),
  });

  // The file name is the idempotency key: a second run skips what the first one uploaded
  const ids: { id: string; file: string }[] = [];
  for (const file of files) {
    const name = basename(file, extname(file));
    const marker = `bulk:${name}`;
    const [already] = await db.select({ id: decisions.id }).from(decisions)
      .where(eq(decisions.sourceName, `${values['source-name']} (${marker})`));
    if (already) {
      ids.push({ id: already.id, file });
      console.log(`= ${file}: already ingested`);
      continue;
    }
    const sidecarPath = join(values.dir, `${name}.json`);
    const meta = existsSync(sidecarPath) ? Sidecar.parse(JSON.parse(readFileSync(sidecarPath, 'utf8'))) : {};
    const stored = await ingestDecision({
      file: readFileSync(join(values.dir, file)),
      title: `Décision ${name}`,      // replaced by a neutral title before publishing
      language: 'fr',
      sourceName: `${values['source-name']} (${marker})`,
      ...meta,
    }, contributorId);
    ids.push({ id: stored.id, file });
    console.log(`+ ${file}: ${stored.chunkCount} section(s)`);
  }

  await waitForJobs(ids.map((d) => d.id), Number(values['timeout-min']) * 60_000);

  if (values['publish-unreviewed']) {
    console.warn('\n--publish-unreviewed: every detected name is confirmed WITHOUT being read. Local benchmark data only.\n');
    for (const { id, file } of ids) console.log(`${file}: ${await publishUnreviewed(id, file, reviewerId)}`);
  } else {
    console.log('\nIn review. Publish each one with PATCH then POST /api/decisions/:id/publish, or run again with --publish-unreviewed.');
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => { await stopQueue(); await sql.end(); });
