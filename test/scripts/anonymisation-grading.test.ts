import { describe, it, expect } from 'vitest';
import { gradeAnonymisation, PersonsLabel, summarize } from '../../src/scripts/lib/anonymisation-grading';
import { buildMentions, type Segment } from '../../src/services/anonymisation/mentions';
import { detectByRules } from '../../src/services/anonymisation/rules';
import { FAITS, MOYEN_1 } from '../fixtures/ccja-judgment-persons';

const SEGMENTS: Segment[] = [
  { id: 'faits', text: FAITS },
  { id: 'moyen-1', text: `${MOYEN_1}\nPrésidée par Monsieur ETOA Martin, Président.` },
];
const LABEL = { persons: [['TCHOUPO Jean-Marie', 'TCHOUPO'], ['NGO BIYONG Esther']], keep: ['ETOA Martin'] };

describe('gradeAnonymisation', () => {
  it('counts overlapping forms once, and a detection that misses nothing covers everything', () => {
    const { mentions } = buildMentions(SEGMENTS, SEGMENTS.flatMap(detectByRules), [{ forms: ['TCHOUPO Jean-Marie'] }, { forms: ['NGO BIYONG Esther'] }]);
    const g = gradeAnonymisation(SEGMENTS, mentions, LABEL);
    expect(g.total).toBe(3); // faits: TCHOUPO Jean-Marie, NGO BIYONG Esther; moyen-1: TCHOUPO
    expect(g.covered).toBe(3);
    expect(g.missed).toEqual([]);
  });

  it('reports a missed occurrence with its context, a kept name that was hidden, and extra mentions', () => {
    const g = gradeAnonymisation(SEGMENTS, [
      { segmentId: 'faits', start: FAITS.indexOf('TCHOUPO'), end: FAITS.indexOf('TCHOUPO') + 18 },
      { segmentId: 'moyen-1', start: SEGMENTS[1].text.indexOf('ETOA'), end: SEGMENTS[1].text.indexOf('ETOA') + 11 },
      { segmentId: 'faits', start: FAITS.indexOf('Gamma'), end: FAITS.indexOf('Gamma') + 5 },
    ], LABEL);
    expect(g.covered).toBe(1);
    expect(g.missed.map((m) => m.segmentId)).toEqual(['faits', 'moyen-1']);
    expect(g.missed[1].context).toContain('« TCHOUPO, émancipé');
    expect(g.wronglyHidden).toBe(1);
    expect(g.extra).toBe(1);
  });

  it('summarize adds up decisions; recall is null with nothing labelled', () => {
    const g = { total: 4, covered: 3, missed: [], wronglyHidden: 1, extra: 2 };
    expect(summarize([g, g])).toEqual({ total: 8, covered: 6, wronglyHidden: 2, extra: 4, recall: 0.75 });
    expect(summarize([]).recall).toBeNull();
  });

  it('a label file entry defaults keep to []', () => {
    expect(PersonsLabel.parse({ id: 1, file: 'a.txt', language: 'fr', persons: [['KAMGA']] }).keep).toEqual([]);
  });
});
