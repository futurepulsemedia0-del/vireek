// supabase/functions/_shared/ai-core/providers/openrouter.ts
//
// OpenRouter adapter — OpenAI-compatible chat-completions wire format,
// last provider in the fallback chain.
// Required secret: OPENROUTER_API_KEY (existing Supabase secret, not created here)
// Optional secret: OPENROUTER_MODEL

import type { ProviderAdapter, NormalizedChatRequest, NormalizedChatResponse } from "../types.ts";
import { AiCoreError } from "../types.ts";

const DEFAULT_MODEL = "openrouter/auto";
const BASE_URL = "https://openrouter.ai/api/v1";

function getApiKey(): string | undefined {
  return Deno.env.get("OPENROUTER_API_KEY");
}
function getModel(): string {
  return Deno.env.get("OPENROUTER_MODEL") || DEFAULT_MODEL;
}

export const openrouterAdapter: ProviderAdapter = {
  id: "openrouter",

  isConfigured(): boolean {
    return !!getApiKey();
  },

  async chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new AiCoreError("NOT_CONFIGURED", "OPENROUTER_API_KEY is not set.", "openrouter");
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
          "HTTP-Referer": "https://vireek.com",
          "X-Title": "Vireek AI Core",
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
        throw new AiCoreError("TIMEOUT", `OpenRouter timed out after ${timeoutMs}ms.`, "openrouter");
      }
      throw new AiCoreError("PROVIDER_ERROR", `OpenRouter network error: ${err}`, "openrouter");
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      throw new AiCoreError("AUTH", "OpenRouter rejected the API key.", "openrouter");
    }
    if (res.status === 429) {
      throw new AiCoreError("RATE_LIMIT", "OpenRouter rate limit hit.", "openrouter");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AiCoreError("PROVIDER_ERROR", `OpenRouter ${res.status}: ${text.slice(0, 300)}`, "openrouter");
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) {
      throw new AiCoreError("INVALID_RESPONSE", "OpenRouter returned no text content.", "openrouter");
    }

    return { text, provider: "openrouter", model, latencyMs: Date.now() - start, wasFallback: false };
  },
};
