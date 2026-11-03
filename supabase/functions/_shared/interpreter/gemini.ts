// supabase/functions/_shared/interpreter/gemini.ts
//
// Translation port backed by Gemini (the model provider already used by
// live-copilot / diagnosis-copilot, same GEMINI_API_KEY). fetch-only, so the
// same file runs in an Edge Function (Deno) and in the bridge worker (Node >= 22).
// Returns null on ANY failure; the session turns that into a polite re-ask.

import { buildTranslatePrompt, parseTranslateOutput, type TranslateRequest, type TranslateResult } from "./mt.ts";

const BASE = "https://generativelanguage.googleapis.com";

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function geminiTranslate(opts: GeminiOptions) {
  const model = opts.model || "gemini-2.5-flash";
  const f = opts.fetchImpl ?? fetch;
  return async function translate(req: TranslateRequest, signal?: AbortSignal): Promise<TranslateResult | null> {
    if (!opts.apiKey) return null;
    const { system, user } = buildTranslatePrompt(req);
    const generationConfig: Record<string, unknown> = {
      temperature: 0,
      maxOutputTokens: 700,
      responseMimeType: "application/json",
      responseSchema: { type: "OBJECT", properties: { t: { type: "STRING" }, c: { type: "NUMBER" } }, required: ["t", "c"] },
    };
    if (model.includes("2.5")) generationConfig.thinkingConfig = { thinkingBudget: 0 }; // lowest latency: no hidden reasoning
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 6000);
    const combined = signal && "any" in AbortSignal ? (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any([signal, timeout]) : timeout;
    try {
      const res = await f(`${BASE}/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig }),
        signal: combined,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; promptFeedback?: { blockReason?: string } };
      if (data.promptFeedback?.blockReason) return null;
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      return parseTranslateOutput(text);
    } catch {
      return null;
    }
  };
}
