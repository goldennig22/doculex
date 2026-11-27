import { describe, it, expect } from 'vitest';
import { assertDecisionSize, MAX_DECISION_CHUNKS, MAX_DECISION_PAGES } from '../../src/services/decisions.service';

// Every chunk of an upload is embedded (a paid call): the caps keep one upload from costing thousands of calls.
// The 39 real CCJA decisions ingested so far have at most 16 pages and 21 chunks.
describe('assertDecisionSize', () => {
  it('accepts the largest real decision with room to spare', () => {
    expect(() => assertDecisionSize({ pageCount: 16, chunkCount: 21 })).not.toThrow();
    expect(() => assertDecisionSize({ pageCount: MAX_DECISION_PAGES, chunkCount: MAX_DECISION_CHUNKS })).not.toThrow();
  });

  it('422 for too many pages, checked before chunking', () => {
    expect(() => assertDecisionSize({ pageCount: 2000 }))
      .toThrow(expect.objectContaining({ statusCode: 422, message: `A decision has at most ${MAX_DECISION_PAGES} pages; this file has 2000` }));
  });

  it('422 for too many chunks, checked before embedding', () => {
    expect(() => assertDecisionSize({ pageCount: 40, chunkCount: MAX_DECISION_CHUNKS + 1 }))
      .toThrow(expect.objectContaining({ statusCode: 422 }));
  });
});
