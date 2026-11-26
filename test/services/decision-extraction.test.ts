import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateText, NoObjectGeneratedError } from 'ai';
import {
  buildExtractionInput, dateMatchesQuote, datesIn, extractionPrompt, extractMetadata, verifyExtraction,
  type ExtractionOutput,
} from '../../src/services/decision-extraction.service';
import { CAPTION, CHUNKS, GOOD_OUTPUT, noObject } from '../fixtures/ccja-judgment';

// Never call an LLM. `Output` stays real: llm.service uses it.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}));

const INPUT = buildExtractionInput(CAPTION, CHUNKS);
const withField = (patch: Partial<ExtractionOutput>): ExtractionOutput => ({ ...GOOD_OUTPUT, ...patch });

/** A partial generateText result: llm.service only reads `output` and `usage`. */
const fakeResult = (output: ExtractionOutput, usage = { inputTokens: 2400, outputTokens: 300 }) =>
  ({ output, usage }) as unknown as Awaited<ReturnType<typeof generateText>>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('buildExtractionInput', () => {
  it('puts the caption first, then the sections in reading order, whatever order the chunks come in', () => {
    const order = ['<caption>', 'Sur le recours', 'Attendu, selon', 'Sur le premier moyen', 'PAR CES MOTIFS :\nStatuant publiquement, après']
      .map((s) => INPUT.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('joins the parts of a section and drops their "[label, part n]" prefix', () => {
    const input = buildExtractionInput(null, [
      { articleRef: 'moyen-1', part: 1, content: '[Sur le premier moyen, part 2]\nsuite du moyen' },
      { articleRef: 'moyen-1', part: 0, content: 'début du moyen' },
    ]);
    expect(input).toContain('début du moyen\nsuite du moyen');
    expect(input).not.toContain('part 2]');
    expect(input).not.toContain('<caption>');
  });

  it('over the budget, cuts the middle but keeps the caption and the dispositif', () => {
    const long = { articleRef: 'faits', part: 0, content: 'x '.repeat(4000) };
    const input = buildExtractionInput(CAPTION, [...CHUNKS, long], 500);
    expect(input).toContain('Arrêt N° 045/2019');
    expect(input).toContain('Rejette le pourvoi');
    expect(input).toContain('[…]');
    expect(input).not.toContain('x x x');
  });

  it('the prompt states the response language explicitly', () => {
    expect(extractionPrompt(INPUT, 'en')).toMatch(/<responseLanguage>en<\/responseLanguage>$/);
  });
});

describe('datesIn / dateMatchesQuote', () => {
  it('reads French, English and numeric dates (numeric is day first)', () => {
    expect(datesIn('du 28 février 2019')).toEqual(['2019-02-28']);
    expect(datesIn('le 1er mars 2019')).toEqual(['2019-03-01']);
    expect(datesIn('du 10/05/2016')).toEqual(['2016-05-10']);
    expect(datesIn('delivered on 28 February 2019')).toEqual(['2019-02-28']);
    expect(datesIn('delivered on February 28, 2019')).toEqual(['2019-02-28']);
    expect(datesIn('le 3 aout 2020')).toEqual(['2020-08-03']); // no accent
  });

  it('catches a numeric date read month first', () => {
    expect(dateMatchesQuote('2016-05-10', 'Pourvoi n° 000/2016/PC du 10/05/2016')).toBe(true);
    expect(dateMatchesQuote('2016-10-05', 'Pourvoi n° 000/2016/PC du 10/05/2016')).toBe(false);
  });

  it('fails when the quote has no date', () => {
    expect(dateMatchesQuote('2019-02-28', 'Audience publique')).toBe(false);
  });
});

describe('verifyExtraction', () => {
  it('keeps every field of a good output', () => {
    const { metadata, dropped } = verifyExtraction(GOOD_OUTPUT, INPUT);
    expect(dropped).toEqual([]);
    expect(metadata).toEqual({
      court: 'CCJA', country: null, chamber: 'Première chambre', caseNumber: 'Arrêt N° 045/2019',
      decisionDate: '2019-02-28', subject: "Qualité de commerçant d'un mineur émancipé", outcome: 'rejet',
      headnote: GOOD_OUTPUT.headnote,
    });
  });

  it('drops a value whose quote is not in the text (an invented case number)', () => {
    const { metadata, dropped } = verifyExtraction(withField({ caseNumber: { value: 'Arrêt N° 099/2019', quote: 'Arrêt N° 099/2019' } }), INPUT);
    expect(metadata.caseNumber).toBeNull();
    expect(dropped).toEqual([{ field: 'caseNumber', reason: 'quote not found in the text' }]);
    expect(metadata.court).toBe('CCJA'); // one bad field never discards the others
  });

  it('drops a case number whose digits are not in its (real) quote', () => {
    const { metadata, dropped } = verifyExtraction(withField({ caseNumber: { value: 'Arrêt N° 046/2019', quote: 'Arrêt N° 045/2019' } }), INPUT);
    expect(metadata.caseNumber).toBeNull();
    expect(dropped[0]).toEqual({ field: 'caseNumber', reason: 'number not in the quote' });
  });

  it('drops a value without a quote, or with a quote too short to prove anything', () => {
    const { metadata, dropped } = verifyExtraction(withField({
      chamber: { value: 'Première chambre', quote: null },
      outcome: { value: 'rejet', quote: 'Re' },
    }), INPUT);
    expect(metadata.chamber).toBeNull();
    expect(metadata.outcome).toBeNull();
    expect(dropped.map((d) => d.reason)).toEqual(['no quote', 'no quote']);
  });

  it('drops a date that is not ISO, and a date that does not match its quote (10/05 read month first)', () => {
    expect(verifyExtraction(withField({ decisionDate: { value: '28 février 2019', quote: '28 février 2019' } }), INPUT).dropped)
      .toEqual([{ field: 'decisionDate', reason: 'not a YYYY-MM-DD date' }]);
    expect(verifyExtraction(withField({ decisionDate: { value: '2016-10-05', quote: 'du 10/05/2016' } }), INPUT).dropped)
      .toEqual([{ field: 'decisionDate', reason: 'date does not match the quote' }]);
  });

  it('a real quote from the wrong passage passes: the pourvoi date is what the eval must catch', () => {
    // Documented limitation: verification proves the value is in the text, not that it is the right one
    const { metadata } = verifyExtraction(withField({ decisionDate: { value: '2016-05-10', quote: 'du 10/05/2016' } }), INPUT);
    expect(metadata.decisionDate).toBe('2016-05-10');
  });

  it('never gives the CCJA a country, even with a real quote (the lower court is Cameroonian)', () => {
    const { metadata, dropped } = verifyExtraction(withField({ country: { value: 'CM', quote: "Cour d'appel du Littoral à Douala" } }), INPUT);
    expect(metadata.country).toBeNull();
    expect(dropped).toEqual([{ field: 'country', reason: 'the CCJA is not a national court' }]);
  });

  it('normalises the court\'s full name to CCJA, and a country to upper case', () => {
    const input = `${INPUT}\nCour suprême du Cameroun, Yaoundé`;
    expect(verifyExtraction(withField({ court: { value: "Cour Commune de Justice et d'Arbitrage", quote: "Cour Commune de Justice et d'Arbitrage" } }), INPUT).metadata.court)
      .toBe('CCJA');
    const national = verifyExtraction(withField({
      court: { value: 'Cour suprême du Cameroun', quote: 'Cour suprême du Cameroun' },
      country: { value: 'cm', quote: 'Cour suprême du Cameroun' },
    }), input);
    expect(national.metadata).toMatchObject({ court: 'Cour suprême du Cameroun', country: 'CM' });
  });

  it('turns an empty headnote into null', () => {
    expect(verifyExtraction(withField({ headnote: '  ' }), INPUT).metadata.headnote).toBeNull();
  });
});

describe('extractMetadata (LLM mocked)', () => {
  it('returns the verified metadata, the model and the cost', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(fakeResult(GOOD_OUTPUT));

    const result = await extractMetadata(INPUT, 'fr');

    expect(result.metadata.caseNumber).toBe('Arrêt N° 045/2019');
    expect(result.model).toBe('test-primary');
    expect(result.usage).toEqual({ inputTokens: 2400, outputTokens: 300 });
    expect(result.costUsd).toBeNull(); // test models have no price
    const call = vi.mocked(generateText).mock.calls[0][0];
    expect(call.prompt).toContain('<responseLanguage>fr</responseLanguage>');
  });

  it('tries the next model when one returns unusable output', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(noObject()).mockResolvedValueOnce(fakeResult(GOOD_OUTPUT));
    expect((await extractMetadata(INPUT, 'fr')).model).toBe('test-second');
  });

  it('throws NoObjectGeneratedError when every model returns unusable output', async () => {
    vi.mocked(generateText).mockRejectedValue(noObject());
    await expect(extractMetadata(INPUT, 'fr')).rejects.toSatisfy(NoObjectGeneratedError.isInstance);
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it('stops at once when the job is aborted, without asking the next model', async () => {
    const controller = new AbortController();
    vi.mocked(generateText).mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    await expect(extractMetadata(INPUT, 'fr', controller.signal)).rejects.toThrow('aborted');
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
