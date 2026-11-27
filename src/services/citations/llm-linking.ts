import { z } from 'zod';
import type { Lang } from '../../interfaces/types';
import { costUsd } from '../../config/prices';
import { generateObjectWithFallback } from '../llm.service';
import { norm } from '../answer.service';
import { ACTS, ACT_CODES, type ActCode } from './acts';
import { actsNamedIn } from './detector';

// The LLM pass, only for references the rules left without an act ("l'article 44 susvisé" with nothing earlier,
// "l'article 12 de l'Acte uniforme", a "loi" the table doesn't know). Same discipline as /ask and extraction:
// - the model never writes an article number or a document id: the rules already have the number, the model only
//   picks an act from a closed list (z.enum), so it can't invent "AUDCG 2012";
// - it must quote the words of the excerpt that name that act, and the quote is checked twice: verbatim in that
//   reference's excerpt, AND our own act table must read the same act in it (actsNamedIn). A quote of just
//   "l'Acte uniforme" names nothing, so the choice is dropped and the reference stays 'low'.
// What it can't catch: a real mention of the wrong act. A link it finds is 'medium' at best.

export const ActChoices = z.object({
  links: z.array(z.object({
    id: z.number().int().describe('The id of the reference, as in <reference id="1">'),
    actCode: z.enum(ACT_CODES).nullable().describe('The act the article belongs to, from the list; null if the excerpt does not say'),
    quote: z.string().describe('The words of the excerpt that name that act, copied character for character; "" when actCode is null'),
  })),
});
export type ActChoices = z.infer<typeof ActChoices>;

export const LINKING_SYSTEM = `You link article references found in one court decision (OHADA business law) to the legal text each article belongs to.
For each reference you get an excerpt of the decision around it. Use only that excerpt:
- If the excerpt names the text the article belongs to (before or after the reference, e.g. "Vu l'Acte uniforme portant sur le droit commercial général" earlier in the paragraph), give its code from the list below and quote, character for character, the words of the excerpt that name it.
- If it does not, or if you would have to rely on what you know about OHADA law (for instance which Act usually has an article with that number), set actCode to null and quote to "".
An article number alone proves nothing: never guess.

Codes:
${ACT_CODES.map((c) => `- ${c}: ${ACTS[c].label}`).join('\n')}`;

export type LinkingItem = { id: number; rawText: string; excerpt: string };

export const linkingPrompt = (items: LinkingItem[], language: Lang): string =>
  `${items.map((i) => `<reference id="${i.id}">${i.rawText}</reference>\n<excerpt id="${i.id}">\n${i.excerpt}\n</excerpt>`).join('\n\n')}\n<language>${language}</language>`;

/** Chars kept around a reference: the paragraph that names the act is usually before it. */
const BEFORE = 1200;
const AFTER = 300;

/** The paragraph around [start, end) of a segment, cut to BEFORE / AFTER characters. */
export function excerptAround(text: string, start: number, end: number): string {
  const paragraphStart = Math.max(0, text.lastIndexOf('\n\n', start) + 1);
  const nextBreak = text.indexOf('\n\n', end);
  const paragraphEnd = nextBreak < 0 ? text.length : nextBreak;
  return text.slice(Math.max(paragraphStart, start - BEFORE), Math.min(paragraphEnd, end + AFTER)).trim();
}

/** Keeps the choices whose quote is in that reference's excerpt and names that act by our own rules. */
export function verifyActChoices(out: ActChoices, excerpts: ReadonlyMap<number, string>): Map<number, ActCode> {
  const resolved = new Map<number, ActCode>();
  for (const link of out.links) {
    const excerpt = excerpts.get(link.id);
    if (!excerpt || link.actCode === null || resolved.has(link.id)) continue;
    const quote = norm(link.quote);
    if (quote.length === 0 || !norm(excerpt).includes(quote)) continue;
    if (!actsNamedIn(link.quote).includes(link.actCode)) continue;
    resolved.set(link.id, link.actCode);
  }
  return resolved;
}

export type LlmLinking = {
  resolved: Map<number, ActCode>;
  dropped: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
};

/**
 * One call for all the unresolved references of a decision. Throws what the fallback chain throws
 * (NoObjectGeneratedError for unusable output, a provider error otherwise); the job decides what each means.
 */
export async function linkWithLlm(items: LinkingItem[], language: Lang, signal?: AbortSignal): Promise<LlmLinking> {
  const { output, usage, modelName } = await generateObjectWithFallback({
    label: '[citations]',
    system: LINKING_SYSTEM,
    prompt: linkingPrompt(items, language),
    schema: ActChoices,
    timeoutMs: 30_000,
    signal,
  });
  const resolved = verifyActChoices(output, new Map(items.map((i) => [i.id, i.excerpt])));
  const proposed = output.links.filter((l) => l.actCode !== null).length;
  return {
    resolved,
    dropped: Math.max(0, proposed - resolved.size),
    model: modelName,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    costUsd: costUsd(modelName, usage.inputTokens, usage.outputTokens),
  };
}
