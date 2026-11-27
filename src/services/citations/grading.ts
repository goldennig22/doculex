import { ACTS, isLinkable, type ActCode, type ActDefinition } from './acts';
import type { ActSource, DetectionFlag } from './detector';

// From a detected citation to (act, version, confidence). Pure: what the database holds comes in as an ArticleIndex.
// Run by the link-citations job, then again in the publish transaction, where the decision date is final.

export type Confidence = 'high' | 'medium' | 'low';
export type CitationMethod = 'rule' | 'llm' | 'reviewer';

/**
 * Why a citation got its confidence. Only 'low' ones go to a reviewer; the article page never shows them.
 * - low: unknown_act (no act after the rules and the LLM), range_not_expanded, version_unknown (no date, no hint),
 *   article_not_found (we hold that act version and it has no such article: a misread, or a gap like Art. 705 of the
 *   Companies Act PDF);
 * - medium: inferred_from_paragraph, found_by_llm, version_by_decision_date (decided soon after a revision: the old
 *   version may still govern the facts);
 * - high, for information: version_not_ingested (certain, but no document holds that version yet: links appear on
 *   its page as soon as it is uploaded), not_linkable (Code civil, the Treaty: known, never linked).
 */
export type LinkReason =
  | 'unknown_act' | 'range_not_expanded' | 'version_unknown' | 'article_not_found'
  | 'inferred_from_paragraph' | 'found_by_llm' | 'version_by_decision_date'
  | 'version_not_ingested' | 'not_linkable';

/** After a revision, how long a decision may still apply the old version to facts that happened before it. */
export const VERSION_TRANSITION_YEARS = 5;

export const versionKey = (code: ActCode, version: string) => `${code}|${version}`;
export const articleKey = (code: ActCode, version: string, articleRef: string) => `${code}|${version}|${articleRef}`;

/** What the statutes in the database hold: act versions (versionKey) and their articles (articleKey). */
export type ArticleIndex = { versions: ReadonlySet<string>; articles: ReadonlySet<string> };

const addYears = (isoDate: string, years: number) => `${Number(isoDate.slice(0, 4)) + years}${isoDate.slice(4)}`;

/**
 * The version a citation means: a year in the text wins ("de 1997"; "révisé" is the latest), otherwise the version in
 * force on the decision date. nearRevision: chosen by date, less than VERSION_TRANSITION_YEARS after a revision.
 */
export function pickVersion(act: ActDefinition, versionHint: string | null, decisionDate: string | null): { version: string | null; nearRevision: boolean } {
  const { versions } = act;
  if (versions.length === 0) return { version: null, nearRevision: false };
  if (versionHint === 'latest') return { version: versions[versions.length - 1].version, nearRevision: false };
  const hinted = versions.find((v) => v.version === versionHint);
  if (hinted) return { version: hinted.version, nearRevision: false };
  if (decisionDate === null) return { version: null, nearRevision: false };

  const inForce = versions.filter((v) => v.inForceFrom <= decisionDate); // ISO dates compare as strings
  if (inForce.length === 0) return { version: null, nearRevision: false };
  const chosen = inForce[inForce.length - 1];
  const afterARevision = inForce.length > 1;
  // A year that names no version ("de 2011") is not ignored silently: the choice by date is then only a guess
  const unmatchedHint = versionHint !== null;
  return {
    version: chosen.version,
    nearRevision: unmatchedHint || (afterARevision && decisionDate < addYears(chosen.inForceFrom, VERSION_TRANSITION_YEARS)),
  };
}

export type GradeInput = {
  articleRef: string;
  actCode: ActCode | null;
  actSource: ActSource;
  versionHint: string | null;
  flags: readonly DetectionFlag[];
  method: Exclude<CitationMethod, 'reviewer'>;
};
export type Grade = { actVersion: string | null; confidence: Confidence; reason: LinkReason | null };

export function gradeCitation(c: GradeInput, decisionDate: string | null, index: ArticleIndex): Grade {
  if (c.actCode === null) return { actVersion: null, confidence: 'low', reason: 'unknown_act' };

  const guessed: LinkReason | null =
    c.method === 'llm' ? 'found_by_llm' : c.actSource === 'paragraph' ? 'inferred_from_paragraph' : null;
  if (!isLinkable(c.actCode)) {
    if (c.flags.includes('range_not_expanded')) return { actVersion: null, confidence: 'low', reason: 'range_not_expanded' };
    return { actVersion: null, confidence: guessed ? 'medium' : 'high', reason: guessed ?? 'not_linkable' };
  }

  const { version, nearRevision } = pickVersion(ACTS[c.actCode], c.versionHint, decisionDate);
  if (c.flags.includes('range_not_expanded')) return { actVersion: version, confidence: 'low', reason: 'range_not_expanded' };
  if (version === null) return { actVersion: null, confidence: 'low', reason: 'version_unknown' };

  const held = index.versions.has(versionKey(c.actCode, version));
  if (held && !index.articles.has(articleKey(c.actCode, version, c.articleRef))) {
    return { actVersion: version, confidence: 'low', reason: 'article_not_found' };
  }
  if (guessed) return { actVersion: version, confidence: 'medium', reason: guessed };
  if (nearRevision) return { actVersion: version, confidence: 'medium', reason: 'version_by_decision_date' };
  return { actVersion: version, confidence: 'high', reason: held ? null : 'version_not_ingested' };
}
