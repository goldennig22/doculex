import { describe, it, expect } from 'vitest';
import { deriveForms, findLeaks, nameHash, normaliseName } from '../../src/services/anonymisation/names';
import { detectByRules, stripTitle } from '../../src/services/anonymisation/rules';
import {
  CAPTION_SEGMENT, anonymiseFreeText, applyMentions, buildMentions, locateForms, nextFreePlaceholder, placeholderAt,
  replaceSpan, type Segment,
} from '../../src/services/anonymisation/mentions';
import { detectionBatches, verifyPersons } from '../../src/services/anonymisation/llm-detection';
import { assertTransition, canTransition, TRANSITIONS, type DecisionStatus } from '../../src/services/decision-status';
import {
  CAPTION_WITH_PERSONS, DISPOSITIF, FAITS, LLM_PERSONS, MOYEN_1, PROCEDURE,
} from '../fixtures/ccja-judgment-persons';

// Pure functions only: no database, no LLM. The LLM's answer is LLM_PERSONS, as a mock would return it.

const KEY = 'test-key-0123456789abcdef0123456789abcdef';
const D1 = '8d1f0c2e-4b7a-4e19-9c3d-5a6b7c8d9e0f';
const D2 = '2a9e7c41-6f3b-4d8a-b1c5-0e2f4a6b8c9d';

const SEGMENTS: Segment[] = [
  { id: CAPTION_SEGMENT, text: CAPTION_WITH_PERSONS },
  { id: 'procedure', text: PROCEDURE },
  { id: 'faits', text: FAITS },
  { id: 'moyen-1', text: MOYEN_1 },
  { id: 'dispositif', text: DISPOSITIF },
];
const seg = (text: string): Segment => ({ id: 's', text });
const ruleNames = (text: string) => detectByRules(seg(text)).map((c) => c.surface);

/** The full pipeline as the job runs it, on the fixture. */
function anonymise(segments: Segment[], llm: { forms: string[] }[]) {
  const rule = segments.flatMap(detectByRules);
  const { persons, mentions } = buildMentions(segments, rule, llm);
  return { persons, ...applyMentions(segments, mentions) };
}

describe('normaliseName and nameHash', () => {
  it('normalises case, accents, hyphens and punctuation the same way on both sides', () => {
    expect(normaliseName('TCHOUPO Jean-Marie')).toBe('tchoupo jean marie');
    expect(normaliseName(' Tchoupo,  JEAN MARIE ')).toBe('tchoupo jean marie');
    expect(normaliseName('ÉTOGA')).toBe(normaliseName('Etoga'));
    expect(normaliseName("N'DIAYE")).toBe('n diaye');
  });

  it('is keyed and scoped to one decision: the same person in two decisions cannot be linked', () => {
    expect(nameHash(D1, 'TCHOUPO Jean-Marie', KEY)).toBe(nameHash(D1, 'tchoupo jean marie', KEY));
    expect(nameHash(D1, 'TCHOUPO', KEY)).not.toBe(nameHash(D2, 'TCHOUPO', KEY));
    expect(nameHash(D1, 'TCHOUPO', KEY)).not.toBe(nameHash(D1, 'TCHOUPO', `${KEY}-other`));
    expect(nameHash(D1, 'TCHOUPO', KEY)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('deriveForms', () => {
  it('derives the upper-case surname, taken whole', () => {
    expect(deriveForms('TCHOUPO Jean-Marie')).toEqual(['TCHOUPO Jean-Marie', 'TCHOUPO']);
    expect(deriveForms('Jean-Marie TCHOUPO')).toEqual(['Jean-Marie TCHOUPO', 'TCHOUPO']);
    expect(deriveForms('NGO BIYONG Esther')).toEqual(['NGO BIYONG Esther', 'NGO BIYONG']); // never "NGO" alone
  });

  it('derives nothing from a name with no upper-case run, and never a first name alone', () => {
    expect(deriveForms('Kamga')).toEqual(['Kamga']);
    expect(deriveForms('TCHOUPO')).toEqual(['TCHOUPO']);
  });
});

describe('detectByRules: titles and markers', () => {
  it.each([
    ['Affaire : Monsieur TCHOUPO Jean-Marie (Conseil', ['TCHOUPO Jean-Marie']],
    ['assisté de Maître NKOUM Paul, Avocat au Barreau', ['NKOUM Paul']],
    ['a assigné le sieur TCHOUPO Jean-Marie en paiement', ['TCHOUPO Jean-Marie']],
    ['sa mère, Dame NGO BIYONG Esther, a attesté', ['NGO BIYONG Esther']],
    ['contre M. FOTSO Directeur Général de la société', ['FOTSO']],
    ['Mme ESSOMBA et Mlle ATANGANA', ['ESSOMBA', 'ATANGANA']],
    ['la nommée ABENA Marie a déclaré', ['ABENA Marie']],
    ['Me NJOYA, notaire', ['NJOYA']],
    ['Mr. EKANE and Mrs MBAH appeared', ['EKANE', 'MBAH']],
    ['Dame ÉTOGA Rose', ['ÉTOGA Rose']], // a capital with an accent
    ['les Établissements KAMGA et Fils', ['KAMGA']], // a sole trader names a person
  ])('%s', (text, expected) => {
    expect(ruleNames(text)).toEqual(expected);
  });

  it.each([
    ['M. le Président de la Cour d\'appel a relevé'],
    ['Monsieur le Procureur Général'],
    ['Mr Justice NKEMBE delivered the judgment'],
    ['les Établissements KAMGA SARL'],
    ['la société Ets FOTSO S.A. a interjeté appel'],
    ['Attendu que la Société Gamma SARL a assigné'],
    ['3 mars 2014, émancipé'],
    ['dans l\'année NGOA'], // "née" inside "année" is not a marker
    ['Présents : Monsieur ETOA Martin, Président'], // judges sitting in the case keep their names
    ['Maître ABEGA Rose, Greffier'],
    ['Madame MBALLA, Juge rapporteur'],
  ])('finds nothing in: %s', (text) => {
    expect(ruleNames(text)).toEqual([]);
  });

  it('misses a name with no title: what the LLM pass is for', () => {
    expect(detectByRules({ id: 'moyen-1', text: MOYEN_1 })).toEqual([]);
  });

  it('returns the name span only, so the title stays in the text', () => {
    const [c] = detectByRules(seg('Affaire : Monsieur TCHOUPO Jean-Marie (Conseil'));
    expect('Affaire : Monsieur TCHOUPO Jean-Marie (Conseil'.slice(c.start, c.end)).toBe('TCHOUPO Jean-Marie');
  });

  it('stripTitle removes a title the LLM left in', () => {
    expect(stripTitle('M. TCHOUPO')).toBe('TCHOUPO');
    expect(stripTitle('le sieur TCHOUPO Jean-Marie')).toBe('TCHOUPO Jean-Marie');
    expect(stripTitle('TCHOUPO')).toBe('TCHOUPO');
  });
});

describe('locateForms', () => {
  it('finds every occurrence, case-insensitively, across a line break, with Unicode boundaries', () => {
    const hits = locateForms([seg('TCHOUPO a vu Tchoupo\nJean-Marie; TCHOUPOS non. ÉTOGA oui')], ['TCHOUPO Jean-Marie', 'TCHOUPO', 'Étoga']);
    expect(hits.map((h) => h.surface).sort()).toEqual(['TCHOUPO', 'Tchoupo', 'Tchoupo\nJean-Marie', 'ÉTOGA'].sort());
  });

  it('never matches a lower-case word: a surname that is also a word does not eat "3 mars 2014"', () => {
    expect(locateForms([seg('le 3 mars 2014, M. MARS a signé')], ['MARS']).map((h) => h.start)).toEqual([19]);
  });
});

describe('buildMentions + applyMentions on the fixture', () => {
  it('placeholders are stable: one letter per person, in order of first appearance, and the same on every run', () => {
    const first = anonymise(SEGMENTS, LLM_PERSONS.persons);
    const second = anonymise(SEGMENTS, LLM_PERSONS.persons);
    expect(second.texts).toEqual(first.texts);
    expect(first.persons.map((p) => p.placeholder)).toEqual(['X', 'Y', 'Z']);

    expect(first.texts.get(CAPTION_SEGMENT)).toContain('Affaire : Monsieur X (Conseil : Maître Y)');
    expect(first.texts.get('procedure')).toContain('formé par Monsieur X, assisté de Maître Y, Avocat');
    expect(first.texts.get('faits')).toContain('le sieur X en paiement');
    expect(first.texts.get('faits')).toContain('Dame Z, a attesté');
    expect(first.texts.get('dispositif')).toContain('formé par Monsieur X ;');
  });

  it('a name in a quote inside the grounds is replaced, though no rule matches there and the LLM listed only the full form', () => {
    const { texts, mentions } = anonymise(SEGMENTS, LLM_PERSONS.persons);
    expect(texts.get('moyen-1')).toContain('« X, émancipé par jugement du 3 mars 2014');
    expect(mentions.find((m) => m.segmentId === 'moyen-1')).toMatchObject({ surface: 'TCHOUPO', placeholder: 'X' });
    const all = [...texts.values()].join('\n');
    for (const word of ['TCHOUPO', 'Jean-Marie', 'NKOUM', 'Paul', 'BIYONG', 'Esther']) expect(all).not.toContain(word);
  });

  it('the surname derived from a titled name is searched everywhere, even with no LLM at all', () => {
    expect(anonymise(SEGMENTS, []).texts.get('moyen-1')).toContain('« X, émancipé');
  });

  it('a person never written with a title is found by the LLM only', () => {
    const witness: Segment[] = [...SEGMENTS, { id: 'faits-2', text: 'Attendu que FOTSO, témoin, a déclaré avoir vu le contrat ;' }];
    expect(anonymise(witness, LLM_PERSONS.persons).texts.get('faits-2')).toContain('que FOTSO, témoin');
    const { texts, mentions } = anonymise(witness, [...LLM_PERSONS.persons, { forms: ['FOTSO'] }]);
    expect(texts.get('faits-2')).toContain('que A, témoin'); // X, Y, Z are taken
    expect(mentions.find((m) => m.segmentId === 'faits-2')).toMatchObject({ surface: 'FOTSO', source: 'llm' });
  });

  it('the longest form wins: "TCHOUPO" never splits "TCHOUPO Jean-Marie" into "X Jean-Marie"', () => {
    const { texts } = anonymise(SEGMENTS, [{ forms: ['TCHOUPO', 'TCHOUPO Jean-Marie'] }]);
    expect([...texts.values()].join('\n')).not.toContain('Jean-Marie');
  });

  it('functions, companies and courts stay named', () => {
    const { texts } = anonymise(SEGMENTS, LLM_PERSONS.persons);
    expect(texts.get('moyen-1')).toContain("M. le Président de la Cour d'appel");
    expect(texts.get(CAPTION_SEGMENT)).toContain('Société Gamma SARL');
    expect(texts.get(CAPTION_SEGMENT)).toContain("COUR COMMUNE DE JUSTICE ET D'ARBITRAGE (CCJA)");
  });

  it('a mention found by both passes is "both"; offsets point at the placeholder in the new text', () => {
    const { texts, mentions } = anonymise(SEGMENTS, LLM_PERSONS.persons);
    const inCaption = mentions.filter((m) => m.segmentId === CAPTION_SEGMENT);
    expect(inCaption.map((m) => [m.surface, m.source])).toEqual([['TCHOUPO Jean-Marie', 'both'], ['NKOUM Paul', 'both']]);
    for (const m of mentions) expect(texts.get(m.segmentId)!.slice(m.start, m.end)).toBe(m.placeholder);
  });

  it('a rule-only name gets its own letter, after the persons that appear before it', () => {
    const { persons } = anonymise(SEGMENTS, [{ forms: ['TCHOUPO Jean-Marie'] }]);
    expect(persons.map((p) => [p.placeholder, p.forms[0]])).toEqual([
      ['X', 'TCHOUPO Jean-Marie'], ['Y', 'NKOUM Paul'], ['Z', 'NGO BIYONG Esther'],
    ]);
  });

  it('anonymiseFreeText applies the persons to a title or headnote', () => {
    const { persons } = anonymise(SEGMENTS, LLM_PERSONS.persons);
    expect(anonymiseFreeText('CCJA, arrêt TCHOUPO c/ Société Gamma SARL', persons)).toBe('CCJA, arrêt X c/ Société Gamma SARL');
  });
});

describe('verifyPersons: the LLM output is not trusted', () => {
  it('drops a form not written in the text (reordered), strips titles, and reports only a count', () => {
    const batch = [{ id: 'faits', text: FAITS }];
    const out = verifyPersons({
      persons: [
        { forms: ['Jean-Marie TCHOUPO', 'le sieur TCHOUPO Jean-Marie'], role: 'party' },
        { forms: ['KAMGA Paul'], role: 'witness' }, // invented
      ],
    }, batch);
    expect(out.persons).toEqual([{ forms: ['TCHOUPO Jean-Marie'] }]);
    expect(out.droppedForms).toBe(2);
    expect(JSON.stringify(out)).not.toContain('KAMGA');
  });

  it('packs segments into batches under the token budget, never splitting one', () => {
    const s = (n: number) => ({ id: String(n), text: 'x'.repeat(4000) }); // ~1000 tokens each
    expect(detectionBatches([s(1), s(2), s(3)], 2500).map((b) => b.map((x) => x.id))).toEqual([['1', '2'], ['3']]);
    expect(detectionBatches([s(1)], 10)).toHaveLength(1);
  });
});

describe('replaceSpan', () => {
  const text = 'le sieur X et Dame Z puis X';
  const mentions = [{ id: 'a', start: 9, end: 10 }, { id: 'b', start: 19, end: 20 }, { id: 'c', start: 26, end: 27 }];

  it('moves the mentions after the edit by the change in length, and gives the target its new span', () => {
    const r = replaceSpan(text, mentions, mentions[0], 'TCHOUPO Jean-Marie');
    expect(r.text).toBe('le sieur TCHOUPO Jean-Marie et Dame Z puis X');
    expect(r.mentions).toEqual([{ id: 'a', start: 9, end: 27 }, { id: 'b', start: 36, end: 37 }, { id: 'c', start: 43, end: 44 }]);
    for (const m of r.mentions.slice(1)) expect(r.text.slice(m.start, m.end)).toMatch(/^[XZ]$/);
  });

  it('leaves the mentions before the edit alone', () => {
    expect(replaceSpan(text, mentions, mentions[2], 'Y').mentions.slice(0, 2)).toEqual(mentions.slice(0, 2));
  });

  it('throws on an edit that overlaps a mention without being it', () => {
    expect(() => replaceSpan(text, mentions, { start: 8, end: 10 }, 'x')).toThrow(/overlaps/);
  });
});

describe('placeholders', () => {
  it('X, Y, Z, then A…W, then X2', () => {
    expect([0, 1, 2, 3, 25, 26].map(placeholderAt)).toEqual(['X', 'Y', 'Z', 'A', 'W', 'X2']);
    expect(nextFreePlaceholder(new Set(['X', 'Z']))).toBe('Y');
  });
});

describe('findLeaks', () => {
  const hashes = new Set(['TCHOUPO Jean-Marie', 'TCHOUPO', 'NGO BIYONG Esther'].map((n) => nameHash(D1, n, KEY)));

  it('finds a hashed name in any case, with punctuation, and reports the field, not the name', () => {
    const leaks = findLeaks([
      { field: 'headnote', text: 'La Cour relève que le sieur Tchoupo, émancipé, était commerçant.' },
      { field: 'title', text: 'CCJA, arrêt n° 045/2019' },
      { field: 'moyen-1', text: 'Dame ngo  biyong-esther a attesté' },
      { field: 'subject', text: null },
    ], hashes, D1, { key: KEY });
    expect(leaks).toEqual(['headnote', 'moyen-1']);
  });

  it('a placeholder, another decision\'s hashes or another key find nothing', () => {
    expect(findLeaks([{ field: 'f', text: 'le sieur X et Dame Z' }], hashes, D1, { key: KEY })).toEqual([]);
    expect(findLeaks([{ field: 'f', text: 'TCHOUPO' }], hashes, D2, { key: KEY })).toEqual([]);
    expect(findLeaks([{ field: 'f', text: 'TCHOUPO' }], hashes, D1, { key: `${KEY}-x` })).toEqual([]);
  });
});

describe('status transitions', () => {
  const ALL: DecisionStatus[] = ['draft', 'in_review', 'published', 'rejected'];
  const LEGAL = new Set(['draft>in_review', 'in_review>published', 'in_review>rejected', 'published>in_review']);

  it.each(ALL.flatMap((from) => ALL.map((to) => [from, to] as const)))('%s → %s', (from, to) => {
    if (LEGAL.has(`${from}>${to}`)) {
      expect(() => assertTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertTransition(from, to)).toThrow(expect.objectContaining({ statusCode: 409 }));
    }
  });

  it('rejected is final; published only goes back to in_review (a takedown)', () => {
    expect(TRANSITIONS.published).toEqual(['in_review']);
    expect(TRANSITIONS.rejected).toEqual([]);
    expect(canTransition('draft', 'published')).toBe(false);
  });
});
