// supabase/functions/_shared/ai-core/llmCost.ts
//
// Pure (no Deno / no network) LLM cost-efficiency primitives shared by costTracking, the response cache,
// prompt caching and batch mode:
//   - feature flags (all DEFAULT OFF; one env var each, "1" turns the feature on)
//   - cache / batch aware cost arithmetic
//
// Multipliers below are the providers' PUBLISHED structure at the time of writing, not measured values.
// [VERIFY] each against the vendor pricing page before relying on dollar savings; override without a
// redeploy via AI_COST_MULTIPLIERS_JSON (shape: { "<provider>": { cacheReadMult, cacheWriteMult, batchMult } }).

import type { ProviderId } from "./types.ts";

export interface CostFlags {
  /** AI_PROMPT_CACHE=1 — send provider cache markers (Anthropic cache_control) and read cached-token usage. */
  promptCache: boolean;
  /** AI_RESPONSE_CACHE=1 — serve identical deterministic requests from ai_response_cache. */
  responseCache: boolean;
  /** AI_BATCH_MODE=1 — allow deferrable jobs to be queued to ai_batch_jobs and sent via a provider batch API. */
  batch: boolean;
}

export function readCostFlags(get: (name: string) => string | undefined): CostFlags {
  const on = (n: string) => get(n) === "1";
  return { promptCache: on("AI_PROMPT_CACHE"), responseCache: on("AI_RESPONSE_CACHE"), batch: on("AI_BATCH_MODE") };
}

export interface CostMultipliers {
  /** Price of a cache-READ input token relative to a normal input token. */
  cacheReadMult: number;
  /** Price of a cache-WRITE input token relative to a normal input token (Anthropic 5-minute TTL). */
  cacheWriteMult: number;
  /** Price of ANY token when the call goes through the provider's batch API. */
  batchMult: number;
}

// Providers without a documented discount keep 1 (no assumed saving).
const NO_DISCOUNT: CostMultipliers = { cacheReadMult: 1, cacheWriteMult: 1, batchMult: 1 };

export const DEFAULT_MULTIPLIERS: Record<ProviderId, CostMultipliers> = {
  // Anthropic: cache read 0.1x, 5-min cache write 1.25x, Message Batches 0.5x. [VERIFY]
  anthropic: { cacheReadMult: 0.1, cacheWriteMult: 1.25, batchMult: 0.5 },
  // Gemini 2.5: implicit caching bills cached tokens at a reduced rate (no write surcharge); Batch API 0.5x. [VERIFY]
  gemini: { cacheReadMult: 0.25, cacheWriteMult: 1, batchMult: 0.5 },
  groq: NO_DISCOUNT,
  cerebras: NO_DISCOUNT,
  cloudflare: NO_DISCOUNT,
  openrouter: NO_DISCOUNT,
  cohere: NO_DISCOUNT,
};

export function multipliersFor(provider: ProviderId, overridesJson?: string): CostMultipliers {
  let o: Partial<Record<string, Partial<CostMultipliers>>> = {};
  try {
    if (overridesJson) o = JSON.parse(overridesJson) ?? {};
  } catch {
    o = {};
  }
  const merged = { ...(DEFAULT_MULTIPLIERS[provider] ?? NO_DISCOUNT), ...(o[provider] ?? {}) };
  const clean = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  const base = DEFAULT_MULTIPLIERS[provider] ?? NO_DISCOUNT;
  return {
    cacheReadMult: clean(merged.cacheReadMult, base.cacheReadMult),
    cacheWriteMult: clean(merged.cacheWriteMult, base.cacheWriteMult),
    batchMult: clean(merged.batchMult, base.batchMult),
  };
}

export interface TokenBreakdown {
  /** Fresh (uncached) input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface PriceUsd {
  inputPer1M: number;
  outputPer1M: number;
}

export interface CostResult {
  costUsd: number;
  /** What the same tokens would cost with no cache and no batch discount. */
  listCostUsd: number;
  savedUsd: number;
}

/**
 * Cost of one call. `inputTokens` is the NON-cached input; cached reads/writes are priced separately.
 * `listCostUsd` treats every input token (fresh + cache read + cache write) at the plain input price.
 */
export function computeCost(price: PriceUsd, t: TokenBreakdown, m: CostMultipliers, batched = false): CostResult {
  const read = Math.max(0, t.cacheReadTokens ?? 0);
  const write = Math.max(0, t.cacheWriteTokens ?? 0);
  const fresh = Math.max(0, t.inputTokens);
  const out = Math.max(0, t.outputTokens);
  const inP = price.inputPer1M / 1_000_000;
  const outP = price.outputPer1M / 1_000_000;
  const listCostUsd = (fresh + read + write) * inP + out * outP;
  const bm = batched ? m.batchMult : 1;
  const costUsd = (fresh * inP + read * inP * m.cacheReadMult + write * inP * m.cacheWriteMult + out * outP) * bm;
  return { costUsd, listCostUsd, savedUsd: Math.max(0, listCostUsd - costUsd) };
}
