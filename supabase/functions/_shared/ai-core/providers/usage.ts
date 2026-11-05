// supabase/functions/_shared/ai-core/providers/usage.ts
// Pure extractors for the token counts providers report in their (non-streaming) responses.
// Returns undefined when the provider did not report usable numbers, so callers fall back to the estimate.

export interface ReportedUsage { inputTokens: number; outputTokens: number }

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
export function anthropicUsage(data: unknown): ReportedUsage | undefined {
  const u = (data as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage;
  return pair(u?.input_tokens, u?.output_tokens);
}

/** Gemini generateContent: usageMetadata.promptTokenCount / candidatesTokenCount (+ thoughtsTokenCount is billed as output). */
export function geminiUsage(data: unknown): ReportedUsage | undefined {
  const u = (data as { usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown } } | null)?.usageMetadata;
  const out = (n(u?.candidatesTokenCount) ?? 0) + (n(u?.thoughtsTokenCount) ?? 0);
  return pair(u?.promptTokenCount, out);
}
