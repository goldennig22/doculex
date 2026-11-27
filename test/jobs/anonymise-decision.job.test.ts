import { describe, it, expect, vi, beforeEach } from 'vitest';
import { APICallError, generateText } from 'ai';
import { anonymisationFailed, runAnonymisation } from '../../src/jobs/anonymise-decision.job';
import {
  loadForAnonymisation, saveAnonymisation, type AnonymisationPlan, type AnonymisationSubject,
} from '../../src/services/anonymisation/anonymisation.service';
import type { DetectedPersons } from '../../src/services/anonymisation/llm-detection';
import {
  CAPTION_WITH_PERSONS, DISPOSITIF, FAITS, LLM_PERSONS, MOYEN_1, PARTY_NAMES, PROCEDURE,
} from '../fixtures/ccja-judgment-persons';
import { noObject } from '../fixtures/ccja-judgment';

// No LLM, no Postgres. load/save are replaced by an in-memory row that keeps their contract ("only a pending decision
// is written"); planAnonymisation and segmentsOf stay real. The SQL is tested in decision-review.db.test.ts.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}));
vi.mock('../../src/services/anonymisation/anonymisation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/anonymisation/anonymisation.service')>()),
  loadForAnonymisation: vi.fn(),
  saveAnonymisation: vi.fn(),
}));
vi.mock('../../src/jobs/queue', () => ({ enqueueEmbedding: vi.fn(), enqueueCitationLinking: vi.fn(), enqueueAnonymisation: vi.fn(), enqueueExtraction: vi.fn() }));

const ID = '8d1f0c2e-4b7a-4e19-9c3d-5a6b7c8d9e0f';
const fakeResult = (output: DetectedPersons) =>
  ({ output, usage: { inputTokens: 3000, outputTokens: 80 } }) as unknown as Awaited<ReturnType<typeof generateText>>;

// Chunks out of reading order, as the database returns them
const SUBJECT: AnonymisationSubject = {
  decisionId: ID, documentId: '2a9e7c41-6f3b-4d8a-b1c5-0e2f4a6b8c9d', language: 'fr',
  title: 'CCJA, arrêt TCHOUPO c/ Société Gamma SARL', anonymisationStatus: 'pending', caption: CAPTION_WITH_PERSONS,
  chunks: [
    { id: 'c-disp', articleRef: 'dispositif', part: 0, content: DISPOSITIF, sectionPath: 'CCJA > Dispositif' },
    { id: 'c-moyen', articleRef: 'moyen-1', part: 0, content: MOYEN_1, sectionPath: 'CCJA > Sur le premier moyen' },
    { id: 'c-proc', articleRef: 'procedure', part: 0, content: PROCEDURE, sectionPath: 'CCJA > Procédure' },
    { id: 'c-faits', articleRef: 'faits', part: 0, content: FAITS, sectionPath: 'CCJA > Faits' },
  ],
};

let row: { status: AnonymisationSubject['anonymisationStatus']; writes: number };
const savedPlan = (): AnonymisationPlan => vi.mocked(saveAnonymisation).mock.calls[0][1];

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  row = { status: 'pending', writes: 0 };
  vi.mocked(loadForAnonymisation).mockImplementation(async () => ({ ...SUBJECT, anonymisationStatus: row.status }));
  vi.mocked(saveAnonymisation).mockImplementation(async (_s, plan) => {
    if (row.status !== 'pending') return false;
    row.status = plan.status;
    row.writes++;
    return true;
  });
});

describe('runAnonymisation', () => {
  it('replaces every name, keeps the title words, and reports counts and cost, never names', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(fakeResult(LLM_PERSONS));

    const result = await runAnonymisation(ID);

    expect(result).toEqual({
      status: 'done', persons: 3, mentions: expect.any(Number), droppedForms: 0,
      models: ['test-primary'], inputTokens: 3000, outputTokens: 80, costUsd: null,
    });
    const plan = savedPlan();
    expect(plan.status).toBe('done');
    expect(plan.caption).toContain('Affaire : Monsieur X (Conseil : Maître Y)');
    expect(plan.title).toBe('CCJA, arrêt X c/ Société Gamma SARL');
    const written = [plan.caption, plan.title, ...plan.chunks.map((c) => c.content)].join('\n');
    for (const name of PARTY_NAMES) expect(written).not.toContain(name);
    // The job's output is stored in pgboss.job: it must not hold a name
    for (const name of PARTY_NAMES) expect(JSON.stringify(result)).not.toContain(name);
    // Every mention keeps its clear name for the reviewer, until confirmation
    expect(plan.mentions.map((m) => m.surface)).toContain('TCHOUPO');
  });

  it('the model saw the caption and every chunk, in reading order', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(fakeResult(LLM_PERSONS));
    await runAnonymisation(ID);
    const prompt = vi.mocked(generateText).mock.calls[0][0].prompt as string;
    const at = (s: string) => prompt.indexOf(s);
    expect(at('Affaire :')).toBeGreaterThanOrEqual(0);
    expect(at('Affaire :')).toBeLessThan(at('Sur le recours'));
    expect(at('Sur le recours')).toBeLessThan(at('Attendu, selon'));
    expect(at('Attendu, selon')).toBeLessThan(at('Sur le premier moyen'));
    expect(at('Sur le premier moyen')).toBeLessThan(at('PAR CES MOTIFS'));
  });

  it('unusable model output: the rules still run, and the decision needs a manual review (no retry)', async () => {
    vi.mocked(generateText).mockRejectedValue(noObject());

    const result = await runAnonymisation(ID);

    expect(result).toMatchObject({ status: 'needs_manual_review', models: [] });
    expect(savedPlan().status).toBe('needs_manual_review');
    expect(savedPlan().caption).toContain('Monsieur X');
  });

  it('a provider error rejects, so pg-boss retries; nothing is written', async () => {
    vi.mocked(generateText).mockRejectedValue(new APICallError({
      message: 'Overloaded', url: 'https://api.example', requestBodyValues: {}, statusCode: 529, isRetryable: true,
    }));
    await expect(runAnonymisation(ID)).rejects.toThrow('Overloaded');
    expect(saveAnonymisation).not.toHaveBeenCalled();
  });

  it('is safe to run twice: the second run skips without calling the model', async () => {
    vi.mocked(generateText).mockResolvedValue(fakeResult(LLM_PERSONS));
    await runAnonymisation(ID);
    expect(await runAnonymisation(ID)).toEqual({ status: 'skipped', reason: 'not_pending' });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(row.writes).toBe(1);
  });

  it('two overlapping runs: one writes, the other lost the race', async () => {
    vi.mocked(generateText).mockResolvedValue(fakeResult(LLM_PERSONS));
    const results = await Promise.all([runAnonymisation(ID), runAnonymisation(ID)]);
    expect(results.map((r) => r.status).sort()).toEqual(['done', 'skipped']);
    expect(row.writes).toBe(1);
  });

  it('skips a decision deleted after the upload', async () => {
    vi.mocked(loadForAnonymisation).mockResolvedValueOnce(null);
    expect(await runAnonymisation(ID)).toEqual({ status: 'skipped', reason: 'not_found' });
  });
});

describe('anonymisationFailed (dead letter)', () => {
  it('applies the rules alone and marks needs_manual_review', async () => {
    const result = await anonymisationFailed(ID);
    expect(result).toMatchObject({ status: 'needs_manual_review' });
    expect(generateText).not.toHaveBeenCalled();
    expect(savedPlan().chunks.find((c) => c.id === 'c-faits')?.content).toContain('le sieur X en paiement');
  });

  it('never undoes a run that succeeded', async () => {
    row.status = 'done';
    expect(await anonymisationFailed(ID)).toEqual({ status: 'skipped', reason: 'not_pending' });
    expect(saveAnonymisation).not.toHaveBeenCalled();
  });
});
