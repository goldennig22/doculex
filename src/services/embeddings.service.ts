import { embed, embedMany } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { env } from '../config/env';

const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY });
export const EMBEDDING_MODEL = env.EMBEDDING_MODEL;
export const DIMENSIONS = 1536;

const model = google.embedding(EMBEDDING_MODEL);

const options = (taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY') => ({
  google: { outputDimensionality: DIMENSIONS, taskType },
});

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model,
    values: texts,
    providerOptions: options('RETRIEVAL_DOCUMENT'),
    maxParallelCalls: env.EMBEDDING_PARALLEL_CALLS,   
    maxRetries: 3,
  });
  return embeddings;
}

export async function embedQuery(text: string): Promise<number[]> {
  const { embedding } = await embed({ model, value: text, providerOptions: options('RETRIEVAL_QUERY') });
  return embedding;
}