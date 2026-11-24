import { z } from 'zod';
import { Source } from '../interfaces/types';

export const LlmAnswer = z.object({
  found: z.boolean().describe('false when the sources do not contain the answer'),
  answer: z.string().describe('Answer in the language of the question; empty string when found is false'),
  citations: z.array(z.object({
    source: z.number().int().describe('Number of the source used, e.g. 1 for <source n="1">'),
    quote: z.string().describe('Short exact quote copied from that source that supports the answer'),
  })),
  confidence: z.enum(['high', 'medium', 'low']),
});

export type LlmAnswer = z.infer<typeof LlmAnswer>;

const renderSources = (sources: Source[]) =>
  `<sources>\n${sources.map((s) =>
    `<source n="${s.n}" document="${s.documentTitle}" article="${s.articleRef}" pages="${s.pageStart}-${s.pageEnd}">\n${s.sectionPath ?? ''}\n${s.content}\n</source>`,
  ).join('\n')}\n</sources>`;
  
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  
export const userPrompt = (question: string, sources: Source[]) =>
    `${renderSources(sources)}\n\n<question>${question}</question>`;

/** Shorter quotes ("", "de", "le commerçant") match almost any article, so they prove nothing. */
export const MIN_QUOTE_CHARS = 20;

export function verifyCitations(answer: LlmAnswer, sources: Source[]) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  return answer.citations
    .filter((c) => {
      const src = byN.get(c.source);
      if (!src) return false;
      const quote = norm(c.quote);
      return quote.length >= MIN_QUOTE_CHARS && norm(src.content).includes(quote);
    })
    .map((c) => {
      const s = byN.get(c.source)!;
      return { document: s.documentTitle, article: s.articleRef, pages: [s.pageStart, s.pageEnd], quote: c.quote };
    });
}