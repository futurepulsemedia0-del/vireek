// supabase/functions/_shared/ai-core/providers/groq.ts
//
// Groq adapter — OpenAI-compatible chat-completions wire format.
// Required secret: GROQ_API_KEY (existing Supabase secret, not created here)
// Optional secret: GROQ_MODEL

import type { ProviderAdapter, NormalizedChatRequest, NormalizedChatResponse } from "../types.ts";
import { AiCoreError } from "../types.ts";

const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const BASE_URL = "https://api.groq.com/openai/v1";

function getApiKey(): string | undefined {
  return Deno.env.get("GROQ_API_KEY");
}
function getModel(): string {
  return Deno.env.get("GROQ_MODEL") || DEFAULT_MODEL;
}

export const groqAdapter: ProviderAdapter = {
  id: "groq",

  isConfigured(): boolean {
    return !!getApiKey();
  },

  async chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new AiCoreError("NOT_CONFIGURED", "GROQ_API_KEY is not set.", "groq");
    }

    const model = getModel();
    const start = Date.now();
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? 12_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens,
          temperature: req.temperature ?? 0.7,
          messages: [{ role: "system", content: req.system }, ...req.messages],
          ...(req.jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new AiCoreError("TIMEOUT", `Groq timed out after ${timeoutMs}ms.`, "groq");
      }
      throw new AiCoreError("PROVIDER_ERROR", `Groq network error: ${err}`, "groq");
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      throw new AiCoreError("AUTH", "Groq rejected the API key.", "groq");
    }
    if (res.status === 429) {
      throw new AiCoreError("RATE_LIMIT", "Groq rate limit hit.", "groq");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AiCoreError("PROVIDER_ERROR", `Groq ${res.status}: ${text.slice(0, 300)}`, "groq");
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) {
      throw new AiCoreError("INVALID_RESPONSE", "Groq returned no text content.", "groq");
    }

    return { text, provider: "groq", model, latencyMs: Date.now() - start, wasFallback: false };
  },
};
