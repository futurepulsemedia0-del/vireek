// supabase/functions/_shared/ai-core/providers/cerebras.ts
//
// Cerebras adapter — OpenAI-compatible chat-completions wire format.
// Required secret: CEREBRAS_API_KEY (existing Supabase secret, not created here)
// Optional secret: CEREBRAS_MODEL

import type { ProviderAdapter, NormalizedChatRequest, NormalizedChatResponse } from "../types.ts";
import { AiCoreError } from "../types.ts";

const DEFAULT_MODEL = "llama-3.3-70b";
const BASE_URL = "https://api.cerebras.ai/v1";

function getApiKey(): string | undefined {
  return Deno.env.get("CEREBRAS_API_KEY");
}
function getModel(): string {
  return Deno.env.get("CEREBRAS_MODEL") || DEFAULT_MODEL;
}

export const cerebrasAdapter: ProviderAdapter = {
  id: "cerebras",

  isConfigured(): boolean {
    return !!getApiKey();
  },

  async chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new AiCoreError("NOT_CONFIGURED", "CEREBRAS_API_KEY is not set.", "cerebras");
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
        throw new AiCoreError("TIMEOUT", `Cerebras timed out after ${timeoutMs}ms.`, "cerebras");
      }
      throw new AiCoreError("PROVIDER_ERROR", `Cerebras network error: ${err}`, "cerebras");
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      throw new AiCoreError("AUTH", "Cerebras rejected the API key.", "cerebras");
    }
    if (res.status === 429) {
      throw new AiCoreError("RATE_LIMIT", "Cerebras rate limit hit.", "cerebras");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AiCoreError("PROVIDER_ERROR", `Cerebras ${res.status}: ${text.slice(0, 300)}`, "cerebras");
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) {
      throw new AiCoreError("INVALID_RESPONSE", "Cerebras returned no text content.", "cerebras");
    }

    return { text, provider: "cerebras", model, latencyMs: Date.now() - start, wasFallback: false };
  },
};
