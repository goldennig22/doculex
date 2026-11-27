import { z } from 'zod';
import dotenv from "dotenv";

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('127.0.0.1'), // the Docker image sets 0.0.0.0; the published port is bound to the VPS's 127.0.0.1
  DATABASE_URL: z.string().min(1),
  LLM_PROVIDER: z.enum(['openai', 'anthropic','google']).default('google'),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ADMIN_API_KEY: z.string().min(32),
  // Keys the HMAC of each anonymised name (name_mentions.original_hash). Kept outside the database, so a database
  // leak alone can't reverse the hashes by trying every surname. Changing it breaks the publish-time leak check
  // of the decisions still in review.
  ANONYMISATION_HMAC_KEY: z.string().min(32),
  EMBEDDING_MODEL: z.string(),
  EMBEDDING_PARALLEL_CALLS: z.coerce.number().default(2),
  LLM_MODEL: z.string(),
  LLM_2ND_MODEL: z.string(),
  LLM_FALLBACK_MODEL: z.string(),
  MIN_SIMILARITY: z.coerce.number(),
  TRUST_PROXY: z.string().optional(), // address of the reverse proxy as the app sees it (the Docker gateway in production)
  // Where a report on a decision is announced: the text is POSTed as the body (an ntfy topic URL works as is).
  // Treat it as a secret: an ntfy topic is readable by anyone who knows its name.
  NOTIFY_URL: z.url().optional(),
}).refine((e) => e.NODE_ENV !== 'production' || e.NOTIFY_URL !== undefined, {
  // A takedown nobody hears about leaves a decision offline for good: refuse to boot without it
  message: 'NOTIFY_URL is required in production (reports on decisions are sent there)',
  path: ['NOTIFY_URL'],
});

export const env = EnvSchema.parse(process.env);