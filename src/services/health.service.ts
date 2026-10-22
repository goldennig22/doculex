import { sql } from '../db/client';
import { env } from '../config/env';

export type CheckResult = { status: 'up' | 'down'; latencyMs: number; error?: string };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

async function timed(fn: () => Promise<void>): Promise<CheckResult> {
  const start = performance.now();
  try {
    await fn();
    return { status: 'up', latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : 'unknown error',
    };
  }
}

export const checkDatabase = () =>
  timed(async () => {
    const rows = await withTimeout(sql`select 1 from pg_extension where extname = 'vector'`, 2000);
    if (rows.length === 0) throw new Error('pgvector extension not installed');
  });

const PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/models',
    key: () => env.OPENAI_API_KEY,
    headers: (k: string) => ({ Authorization: `Bearer ${k}` }),
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    key: () => env.ANTHROPIC_API_KEY,
    headers: (k: string) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
  },
  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    key: () => env.GEMINI_API_KEY,
    headers: (k: string) => ({ 'x-goog-api-key': k }),
  },
  
} as const;

let llmCache: { at: number; result: CheckResult } | null = null;

export async function checkLlm(): Promise<CheckResult> {
  if (llmCache && Date.now() - llmCache.at < 60_000) return llmCache.result;
  const provider = PROVIDERS[env.LLM_PROVIDER];
  const result = await timed(async () => {
    const key = provider.key();
    if (!key) throw new Error(`${env.LLM_PROVIDER} API key missing`);
    const res = await fetch(provider.url, { headers: provider.headers(key), signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`provider returned HTTP ${res.status}`);
  });
  llmCache = { at: Date.now(), result };
  return result;
}