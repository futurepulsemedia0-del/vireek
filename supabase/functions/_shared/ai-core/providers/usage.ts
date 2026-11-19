// supabase/functions/_shared/ai-core/providers/usage.ts
// Pure extractors for the token counts providers report in their (non-streaming) responses.
// Returns undefined when the provider did not report usable numbers, so callers fall back to the estimate.

/** `inputTokens` is the FRESH (non-cached) input; cached tokens are reported separately. */
export interface ReportedUsage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

function pair(i: unknown, o: unknown): ReportedUsage | undefined {
  const a = n(i);
  const b = n(o);
  return a === null || b === null || a + b === 0 ? undefined : { inputTokens: a, outputTokens: b };
}

/** OpenAI-compatible APIs (Groq, Cerebras, OpenRouter, ...): usage.prompt_tokens / completion_tokens. */
export function openAiUsage(data: unknown): ReportedUsage | undefined {
  const u = (data as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  return pair(u?.prompt_tokens, u?.completion_tokens);
}

/** Anthropic Messages API: usage.input_tokens / output_tokens. */
/** Anthropic Messages API: usage.input_tokens (fresh only) / output_tokens, plus cache read / write counts. */
export function anthropicUsage(data: unknown): ReportedUsage | undefined {
  const u = (data as { usage?: { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown } } | null)?.usage;
  const read = n(u?.cache_read_input_tokens) ?? 0;
  const write = n(u?.cache_creation_input_tokens) ?? 0;
  const base = pair(u?.input_tokens, u?.output_tokens);
  if (base) return read || write ? { ...base, cacheReadTokens: read, cacheWriteTokens: write } : base;
  // input_tokens can legitimately be 0 when the whole prompt was served from cache.
  const out = n(u?.output_tokens);
  const inp = n(u?.input_tokens);
  if (inp === null || out === null || inp + out + read + write === 0) return undefined;
  return { inputTokens: inp, outputTokens: out, cacheReadTokens: read, cacheWriteTokens: write };
}

/**
 * Gemini generateContent: usageMetadata.promptTokenCount / candidatesTokenCount (+ thoughtsTokenCount is billed as output).
 * promptTokenCount INCLUDES cachedContentTokenCount (implicit caching), so the fresh part is the difference.
 */
export function geminiUsage(data: unknown): ReportedUsage | undefined {
  const u = (data as { usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown; cachedContentTokenCount?: unknown } } | null)?.usageMetadata;
  const out = (n(u?.candidatesTokenCount) ?? 0) + (n(u?.thoughtsTokenCount) ?? 0);
  const prompt = n(u?.promptTokenCount);
  const cached = Math.min(n(u?.cachedContentTokenCount) ?? 0, prompt ?? 0);
  const base = pair(prompt === null ? null : prompt - cached, out);
  if (base) return cached ? { ...base, cacheReadTokens: cached } : base;
  if (prompt !== null && cached > 0 && out >= 0) return { inputTokens: prompt - cached, outputTokens: out, cacheReadTokens: cached };
  return undefined;
}
