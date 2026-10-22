import { ChunkDraft, PageText } from "../interfaces/documents";

// A heading starts a line: "Article 1er", "Art. 2", "ARTICLE 12 bis", "Article 35-1".
const ARTICLE_HEADING =
  /^[ \t]*(?:article|art\.)[ \t]*(\d+(?:-\d+)?|1er|premier)(?:[ \t]+(bis|ter|quater))?\b/gimu;

const MAX_TOKENS = 800; // split an article only above this size
const TARGET_TOKENS = 500; // aim for parts about this size
const MAX_GAP = 5; // largest jump between article numbers we still accept

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export function normalizeRef(num: string, suffix?: string): string {
  const n = /^(1er|premier)$/i.test(num) ? '1' : num;
  return suffix ? `${n} ${suffix.toLowerCase()}` : n;
}

// "12 bis" -> 12, "35-1" -> 35
const baseNumber = (ref: string): number => parseInt(ref, 10);

/**
 * Removes running headers/footers: a line near the top or bottom of a page
 * that appears on more than half the pages. Digits are replaced by '#' so
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
    [...counts].filter(([key, n]) => key !== '' && n > pages.length / 2).map(([key]) => key),
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
  for (const h of candidates.slice(1)) {
    const prev = kept[kept.length - 1];
    const prevBase = baseNumber(prev.ref);
    const base = baseNumber(h.ref);
    const sameNumberNewSuffix = base === prevBase && h.ref !== prev.ref;
    const smallStep = base > prevBase && base - prevBase <= MAX_GAP;
    if (sameNumberNewSuffix || smallStep) kept.push(h);
  }
  return kept;
}

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

export function chunkByArticle(pages: PageText[]): ChunkDraft[] {
  const cleaned = stripRepeatedLines(pages);

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

  // 2. Article boundaries; text before the first heading is skipped
  const headings = selectHeadings(fullText);
  const drafts: ChunkDraft[] = [];

  headings.forEach((h, i) => {
    const end = i + 1 < headings.length ? headings[i + 1].index : fullText.length;
    const whole = fullText.slice(h.index, end);
    const ranges =
      estimateTokens(whole) > MAX_TOKENS
        ? splitRange(fullText, h.index, end)
        : [[h.index, end] as [number, number]];

    // 3. One draft per part, with pages taken from its own offsets
    ranges.forEach(([s, e], part) => {
      const raw = fullText.slice(s, e);
      const body = raw.trim();
      if (!body) return;
      const first = s + raw.indexOf(body[0]);
      const last = first + body.length - 1;
      const content = part === 0 ? body : `Article ${h.ref} (suite)\n${body}`;
      drafts.push({
        articleRef: h.ref,
        part,
        pageStart: pageAt(first),
        pageEnd: pageAt(last),
        content,
        tokenCount: estimateTokens(content),
      });
    });
  });

  return drafts;
}
