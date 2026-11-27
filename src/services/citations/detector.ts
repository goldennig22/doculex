import { ACTS, ACT_CODES, type ActCode } from './acts';
import type { Segment } from '../anonymisation/mentions';

// Finds the articles a court decision cites: "l'article 28 de l'AUPSRVE", "articles 13 à 15 du même Acte uniforme",
// "Article 311 of the Uniform Act relating to Commercial Companies", "l'article 44 susvisé". Pure: no database, no LLM.
//
// Two passes over the text:
//   1. act mentions: every place an act is named (AUPSRVE, "Acte uniforme portant sur le droit commercial général",
//      "Code civil"), whether an article is next to it or not. Every look-back is a search in this sorted list.
//   2. article mentions: a trigger ("article", "art."), a list of numbers ("13, 14 et 15", "13 à 15"), then the act,
//      tried in a fixed order (see attachAct).
//
// All matching runs on foldForMatch(text), which has the same length as text: every offset is valid in the original.

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * How the act was found:
 * - explicit: named right after the numbers ("de l'AUPSRVE"), or just before ("l'AUPSRVE en son article 28");
 * - same_act: "du même Acte uniforme", "dudit Acte", "of the said Uniform Act": the last Uniform Act named before;
 * - anaphora: "l'article 44 susvisé": the act of the last earlier citation of the same article;
 * - paragraph: nothing names it; the last act named earlier in the same paragraph (a guess: medium at best);
 * - null: not found. The LLM pass gets these.
 */
export type ActSource = 'explicit' | 'same_act' | 'anaphora' | 'paragraph' | null;

/** range_not_expanded: "13 à 1500", "15 à 13", "13 bis à 15": only the two ends are kept, for a reviewer. */
export type DetectionFlag = 'range_not_expanded';

export type DetectedCitation = {
  /** Same format as chunks.article_ref: "1", "12 bis", "35-1" */
  articleRef: string;
  actCode: ActCode | null;
  /** text.slice(start, end): the whole mention, shared by every article of a list or range */
  rawText: string;
  /** UTF-16 offsets in the text given to detectCitations, end excluded */
  start: number;
  end: number;
  actSource: ActSource;
  /** "1997" from "l'Acte uniforme du 17 avril 1997", "latest" from "révisé"; null when the text doesn't date the act */
  versionHint: string | null;
  flags: DetectionFlag[];
};

export type ActMention = { code: ActCode; start: number; end: number; versionHint: string | null };

export type SegmentCitation = DetectedCitation & { segmentId: string };

/** What the earlier segments of the same decision tell the next one. */
export type DetectionContext = {
  citations: readonly DetectedCitation[];
  lastUniformAct: Pick<ActMention, 'code' | 'versionHint'> | null;
};
const EMPTY_CONTEXT: DetectionContext = { citations: [], lastUniformAct: null };

// ─── Folding: lower case, no accents, straight apostrophes, SAME LENGTH ──────

const SPECIAL: Record<string, string> = {
  '’': "'", '‘': "'", 'ʼ': "'", '´': "'", '`': "'",
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
};
const foldCache = new Map<string, string>();

function foldChar(c: string): string {
  const special = SPECIAL[c];
  if (special) return special;
  if (c < '\u0080') return c.toLowerCase();
  let folded = foldCache.get(c);
  if (folded === undefined) {
    // NFD splits "é" into "e" + a combining accent: keep the base letter only. Anything that would not stay one
    // UTF-16 unit (a ligature, a lone surrogate's oddities) is kept as it is.
    const base = c.normalize('NFD')[0].toLowerCase();
    folded = base.length === 1 ? base : c;
    foldCache.set(c, folded);
  }
  return folded;
}

/**
 * One UTF-16 unit for one: never `text.normalize('NFD')`, which makes "général" one unit longer and shifts every
 * offset after it.
 */
export function foldForMatch(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += foldChar(text[i]);
  return out;
}

// ─── Article references ──────────────────────────────────────────────────────

/** Same format as normalizeRef in chunker.service (not imported: that module loads the database client). */
function toArticleRef(num: string, suffix: string | undefined): string {
  const n = /^(1er|1re|premier|first)$/.test(num) ? '1' : num;
  return suffix ? `${n} ${suffix}` : n;
}

/** "13", "15" → 13, 14, 15. null when it can't or shouldn't: not plain numbers, backwards, or more than max articles. */
export function expandRange(from: string, to: string, max = 30): string[] | null {
  if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) return null;
  const a = Number(from);
  const b = Number(to);
  if (b <= a || b - a + 1 > max) return null;
  return Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
}

// The hyphen is NOT a range: "35-1" is an article (see the chunker). "à", "au", "to", "through" and dashes are.
const NUM = /(1er|1re|premier|first|\d+(?:-\d+)?)(?:\s?(bis|ter|quater|quinquies|sexies|septies|octies))?(?![a-z0-9°/])/y;
const MONTH = /\s+(?:janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|january|february|march|april|may|june|july|august|september|october|november|december)\b/y;
const QN = String.raw`(?:\d+(?:er|re|e|°)?|premier|first|second|deuxieme|troisieme|quatrieme|[a-z]\))`;
// "alinéa 2", "al. 1er", "paragraphes 2 et 3", "point 3°", "(2)": read and thrown away, never an article
const QUALIFIER = new RegExp(String.raw`\s*,?\s*(?:(?:alineas?|al\.|paragraphes?|paragraphs?|para\.|points?|litteras?|§)\s*${QN}(?:\s*(?:,|et|and)\s*${QN})*|\(\s*\d+\s*\)(?:\s*\(\s*[a-z0-9]+\s*\))*)`, 'y');
const RANGE = /\s*(?:a|au|to|through|–|—)\s*/y;
const SEPARATOR = /\s*(?:,|et|and|ou|or|&)\s*/y;
const AND_FOLLOWING = /\s*(?:et\s+(?:suivants|s\.|ss\.?)|et\s+seq\.?|ff\.)/y;

function stickyAt(re: RegExp, s: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(s);
}

function readNumber(folded: string, at: number): { ref: string; end: number } | null {
  const m = stickyAt(NUM, folded, at);
  if (!m) return null;
  const end = at + m[0].length;
  if (stickyAt(MONTH, folded, end)) return null; // "le 7 juillet": a date
  return { ref: toArticleRef(m[1], m[2]), end };
}

function skipQualifiers(folded: string, at: number): number {
  let pos = at;
  for (let m = stickyAt(QUALIFIER, folded, pos); m && m[0].length > 0; m = stickyAt(QUALIFIER, folded, pos)) pos += m[0].length;
  return pos;
}

/**
 * The numbers after a trigger: "7", "13 et 14", "13, 14 et 15", "13 à 15", "1er et 2", "12 bis", "49 alinéa 2".
 * `at` is just after the trigger word. null when no number follows ("l'article susvisé", "the article").
 */
export function parseArticleList(folded: string, at: number, maxRange = 30): { refs: string[]; end: number; flags: DetectionFlag[] } | null {
  const first = readNumber(folded, at);
  if (!first) return null;
  const refs = [first.ref];
  const flags: DetectionFlag[] = [];
  let end = first.end;
  for (;;) {
    const pos = skipQualifiers(folded, end);
    end = pos;
    const range = stickyAt(RANGE, folded, pos);
    const toNum = range ? readNumber(folded, pos + range[0].length) : null;
    if (toNum) {
      const from = refs[refs.length - 1];
      const expanded = expandRange(from, toNum.ref, maxRange);
      if (expanded) refs.splice(refs.length - 1, 1, ...expanded);
      else {
        refs.push(toNum.ref);
        if (!flags.includes('range_not_expanded')) flags.push('range_not_expanded');
      }
      end = toNum.end;
      continue;
    }
    const sep = stickyAt(SEPARATOR, folded, pos);
    const next = sep ? readNumber(folded, pos + sep[0].length) : null;
    if (next) {
      refs.push(next.ref);
      end = next.end;
      continue;
    }
    break;
  }
  const following = stickyAt(AND_FOLLOWING, folded, end);
  if (following) end += following[0].length;
  return { refs, end, flags };
}

// ─── Pass 1: act mentions ────────────────────────────────────────────────────

const byLengthDesc = (a: string, b: string) => b.length - a.length;

const ABBREVIATIONS = new Map<string, ActCode>(
  ACT_CODES.flatMap((code) => ACTS[code].abbreviations.map((a) => [a, code] as const)));
// On the ORIGINAL text, case-sensitive: "AUS" is the Act, "aus" is nothing
const ABBREVIATION_RE = new RegExp(String.raw`(?<![A-Za-z0-9])(${[...ABBREVIATIONS.keys()].sort(byLengthDesc).join('|')})(?![A-Za-z0-9])`, 'g');

// PDF text breaks lines anywhere, titles included: "droit\ncommercial général". Every space of a phrase is \s+.
const spaced = (phrase: string) => phrase.replace(/ /g, String.raw`\s+`);

const UNIFORM_ACT_RE = /\b(?:(revised|revise)\s+)?(acte\s+uniforme|uniform\s+act)\b/g;
const KEYWORDS = ACT_CODES.flatMap((code) => ACTS[code].keywords.map((keyword) => ({
  code,
  re: new RegExp(String.raw`(?<![a-z])${spaced(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}(?![a-z])`, 'g'),
})));
/** Between "Acte uniforme" and its keyword: " OHADA du 15 décembre 2010 ", never a sentence break */
const KEYWORD_GAP = /^[^.;,:()]{0,60}$/;

const PATTERN_ACTS = ACT_CODES.filter((code) => ACTS[code].patterns?.length).map((code) => ({
  code,
  re: new RegExp(String.raw`\b(?:${ACTS[code].patterns!.map(spaced).join('|')})(?![a-z])`, 'g'),
}));
/** "le Traité" is the OHADA Treaty, "a traité" is a verb: the treaty must be capitalised in the original */
const CAPITALISED: ReadonlySet<ActCode> = new Set(['TRAITE']);

const YEAR_AFTER = /\s*,?\s*\(?\s*(?:(?:revise|revised|adopte|adopted|signe|signed)\s+)?(?:(?:le|on)\s+)?(?:(?:du|de|of|dated)\s+)?(?:\d{1,2}(?:er)?\s+[a-z]+\s+)?(19\d{2}|20\d{2})(?![0-9])\)?/y;
const REVISED_AFTER = /\s*,?\s*(?:revise|revised)\b/y;
const YEAR_IN = /(?<![0-9])(19\d{2}|20\d{2})(?![0-9])/;

/** A date or "révisé" right after an act's name: "AUDCG révisé", "l'Acte uniforme … du 15 décembre 2010". */
function trailingHint(folded: string, at: number): { versionHint: string; end: number } | null {
  const year = stickyAt(YEAR_AFTER, folded, at);
  if (year) return { versionHint: year[1], end: at + year[0].length };
  const revised = stickyAt(REVISED_AFTER, folded, at);
  if (revised) return { versionHint: 'latest', end: at + revised[0].length };
  return null;
}

function keywordAfter(folded: string, at: number): { code: ActCode; end: number; gap: string } | null {
  const window = folded.slice(at, at + 220);
  let best: { code: ActCode; index: number; length: number } | null = null;
  for (const { code, re } of KEYWORDS) {
    re.lastIndex = 0;
    const m = re.exec(window);
    if (!m || !KEYWORD_GAP.test(window.slice(0, m.index))) continue;
    if (!best || m.index < best.index || (m.index === best.index && m[0].length > best.length)) {
      best = { code, index: m.index, length: m[0].length };
    }
  }
  return best ? { code: best.code, end: at + best.index + best.length, gap: window.slice(0, best.index) } : null;
}

/**
 * Every act named in the text, sorted by start, never overlapping (the longer of two overlapping mentions wins).
 * "Acte uniforme" with no recognisable title is not a mention: it is a back-reference, resolved in pass 2.
 */
export function findActMentions(text: string, folded = foldForMatch(text)): ActMention[] {
  const found: ActMention[] = [];

  for (const m of text.matchAll(ABBREVIATION_RE)) {
    const start = m.index;
    let end = start + m[0].length;
    const hint = trailingHint(folded, end);
    if (hint) end = hint.end;
    found.push({ code: ABBREVIATIONS.get(m[1])!, start, end, versionHint: hint?.versionHint ?? null });
  }

  for (const m of folded.matchAll(UNIFORM_ACT_RE)) {
    const kw = keywordAfter(folded, m.index + m[0].length);
    if (!kw) continue;
    let end = kw.end;
    let versionHint: string | null = m[1] || /\brevise/.test(kw.gap) ? 'latest' : (YEAR_IN.exec(kw.gap)?.[1] ?? null);
    const hint = trailingHint(folded, end);
    if (hint) {
      end = hint.end;
      versionHint = hint.versionHint;
    }
    found.push({ code: kw.code, start: m.index, end, versionHint });
  }

  for (const { code, re } of PATTERN_ACTS) {
    for (const m of folded.matchAll(re)) {
      if (CAPITALISED.has(code) && !/[A-Z]/.test(text[m.index])) continue;
      found.push({ code, start: m.index, end: m.index + m[0].length, versionHint: null });
    }
  }

  found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept: ActMention[] = [];
  for (const m of found) {
    const last = kept[kept.length - 1];
    if (last && m.start < last.end) continue;
    kept.push(m);
  }
  return kept;
}

// ─── Pass 2: article mentions ────────────────────────────────────────────────

const TRIGGER = /\b(?:l'|les\s+|the\s+)?(?:articles?|art\.?)\s*/g;
const ANAPHORA = /\s*,?\s*(?:susvise(?:e|s|es)?|sus-vise(?:e|s|es)?|precite(?:e|s|es)?|susmentionne(?:e|s|es)?|sus-indique(?:e|s|es)?|ci-dessus|above-mentioned|above mentioned|aforementioned|mentioned above|cited above)\b/y;
const PREPOSITION = /\s*,?\s*(?:(?:du|des|de\s+l'|de\s+la|de|d'|of\s+the|of|under\s+the|under|in\s+the)\s*)?(?:l'|la\s+|le\s+|the\s+)?/y;
// Checked only when no titled act starts here, so a bare "Acte uniforme" means "the one just named". Not when a title
// follows that the table doesn't know ("Acte uniforme relatif au droit de la mer"): that is UNKNOWN_ACT.
const UNTITLED = String.raw`(?!\s+(?:ohada\s+)?(?:portant|relatif|relative|sur|du\s+\d|de\s+\d|relating|on|of\s+\d|dated))`;
const SAME_ACT = new RegExp(String.raw`(?:(?:meme|present|dit)\s+acte(?:\s+uniforme)?|ledit\s+acte(?:\s+uniforme)?|acte\s+uniforme\s+(?:susvise|precite|susmentionne|sus-vise)e?|acte\s+uniforme${UNTITLED}|(?:same|said|above-mentioned|above mentioned|aforementioned)\s+uniform\s+act|uniform\s+act${UNTITLED})\b`, 'y');
// A text is named, but not one the table knows: unresolved, and never replaced by a guess from the paragraph
const UNKNOWN_ACT = /(?:acte\s+uniforme|uniform\s+act|convention|loi|law|code|reglement|regulation|decret|decree|directive|traite|treaty|ordonnance)\b/y;
/** Its title: up to punctuation or the verb that follows it ("… relatif au droit de la mer dispose que"), 100 chars at most */
const UNKNOWN_TITLE = /(?:(?!\s+(?:dispose|disposent|prevoit|prevoient|precise|enonce|qui|que|selon|est|sont|a|ont|provides|states|which|that|is|are)\b)[^;.,:\n]){1,100}/y;
const EN_SON = /^\s*,?\s*(?:en|in)\s+(?:son|ses|its)\s+$/;

const lastBefore = <T extends { end: number }>(items: readonly T[], pos: number, ok: (t: T) => boolean = () => true): T | null => {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].end <= pos && ok(items[i])) return items[i];
  return null;
};

/**
 * Every article cited in one text, in order. A list or range gives one result per article, all with the same span.
 * `context` carries what earlier segments of the same decision said (for "susvisé" and "du même Acte uniforme").
 */
export function detectCitations(text: string, context: DetectionContext = EMPTY_CONTEXT): DetectedCitation[] {
  const folded = foldForMatch(text);
  const mentions = findActMentions(text, folded);
  const mentionAt = new Map(mentions.map((m) => [m.start, m]));
  const paragraphStarts = [0, ...[...folded.matchAll(/\n[ \t]*\n/g)].map((m) => m.index + m[0].length)];
  const paragraphStartOf = (pos: number) => paragraphStarts.filter((p) => p <= pos).pop() ?? 0;
  const isUniformAct = (m: ActMention) => ACTS[m.code].kind === 'uniform_act';

  const out: DetectedCitation[] = [];
  const re = new RegExp(TRIGGER.source, 'g');
  for (let t = re.exec(folded); t; t = re.exec(folded)) {
    const list = parseArticleList(folded, t.index + t[0].length);
    if (!list) continue;
    let start = t.index;
    let end = list.end;

    const anaphora = stickyAt(ANAPHORA, folded, end);
    const afterAnaphora = anaphora ? end + anaphora[0].length : end;
    const prep = stickyAt(PREPOSITION, folded, afterAnaphora)!;
    const actAt = afterAnaphora + prep[0].length;

    type Found = { code: ActCode | null; source: ActSource; versionHint: string | null };
    let shared: Found | null = null;

    const named = mentionAt.get(actAt);
    const same = named ? null : stickyAt(SAME_ACT, folded, actAt);
    if (named) {
      // 1. "de l'AUPSRVE", "of the Uniform Act relating to Commercial Companies"
      shared = { code: named.code, source: 'explicit', versionHint: named.versionHint };
      end = named.end;
    } else if (same) {
      // 2. "du même Acte uniforme", "dudit Acte", "l'Acte uniforme susvisé"
      const previous = lastBefore(mentions, t.index, isUniformAct) ?? context.lastUniformAct;
      shared = previous
        ? { code: previous.code, source: 'same_act', versionHint: previous.versionHint }
        : { code: null, source: null, versionHint: null };
      end = actAt + same[0].length;
    } else if (stickyAt(UNKNOWN_ACT, folded, actAt)) {
      // Keep the unknown title in rawText: it is what the reviewer (and the LLM) must read
      shared = { code: null, source: null, versionHint: null };
      end = actAt + stickyAt(UNKNOWN_TITLE, folded, actAt)![0].trimEnd().length;
    } else if (anaphora) {
      end = afterAnaphora; // 3. "l'article 44 susvisé": resolved per article, below
    } else {
      // 4. "l'AUPSRVE en son article 28"
      const before = lastBefore(mentions, t.index);
      if (before && EN_SON.test(folded.slice(before.end, t.index))) {
        shared = { code: before.code, source: 'explicit', versionHint: before.versionHint };
        start = before.start;
      }
    }

    for (const articleRef of list.refs) {
      let found = shared;
      if (!found && anaphora) {
        const earlier = lastBefore(out, t.index, (c) => c.articleRef === articleRef && c.actCode !== null)
          ?? [...context.citations].reverse().find((c) => c.articleRef === articleRef && c.actCode !== null);
        found = earlier
          // A guess stays a guess: "susvisé" pointing at a paragraph inference is no more certain than that inference
          ? { code: earlier.actCode, source: earlier.actSource === 'paragraph' ? 'paragraph' : 'anaphora', versionHint: earlier.versionHint }
          : { code: null, source: null, versionHint: null };
      }
      if (!found) {
        // 5. Nothing names it: the last act named earlier in the same paragraph
        const paragraphStart = paragraphStartOf(t.index);
        const previous = lastBefore(mentions, t.index, (m) => m.start >= paragraphStart);
        found = previous
          ? { code: previous.code, source: 'paragraph', versionHint: previous.versionHint }
          : { code: null, source: null, versionHint: null };
      }
      out.push({
        articleRef, actCode: found.code, rawText: text.slice(start, end), start, end,
        actSource: found.source, versionHint: found.versionHint, flags: [...list.flags],
      });
    }
    re.lastIndex = Math.max(end, list.end);
  }
  return out;
}

/** The whole decision, segments in reading order: "susvisé" and "du même Acte" can point to an earlier section. */
export function detectInDecision(segments: Segment[]): SegmentCitation[] {
  const all: SegmentCitation[] = [];
  let lastUniformAct: DetectionContext['lastUniformAct'] = null;
  for (const s of segments) {
    const found = detectCitations(s.text, { citations: all, lastUniformAct });
    all.push(...found.map((c) => ({ ...c, segmentId: s.id })));
    const last = lastBefore(findActMentions(s.text), Infinity, (m) => ACTS[m.code].kind === 'uniform_act');
    if (last) lastUniformAct = { code: last.code, versionHint: last.versionHint };
  }
  return all;
}

/** The acts a short text names, for checking an LLM's quote: findActMentions without the offsets. */
export const actsNamedIn = (text: string): ActCode[] => findActMentions(text).map((m) => m.code);
