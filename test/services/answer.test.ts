import { describe, it, expect } from 'vitest';
import { LlmAnswer, MIN_QUOTE_CHARS, verifyCitations } from '../../src/services/answer.service';
import { costUsd } from '../../src/config/prices';
import { Source } from '../../src/interfaces/types';

const TITLE = 'Acte uniforme OHADA du 15 décembre 2010 portant sur le droit commercial généra';

const art2: Source = {
  n: 1,
  documentId: 'doc-fr',
  documentTitle: TITLE,
  articleRef: '2',
  sectionPath: 'LIVRE I > TITRE I > CHAPITRE I',
  pageStart: 3,
  pageEnd: 3,
  content: "Est commerçant celui qui fait de l'accomplissement d'actes de commerce par nature sa profession.",
};
const art6: Source = {
  ...art2,
  n: 2,
  articleRef: '6',
  pageStart: 4,
  pageEnd: 5,
  content: "Nul ne peut accomplir des actes de commerce à titre de profession habituelle,\ns'il n'est juridiquement capable d'exercer le commerce.",
};

const answer = (citations: LlmAnswer['citations']): LlmAnswer => ({
  found: true,
  answer: "Est commerçant celui qui fait des actes de commerce sa profession (art. 2).",
  citations,
  confidence: 'high',
});

describe('verifyCitations', () => {
  it('maps a valid citation to document, article, pages and quote', () => {
    const quote = "fait de l'accomplissement d'actes de commerce";
    expect(verifyCitations(answer([{ source: 1, quote }]), [art2, art6])).toEqual([
      { document: TITLE, article: '2', pages: [3, 3], quote },
    ]);
  });

  it('drops a citation to a source number that was never sent', () => {
    const out = verifyCitations(answer([{ source: 7, quote: "fait de l'accomplissement d'actes de commerce" }]), [art2]);
    expect(out).toEqual([]);
  });

  it('drops a quote that is not in the cited source', () => {
    // real text from Art. 6, but attributed to source 1 (Art. 2)
    const out = verifyCitations(answer([{ source: 1, quote: "s'il n'est juridiquement capable" }]), [art2, art6]);
    expect(out).toEqual([]);
  });

  it('drops an empty quote and one too short to prove anything', () => {
    const out = verifyCitations(answer([{ source: 1, quote: '' }, { source: 1, quote: 'de commerce' }]), [art2]);
    expect(out).toEqual([]);
  });

  it(`accepts a quote of exactly ${MIN_QUOTE_CHARS} characters`, () => {
    const quote = "Est commerçant celui qui fait".slice(0, MIN_QUOTE_CHARS);
    expect(verifyCitations(answer([{ source: 1, quote }]), [art2])).toHaveLength(1);
  });

  it('ignores case, typographic apostrophes and line breaks', () => {
    // the source has a line break after "habituelle," and a straight apostrophe in "s'il"
    const quote = 'PROFESSION HABITUELLE, s’il n’est juridiquement';
    expect(verifyCitations(answer([{ source: 2, quote }]), [art2, art6])).toHaveLength(1);
  });

  it('keeps the valid citations when another one is dropped', () => {
    const out = verifyCitations(
      answer([
        { source: 1, quote: 'une phrase que le modèle a inventée de toutes pièces' },
        { source: 2, quote: "s'il n'est juridiquement capable" },
      ]),
      [art2, art6],
    );
    expect(out.map((c) => c.article)).toEqual(['6']);
  });
});

describe('costUsd', () => {
  const prices = { 'test-model': { input: 1, output: 5 } }; // USD per million tokens

  it('prices input and output tokens per million', () => {
    // (2000 × 1 + 300 × 5) / 1e6
    expect(costUsd('test-model', 2000, 300, prices)).toBeCloseTo(0.0035, 10);
  });

  it('returns 0, not null, for zero tokens', () => {
    expect(costUsd('test-model', 0, 0, prices)).toBe(0);
  });

  it('returns null for a model without a price', () => {
    expect(costUsd('unknown-model', 2000, 300, prices)).toBeNull();
  });

  it('returns null when the provider did not report tokens', () => {
    expect(costUsd('test-model', undefined, 300, prices)).toBeNull();
    expect(costUsd('test-model', 2000, undefined, prices)).toBeNull();
  });
});
