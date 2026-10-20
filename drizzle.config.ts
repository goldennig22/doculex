import { defineConfig } from 'drizzle-kit';

// drizzle-kit doesn't read .env by itself; Node 22 can load it.
// The try/catch keeps CI working, where there is no .env file and variables come from GitLab.
try { process.loadEnvFile(); } catch {}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
});