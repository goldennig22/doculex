import type { ChunkDraft, Lang, PageText } from '../interfaces/types';
import { estimateTokens, joinPages, MAX_TOKENS, splitRange } from './chunker.service';

/**
 * Judgments have no "Article N": they are split by their legal function instead.
 *
 *   COUR COMMUNE DE JUSTICE ET D'ARBITRAGE … Affaire : X contre Y   caption     → dropped (party names, no legal content)
 *   … a rendu l'Arrêt suivant :                                      (end of the caption)
 *   Sur le recours … dont le dispositif est le suivant : « … »       procedure   (quotes the LOWER court's dispositif)
 *   Attendu, selon l'arrêt attaqué, que …                            faits
 *   Sur la compétence de la Cour …                                   competence
 *   Sur le premier moyen …  Attendu qu'il est fait grief …            moyen-1     ┐ the party's grievance AND the court's
 *                           Mais attendu que …                                    ┘ answer stay in ONE chunk
 *   Sur les dépens …                                                 depens      → dropped (no legal content)
 *   PAR CES MOTIFS : … Casse et annule …                             dispositif  (the LAST "PAR CES MOTIFS")
 *   Ainsi fait, jugé et prononcé … Le Président / Le Greffier        signatures  → dropped
 *
 * Why one chunk per moyen: a size-based cut can separate "il est fait grief à l'arrêt d'avoir violé l'article 7"
 * (what the losing party claims) from "Mais attendu que…" (what the court decides), and the LLM would then
 * present the party's argument as the holding.
 */
export type DecisionSection =
  | 'procedure' | 'faits' | 'competence' | 'recevabilite' | 'moyen' | 'evocation' | 'depens' | 'dispositif'
  | 'texte'; // fallback: no structure found

export type SectionSpan = {
  section: DecisionSection;
  ref: string;   // stored in chunks.article_ref: "faits", "moyen-2", "dispositif"
  label: string; // shown in the section path and part labels: "Sur le premier moyen", "Faits"
  start: number; // offsets in fullText, end excluded
  end: number;
};

type Markers = {
  /** End of the caption; null when the language has no reliable marker. First match. */
  captionEnd: RegExp | null;
  /** Operative part. The LAST match wins: earlier ones quote the lower court's decision. Needs the g flag. */
  dispositif: RegExp;
  /** Signatures, cut off after the dispositif. */
  end: RegExp;
  /** Headings between the caption and the dispositif. `once`: only the first match counts. Need the g flag. */
  headings: { section: DecisionSection; pattern: RegExp; once?: boolean }[];
};

// Every heading starts a line: the same word inside a sentence ("…sur le premier moyen invoqué…") is not a heading.
const MARKERS: Record<Lang, Markers> = {
  fr: {
    captionEnd: /a\s+rendu\s+l['’]arr[êe]t\s+suivant\s*:?/iu,
    dispositif: /^[ \t]*PAR\s+CES\s+MOTIFS\b/gimu,
    end: /^[ \t]*Ainsi\s+fait,?\s+jug[ée]\s+et\s+prononc[ée]/imu,
    headings: [
      {
        section: 'faits',
        once: true,
        pattern: /^[ \t]*(?:Attendu|Considérant)[ \t]*,?[ \t]*(?:selon\s+l['’](?:arrêt|ordonnance|jugement)\s+attaqué|qu['’]il\s+(?:ressort|résulte)\s+(?:des\s+pièces|de\s+l['’]arrêt))/gimu,
      },
      { section: 'competence', pattern: /^[ \t]*Sur\s+(?:la\s+compétence|l['’]exception\s+d['’]incompétence)/gimu },
      { section: 'recevabilite', pattern: /^[ \t]*Sur\s+(?:la\s+recevabilité|l['’]irrecevabilité|la\s+fin\s+de\s+non[-\s]recevoir)/gimu },
      // "Sur le premier moyen", "Sur le moyen unique", "Sur les deuxième et troisième moyens réunis"
      { section: 'moyen', pattern: /^[ \t]*Sur\s+(?:le|les)\s+[^\n]{0,80}?\bmoyens?\b/gimu },
      { section: 'evocation', pattern: /^[ \t]*Sur\s+l['’]évocation/gimu },
      { section: 'depens', pattern: /^[ \t]*Sur\s+les\s+dépens/gimu },
    ],
  },
  en: {
    captionEnd: /(?:rendered|delivered)\s+the\s+following\s+(?:judgment|ruling)\s*:?/iu,
    dispositif: /^[ \t]*(?:FOR\s+THESE\s+REASONS|ON\s+THESE\s+GROUNDS|IT\s+IS\s+(?:HEREBY\s+)?ORDERED)\b/gimu,
    end: /^[ \t]*(?:Thus\s+done|Done\s+and\s+delivered|Delivered\s+in\s+open\s+court)/imu,
    headings: [
      {
        section: 'faits',
        once: true,
        pattern: /^[ \t]*(?:(?:THE\s+)?(?:FACTS|BACKGROUND)\b|Whereas,?\s+according\s+to\s+the\s+(?:impugned|appealed))/gimu,
      },
      { section: 'competence', pattern: /^[ \t]*On\s+(?:the\s+)?(?:jurisdiction|objection\s+to\s+jurisdiction)/gimu },
      { section: 'recevabilite', pattern: /^[ \t]*On\s+(?:the\s+)?admissibility/gimu },
      // "On the first ground", "On the sole ground of appeal", "GROUND 2", "GROUND ONE"
      { section: 'moyen', pattern: /^[ \t]*(?:On\s+the\s+[^\n]{0,60}?\bgrounds?\b|GROUND\s+(?:\d+|ONE|TWO|THREE|FOUR|FIVE|SIX)\b)/gimu },
      { section: 'evocation', pattern: /^[ \t]*On\s+(?:the\s+)?evocation/gimu },
      { section: 'depens', pattern: /^[ \t]*On\s+(?:the\s+)?costs/gimu },
    ],
  },
};

const LABELS: Record<Lang, Record<DecisionSection, string>> = {
  fr: {
    procedure: 'Procédure', faits: 'Faits', competence: 'Compétence', recevabilite: 'Recevabilité',
    moyen: 'Moyen', evocation: 'Évocation', depens: 'Dépens', dispositif: 'Dispositif', texte: 'Texte intégral',
  },
  en: {
    procedure: 'Procedure', faits: 'Facts', competence: 'Jurisdiction', recevabilite: 'Admissibility',
    moyen: 'Ground', evocation: 'Evocation', depens: 'Costs', dispositif: 'Operative part', texte: 'Full text',
  },
};

/** Sections that never become chunks: no legal content, and nothing a student would search for. */
const DROPPED = new Set<DecisionSection>(['depens']);

const MAX_LABEL = 100;

/** The heading line itself, as a label: "Sur le premier moyen, tiré de la violation de l'article 28…" */
function headingLabel(fullText: string, index: number): string {
  const nl = fullText.indexOf('\n', index);
  const line = fullText.slice(index, nl === -1 ? undefined : nl).trim().replace(/\s+/g, ' ');
  return line.length <= MAX_LABEL ? line : `${line.slice(0, MAX_LABEL).replace(/\s+\S*$/, '')}…`;
}

/**
 * Finds the sections of a judgment. Pure: no database, no I/O.
 * Returns [] when it finds neither a dispositif nor any heading; the caller then falls back to plain splitting.
 * Spans are in document order, cover [end of caption, start of signatures) and never overlap.
 */
export function findSections(fullText: string, lang: Lang): SectionSpan[] {
  const m = MARKERS[lang];

  const disp = [...fullText.matchAll(m.dispositif)].at(-1);
  const tailFrom = disp?.index ?? 0;
  const endMatch = m.end.exec(fullText.slice(tailFrom));
  const textEnd = endMatch ? tailFrom + endMatch.index : fullText.length;
  const reasonsEnd = disp?.index ?? textEnd;

  const caption = m.captionEnd?.exec(fullText.slice(0, reasonsEnd));
  const start = caption ? caption.index + caption[0].length : 0;

  // Headings between the caption and the dispositif; two patterns matching at the same place: the first listed wins
  const reasons = fullText.slice(start, reasonsEnd);
  const found: { section: DecisionSection; index: number }[] = [];
  const taken = new Set<number>();
  for (const h of m.headings) {
    const matches = [...reasons.matchAll(h.pattern)];
    for (const match of h.once ? matches.slice(0, 1) : matches) {
      const index = start + match.index;
      if (taken.has(index)) continue;
      taken.add(index);
      found.push({ section: h.section, index });
    }
  }
  found.sort((a, b) => a.index - b.index);

  if (!disp && found.length === 0) return [];

  const spans: SectionSpan[] = [];
  const counts = new Map<DecisionSection, number>();
  const push = (section: DecisionSection, s: number, e: number, label: string) => {
    if (fullText.slice(s, e).trim() === '') return;
    const n = (counts.get(section) ?? 0) + 1;
    counts.set(section, n);
    // Moyens are numbered from 1 in reading order ("moyen-1"); a repeated section gets a suffix ("competence-2")
    const ref = section === 'moyen' ? `moyen-${n}` : n === 1 ? section : `${section}-${n}`;
    spans.push({ section, ref, label, start: s, end: e });
  };

  // Everything before the first heading: the appeal, the lower court's decision, the "Vu…" lines
  push('procedure', start, found[0]?.index ?? reasonsEnd, LABELS[lang].procedure);
  found.forEach((h, i) => {
    const end = found[i + 1]?.index ?? reasonsEnd;
    const label = h.section === 'moyen' ? headingLabel(fullText, h.index) : LABELS[lang][h.section];
    push(h.section, h.index, end, label);
  });
  if (disp) push('dispositif', disp.index, textEnd, LABELS[lang].dispositif);

  return spans;
}

/**
 * Chunks a judgment: one chunk per section, one per moyen; a section over MAX_TOKENS is split on sentence ends
 * (each part labelled "[Sur le premier moyen, part 2]", as article parts are).
 * Without any recognisable structure, the whole text is split by size under the ref "texte".
 * Returns [] only when there is no text at all (a scanned PDF).
 *
 * `pathPrefix` starts every section path, e.g. "CCJA > Première chambre > Arrêt n° 045/2019":
 * embeddingText puts it in front of the content, as it does with a statute's Livre > Titre > Chapitre.
 */
export function chunkDecision(pages: PageText[], { lang, pathPrefix }: { lang: Lang; pathPrefix: string }): ChunkDraft[] {
  if (pages.every((p) => p.text.trim() === '')) return [];
  const { fullText, pageAt, lastNonSpace } = joinPages(pages);

  const found = findSections(fullText, lang).filter((s) => !DROPPED.has(s.section));
  const spans: SectionSpan[] = found.length > 0
    ? found
    : [{ section: 'texte', ref: 'texte', label: LABELS[lang].texte, start: 0, end: fullText.length }];

  const drafts: ChunkDraft[] = [];
  for (const span of spans) {
    const ranges = estimateTokens(fullText.slice(span.start, span.end)) > MAX_TOKENS
      ? splitRange(fullText, span.start, span.end)
      : [[span.start, span.end] as [number, number]];

    let part = 0;
    for (const [s, e] of ranges) {
      const raw = fullText.slice(s, e);
      const text = raw.trim();
      if (text === '') continue;
      const content = part === 0 ? text : `[${span.label}, part ${part + 1}]\n${text}`;
      drafts.push({
        articleRef: span.ref,
        part,
        pageStart: pageAt(s + (raw.length - raw.trimStart().length)),
        pageEnd: pageAt(lastNonSpace(s, e)),
        sectionPath: pathPrefix ? `${pathPrefix} > ${span.label}` : span.label,
        content,
        tokenCount: estimateTokens(content),
      });
      part++;
    }
  }
  return drafts;
}
