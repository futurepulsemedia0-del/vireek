// supabase/functions/_shared/ai-core/providers/gemini.ts
//
// Google Gemini adapter. Uses the generateContent REST endpoint directly
// (no SDK dependency, keeps the edge function bundle small).
//
// Required secret: GEMINI_API_KEY
// Optional secret: GEMINI_MODEL (defaults below)

import type {
  ProviderAdapter,
  NormalizedChatRequest,
  NormalizedChatResponse,
} from "../types.ts";
import { AiCoreError } from "../types.ts";

const DEFAULT_MODEL = "gemini-2.5-flash";

function getApiKey(): string | undefined {
  return Deno.env.get("GEMINI_API_KEY");
}

function getModel(): string {
  return Deno.env.get("GEMINI_MODEL") || DEFAULT_MODEL;
}

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  capabilities: ["chat", "json"],

  isConfigured(): boolean {
    return !!getApiKey();
  },

  async chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new AiCoreError("NOT_CONFIGURED", "GEMINI_API_KEY is not set.", "gemini");
    }

    const model = getModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // Gemini has no separate "system" role in the basic contents array —
    // it's passed via systemInstruction. History maps role "assistant" ->
    // "model", "user" stays "user".
    const contents = req.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const start = Date.now();
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? 12_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents,
          generationConfig: {
            maxOutputTokens: req.maxTokens,
            temperature: req.temperature ?? 0.7,
            ...(req.jsonMode ? { responseMimeType: "application/json" } : {}),
          },
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new AiCoreError("TIMEOUT", `Gemini timed out after ${timeoutMs}ms.`, "gemini");
      }
      throw new AiCoreError("PROVIDER_ERROR", `Gemini network error: ${err}`, "gemini");
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      throw new AiCoreError("AUTH", "Gemini rejected the API key.", "gemini");
    }
    if (res.status === 429) {
      throw new AiCoreError("RATE_LIMIT", "Gemini rate limit hit.", "gemini");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AiCoreError("PROVIDER_ERROR", `Gemini ${res.status}: ${text.slice(0, 300)}`, "gemini");
    }

    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? "")
      .join("\n")
      .trim();

    if (!text) {
      throw new AiCoreError("INVALID_RESPONSE", "Gemini returned no text content.", "gemini");
    }

    return {
      text,
      provider: "gemini",
      model,
      latencyMs: Date.now() - start,
      wasFallback: false,
    };
  },
};
