// supabase/functions/_shared/ai-core/promptCache.ts
//
// Provider PROMPT caching (not response caching). Only Anthropic needs explicit markers:
//   - Anthropic: a `cache_control: { type: "ephemeral" }` breakpoint on the last stable system block.
//   - Gemini 2.5 caches implicit prefixes automatically (no request change); we only READ the cached-token
//     count from usageMetadata so the cost log reflects it.
// Everything else is unchanged. Behind AI_PROMPT_CACHE=1.
//
// The marker is only sent when the stable prefix is long enough to be cacheable. Below the provider's
// minimum the API silently ignores the marker, so adding it would be noise at best.
// Minimums [VERIFY against docs.anthropic.com "Prompt caching"]: 1024 tokens (Sonnet/Opus families),
// 4096 for Haiku 4.5. Token count is estimated at 4 chars/token, which UNDER-estimates Persian/Arabic/CJK,
// so non-Latin prompts are conservatively treated as shorter than they are.

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export function minCacheableTokens(model: string): number {
  return /haiku/i.test(model) ? 4096 : 1024;
}

export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface BuildSystemInput {
  system: string;
  /** Number of leading characters of `system` that are identical across calls (identity + task rules). */
  stablePrefixChars?: number;
  /** Extra instruction appended AFTER the stable prefix (e.g. the JSON-only rule), never cached. */
  suffix?: string;
  enabled: boolean;
  model: string;
}

/**
 * Returns the Anthropic `system` field. A plain string unless caching is enabled AND the stable prefix is
 * long enough, in which case it is two blocks: [stable prefix + cache_control, dynamic remainder].
 */
export function buildAnthropicSystem(i: BuildSystemInput): string | SystemBlock[] {
  const tail = i.suffix ? `\n\n${i.suffix}` : "";
  const n = i.stablePrefixChars ?? 0;
  const splittable = i.enabled && Number.isInteger(n) && n > 0 && n <= i.system.length;
  if (!splittable || approxTokens(i.system.slice(0, n)) < minCacheableTokens(i.model)) {
    return i.system + tail;
  }
  const prefix = i.system.slice(0, n);
  const rest = i.system.slice(n) + tail;
  const blocks: SystemBlock[] = [{ type: "text", text: prefix, cache_control: { type: "ephemeral" } }];
  if (rest.length > 0) blocks.push({ type: "text", text: rest });
  return blocks;
}
