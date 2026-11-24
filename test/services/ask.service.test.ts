import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateText } from 'ai';
import { answerQuestion, askQuestion } from '../../src/services/ask.service';
import { getArticleParts, searchByVector } from '../../src/services/search.service';
import { storeQuery } from '../../src/services/queries.service';
import { LlmAnswer } from '../../src/services/answer.service';
import { SearchResult } from '../../src/interfaces/types';

// Never call an LLM, the embedding provider or Postgres here. `Output` stays real: ask.service uses it at import.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}));
vi.mock('../../src/services/search.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/search.service')>()), // keeps detectLanguage, dedupeByArticle
  searchByVector: vi.fn(),
  getArticleParts: vi.fn(),
}));
vi.mock('../../src/services/queries.service', () => ({ storeQuery: vi.fn() }));

// Model names come from vitest.config.ts: test-primary → test-second → test-fallback. MIN_SIMILARITY = 0.6.
const TITLE = 'Acte uniforme OHADA du 15 décembre 2010 portant sur le droit commercial généra';
const Q1 = "Quelles sont les conditions requises pour qu'une personne physique ait la qualité de commerçant ?";
const ART2 = "Est commerçant celui qui fait de l'accomplissement d'actes de commerce par nature sa profession.";
const ART6 = "Nul ne peut accomplir des actes de commerce à titre de profession habituelle, s'il n'est juridiquement capable d'exercer le commerce.";

const hit = (articleRef: string, similarity: number, content: string): SearchResult => ({
  id: `chunk-${articleRef}`, articleRef, pageStart: 3, content, similarity, documentTitle: TITLE, documentId: 'doc-fr',
});
const part = (articleRef: string, content: string, pageStart: number, pageEnd: number) => ({
  documentId: 'doc-fr', articleRef, part: 0, pageStart, pageEnd, sectionPath: 'LIVRE I > TITRE I', content,
});

/**
 * A partial generateText result: ask.service only reads `output` and `usage`.
 * The cast is limited to this test double; if the service starts reading another field, the tests fail on undefined.
 */
const fakeResult = (output: LlmAnswer, usage = { inputTokens: 3120, outputTokens: 210 }) =>
  ({ output, usage }) as unknown as Awaited<ReturnType<typeof generateText>>;

const answered = (citations: LlmAnswer['citations']): LlmAnswer => ({
  found: true, answer: "Est commerçant celui qui fait des actes de commerce par nature sa profession (art. 2).",
  citations, confidence: 'high',
});
const GOOD_QUOTE = "fait de l'accomplissement d'actes de commerce";

/** The single queries row written for this question. */
const loggedRow = () => {
  expect(storeQuery).toHaveBeenCalledTimes(1);
  return vi.mocked(storeQuery).mock.calls[0][0];
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});  // "[ask] model failed" lines from the fallback tests
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(storeQuery).mockResolvedValue('query-1');
  // Retrieval for Q1: Art. 2 then Art. 6, well above the threshold
  vi.mocked(searchByVector).mockResolvedValue([hit('2', 0.78, ART2), hit('6', 0.71, ART6)]);
  vi.mocked(getArticleParts).mockResolvedValue([part('2', ART2, 3, 3), part('6', ART6, 4, 5)]);
});

describe('answerQuestion: layer 1 (similarity threshold)', () => {
  it('refuses below MIN_SIMILARITY without building sources or calling the LLM', async () => {
    vi.mocked(searchByVector).mockResolvedValueOnce([hit('2', 0.41, ART2)]);

    const { response, trace } = await answerQuestion('Quel est le taux de TVA au Cameroun ?');

    expect(response).toEqual({ found: false, answer: null, citations: [], confidence: null, language: 'fr' });
    expect(getArticleParts).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(loggedRow()).toMatchObject({ found: false, stoppedAt: 'threshold', topSimilarity: 0.41, model: null, costUsd: null });
    expect(trace).toMatchObject({ stoppedAt: 'threshold', sourceArticles: [], id: 'query-1' });
  });

  it('treats an empty search result as similarity 0', async () => {
    vi.mocked(searchByVector).mockResolvedValueOnce([]);

    const { trace } = await answerQuestion(Q1);

    expect(generateText).not.toHaveBeenCalled();
    expect(trace).toMatchObject({ stoppedAt: 'threshold', topSimilarity: 0 });
  });
});

describe('answerQuestion: answers', () => {
  it('maps a verified citation to document, article and pages, and logs the spend', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(fakeResult(answered([{ source: 1, quote: GOOD_QUOTE }])));

    const { response, trace } = await answerQuestion(Q1);

    expect(response).toMatchObject({ found: true, confidence: 'high', language: 'fr' });
    expect(response.citations).toEqual([{ document: TITLE, article: '2', pages: [3, 3], quote: GOOD_QUOTE }]);
    expect(loggedRow()).toMatchObject({
      found: true, stoppedAt: null, model: 'test-primary', inputTokens: 3120, outputTokens: 210,
    });
    expect(trace.sourceArticles).toEqual([{ document: TITLE, article: '2' }, { document: TITLE, article: '6' }]);
  });

  it('drops a citation to a source that does not exist and keeps the valid one', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(fakeResult(answered([
      { source: 9, quote: GOOD_QUOTE },
      { source: 1, quote: GOOD_QUOTE },
    ])));

    const { response } = await answerQuestion(Q1);

    expect(response.found).toBe(true);
    expect(response.citations.map((c) => c.article)).toEqual(['2']);
  });

  it('turns the answer into found:false when no quote can be verified (layer 2b)', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(fakeResult(answered([
      { source: 1, quote: 'le commerçant doit avoir au moins dix-huit ans révolus' }, // not in Art. 2
    ])));

    const { response, trace } = await answerQuestion(Q1);

    expect(response).toMatchObject({ found: false, answer: null, citations: [] });
    expect(loggedRow()).toMatchObject({ found: false, stoppedAt: 'no_valid_citation', model: 'test-primary' });
    expect(trace.stoppedAt).toBe('no_valid_citation');
  });

  it('refuses when the model returns found:false (layer 2a), and still logs the spend', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(fakeResult({ found: false, answer: '', citations: [], confidence: 'low' }));

    const { response } = await answerQuestion(Q1);

    expect(response.found).toBe(false);
    expect(loggedRow()).toMatchObject({ found: false, stoppedAt: 'llm', model: 'test-primary', inputTokens: 3120 });
  });
});

describe('answerQuestion: model fallback', () => {
  it('uses the second model when the primary throws', async () => {
    vi.mocked(generateText)
      .mockRejectedValueOnce(new Error('overloaded'))
      .mockResolvedValueOnce(fakeResult(answered([{ source: 1, quote: GOOD_QUOTE }])));

    const { response } = await answerQuestion(Q1);

    expect(response.found).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(loggedRow()).toMatchObject({ found: true, model: 'test-second' });
  });

  it('uses the last fallback when the first two throw', async () => {
    vi.mocked(generateText)
      .mockRejectedValueOnce(new Error('overloaded'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(fakeResult(answered([{ source: 1, quote: GOOD_QUOTE }])));

    await answerQuestion(Q1);

    expect(loggedRow()).toMatchObject({ found: true, model: 'test-fallback' });
  });

  it('throws the last error when every model fails, after logging stopped_at = error', async () => {
    vi.mocked(generateText)
      .mockRejectedValueOnce(new Error('overloaded'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('quota exceeded'));

    await expect(answerQuestion(Q1)).rejects.toThrow('quota exceeded');
    expect(loggedRow()).toMatchObject({ found: false, stoppedAt: 'error', model: null });
  });
});

describe('answerQuestion: logging', () => {
  it('still answers when the queries insert fails', async () => {
    vi.mocked(storeQuery).mockRejectedValueOnce(new Error('connection refused'));
    vi.mocked(generateText).mockResolvedValueOnce(fakeResult(answered([{ source: 1, quote: GOOD_QUOTE }])));

    const { response, trace } = await answerQuestion(Q1);

    expect(response.found).toBe(true);
    expect(trace.id).toBeUndefined();
    expect(console.error).toHaveBeenCalled(); // reported, not swallowed
  });
});

describe('askQuestion', () => {
  it('returns only the API response, without the trace', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(fakeResult(answered([{ source: 1, quote: GOOD_QUOTE }])));

    const res = await askQuestion(Q1);

    expect(res).not.toHaveProperty('trace');
    expect(res.found).toBe(true);
  });
});
