import { deriveForms, normaliseName } from './names';

// From candidate names to mentions with placeholders, and the text edits that go with them. Pure: no database, no LLM.
//
//   rule candidates + LLM forms → persons (forms grouped) → every occurrence of every form → placeholders by first
//   appearance → texts with "X", "Y"… and mentions whose offsets point at the placeholders.

/** A text that can hold names: the caption or one chunk. An array of segments is in reading order. */
export type Segment = { id: string; text: string };
export const CAPTION_SEGMENT = 'caption';

/** UTF-16 offsets, end excluded. */
export type Span = { segmentId: string; start: number; end: number };
export type Candidate = Span & { surface: string; source: 'rule' | 'llm' };
export type DetectionSource = 'rule' | 'llm' | 'both';
/** `surface`: the clear name as written; start/end: where it is (in the original text, or after applyMentions, the placeholder). */
export type DetectedMention = Span & { surface: string; placeholder: string; source: DetectionSource };
export type Person = { placeholder: string; forms: string[] };

// ── Placeholders ─────────────────────────────────────────────────────────────────────────────────────

const LETTERS = 'XYZABCDEFGHIJKLMNOPQRSTUVW';

/** 0 → "X", 1 → "Y", 2 → "Z", 3 → "A" … 25 → "W", 26 → "X2". */
export function placeholderAt(i: number): string {
  return i < LETTERS.length ? LETTERS[i] : `${LETTERS[i % LETTERS.length]}${Math.floor(i / LETTERS.length) + 1}`;
}

export const PLACEHOLDER_FORMAT = /^[A-Z](?:[2-9]|[1-9]\d+)?$/;

/** The first placeholder not in use: a person a reviewer adds never takes another person's letter. */
export function nextFreePlaceholder(used: ReadonlySet<string>): string {
  for (let i = 0; ; i++) if (!used.has(placeholderAt(i))) return placeholderAt(i);
}

// ── Finding every occurrence of a form ───────────────────────────────────────────────────────────────

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A form as a pattern: any whitespace between its words (a PDF line break can fall inside a name), case-insensitive,
 * and Unicode word boundaries. JavaScript's \b is ASCII-only: /\bÉTOGA\b/ never matches "Dame ÉTOGA".
 */
function formPattern(form: string): RegExp {
  const words = form.trim().split(/\s+/).map(escape).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'giu');
}

/**
 * Every occurrence of each form in the segments. Case-insensitive so "TCHOUPO" finds "Tchoupo", but an occurrence
 * must start with a capital: a name is capitalised, and without this a surname that is also a word (MARS) would
 * replace "3 mars 2014".
 */
export function locateForms(segments: Segment[], forms: string[]): (Span & { surface: string; form: string })[] {
  const found: (Span & { surface: string; form: string })[] = [];
  for (const form of new Set(forms.map((f) => f.trim()).filter((f) => f.length >= 2))) {
    const pattern = formPattern(form);
    for (const seg of segments) {
      for (const m of seg.text.matchAll(pattern)) {
        if (!/^\p{Lu}/u.test(m[0])) continue;
        found.push({ segmentId: seg.id, start: m.index, end: m.index + m[0].length, surface: m[0], form });
      }
    }
  }
  return found;
}

// ── Persons and placeholders ─────────────────────────────────────────────────────────────────────────

type Origin = 'rule' | 'llm';
type Group = { forms: Map<string, { form: string; origins: Set<Origin> }> };
type Occurrence = Span & { group: number; origins: Set<Origin> };

/**
 * Groups forms into persons. A form (normalised) belongs to the first person that claims it: LLM persons first, in
 * the model's order (it is better at telling "KAMGA Jean" from "KAMGA Paul"), then each rule candidate joins the
 * person that owns its full form or one of its derived forms, or starts a new person.
 * Two persons sharing a bare surname: the bare form goes to the first; the reviewer can reassign a mention.
 */
function groupForms(rule: Candidate[], llm: { forms: string[] }[]): Group[] {
  const groups: Group[] = [];
  const owner = new Map<string, number>();
  const add = (g: number, form: string, origin: Origin) => {
    const key = normaliseName(form);
    if (key === '') return;
    const current = owner.get(key);
    if (current !== undefined && current !== g) return; // claimed by an earlier person
    owner.set(key, g);
    const entry = groups[g].forms.get(key) ?? { form, origins: new Set<Origin>() };
    entry.origins.add(origin);
    groups[g].forms.set(key, entry);
  };

  for (const p of llm) {
    const g = groups.push({ forms: new Map() }) - 1;
    for (const f of p.forms) for (const d of deriveForms(f)) add(g, d, 'llm');
  }
  for (const c of rule) {
    const derived = deriveForms(c.surface);
    const existing = [c.surface, ...derived].map((d) => owner.get(normaliseName(d))).find((g) => g !== undefined);
    const g = existing ?? groups.push({ forms: new Map() }) - 1;
    for (const d of derived) add(g, d, 'rule');
  }
  return groups;
}

/** Overlapping occurrences become one span (the longest wins the person): "TCHOUPO" inside "TCHOUPO Jean-Marie". */
function mergeOverlaps(occurrences: Occurrence[]): Occurrence[] {
  const sorted = [...occurrences].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const merged: Occurrence[] = [];
  for (const o of sorted) {
    const last = merged.at(-1);
    if (last && o.start < last.end) {
      last.end = Math.max(last.end, o.end);
      for (const x of o.origins) last.origins.add(x);
    } else {
      merged.push({ ...o, origins: new Set(o.origins) });
    }
  }
  return merged;
}

/**
 * The detection result for one decision: persons with stable placeholders, and every occurrence of their names.
 *
 * Every form of every person is searched in every segment, so a name the LLM saw once and the rules saw elsewhere is
 * replaced everywhere, including "« TCHOUPO, émancipé… »" inside a quote with no title. Longer forms win overlaps,
 * so "TCHOUPO" never splits "TCHOUPO Jean-Marie" (which would publish "M. X Jean-Marie").
 * Placeholders follow the first appearance in reading order: the same input always gives the same letters.
 */
export function buildMentions(
  segments: Segment[], rule: Candidate[], llm: { forms: string[] }[],
): { persons: Person[]; mentions: DetectedMention[] } {
  const groups = groupForms(rule, llm);
  const order = new Map(segments.map((s, i) => [s.id, i]));

  const bySegment = new Map<string, Occurrence[]>();
  const push = (o: Occurrence) => bySegment.set(o.segmentId, [...(bySegment.get(o.segmentId) ?? []), o]);

  groups.forEach((g, gi) => {
    const forms = [...g.forms.values()];
    for (const hit of locateForms(segments, forms.map((f) => f.form))) {
      const origins = new Set(forms.find((f) => f.form === hit.form.trim())?.origins ?? []);
      push({ segmentId: hit.segmentId, start: hit.start, end: hit.end, group: gi, origins });
    }
  });
  // A rule candidate is a fact about its position, whatever form found it: mark the spans it overlaps
  for (const c of rule) {
    for (const o of bySegment.get(c.segmentId) ?? []) if (o.start < c.end && c.start < o.end) o.origins.add('rule');
  }

  const occurrences = segments.flatMap((s) => mergeOverlaps(bySegment.get(s.id) ?? []));
  occurrences.sort((a, b) => order.get(a.segmentId)! - order.get(b.segmentId)! || a.start - b.start);

  const letterOf = new Map<number, string>();
  for (const o of occurrences) if (!letterOf.has(o.group)) letterOf.set(o.group, placeholderAt(letterOf.size));

  const text = new Map(segments.map((s) => [s.id, s.text]));
  const mentions = occurrences.map((o): DetectedMention => ({
    segmentId: o.segmentId, start: o.start, end: o.end,
    surface: text.get(o.segmentId)!.slice(o.start, o.end),
    placeholder: letterOf.get(o.group)!,
    source: o.origins.has('rule') && o.origins.has('llm') ? 'both' : o.origins.has('llm') ? 'llm' : 'rule',
  }));
  const persons = [...letterOf].map(([g, placeholder]) => ({
    placeholder, forms: [...groups[g].forms.values()].map((f) => f.form),
  }));
  return { persons, mentions };
}

// ── Text edits ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Writes the placeholders into the segments. Returns the new texts and the mentions with their offsets moved onto the
 * placeholders ("M. X": start/end of "X"). Mentions must not overlap (buildMentions guarantees it).
 */
export function applyMentions(segments: Segment[], mentions: DetectedMention[]): { texts: Map<string, string>; mentions: DetectedMention[] } {
  const texts = new Map<string, string>();
  const moved: DetectedMention[] = [];
  for (const seg of segments) {
    const own = mentions.filter((m) => m.segmentId === seg.id).sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const m of own) {
      if (m.start < cursor) throw new Error(`Overlapping mentions in segment ${seg.id} at ${m.start}`);
      out += seg.text.slice(cursor, m.start);
      const start = out.length;
      out += m.placeholder;
      moved.push({ ...m, start, end: out.length });
      cursor = m.end;
    }
    texts.set(seg.id, out + seg.text.slice(cursor));
  }
  return { texts, mentions: moved };
}

/**
 * The only way a stored text with mentions changes. Replaces [target.start, target.end) with `replacement` and moves
 * every mention after it by the change in length: reverting "X" to "TCHOUPO Jean-Marie" moves the next mention of the
 * same chunk 17 characters right. The mention AT the target gets the new span. A mention that overlaps the target
 * without being it is a bug in the caller: it throws rather than corrupt the offsets.
 */
export function replaceSpan<M extends { start: number; end: number }>(
  text: string, mentions: M[], target: { start: number; end: number }, replacement: string,
): { text: string; mentions: M[] } {
  if (target.start < 0 || target.end > text.length || target.end < target.start) {
    throw new Error(`Span ${target.start}-${target.end} is outside the text (length ${text.length})`);
  }
  const delta = replacement.length - (target.end - target.start);
  const moved = mentions.map((m) => {
    if (m.start === target.start && m.end === target.end) return { ...m, end: m.start + replacement.length };
    if (m.start >= target.end) return { ...m, start: m.start + delta, end: m.end + delta };
    if (m.end <= target.start) return m;
    throw new Error(`Mention ${m.start}-${m.end} overlaps the edited span ${target.start}-${target.end}`);
  });
  return { text: text.slice(0, target.start) + replacement + text.slice(target.end), mentions: moved };
}

/**
 * Replaces the persons' names in a text that has no mention rows: a title, a section path, a subject or headnote.
 * The leak check at publish catches what this misses.
 */
export function anonymiseFreeText(text: string, persons: Person[]): string {
  const seg = { id: 'free', text };
  const occurrences: Occurrence[] = persons.flatMap((p, gi) =>
    locateForms([seg], p.forms).map((h) => ({ segmentId: seg.id, start: h.start, end: h.end, group: gi, origins: new Set<Origin>() })));
  const mentions = mergeOverlaps(occurrences).map((o) => ({
    segmentId: seg.id, start: o.start, end: o.end, surface: '', placeholder: persons[o.group].placeholder, source: 'rule' as const,
  }));
  return applyMentions([seg], mentions).texts.get(seg.id)!;
}
