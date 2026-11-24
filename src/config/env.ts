import { z } from 'zod';
import dotenv from "dotenv";

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  LLM_PROVIDER: z.enum(['openai', 'anthropic','google']).default('google'),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ADMIN_API_KEY: z.string().min(32),
  EMBEDDING_MODEL: z.string(),
  EMBEDDING_PARALLEL_CALLS: z.coerce.number().default(2),
  LLM_MODEL: z.string(),
  LLM_2ND_MODEL: z.string(),
  LLM_FALLBACK_MODEL: z.string(),
  MIN_SIMILARITY: z.coerce.number(),
  TRUST_PROXY: z.string().optional(), // address of the reverse proxy, e.g. 127.0.0.1 for Caddy on the same VPS
});

export const env = EnvSchema.parse(process.env);