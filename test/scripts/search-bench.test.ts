import { describe, it, expect } from 'vitest';
import { caseKey, firstPerKey, mean, percentile, recallAtK, reciprocalRank } from '../../src/scripts/lib/search-bench';

describe('search benchmark helpers', () => {
  it('recall@k counts the reference ids found in the first k', () => {
    expect(recallAtK(['a', 'b', 'x'], ['a', 'b', 'c'], 3)).toBeCloseTo(2 / 3);
    expect(recallAtK([], ['a'], 10)).toBe(0);              // the filtered-HNSW trap: nothing returned
    expect(recallAtK(['a'], [], 10)).toBe(1);               // the filter matches no decision: nothing to miss
    expect(recallAtK(['x', 'a'], ['a', 'b'], 1)).toBe(0);   // only the first k of each side count
  });

  it('percentile uses the nearest rank', () => {
    const ms = [5, 1, 3, 2, 4];
    expect(percentile(ms, 50)).toBe(3);
    expect(percentile(ms, 95)).toBe(5);
    expect(percentile(ms, 0)).toBe(1);
    expect(percentile([], 50)).toBeNaN();
  });

  it('firstPerKey keeps each decision at the place of its closest chunk', () => {
    const chunks = [{ d: 'A' }, { d: 'A' }, { d: 'B' }, { d: 'A' }, { d: 'C' }];
    expect(firstPerKey(chunks, (c) => c.d)).toEqual(['A', 'B', 'C']);
  });

  it('caseKey ignores zero-padding and wording', () => {
    expect(caseKey('Arrêt N° 045/2019')).toBe('45/2019');
    expect(caseKey('45 / 2019')).toBe('45/2019');
    expect(caseKey('Arrêt n° 210/2019/PC')).toBe('210/2019');
    expect(caseKey('article 7')).toBeNull();
    expect(caseKey(null)).toBeNull();
  });

  it('reciprocal rank and mean', () => {
    expect(reciprocalRank(['x', 'y', 'a'], new Set(['a']))).toBeCloseTo(1 / 3);
    expect(reciprocalRank(['x'], new Set(['a']))).toBe(0);
    expect(mean([1, 0, 0.5])).toBeCloseTo(0.5);
    expect(mean([])).toBeNaN();
  });
});
