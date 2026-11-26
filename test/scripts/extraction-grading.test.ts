import { describe, it, expect } from 'vitest';
import { EvalFile, gradeDecision, gradeField, summarizeFields } from '../../src/scripts/lib/extraction-grading';
import type { DecisionMetadata } from '../../src/services/decision-extraction.service';

const expected = {
  court: 'CCJA', country: null, chamber: 'Première chambre', caseNumber: 'Arrêt N° 045/2019',
  decisionDate: '2019-02-28', outcome: 'rejet' as const, subject: "Qualité de commerçant d'un mineur émancipé",
};
const actual: DecisionMetadata = {
  court: 'CCJA', country: null, chamber: 'première  chambre', caseNumber: 'arrêt n°045/2019',
  decisionDate: '2019-02-28', outcome: 'rejet', subject: 'autre chose', headnote: null,
};

describe('gradeField', () => {
  it('separates the four verdicts', () => {
    expect(gradeField('court', null, null)).toBe('correct');
    expect(gradeField('court', null, 'CCJA')).toBe('missed');
    expect(gradeField('country', 'CM', null)).toBe('invented');
    expect(gradeField('decisionDate', '2016-05-10', '2019-02-28')).toBe('wrong');
  });

  it('compares after normalisation: case, accents, spaces; only the digits of a case number', () => {
    expect(gradeField('chamber', 'premiere chambre', 'Première  chambre')).toBe('correct');
    expect(gradeField('caseNumber', '045/2019', 'Arrêt N° 045 / 2019')).toBe('correct');
    expect(gradeField('caseNumber', 'Pourvoi n° 000/2016/PC', 'Arrêt N° 045/2019')).toBe('wrong');
    expect(gradeField('country', 'cm', 'CM')).toBe('correct');
  });
});

describe('gradeDecision / summarizeFields', () => {
  it('grades every exact field and counts the verdicts per field', () => {
    const grade = gradeDecision(actual, expected);
    expect(grade).toEqual({
      court: 'correct', country: 'correct', chamber: 'correct', caseNumber: 'correct', decisionDate: 'correct', outcome: 'correct',
    });
    const summary = summarizeFields([grade, gradeDecision({ ...actual, country: 'CM', decisionDate: null }, expected)]);
    expect(summary.country).toEqual({ correct: 1, missed: 0, invented: 1, wrong: 0, total: 2 });
    expect(summary.decisionDate).toEqual({ correct: 1, missed: 1, invented: 0, wrong: 0, total: 2 });
  });
});

describe('EvalFile', () => {
  it('requires every expected field (null is a label, a missing key is a mistake) and an ISO date', () => {
    const base = { id: 1, file: 'eval/decisions/x.pdf', language: 'fr', expected };
    expect(EvalFile.safeParse({ decisions: [base] }).success).toBe(true);
    const noCountry: Partial<typeof expected> = { ...expected };
    delete noCountry.country;
    expect(EvalFile.safeParse({ decisions: [{ ...base, expected: noCountry }] }).success).toBe(false);
    expect(EvalFile.safeParse({ decisions: [{ ...base, expected: { ...expected, decisionDate: '28/02/2019' } }] }).success).toBe(false);
  });
});
