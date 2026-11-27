// Pure helpers of the decision-search benchmark (src/scripts/bench-decision-search.ts), unit-tested.

/** Share of the reference ids that `got` returned, in its first k. 1 when the reference is empty (nothing to find). */
export function recallAtK(got: string[], truth: string[], k: number): number {
  const reference = truth.slice(0, k);
  if (reference.length === 0) return 1;
  const top = new Set(got.slice(0, k));
  return reference.filter((id) => top.has(id)).length / reference.length;
}

/** Nearest-rank percentile (p in 0..100) of a sample; NaN for an empty one. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * Chunks (sorted by distance) to decisions: the first, i.e. closest, chunk of each decision decides its place.
 * Ten chunks can hold fewer than ten decisions: that's why the chunk-level strategies over-fetch.
 */
export function firstPerKey<T>(rows: T[], key: (row: T) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const k = key(row);
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

/** "Arrêt N° 045/2019" and "45/2019" both become "45/2019"; null when the text holds no case number. */
export function caseKey(text: string | null): string | null {
  const m = /(\d{1,4})\s*\/\s*((?:19|20)\d{2})(?!\d)/.exec(text ?? '');
  return m ? `${Number(m[1])}/${m[2]}` : null;
}

/** Reciprocal rank of the first expected item in `ranked` (1, 1/2, 1/3…), 0 when none is there. */
export function reciprocalRank(ranked: string[], expected: Set<string>): number {
  const i = ranked.findIndex((x) => expected.has(x));
  return i < 0 ? 0 : 1 / (i + 1);
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
