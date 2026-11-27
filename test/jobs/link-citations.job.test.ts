import { describe, it, expect, vi, beforeEach } from 'vitest';
import { APICallError, generateText } from 'ai';
import { runCitationLinking } from '../../src/jobs/link-citations.job';
import {
  loadArticleIndex, loadForLinking, replaceDetectedCitations, type LinkingSubject, type NewCitation,
} from '../../src/services/citations/citations.service';
import { articleKey, versionKey } from '../../src/services/citations/grading';
import type { ActChoices } from '../../src/services/citations/llm-linking';
import { MOYEN_1 } from '../fixtures/ccja-judgment-persons';
import { noObject } from '../fixtures/ccja-judgment';

// No LLM, no Postgres: the service's load/save are replaced by an in-memory decision; detection and grading are real.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}));
vi.mock('../../src/services/citations/citations.service', () => ({
  loadForLinking: vi.fn(), loadArticleIndex: vi.fn(), replaceDetectedCitations: vi.fn(),
}));

const ID = '8d1f0c2e-4b7a-4e19-9c3d-5a6b7c8d9e0f';
const MOYEN_2 = "Attendu que l'article 12 de l'Acte uniforme relatif au droit de la mer dispose … ;\n\n"
  + "Vu l'AUPSRVE ; Attendu que le juge a ordonné la saisie ; que selon l'article 44 susvisé, …";
const subject = (over: Partial<LinkingSubject> = {}): LinkingSubject => ({
  decisionId: ID, status: 'in_review', decisionDate: '2019-02-28', language: 'fr',
  segments: [{ id: 'c-moyen-1', text: MOYEN_1 }, { id: 'c-moyen-2', text: MOYEN_2 }],
  ...over,
});
const modelSays = (output: ActChoices) => vi.mocked(generateText).mockResolvedValueOnce(
  { output, usage: { inputTokens: 900, outputTokens: 40 } } as unknown as Awaited<ReturnType<typeof generateText>>);

let saved: NewCitation[][];
const lastSave = () => saved[saved.length - 1];
const row = (articleRef: string) => lastSave().find((r) => r.articleRef === articleRef)!;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  saved = [];
  vi.mocked(loadForLinking).mockResolvedValue(subject());
  vi.mocked(loadArticleIndex).mockResolvedValue({
    versions: new Set([versionKey('AUDCG', '2010')]),
    articles: new Set([articleKey('AUDCG', '2010', '7')]),
  });
  vi.mocked(replaceDetectedCitations).mockImplementation(async (_id, rows) => {
    saved.push(rows);
    return true;
  });
});

describe('runCitationLinking', () => {
  it('stores every citation; an unknown act stays as a low-confidence link for review', async () => {
    modelSays({ links: [] }); // the model can't tell either

    const result = await runCitationLinking(ID);

    expect(row('7')).toMatchObject({ actCode: 'AUDCG', actVersion: '2010', method: 'rule', confidence: 'high', chunkId: 'c-moyen-1' });
    expect(row('12')).toMatchObject({
      actCode: null, actVersion: null, method: 'rule', confidence: 'low', reason: 'unknown_act',
      rawText: "l'article 12 de l'Acte uniforme relatif au droit de la mer", chunkId: 'c-moyen-2',
    });
    expect(result).toMatchObject({ status: 'done', citations: 3, low: 2, sentToLlm: 2, resolvedByLlm: 0 });
  });

  it('asks the LLM only about unresolved references, and keeps a verified answer as medium', async () => {
    modelSays({ links: [{ id: 2, actCode: 'AUPSRVE', quote: 'AUPSRVE' }] });

    const result = await runCitationLinking(ID);

    const prompt = vi.mocked(generateText).mock.calls[0][0].prompt as string;
    expect(prompt).toContain(`<reference id="1">l'article 12 de l'Acte uniforme relatif au droit de la mer</reference>`);
    expect(prompt).toContain(`<reference id="2">l'article 44 susvisé</reference>`);
    expect(prompt).not.toContain('article 7 de'); // resolved by the rules: never sent
    expect(row('44')).toMatchObject({ actCode: 'AUPSRVE', actVersion: '1998', method: 'llm', confidence: 'medium', reason: 'found_by_llm' });
    expect(row('12')).toMatchObject({ confidence: 'low' });
    expect(result).toMatchObject({ resolvedByLlm: 1, model: 'test-primary' });
  });

  it('saves the rules\' links before calling the LLM, so a provider outage still leaves them', async () => {
    vi.mocked(generateText).mockRejectedValue(new APICallError({
      message: 'overloaded', url: 'https://api.example', requestBodyValues: {}, statusCode: 529, isRetryable: true,
    }));

    await expect(runCitationLinking(ID)).rejects.toThrow('overloaded'); // pg-boss retries
    expect(saved).toHaveLength(1);
    expect(row('7')).toMatchObject({ confidence: 'high' });
  });

  it('keeps the rules\' links when the model output is unusable, without retrying', async () => {
    vi.mocked(generateText).mockRejectedValue(noObject());

    expect(await runCitationLinking(ID)).toMatchObject({ status: 'done', resolvedByLlm: 0, model: null });
    expect(saved).toHaveLength(1);
  });

  it('makes no LLM call when the rules resolved everything', async () => {
    vi.mocked(loadForLinking).mockResolvedValue(subject({ segments: [{ id: 'c-moyen-1', text: MOYEN_1 }] }));

    expect(await runCitationLinking(ID)).toMatchObject({ status: 'done', citations: 1, sentToLlm: 0, costUsd: 0 });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('skips a rejected decision', async () => {
    vi.mocked(loadForLinking).mockResolvedValue(subject({ status: 'rejected' }));
    expect(await runCitationLinking(ID)).toEqual({ status: 'skipped', reason: 'rejected' });
    expect(replaceDetectedCitations).not.toHaveBeenCalled();
  });
});
