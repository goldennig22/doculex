// Says which act version a statute already in the database holds, so decision citations link to it. New statutes get
// it at upload (actCode, actVersion fields). Then grades every decision's citations again: links to that version
// that were waiting ("version_not_ingested") now show on its article pages, and missing articles are flagged.
//   npm run documents:set-act -- --document c9725d5d-0bc8-46aa-b8f8-cfa870d6425c --act AUDCG --version 2010
//   production: docker compose exec app node dist/scripts/set-document-act.js --document … --act … --version …
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { sql } from '../db/client';
import { ACTS, LINKABLE_ACT_CODES } from '../services/citations/acts';
import { regradeAllCitations } from '../services/citations/citations.service';
import { setDocumentAct } from '../services/documents.service';

const Args = z.object({
  document: z.uuid(),
  act: z.enum(LINKABLE_ACT_CODES),
  version: z.string(),
}).refine((a) => ACTS[a.act].versions.some((v) => v.version === a.version), {
  message: 'Unknown version for this act (see src/services/citations/acts.ts)',
});

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { document: { type: 'string' }, act: { type: 'string' }, version: { type: 'string' } } });
  const parsed = Args.safeParse(values);
  if (!parsed.success) {
    throw new Error(`Usage: --document <uuid> --act ${LINKABLE_ACT_CODES.join('|')} --version <year>\n${z.prettifyError(parsed.error)}`);
  }
  const { document, act, version } = parsed.data;
  if (!(await setDocumentAct(document, act, version))) throw new Error(`No statute with id ${document}`);
  console.log(`Document ${document} holds ${act} ${version}.`);
  const decisions = await regradeAllCitations();
  console.log(`Citations of ${decisions} decision(s) graded again.`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
