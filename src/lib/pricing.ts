// USD per 1M tokens, from https://dev.meta.ai/docs/pricing-rate-limits (checked 2026-10-27).
export type Price = { input: number; cachedInput: number; output: number };

export const PRICES: Record<string, Price> = {
  "muse-wonder-1.0": { input: 4.0, cachedInput: 0.2, output: 20.0 },
  "muse-spark-1.3": { input: 1.25, cachedInput: 0.15, output: 4.25 },
  "muse-spark-1.3-contributor": { input: 0.1, cachedInput: 0.002, output: 0.2 },
  "muse-spark-1.2": { input: 1.25, cachedInput: 0.15, output: 4.25 },
  "muse-spark-1.2-contributor": { input: 0.1, cachedInput: 0.002, output: 0.2 },
  // Baseten Model APIs, from https://www.baseten.co/library/muse-spark-open (checked 2026-10-27).
  "meta-models/muse-spark-open-1026": { input: 1.25, cachedInput: 0.15, output: 4.25 },
};

export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
};

export function costUsd(model: string, usage: Usage | undefined | null): number {
  const p = PRICES[model];
  if (!p || !usage) return 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const freshIn = Math.max(0, (usage.prompt_tokens ?? 0) - cached);
  const out = usage.completion_tokens ?? 0; // includes reasoning tokens
  return (freshIn * p.input + cached * p.cachedInput + out * p.output) / 1_000_000;
}
