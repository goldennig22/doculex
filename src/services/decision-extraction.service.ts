import { z } from 'zod';
import type { LanguageModelUsage } from 'ai';
import type { Lang } from '../interfaces/types';
import { decisionOutcome } from '../db/schema';
import { costUsd } from '../config/prices';
import { norm } from './answer.service';
import { estimateTokens } from './chunker.service';
import { sectionRank } from './decision-chunker.service';
import { generateObjectWithFallback } from './llm.service';

// AI metadata extraction for a court decision. Same discipline as /ask:
//   - only facts stated in the text, null when the text doesn't say it;
//   - every value comes with a quote, and the server checks that quote verbatim in the text it sent
//     (a model can invent "Arrêt n° 045/2019"; it can't make that string appear in the caption).
// What verification can't catch: a real quote from the wrong passage (the lower court's date, the pourvoi number).
// The prompt targets those, and eval/decisions.json measures them.

export const OUTCOMES = decisionOutcome.enumValues;
export type Outcome = (typeof OUTCOMES)[number];

const QUOTE = 'Exact words copied from the text that state this value; null when value is null';

const evidenced = <T extends z.ZodType>(value: T, description: string) => z.object({
  value: value.nullable().describe(description),
  quote: z.string().nullable().describe(QUOTE),
});

// What the model must return. The date is a plain string here and checked field by field in verifyExtraction:
// a strict date in the schema would turn one bad date into a NoObjectGeneratedError and lose every other field.
export const ExtractionOutput = z.object({
  court: evidenced(z.string(),
    'The court that delivered THIS decision. "CCJA" for the Cour Commune de Justice et d\'Arbitrage; any other court as written. Never the lower court whose decision is appealed.'),
  country: evidenced(z.string(),
    'ISO 3166-1 alpha-2 code of the country of the court that delivered this decision ("CM", "CI"). null for the CCJA, which is not a national court. Only if the text names the country or a city of that court.'),
  chamber: evidenced(z.string(), 'The chamber of the court that delivered this decision, as written, e.g. "Première chambre".'),
  caseNumber: evidenced(z.string(),
    'The number of THIS decision as written on its "Arrêt N°" / "Judgment No." line, e.g. "Arrêt N° 045/2019". Never the appeal (pourvoi) number, never the number of the decision appealed.'),
  decisionDate: evidenced(z.string(),
    'The date THIS decision was delivered, as YYYY-MM-DD. Numeric dates in the text are day/month/year. Quote the date as written. Never the date of the appeal or of the lower court\'s decision.'),
  subject: evidenced(z.string(),
    'The legal question the court decided, as a short phrase (at most 15 words) in the language of the decision. Quote the passage of the court\'s reasoning it comes from.'),
  outcome: evidenced(z.enum(OUTCOMES),
    'What THIS court decided, from the LAST "PAR CES MOTIFS" / "FOR THESE REASONS": cassation (quashes), cassation_partielle (quashes in part), rejet (dismisses the appeal), irrecevabilite (inadmissible), incompetence (no jurisdiction), autre. Earlier "PAR CES MOTIFS" quote the lower court: ignore them.'),
  headnote: z.string().nullable().describe(
    'Exactly 3 sentences in <responseLanguage>: the question, what the court held and why. Summarise the court\'s answer ("Mais attendu que…"), never a party\'s grievance ("il est fait grief…"). null if the text has no reasoning.'),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

export const EXTRACTION_SYSTEM = `You extract metadata from one court decision (OHADA business law) for a legal research database.
Rules:
1. Use only facts stated in the text. Never use outside knowledge, never guess, never infer a value the text does not state.
2. When the text does not state a field, set its value and quote to null. A null is correct; a guess is an error.
3. For every value, copy into quote the exact words of the text that state it, character for character.
4. Describe THIS decision: not the lower court's decision it reviews, which the text often quotes, including its own "PAR CES MOTIFS".
5. Ignore the names of the parties and of their lawyers: never put them in any field.
6. Write subject and headnote in the language given in <responseLanguage>.`;

export type DecisionMetadata = {
  court: string | null;
  country: string | null;
  chamber: string | null;
  caseNumber: string | null;
  decisionDate: string | null;
  subject: string | null;
  outcome: Outcome | null;
  headnote: string | null;
};
export type MetadataField = keyof DecisionMetadata;
export type DroppedField = { field: MetadataField; reason: string };

// ── Input ──────────────────────────────────────────────────────────────────────────────────────────

export type ChunkText = { articleRef: string; part: number; content: string };

/** Enough for most judgments; a 30-page appeal decision is cut (caption and dispositif always kept). */
export const MAX_INPUT_TOKENS = 12_000;

const PART_LABEL = /^\[[^\]\n]+, part \d+\]\n/;

/**
 * The text sent to the model, and the text quotes are checked against: the caption, then the chunks in reading
 * order (part labels removed). Over maxTokens, sections are kept in reading order while they fit, but the caption
 * and the dispositif always are: they hold most of the fields. A cut is marked "[…]".
 */
export function buildExtractionInput(caption: string | null, chunks: ChunkText[], maxTokens = MAX_INPUT_TOKENS): string {
  const ordered = [...chunks].sort((a, b) => sectionRank(a.articleRef) - sectionRank(b.articleRef) || a.part - b.part);
  const sections: { ref: string; text: string }[] = [];
  for (const c of ordered) {
    const text = c.content.replace(PART_LABEL, '');
    const last = sections.at(-1);
    if (last?.ref === c.articleRef) last.text += `\n${text}`;
    else sections.push({ ref: c.articleRef, text });
  }

  const head = caption ? `<caption>\n${caption}\n</caption>\n` : '';
  const dispositif = sections.filter((s) => s.ref === 'dispositif');
  let budget = maxTokens - estimateTokens(head) - dispositif.reduce((n, s) => n + estimateTokens(s.text), 0);

  const body: string[] = [];
  let cut = false;
  for (const s of sections) {
    if (s.ref === 'dispositif') { body.push(s.text); continue; }
    const cost = estimateTokens(s.text);
    if (cost <= budget) { body.push(s.text); budget -= cost; }
    else if (!cut) { body.push('[…]'); cut = true; }
  }
  return `${head}<decision>\n${body.join('\n')}\n</decision>`;
}

export const extractionPrompt = (input: string, language: Lang): string =>
  `${input}\n\n<responseLanguage>${language}</responseLanguage>`;

// ── Verification ───────────────────────────────────────────────────────────────────────────────────

/** "CCJA" and "Première chambre" are short; under 4 characters a quote ("du", "N°") proves nothing. */
export const MIN_EVIDENCE_CHARS = 4;

const MONTHS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10,
  novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10,
  november: 11, december: 12,
};
const MONTH = Object.keys(MONTHS).join('|');
const stripAccents = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Every date written in `text`: "28 février 2019", "1er mars 2019", "10/05/2016" (day first), "February 28, 2019". */
export function datesIn(text: string): string[] {
  const t = stripAccents(text.toLowerCase());
  const found: string[] = [];
  for (const m of t.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g)) {
    found.push(iso(Number(m[3]), Number(m[2]), Number(m[1])));
  }
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:er|st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\s*,?\\s+(\\d{4})\\b`, 'g'))) {
    found.push(iso(Number(m[3]), MONTHS[m[2]], Number(m[1])));
  }
  for (const m of t.matchAll(new RegExp(`\\b(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s+(\\d{4})\\b`, 'g'))) {
    found.push(iso(Number(m[3]), MONTHS[m[1]], Number(m[2])));
  }
  return found;
}

/** The ISO value is one of the dates the quote states: catches "10/05/2016" read as 2016-10-05. */
export const dateMatchesQuote = (isoDate: string, quote: string): boolean => datesIn(quote).includes(isoDate);

const isIsoDate = (s: string) => z.iso.date().safeParse(s).success;
const digitRuns = (s: string): string[] => s.match(/\d+/g) ?? [];

/**
 * Turns the model's output into metadata the database may store. A field whose evidence fails becomes null
 * and is listed in `dropped`, so one bad field never discards the others.
 */
export function verifyExtraction(out: ExtractionOutput, input: string): { metadata: DecisionMetadata; dropped: DroppedField[] } {
  const text = norm(input);
  const dropped: DroppedField[] = [];

  function evidence<T>(field: MetadataField, e: { value: T | null; quote: string | null }, check?: (v: T, quote: string) => string | null): T | null {
    if (e.value === null) return null;
    const quote = e.quote === null ? '' : norm(e.quote);
    let reason: string | null = null;
    if (quote.length < MIN_EVIDENCE_CHARS) reason = 'no quote';
    else if (!text.includes(quote)) reason = 'quote not found in the text';
    else if (check) reason = check(e.value, e.quote ?? '');
    if (reason) { dropped.push({ field, reason }); return null; }
    return e.value;
  }

  const rawCourt = evidence('court', out.court);
  const court = rawCourt !== null && norm(rawCourt).includes('cour commune de justice') ? 'CCJA' : rawCourt;

  let country = evidence('country', out.country, (v) => (/^[A-Za-z]{2}$/.test(v.trim()) ? null : 'not an ISO 3166-1 alpha-2 code'));
  if (country !== null && court === 'CCJA') {
    dropped.push({ field: 'country', reason: 'the CCJA is not a national court' });
    country = null;
  }

  const metadata: DecisionMetadata = {
    court,
    country: country?.trim().toUpperCase() ?? null,
    chamber: evidence('chamber', out.chamber),
    // Every number in the value must be in the quote: a real quote with an invented number fails
    caseNumber: evidence('caseNumber', out.caseNumber, (v, q) =>
      digitRuns(v).length > 0 && digitRuns(v).every((d) => digitRuns(q).includes(d)) ? null : 'number not in the quote'),
    decisionDate: evidence('decisionDate', out.decisionDate, (v, q) =>
      !isIsoDate(v) ? 'not a YYYY-MM-DD date' : dateMatchesQuote(v, q) ? null : 'date does not match the quote'),
    subject: evidence('subject', out.subject),
    outcome: evidence('outcome', out.outcome),
    headnote: out.headnote?.trim() || null,
  };
  return { metadata, dropped };
}

// ── The call ───────────────────────────────────────────────────────────────────────────────────────

export type ExtractionResult = {
  metadata: DecisionMetadata;
  dropped: DroppedField[];
  model: string;
  usage: LanguageModelUsage;
  costUsd: number | null;
};

/**
 * One extraction, verified. Throws what the fallback chain throws: NoObjectGeneratedError when the models'
 * output never matched the schema, a provider error otherwise. The caller decides what each one means.
 * No one is waiting on this (it runs in a job): each model gets 30 s.
 */
export async function extractMetadata(input: string, language: Lang, signal?: AbortSignal): Promise<ExtractionResult> {
  const { output, usage, modelName } = await generateObjectWithFallback({
    label: '[extract]',
    system: EXTRACTION_SYSTEM,
    prompt: extractionPrompt(input, language),
    schema: ExtractionOutput,
    timeoutMs: 30_000,
    signal,
  });
  const { metadata, dropped } = verifyExtraction(output, input);
  return { metadata, dropped, model: modelName, usage, costUsd: costUsd(modelName, usage.inputTokens, usage.outputTokens) };
}
