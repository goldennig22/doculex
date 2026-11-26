import { buildApp } from './app';
import { env } from './config/env';
import { sql } from './db/client';
import { startQueue, stopQueue } from './jobs/queue';
import { markExtractionFailed, runDecisionExtraction } from './jobs/extract-decision.job';

const app = buildApp();

// Run the server
const start = async () => {
  try {
    // The worker runs in the API process: one process on one VPS (same reasoning as the in-memory rate limit)
    await startQueue({ extractDecision: runDecisionExtraction, extractionFailed: markExtractionFailed });
    await app.listen({ port: env.PORT, host: env.HOST });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, async () => {
        await app.close();   // no new uploads, so no new jobs
        await stopQueue();   // let a running extraction finish
        await sql.end();
        process.exit(0);
      });
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
