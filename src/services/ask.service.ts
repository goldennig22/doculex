import { generateText, Output } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from "@ai-sdk/openai";
import { env } from '../config/env';
import { LlmAnswer, userPrompt, verifyCitations } from './answer.service';
import { dedupeByArticle, detectLanguage, getArticleParts, searchByVector } from './search.service';
import { AskResponse, AskResult, SearchResult, Source, SourceRef, UserQuery } from '../interfaces/types';
import { storeQuery } from './queries.service';
import { costUsd } from '../config/prices';

const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
const openAI = createOpenAI({ apiKey: env.OPENAI_API_KEY })
const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });
const SYSTEM = `You answer questions about OHADA business law using ONLY the numbered sources provided.
Rules:
1. Use only facts stated in the sources. Never use outside knowledge, even if you know the answer.
2. Cite every source you rely on by its number, with a short quote copied exactly from it.
3. If the sources do not contain the answer, set found to false, answer to "" and citations to [].
4. Answer in the language of the question (French or English), even if the sources are in the other language.
5. Be concise: 2 to 5 sentences. You are a research aid, not a lawyer.`;

// Tried in order: if Anthropic is down or times out, OpenAI answers, then Gemini
const MODELS = [
  { name: env.LLM_MODEL, model: anthropic(env.LLM_MODEL) },
  { name: env.LLM_2ND_MODEL, model: openAI(env.LLM_2ND_MODEL) },
  { name: env.LLM_FALLBACK_MODEL, model: google(env.LLM_FALLBACK_MODEL) },
];

async function generateWithFallback(prompt: string) {
  let lastError: unknown;
  // AbortSignal.timeout(20_000)
  for (const m of MODELS) {
    try {
      const res = await generateText({
        model: m.model,
        system: SYSTEM,
        prompt,
        output: Output.object({ schema: LlmAnswer }),
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(10_000),
      });
      return { output: res.output, usage: res.usage, modelName: m.name };
    } catch (err) {
      lastError = err;   // log it with the model name, then try the next one
      console.warn(`[ask] ${m.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw lastError;
}

/** Joins every part of each article, in the order the search ranked the articles. */
async function buildSources(top: SearchResult[]): Promise<Source[]> {
  const parts = await getArticleParts(
    top.map((t) => ({ documentId: t.documentId, articleRef: t.articleRef })),
    { kinds: ['statute'] },
  );
  return top.map((t, i) => {
    const own = parts.filter((p) => p.documentId === t.documentId && p.articleRef === t.articleRef);
    return {
      n: i + 1,
      documentId: t.documentId,
      documentTitle: t.documentTitle,
      articleRef: t.articleRef,
      sectionPath: own[0]?.sectionPath ?? null,
      pageStart: own[0]?.pageStart ?? t.pageStart,
      pageEnd: own.at(-1)?.pageEnd ?? t.pageStart,
      // part 2+ starts with "[Article 12, part 2]": drop that label when joining the parts back
      content: own.map((p) => p.content.replace(/^\[Article [^\]]+\]\n/, '')).join('\n'),
    };
  });
}

/** What the API returns. The eval calls answerQuestion to also get the trace. */
export async function askQuestion(question: string): Promise<AskResponse> {
  return (await answerQuestion(question)).response;
}

export async function answerQuestion(question: string): Promise<AskResult> {
  const started = performance.now();
  const language = detectLanguage(question);
  // Statutes only until an eval with published decisions says otherwise (see README, v2)
  const hits = await searchByVector(question, 20, { kinds: ['statute'] });
  const topSimilarity = hits[0]?.similarity ?? 0;
  const notFound: AskResponse = { found: false, answer: null, citations: [], confidence: null, language };

  // Every exit goes through here: one queries row per question, and the same values returned as the trace.
  // The row is built in memory first, so a failed insert still returns a complete trace.
  const finish = async (
    row: Pick<UserQuery, 'found' | 'stoppedAt'> & Partial<UserQuery>,
    response: AskResponse,
    sourceArticles: SourceRef[] = [],
  ): Promise<AskResult> => {
    const query: UserQuery = {
      question, language, topSimilarity,
      model: null, inputTokens: null, outputTokens: null, costUsd: null,
      latencyMs: Math.round(performance.now() - started),
      ...row,
    };
    // Logging must never break an answer: the error is reported, the answer still goes out
    const id = await storeQuery(query).catch((err: unknown) => {
      console.error('[ask] could not log query', err);
      return undefined;
    });
    return { response, trace: { ...query, id, sourceArticles } };
  };

  // Layer 1: too far from every article → refuse without calling the LLM
  if (topSimilarity < env.MIN_SIMILARITY) {
    return finish({ found: false, stoppedAt: 'threshold' }, notFound);
  }

  const sources = await buildSources(dedupeByArticle(hits).slice(0, 5));
  const refs: SourceRef[] = sources.map((s) => ({ document: s.documentTitle, article: s.articleRef }));

  let generated: Awaited<ReturnType<typeof generateWithFallback>>;
  try {
    generated = await generateWithFallback(userPrompt(question, sources, language));
  } catch (err) {
    await finish({ found: false, stoppedAt: 'error' }, notFound, refs);
    throw err; // the error handler turns it into a clean 500
  }

  const { output, usage, modelName } = generated;
  const spend = {
    model: modelName,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    costUsd: costUsd(modelName, usage.inputTokens, usage.outputTokens),
  };

  // Layer 2a: the model says the sources don't contain the answer
  if (!output.found) {
    return finish({ found: false, stoppedAt: 'llm', ...spend }, notFound, refs);
  }

  // Layer 2b: an answer with no citation we can verify is not shown
  const citations = verifyCitations(output, sources);
  if (citations.length === 0) {
    return finish({ found: false, stoppedAt: 'no_valid_citation', ...spend }, notFound, refs);
  }

  return finish(
    { found: true, stoppedAt: null, ...spend },
    { found: true, answer: output.answer, citations, confidence: output.confidence, language },
    refs,
  );
}