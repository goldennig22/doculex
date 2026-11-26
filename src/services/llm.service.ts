import { generateText, Output, type LanguageModelUsage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { z } from 'zod';
import { env } from '../config/env';

const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
const openAI = createOpenAI({ apiKey: env.OPENAI_API_KEY });
const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });

// Tried in order: if Anthropic is down or times out, OpenAI answers, then Gemini
const MODELS = [
  { name: env.LLM_MODEL, model: anthropic(env.LLM_MODEL) },
  { name: env.LLM_2ND_MODEL, model: openAI(env.LLM_2ND_MODEL) },
  { name: env.LLM_FALLBACK_MODEL, model: google(env.LLM_FALLBACK_MODEL) },
];

export type StructuredRequest<OUT> = {
  /** Prefix of the warning logged when a model fails: "[ask]", "[extract]" */
  label: string;
  system: string;
  prompt: string;
  schema: z.ZodType<OUT>;
  /** Per model. The worst case is about 3 × timeoutMs (plus one SDK retry each). */
  timeoutMs: number;
  /** Aborts the whole chain, e.g. the pg-boss job's signal when the job expires or the worker stops. */
  signal?: AbortSignal;
};

/**
 * Structured output with the three-model fallback. Throws the last model's error when all fail, so callers
 * can tell a provider failure (APICallError, timeout) from unusable output (NoObjectGeneratedError).
 * An abort from `signal` stops the chain at once: no point asking the next model for a job that is gone.
 */
export async function generateObjectWithFallback<OUT>(req: StructuredRequest<OUT>): Promise<{
  output: OUT; usage: LanguageModelUsage; modelName: string;
}> {
  let lastError: unknown;
  for (const m of MODELS) {
    try {
      const timeout = AbortSignal.timeout(req.timeoutMs);
      const res = await generateText({
        model: m.model,
        system: req.system,
        prompt: req.prompt,
        output: Output.object({ schema: req.schema }),
        maxRetries: 1,
        abortSignal: req.signal ? AbortSignal.any([timeout, req.signal]) : timeout,
      });
      // Read inside the try: an output that fails the schema throws here, and the next model gets a chance
      return { output: res.output, usage: res.usage, modelName: m.name };
    } catch (err) {
      if (req.signal?.aborted) throw err;
      lastError = err;
      console.warn(`${req.label} ${m.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw lastError;
}
