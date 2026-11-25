// Applies pending migrations from ./drizzle with drizzle-orm's migrator (a runtime dependency),
// so production can migrate without drizzle-kit (a devDependency, absent from the Docker image).
// Same tracking table as `drizzle-kit migrate` (drizzle.__drizzle_migrations), and all pending
// migrations run in ONE transaction: if one fails, none is applied and the schema stays as it was.
import path from 'node:path';
import dotenv from 'dotenv';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

dotenv.config({ quiet: true }); // dev reads .env; in CI and in the container the variables are already set

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, { max: 1, onnotice: () => {} }); // silence "extension already exists" notices
  try {
    // src/scripts (tsx) and dist/scripts (node) are both two levels below the project root.
    await migrate(drizzle(sql), { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
  } finally {
    await sql.end();
  }
}

main().then(
  () => console.log('migrations applied'),
  (err: unknown) => {
    console.error('migration failed:', err);
    process.exit(1);
  },
);
