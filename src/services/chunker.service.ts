import { ChunkDraft, PageText } from "../interfaces/documents";
// ─── Patterns ────────────────────────────────────────────────────────────────
 
// An article heading starts a line: "Article 1er", "Art.2.-", "ARTICLE 12 bis", "Article 35-1".
const ARTICLE_HEADING =
  /^[ \t]*(?:article|art\.)[ \t]*(\d+(?:-\d+)?|1er|premier)(?:[ \t]+(bis|ter|quater))?\b/gimu;
 
// A structural heading: "Livre 1 - …", "Titre 2 - …", "CHAPTER 3 …", "Section1 …",
// "TITLE 1– …", "BOOK ONE: …", "PRELIMINARY CHAPTER".
const NUM = String.raw`(?:\d+(?:er|ère)?|[ivxlc]+(?:er)?|one|two|three|four|five|six|seven|eight|nine|ten|premier|première|unique|préliminaire|preliminary)`;
const STRUCTURE = new RegExp(
  String.raw`^\s*(?:preliminary\s+)?(part|book|livre|title|titre|chapter|chapitre|section|sub-section|sous-section|paragraph|paragraphe)(?:\s*${NUM}\b|\s*$)`,
  'iu',
);
 
// Depth of each kind of heading: a new "Livre" clears the Titre/Chapitre/Section below it.
const LEVEL: Record<string, number> = {
  part: 0,
  book: 1, livre: 1,
  title: 2, titre: 2,
  chapter: 3, chapitre: 3,
  section: 4,
  'sub-section': 5, 'sous-section': 5,
  paragraph: 6, paragraphe: 6,
};
 
// Hyphenated prefixes that are real compound words: "non-commerçant" keeps its hyphen.
const KEEP_HYPHEN = new Set([
  'non', 'sous', 'co', 'auto', 'quasi', 'semi', 'vice', 'ex', 'anti', 'contre', 'extra', 'inter', 'self', 'pre', 'post',
]);
 
const MAX_TOKENS = 800; // split an article only above this size
const TARGET_TOKENS = 500; // aim for parts about this size
const MAX_GAP = 5; // largest jump between article numbers we still accept
 
// ─── Small helpers ───────────────────────────────────────────────────────────
 
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);
 
export function normalizeRef(num: string, suffix?: string): string {
  const n = /^(1er|premier)$/i.test(num) ? '1' : num;
  return suffix ? `${n} ${suffix.toLowerCase()}` : n;
}
 
// "12 bis" -> 12, "35-1" -> 35
const baseNumber = (ref: string): number => parseInt(ref, 10);
 
const isStructure = (line: string): boolean => STRUCTURE.test(line);
 
// A title line under a structural heading: "DEFINITION OF THE COMPANY".
// All capitals, not a bare page number or roman numeral ("117", "IV").
const isCapsTitle = (line: string): boolean => {
  const l = line.trim();
  return (
    l.length > 2 &&
    l.length <= 150 &&
    /\p{Lu}/u.test(l) &&
    !/\p{Ll}/u.test(l) &&
    !/^[\dIVXLC\s.\-–]+$/.test(l)
  );
};
 
// A short title under a structural line: "Registered capital" (no final punctuation).
const isShortTitle = (line: string): boolean => {
  const l = line.trim();
  return l.length >= 2 && l.length <= 120 && /^\p{Lu}/u.test(l) && !/[.;:,]$/.test(l);
};
 
/** Text shown to the embedding model: the section path gives the article its context. */
export const embeddingText = (c: Pick<ChunkDraft, 'sectionPath' | 'content'>): string =>
  c.sectionPath ? `${c.sectionPath}\n${c.content}` : c.content;
 
// ─── Page cleaning ───────────────────────────────────────────────────────────
 
/** Fixes PDF artefacts: bullet glyphs and words cut by a hyphen at the end of a line. */
export function cleanPageText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // NUL and other control characters: Postgres rejects 0x00 in text columns
    .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/^[ \t]*(?:\d{1,4}|[IVXLC]{1,6})[ \t]*$/gm, '') // page numbers and tab markers ("117", "IV")
    .replace(/[\uF0B7\u2022\u25CF]/g, '-') // bullet glyphs (private-use \uF0B7 in the AUDCG) -> "-"
    .replace(/(\p{L}+)-\n(\p{Ll})/gu, (_m, word: string, next: string) =>
      KEEP_HYPHEN.has(word.toLowerCase()) ? `${word}-${next}` : `${word}${next}`,
    );
}
 
/**
 * Removes running headers/footers: a line near the top or bottom of a page
 * that appears on at least 30% of the pages. Digits are replaced by '#' so
 * "Page 3" and "Page 4" count as the same line. Article headings are never removed.
 */
export function stripRepeatedLines(pages: PageText[], edge = 2): PageText[] {
  if (pages.length < 3) return pages;
 
  const norm = (l: string) => l.trim().replace(/\d+/g, '#').replace(/\s+/g, ' ').toLowerCase();
  const isHeading = (l: string) => new RegExp(ARTICLE_HEADING.source, 'iu').test(l);
  const edgeLines = (text: string) => {
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    return [...lines.slice(0, edge), ...lines.slice(-edge)];
  };
 
  const counts = new Map<string, number>();
  for (const p of pages) {
    for (const key of new Set(edgeLines(p.text).filter((l) => !isHeading(l)).map(norm))) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const repeated = new Set(
    // 30%, not 50%: many PDFs alternate headers between odd and even pages
    [...counts].filter(([key, n]) => key !== '' && n >= Math.max(3, pages.length * 0.3)).map(([key]) => key),
  );
  if (repeated.size === 0) return pages;
 
  return pages.map((p) => {
    const lines = p.text.split('\n');
    const nonEmpty = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
    const edgeIdx = new Set([...nonEmpty.slice(0, edge), ...nonEmpty.slice(-edge)]);
    const kept = lines.filter((l, i) => !(edgeIdx.has(i) && repeated.has(norm(l))));
    return { ...p, text: kept.join('\n') };
  });
}
 
// ─── Article headings ────────────────────────────────────────────────────────
 
type Heading = { ref: string; index: number };
 
/**
 * Keeps only headings that follow the article sequence.
 * - Starts at the LAST "Article 1": anything before it is a table of contents.
 * - A heading must be the same number with a new suffix (12 -> 12 bis) or a
 *   small step forward (12 -> 13). Anything else stays inside the current article.
 */
export function selectHeadings(fullText: string): Heading[] {
  const all: Heading[] = [...fullText.matchAll(ARTICLE_HEADING)].map((m) => ({
    ref: normalizeRef(m[1], m[2]),
    index: m.index!,
  }));
  if (all.length === 0) return [];
 
  const lastOne = all.map((h) => h.ref).lastIndexOf('1');
  const candidates = lastOne >= 0 ? all.slice(lastOne) : all;
 
  const kept: Heading[] = [candidates[0]];
  const seen = new Set([candidates[0].ref]);
  for (const h of candidates.slice(1)) {
    if (seen.has(h.ref)) continue; // "2", "2 bis", "2" again → the second "2" is not a heading
    const prev = kept[kept.length - 1];
    const prevBase = baseNumber(prev.ref);
    const base = baseNumber(h.ref);
    const sameNumberNewSuffix = base === prevBase && h.ref !== prev.ref;
    const smallStep = base > prevBase && base - prevBase <= MAX_GAP;
    if (sameNumberNewSuffix || smallStep) {
      kept.push(h);
      seen.add(h.ref);
    }
  }
  return kept;
}
 
// ─── Section path ────────────────────────────────────────────────────────────
 
type Line = { start: number; end: number; text: string }; // offsets in fullText, end excludes '\n'
 
function linesIn(text: string, start: number, end: number): Line[] {
  const out: Line[] = [];
  let pos = start;
  while (pos < end) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1 || nl > end) nl = end;
    out.push({ start: pos, end: nl, text: text.slice(pos, nl) });
    pos = nl + 1;
  }
  return out;
}
 
type StructHeading = { level: number; text: string };
 
/** Turns a block of lines into headings: a structural line, plus the caps title lines under it. */
function readHeadings(lines: Line[]): StructHeading[] {
  const out: StructHeading[] = [];
  for (const { text } of lines) {
    const t = text.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    const m = t.match(STRUCTURE);
    if (m) out.push({ level: LEVEL[m[1].toLowerCase()], text: t });
    else if (out.length > 0) out[out.length - 1].text += ` ${t}`;
  }
  return out;
}
 
/** Tracks where we are in the document: Livre > Titre > Chapitre > Section. */
class SectionPath {
  private levels: (string | undefined)[] = [];
 
  apply(headings: StructHeading[]): void {
    for (const h of headings) {
      this.levels[h.level] = h.text;
      this.levels.length = h.level + 1; // a new Titre clears the Chapitre and Section below it
    }
  }
 
  toString(): string | null {
    const parts = this.levels.filter((x): x is string => Boolean(x));
    return parts.length ? parts.join(' > ') : null;
  }
}
 
/**
 * Index of the first line AFTER a heading block that starts at `from`
 * (blank lines, structural lines and the caps title lines under them).
 * Returns `from` when no structural line starts there.
 */
function leadingBlockEnd(lines: Line[], from: number): number {
  let i = from;
  while (i < lines.length && !lines[i].text.trim()) i++;
  if (i >= lines.length || !isStructure(lines[i].text)) return from;
  let prevWasStructure = false;
  while (i < lines.length) {
    const t = lines[i].text;
    if (!t.trim()) { i++; continue; }
    if (isStructure(t)) { prevWasStructure = true; i++; continue; }
    if (isCapsTitle(t) || (prevWasStructure && isShortTitle(t))) { prevWasStructure = false; i++; continue; }
    break;
  }
  // A block that runs to the end of the article introduces the NEXT article
  // (French one-line articles: "Art.100.- …" then "Livre 6 - …"), so it is not leading.
  const restIsBlank = lines.slice(i).every((l) => !l.text.trim());
  return restIsBlank ? from : i;
}
 
/**
 * Index of the first line of the heading block at the END of the article
 * (headings that introduce the NEXT article). Returns lines.length when none.
 */
function trailingBlockStart(lines: Line[], notBefore: number): number {
  const prevNonBlank = (k: number) => {
    let p = k - 1;
    while (p >= notBefore && !lines[p].text.trim()) p--;
    return p >= notBefore ? lines[p].text : '';
  };
  let j = lines.length - 1;
  while (j >= notBefore) {
    const t = lines[j].text;
    const titleUnderStructure = isShortTitle(t) && isStructure(prevNonBlank(j));
    if (!t.trim() || isStructure(t) || isCapsTitle(t) || titleUnderStructure) j--;
    else break;
  }
  // The block must begin with a structural line; caps lines before it stay in the body.
  for (let k = j + 1; k < lines.length; k++) {
    if (isStructure(lines[k].text)) return k;
  }
  return lines.length;
}
 
// ─── Splitting long articles ─────────────────────────────────────────────────
 
/** Splits [start, end) on line breaks, cutting only after a line that ends a sentence. */
function splitRange(text: string, start: number, end: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let partStart = start;
  let pos = start;
  while (pos < end) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 || nl >= end ? end : nl + 1;
    const line = text.slice(pos, lineEnd).trim();
    const size = estimateTokens(text.slice(partStart, lineEnd));
    const endsSentence = /[.;:]$/.test(line);
    if ((size >= TARGET_TOKENS && endsSentence) || size >= MAX_TOKENS) {
      parts.push([partStart, lineEnd]);
      partStart = lineEnd;
    }
    pos = lineEnd;
  }
  if (text.slice(partStart, end).trim() !== '') parts.push([partStart, end]);
  return parts;
}
 
// ─── Main entry point ────────────────────────────────────────────────────────
 
export function chunkByArticle(pages: PageText[]): ChunkDraft[] {
  const cleaned = stripRepeatedLines(pages.map((p) => ({ ...p, text: cleanPageText(p.text) })));
 
  // 1. One string for the whole document + where each page starts in it
  const pageStarts: number[] = [];
  let fullText = '';
  for (const p of cleaned) {
    pageStarts.push(fullText.length);
    fullText += p.text + '\n';
  }
  const pageAt = (offset: number): number => {
    let i = 0;
    while (i + 1 < pageStarts.length && pageStarts[i + 1] <= offset) i++;
    return cleaned[i].page;
  };
  const lastNonSpace = (s: number, e: number): number => {
    let i = e - 1;
    while (i > s && /\s/.test(fullText[i])) i--;
    return i;
  };
 
  // 2. Article boundaries; text before the first heading is skipped
  const headings = selectHeadings(fullText);
  if (headings.length === 0) return [];
 
  // Headings just before Article 1 ("PRELIMINARY CHAPTER") start the path.
  const path = new SectionPath();
  const preamble = linesIn(fullText, 0, headings[0].index);
  path.apply(readHeadings(preamble.slice(trailingBlockStart(preamble, 0))));
 
  const drafts: ChunkDraft[] = [];
 
  headings.forEach((h, i) => {
    const end = i + 1 < headings.length ? headings[i + 1].index : fullText.length;
    const lines = linesIn(fullText, h.index, end);
    const headingLine = lines[0];
 
    // 3. Headings right after "ARTICLE 4" belong to this article ("TITLE 1 / DEFINITION OF…");
    //    headings at the end introduce the next one ("Chapitre 2 - Capacité…").
    const leadEnd = leadingBlockEnd(lines, 1);
    const trailStart = trailingBlockStart(lines, leadEnd);
    path.apply(readHeadings(lines.slice(1, leadEnd)));
    const sectionPath = path.toString();
    path.apply(readHeadings(lines.slice(trailStart)));
 
    const bodyStart = leadEnd < lines.length ? lines[leadEnd].start : headingLine.end;
    const bodyEnd = trailStart < lines.length ? lines[trailStart].start : end;
    const head = headingLine.text.trim();
    const body = fullText.slice(bodyStart, bodyEnd);
 
    // 4. Long articles are split into parts; every part keeps the article's ref and section path
    const ranges =
      estimateTokens(head + body) > MAX_TOKENS
        ? splitRange(fullText, bodyStart, bodyEnd)
        : [[bodyStart, bodyEnd] as [number, number]];
 
    ranges.forEach(([s, e], idx) => {
      const text = fullText.slice(s, e).trim();
      if (!text && idx > 0) return;
      const part = drafts.filter((d) => d.articleRef === h.ref).length;
      const content =
        part === 0 ? [head, text].filter(Boolean).join('\n') : `[Article ${h.ref}, part ${part + 1}]\n${text}`;
      drafts.push({
        articleRef: h.ref,
        part,
        pageStart: pageAt(part === 0 ? h.index : s),
        pageEnd: pageAt(text ? lastNonSpace(s, e) : headingLine.end),
        sectionPath,
        content,
        tokenCount: estimateTokens(content),
      });
    });
  });
 
  return drafts;
}
 