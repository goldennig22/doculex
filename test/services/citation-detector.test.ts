import { describe, it, expect } from 'vitest';
import {
  detectCitations, detectInDecision, expandRange, findActMentions, foldForMatch, parseArticleList,
} from '../../src/services/citations/detector';
import type { ActCode } from '../../src/services/citations/acts';
import { MOYEN_1 } from '../fixtures/ccja-judgment-persons';

// The citation detector is pure: no database, no LLM. Texts are written as CCJA decisions write them.

type Expected = [articleRef: string, actCode: ActCode | null][];

const FORMATS: [label: string, text: string, expected: Expected][] = [
  ['full French title',
    "Sur le premier moyen, tiré de la violation de l'article 7 de l'Acte uniforme portant sur le droit commercial général",
    [['7', 'AUDCG']]],
  ['abbreviation', "Vu l'article 28 de l'AUPSRVE ;", [['28', 'AUPSRVE']]],
  ['"art." and "1er", no preposition', 'conformément à art. 1er AUDCG', [['1', 'AUDCG']]],
  ['list with "et", shortened title',
    "les articles 13 et 14 de l'Acte uniforme relatif au droit des sociétés commerciales",
    [['13', 'AUSCGIE'], ['14', 'AUSCGIE']]],
  ['English title', 'Article 311 of the Uniform Act relating to Commercial Companies', [['311', 'AUSCGIE']]],
  ['range with "à"', "les articles 13 à 15 de l'AUSCGIE", [['13', 'AUSCGIE'], ['14', 'AUSCGIE'], ['15', 'AUSCGIE']]],
  ['comma list, other abbreviation', "les articles 13, 14 et 15 de l'AUDSCGIE",
    [['13', 'AUSCGIE'], ['14', 'AUSCGIE'], ['15', 'AUSCGIE']]],
  ['English range', 'Articles 10 to 12 of the Uniform Act on General Commercial Law',
    [['10', 'AUDCG'], ['11', 'AUDCG'], ['12', 'AUDCG']]],
  ['"bis" suffix', "l'article 12 bis de l'AUDCG", [['12 bis', 'AUDCG']]],
  ['hyphen is a sub-number, not a range', "l'article 35-1 de l'AUSCGIE", [['35-1', 'AUSCGIE']]],
  ['Rules of procedure of the CCJA (outside the corpus)',
    "l'article 28 bis du Règlement de procédure de la Cour Commune de Justice et d'Arbitrage",
    [['28 bis', 'RP_CCJA']]],
  ['OHADA Treaty', "l'article 14 du Traité relatif à l'harmonisation du droit des affaires en Afrique", [['14', 'TRAITE']]],
  ['national code', "a violé l'article 1134 du Code civil", [['1134', 'CODE_CIVIL']]],
  ['"alinéa 2" is not an article', "l'article 49 alinéa 2 de l'AUPSRVE", [['49', 'AUPSRVE']]],
  ['"susvisé" takes the act of the earlier citation',
    "Vu l'article 28 de l'AUPSRVE ; Attendu que l'article 28 susvisé dispose que…",
    [['28', 'AUPSRVE'], ['28', 'AUPSRVE']]],
  ['"du même Acte uniforme" takes the last Uniform Act named',
    "les articles 101 et 102 de l'AUDCG ; qu'aux termes de l'article 103 du même Acte uniforme…",
    [['101', 'AUDCG'], ['102', 'AUDCG'], ['103', 'AUDCG']]],
  ['each article keeps its own act', "l'article 7 de l'AUDCG, ensemble l'article 9 de l'AUS",
    [['7', 'AUDCG'], ['9', 'AUS']]],
  ['curly apostrophes', 'l’article 32 de l’Acte uniforme portant organisation des sûretés', [['32', 'AUS']]],
  ['"susvisé" with nothing earlier stays unresolved', "Attendu que l'article 44 susvisé dispose…", [['44', null]]],
  ['a case number is not an article', 'Arrêt n° 045/2019 du 28 février 2019', []],
];

describe('detectCitations: 20 citation formats', () => {
  it.each(FORMATS)('%s', (_label, text, expected) => {
    const found = detectCitations(text);
    expect(found.map((c) => [c.articleRef, c.actCode])).toEqual(expected);
    // The offsets point at rawText in the ORIGINAL text, accents and curly apostrophes included
    for (const c of found) expect(text.slice(c.start, c.end)).toBe(c.rawText);
  });
});

describe('ranges and lists', () => {
  it('expands a range to each article, all sharing one span', () => {
    const text = "qu'aux termes des articles 13 à 15 du même Acte uniforme ;";
    const found = detectCitations(text, { citations: [], lastUniformAct: { code: 'AUDCG', versionHint: null } });
    expect(found.map((c) => c.articleRef)).toEqual(['13', '14', '15']);
    expect(new Set(found.map((c) => `${c.start}-${c.end}`)).size).toBe(1);
    expect(found[0].rawText).toBe('articles 13 à 15 du même Acte uniforme');
    expect(found.every((c) => c.actCode === 'AUDCG' && c.actSource === 'same_act')).toBe(true);
  });

  it.each([
    ['13', '15', ['13', '14', '15']],
    ['15', '13', null],        // backwards
    ['13 bis', '15', null],    // not plain numbers
    ['1', '919', null],        // over the cap: an OCR error must not create 919 links
  ])('expandRange(%s, %s)', (from, to, expected) => {
    expect(expandRange(from, to)).toEqual(expected);
  });

  it('keeps only the two ends of a range it will not expand, flagged for review', () => {
    const [a, b] = detectCitations("les articles 13 à 1500 de l'AUSCGIE");
    expect([a.articleRef, b.articleRef]).toEqual(['13', '1500']);
    expect(a.flags).toEqual(['range_not_expanded']);
  });

  it('reads "alinéas 2 et 3" as qualifiers, and "et suivants" as the end of the list', () => {
    const folded = foldForMatch("article 7 alinéas 2 et 3 et article 9");
    expect(parseArticleList(folded, 'article '.length)?.refs).toEqual(['7']);
    expect(detectCitations("les articles 2 et suivants de l'AUDCG").map((c) => [c.articleRef, c.actCode]))
      .toEqual([['2', 'AUDCG']]);
  });

  it('never reads a date as a list item', () => {
    expect(detectCitations("l'article 7 de l'AUDCG et 8 juillet 2015").map((c) => c.articleRef)).toEqual(['7']);
  });
});

describe('acts named earlier', () => {
  it('takes the act of the paragraph when nothing follows the article, and says it guessed', () => {
    const text = "Attendu que l'Acte uniforme portant sur le droit commercial général régit le bail ; que selon l'article 101, …";
    const [c] = detectCitations(text);
    expect(c).toMatchObject({ articleRef: '101', actCode: 'AUDCG', actSource: 'paragraph' });
  });

  it('does not look past a blank line for the paragraph act', () => {
    const text = "Vu l'AUDCG ;\n\nAttendu que l'article 101 dispose…";
    expect(detectCitations(text)[0]).toMatchObject({ actCode: null, actSource: null });
  });

  it('a paragraph guess can be wrong: after "Code civil", a bare article goes to the Code civil', () => {
    const found = detectCitations("a violé l'article 1134 du Code civil et les articles 101 et 102 ;");
    expect(found.map((c) => [c.articleRef, c.actCode, c.actSource])).toEqual([
      ['1134', 'CODE_CIVIL', 'explicit'], ['101', 'CODE_CIVIL', 'paragraph'], ['102', 'CODE_CIVIL', 'paragraph'],
    ]);
  });

  it('reads "l\'AUPSRVE en son article 28" as explicit, the span starting at the act', () => {
    const text = "Vu l'AUPSRVE en son article 28 ;";
    const [c] = detectCitations(text);
    expect(c).toMatchObject({ articleRef: '28', actCode: 'AUPSRVE', actSource: 'explicit', rawText: 'AUPSRVE en son article 28' });
  });

  it('an act title it does not know is unresolved, never replaced by the paragraph act', () => {
    const [, c] = detectCitations("Vu l'article 7 de l'AUDCG et l'article 12 de l'Acte uniforme relatif au droit de la mer");
    expect(c).toMatchObject({
      articleRef: '12', actCode: null, actSource: null, rawText: "l'article 12 de l'Acte uniforme relatif au droit de la mer",
    });
  });

  it('two different "article 28" in one decision keep their own acts', () => {
    const found = detectCitations("Vu l'article 28 de l'AUPSRVE ensemble l'article 28 bis du Règlement de procédure ;");
    expect(found.map((c) => [c.articleRef, c.actCode])).toEqual([['28', 'AUPSRVE'], ['28 bis', 'RP_CCJA']]);
  });

  it('follows "susvisé" and "du même Acte" across the sections of a decision', () => {
    const found = detectInDecision([
      { id: 'moyen-1', text: MOYEN_1 },
      { id: 'moyen-2', text: "Attendu que l'article 7 susvisé … ; qu'aux termes de l'article 8 du même Acte uniforme …" },
    ]);
    expect(found.map((c) => [c.segmentId, c.articleRef, c.actCode, c.actSource])).toEqual([
      ['moyen-1', '7', 'AUDCG', 'explicit'],
      ['moyen-2', '7', 'AUDCG', 'anaphora'],
      ['moyen-2', '8', 'AUDCG', 'same_act'],
    ]);
  });
});

describe('act mentions and version hints', () => {
  it.each([
    ["l'Acte uniforme du 17 avril 1997 portant sur le droit commercial général", 'AUDCG', '1997'],
    ["l'Acte uniforme portant sur le droit commercial général du 15 décembre 2010", 'AUDCG', '2010'],
    ["l'AUDCG révisé", 'AUDCG', 'latest'],
    ['the Revised Uniform Act relating to Commercial Companies', 'AUSCGIE', 'latest'],
    ["l'AUSCGIE", 'AUSCGIE', null],
  ])('%s', (text, code, versionHint) => {
    expect(findActMentions(text)).toMatchObject([{ code, versionHint }]);
  });

  it('needs the abbreviation in upper case, and the Treaty capitalised', () => {
    expect(findActMentions('aus et la cour a traité la question')).toEqual([]);
  });

  it('reads a title cut by a PDF line break', () => {
    const text = "violation de l'article 7 de l'Acte uniforme portant sur le droit\ncommercial général ;";
    const [c] = detectCitations(text);
    expect(c).toMatchObject({ articleRef: '7', actCode: 'AUDCG', actSource: 'explicit' });
    expect(c.rawText.endsWith('droit\ncommercial général')).toBe(true);
  });
});

describe('foldForMatch', () => {
  it('keeps the length, so offsets found on the folded text are valid in the original', () => {
    const text = 'Acte uniforme portant sur le droit commercial général, l’Œuvre, ÉTÉ';
    expect(foldForMatch(text)).toHaveLength(text.length);
    expect(foldForMatch('Général l’AUPSRVE')).toBe("general l'aupsrve");
    // What NFD would have done: one unit longer per accent ("général" has two)
    expect('général'.normalize('NFD')).toHaveLength('général'.length + 2);
  });
});
