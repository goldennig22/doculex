import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateText } from 'ai';
import {
  excerptAround, linkWithLlm, linkingPrompt, verifyActChoices, type ActChoices,
} from '../../src/services/citations/llm-linking';

// The LLM is always mocked: only eval scripts call a provider.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}));
const modelSays = (output: ActChoices) => vi.mocked(generateText).mockResolvedValueOnce(
  { output, usage: { inputTokens: 900, outputTokens: 40 } } as unknown as Awaited<ReturnType<typeof generateText>>);

// The act is named two sentences before the bare "article 101": the paragraph rule would find it, but in a longer
// decision the naming is in the visas, sections earlier. That is the case the LLM pass is for.
const EXCERPT = "Vu l'Acte uniforme portant sur le droit commercial général ; Attendu que le bail a été renouvelé ; "
  + "qu'aux termes de l'article 101, le preneur a droit au renouvellement ;";
const EXCERPTS = new Map([[1, EXCERPT]]);

beforeEach(() => vi.resetAllMocks());

describe('verifyActChoices', () => {
  it('keeps an act whose quote is in the excerpt and names that act', () => {
    const out = { links: [{ id: 1, actCode: 'AUDCG' as const, quote: "l'Acte uniforme portant sur le droit commercial général" }] };
    expect(verifyActChoices(out, EXCERPTS)).toEqual(new Map([[1, 'AUDCG']]));
  });

  it.each([
    ['a quote that is not in the excerpt', { id: 1, actCode: 'AUDCG' as const, quote: "l'AUDCG du 15 décembre 2010" }],
    ['a quote that names another act', { id: 1, actCode: 'AUSCGIE' as const, quote: "l'Acte uniforme portant sur le droit commercial général" }],
    ['a quote that names no act at all', { id: 1, actCode: 'AUDCG' as const, quote: "Vu l'Acte uniforme" }],
    ['an empty quote', { id: 1, actCode: 'AUDCG' as const, quote: '' }],
    ['an id that was never sent', { id: 7, actCode: 'AUDCG' as const, quote: "l'Acte uniforme portant sur le droit commercial général" }],
    ['null', { id: 1, actCode: null, quote: '' }],
  ])('drops %s', (_label, link) => {
    expect(verifyActChoices({ links: [link] }, EXCERPTS).size).toBe(0);
  });

  it('ignores case, curly apostrophes and line breaks in the quote, like quote verification in /ask', () => {
    const out = { links: [{ id: 1, actCode: 'AUDCG' as const, quote: 'l’Acte uniforme portant sur le\ndroit commercial général' }] };
    expect(verifyActChoices(out, EXCERPTS).get(1)).toBe('AUDCG');
  });
});

describe('linkWithLlm', () => {
  it('sends only the excerpt of each reference, and reports what it dropped', async () => {
    modelSays({ links: [
      { id: 1, actCode: 'AUDCG', quote: "l'Acte uniforme portant sur le droit commercial général" },
      { id: 2, actCode: 'AUS', quote: 'Acte uniforme portant organisation des sûretés' }, // not in excerpt 2
    ] });
    const items = [
      { id: 1, rawText: "l'article 101", excerpt: EXCERPT },
      { id: 2, rawText: "l'article 44 susvisé", excerpt: "Attendu que l'article 44 susvisé dispose…" },
    ];

    const result = await linkWithLlm(items, 'fr');

    expect(result).toMatchObject({ resolved: new Map([[1, 'AUDCG']]), dropped: 1, model: 'test-primary', inputTokens: 900 });
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toBe(linkingPrompt(items, 'fr'));
  });
});

describe('excerptAround', () => {
  it('stays inside the paragraph of the reference', () => {
    const text = "Vu l'AUS ;\n\nAttendu que l'article 44 susvisé dispose…\n\nPAR CES MOTIFS";
    const start = text.indexOf('article 44');
    expect(excerptAround(text, start, start + 'article 44 susvisé'.length)).toBe("Attendu que l'article 44 susvisé dispose…");
  });
});
