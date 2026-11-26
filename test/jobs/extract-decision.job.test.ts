import { describe, it, expect, vi, beforeEach } from 'vitest';
import { APICallError, generateText } from 'ai';
import { runDecisionExtraction, markExtractionFailed } from '../../src/jobs/extract-decision.job';
import { loadForExtraction, markNeedsManualEntry, saveExtraction } from '../../src/services/decisions.service';
import type { ExtractionOutput } from '../../src/services/decision-extraction.service';
import { CAPTION, CHUNKS, GOOD_OUTPUT, noObject } from '../fixtures/ccja-judgment';

// No LLM, no Postgres. The three DB functions are replaced by an in-memory row that keeps their contract
// ("only a pending decision is written"); the real SQL is tested in decision-extraction.db.test.ts.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}));
vi.mock('../../src/services/decisions.service', () => ({
  loadForExtraction: vi.fn(),
  saveExtraction: vi.fn(),
  markNeedsManualEntry: vi.fn(),
}));
// The real decisions.service would import the queue; the mock above doesn't, but keep it inert anyway
vi.mock('../../src/jobs/queue', () => ({ enqueueExtraction: vi.fn() }));

const ID = '8d1f0c2e-4b7a-4e19-9c3d-5a6b7c8d9e0f';
const fakeResult = (output: ExtractionOutput) =>
  ({ output, usage: { inputTokens: 2400, outputTokens: 300 } }) as unknown as Awaited<ReturnType<typeof generateText>>;

type Row = { status: 'pending' | 'done' | 'needs_manual_entry'; error: string | null; writes: number };
let row: Row;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  row = { status: 'pending', error: null, writes: 0 };
  vi.mocked(loadForExtraction).mockImplementation(async () => ({
    decisionId: ID, language: 'fr', extractionStatus: row.status, captionText: CAPTION, chunks: CHUNKS,
  }));
  vi.mocked(saveExtraction).mockImplementation(async () => {
    if (row.status !== 'pending') return false;
    row.status = 'done';
    row.writes++;
    return true;
  });
  vi.mocked(markNeedsManualEntry).mockImplementation(async (_id, reason) => {
    if (row.status !== 'pending') return false;
    row.status = 'needs_manual_entry';
    row.error = reason;
    return true;
  });
});

describe('runDecisionExtraction', () => {
  it('writes the verified fields and reports model, tokens and cost (stored as the job output)', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(fakeResult(GOOD_OUTPUT));

    const result = await runDecisionExtraction(ID);

    expect(result).toEqual({
      status: 'done', model: 'test-primary', inputTokens: 2400, outputTokens: 300, costUsd: null, dropped: [],
    });
    expect(saveExtraction).toHaveBeenCalledWith(ID, expect.objectContaining({
      court: 'CCJA', caseNumber: 'Arrêt N° 045/2019', decisionDate: '2019-02-28', outcome: 'rejet', country: null,
    }));
    // The model saw the caption: no chunk contains the case number
    expect(vi.mocked(generateText).mock.calls[0][0].prompt).toContain('Arrêt N° 045/2019');
  });

  it('reports the fields verification dropped', async () => {
    vi.mocked(generateText).mockResolvedValueOnce(fakeResult({
      ...GOOD_OUTPUT, caseNumber: { value: 'Arrêt N° 099/2019', quote: 'Arrêt N° 099/2019' },
    }));
    const result = await runDecisionExtraction(ID);
    expect(result).toMatchObject({ status: 'done', dropped: ['caseNumber: quote not found in the text'] });
    expect(vi.mocked(saveExtraction).mock.calls[0][1].caseNumber).toBeNull();
  });

  it('marks the decision for manual entry on unusable model output, and resolves (no retry)', async () => {
    vi.mocked(generateText).mockRejectedValue(noObject());

    const result = await runDecisionExtraction(ID);

    expect(result).toMatchObject({ status: 'needs_manual_entry' });
    expect(row.status).toBe('needs_manual_entry');
    expect(row.error).toMatch(/did not match the extraction schema/);
    expect(saveExtraction).not.toHaveBeenCalled();
  });

  it('rejects on a provider error, so that pg-boss retries, and leaves the decision pending', async () => {
    const outage = new APICallError({
      message: 'Service Unavailable', url: 'https://api.example/v1', requestBodyValues: {}, statusCode: 503, isRetryable: true,
    });
    vi.mocked(generateText).mockRejectedValue(outage);

    await expect(runDecisionExtraction(ID)).rejects.toBe(outage);
    expect(row.status).toBe('pending');
    expect(markNeedsManualEntry).not.toHaveBeenCalled();
  });

  it('is safe to run twice: the second run skips without calling the LLM', async () => {
    vi.mocked(generateText).mockResolvedValue(fakeResult(GOOD_OUTPUT));

    const first = await runDecisionExtraction(ID);
    const second = await runDecisionExtraction(ID);

    expect(first.status).toBe('done');
    expect(second).toEqual({ status: 'skipped', reason: 'not_pending' });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(row.writes).toBe(1);
  });

  it('two overlapping runs: both pass the check and pay for the LLM, only one writes', async () => {
    vi.mocked(generateText).mockResolvedValue(fakeResult(GOOD_OUTPUT));

    const results = await Promise.all([runDecisionExtraction(ID), runDecisionExtraction(ID)]);

    expect(results.map((r) => r.status).sort()).toEqual(['done', 'skipped']);
    expect(results).toContainEqual({ status: 'skipped', reason: 'lost_race' });
    expect(row.writes).toBe(1);
  });

  it('completes without work when the decision was deleted after the upload', async () => {
    vi.mocked(loadForExtraction).mockResolvedValueOnce(null);
    expect(await runDecisionExtraction(ID)).toEqual({ status: 'skipped', reason: 'not_found' });
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe('markExtractionFailed (dead letter)', () => {
  it('marks a pending decision for manual entry', async () => {
    await markExtractionFailed(ID, 'Extraction failed after all retries');
    expect(row).toMatchObject({ status: 'needs_manual_entry', error: 'Extraction failed after all retries' });
  });

  it('never undoes a run that succeeded', async () => {
    row.status = 'done';
    await markExtractionFailed(ID, 'late failure');
    expect(row).toMatchObject({ status: 'done', error: null });
  });
});
