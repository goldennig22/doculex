import { defineConfig } from 'vitest/config';

// Read .env here so TEST_DATABASE_URL can live there; variables already set (CI) win over the file.
try { process.loadEnvFile(); } catch { /* no .env in CI: variables come from GitLab */ }

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      // Never the dev database: the integration tests insert fixtures and rank over every chunk.
      // Without TEST_DATABASE_URL, a dummy that only the RUN_DB_TESTS suites would ever try to reach.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:5433/test',
      ADMIN_API_KEY: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      ANONYMISATION_HMAC_KEY: 'test-only-hmac-key-0123456789abcdef0123456789abcdef',
      EMBEDDING_MODEL: 'test-embedding',
      LLM_MODEL: 'test-primary',
      LLM_2ND_MODEL: 'test-second',
      LLM_FALLBACK_MODEL: 'test-fallback',
      MIN_SIMILARITY: '0.6',
    },
  },
});
