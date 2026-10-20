import { buildApp } from './app';
import { env } from './config/env';
import { sql } from './db/client';

const app = buildApp();

// Run the server
const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, async () => {
        await app.close();
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
