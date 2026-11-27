import { describe, it, expect } from 'vitest';
import { ACTS } from '../../src/services/citations/acts';
import {
  articleKey, gradeCitation, pickVersion, versionKey, type ArticleIndex, type GradeInput,
} from '../../src/services/citations/grading';

// What the database holds in these tests: the two Acts ingested so far, AUDCG 2010 (French) and the Companies Act 1997
// (English), whose PDF has no Art. 705.
const INDEX: ArticleIndex = {
  versions: new Set([versionKey('AUDCG', '2010'), versionKey('AUSCGIE', '1997')]),
  articles: new Set([
    ...['1', '7', '13', '14', '15', '101', '102'].map((r) => articleKey('AUDCG', '2010', r)),
    ...['311', '704', '706'].map((r) => articleKey('AUSCGIE', '1997', r)),
  ]),
};
const rule = (c: Partial<GradeInput>): GradeInput => ({
  articleRef: '7', actCode: 'AUDCG', actSource: 'explicit', versionHint: null, flags: [], method: 'rule', ...c,
});

describe('pickVersion', () => {
  it.each([
    // [hint, decision date, version, nearRevision]
    [null, '2019-02-28', '2010', false],   // 8 years after the 2010 revision came into force
    [null, '2008-06-12', '1997', false],   // before it: the 1997 numbering
    [null, '2013-03-01', '2010', true],    // 2 years after: the facts may still be under the 1997 Act
    ['1997', '2019-02-28', '1997', false], // "l'Acte uniforme du 17 avril 1997" wins over the date
    ['latest', null, '2010', false],       // "AUDCG révisé"
    ['2011', '2019-02-28', '2010', true],  // a year that names no version: the date decides, as a guess
    [null, null, null, false],             // no date yet (extraction hasn't run), no hint
    [null, '1995-01-01', null, false],     // before the first version
  ])('AUDCG, hint %s, decided %s → %s', (hint, date, version, nearRevision) => {
    expect(pickVersion(ACTS.AUDCG, hint, date)).toEqual({ version, nearRevision });
  });
});

describe('gradeCitation', () => {
  it('high: the act is named, the version is certain and the article exists', () => {
    expect(gradeCitation(rule({}), '2019-02-28', INDEX)).toEqual({ actVersion: '2010', confidence: 'high', reason: null });
  });

  it('an unknown act gives a low-confidence link, kept for review', () => {
    expect(gradeCitation(rule({ actCode: null, actSource: null }), '2019-02-28', INDEX))
      .toEqual({ actVersion: null, confidence: 'low', reason: 'unknown_act' });
  });

  it('a 2021 decision citing AUSCGIE art. 311 means the 2014 Act, not the 1997 one we hold', () => {
    expect(gradeCitation(rule({ actCode: 'AUSCGIE', articleRef: '311' }), '2021-03-10', INDEX))
      .toEqual({ actVersion: '2014', confidence: 'high', reason: 'version_not_ingested' });
  });

  it('a 2005 English judgment citing art. 311 links to the 1997 Companies Act', () => {
    expect(gradeCitation(rule({ actCode: 'AUSCGIE', articleRef: '311' }), '2005-07-01', INDEX))
      .toEqual({ actVersion: '1997', confidence: 'high', reason: null });
  });

  it('low when the version we hold has no such article (Art. 705, missing from the PDF)', () => {
    expect(gradeCitation(rule({ actCode: 'AUSCGIE', articleRef: '705' }), '2005-07-01', INDEX))
      .toEqual({ actVersion: '1997', confidence: 'low', reason: 'article_not_found' });
  });

  it.each([
    [rule({ actSource: 'paragraph' }), 'inferred_from_paragraph'],
    [rule({ method: 'llm', actSource: null }), 'found_by_llm'],
  ])('medium when the act was guessed (%#)', (input, reason) => {
    expect(gradeCitation(input, '2019-02-28', INDEX)).toEqual({ actVersion: '2010', confidence: 'medium', reason });
  });

  it('medium when the decision came soon after a revision', () => {
    expect(gradeCitation(rule({}), '2013-03-01', INDEX))
      .toEqual({ actVersion: '2010', confidence: 'medium', reason: 'version_by_decision_date' });
  });

  it('low while the version is unknown: graded again at publication, when the date is final', () => {
    expect(gradeCitation(rule({}), null, INDEX)).toEqual({ actVersion: null, confidence: 'low', reason: 'version_unknown' });
  });

  it('low for a range it would not expand', () => {
    expect(gradeCitation(rule({ articleRef: '13', flags: ['range_not_expanded'] }), '2019-02-28', INDEX))
      .toEqual({ actVersion: '2010', confidence: 'low', reason: 'range_not_expanded' });
  });

  it('Code civil: known, never linked, never sent for review', () => {
    expect(gradeCitation(rule({ actCode: 'CODE_CIVIL', articleRef: '1134' }), '2019-02-28', INDEX))
      .toEqual({ actVersion: null, confidence: 'high', reason: 'not_linkable' });
  });
});
