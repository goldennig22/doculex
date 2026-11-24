// USD per 1 million tokens. Copy these from the providers' pricing pages and update them when prices change.
export const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gemini-3.8-flash': { input: 0.1, output: 0.5 },
};

/** null when the model has no price configured or the provider did not report tokens. */
export function costUsd(
  model: string,
  inputTokens?: number,
  outputTokens?: number,
  prices: Record<string, { input: number; output: number }> = PRICES_PER_MTOK, // tests pass their own table
): number | null {
  const price = prices[model];
  if (!price || inputTokens === undefined || outputTokens === undefined) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}