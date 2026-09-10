// supabase/functions/_shared/ai-core/providers/cohere.ts
//
// Cohere adapter — registered with "embedding" and "rerank" capabilities
// ONLY. It also implements chat() as a technical capability, but the
// registry never routes chat tasks to it.
//
// Required secret: COHERE_API_KEY

import type {
  ProviderAdapter,
  NormalizedChatRequest,
  NormalizedChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from "../types.ts";
import { AiCoreError } from "../types.ts";

const DEFAULT_CHAT_MODEL = "command-r-plus";
const DEFAULT_EMBED_MODEL = "embed-english-v3.0";

function getApiKey(): string | undefined {
  return Deno.env.get("COHERE_API_KEY");
}

export const cohereAdapter: ProviderAdapter = {
  id: "cohere",
  capabilities: ["embedding", "rerank", "chat"],

  isConfigured(): boolean {
    return !!getApiKey();
  },

  async chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new AiCoreError("NOT_CONFIGURED", "COHERE_API_KEY is not set.", "cohere");
    }
    const model = Deno.env.get("COHERE_MODEL") || DEFAULT_CHAT_MODEL;
    const start = Date.now();
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? 12_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const history = req.messages.slice(0, -1).map((m) => ({
      role: m.role === "assistant" ? "CHATBOT" : "USER",
      message: m.content,
    }));
    const lastMessage = req.messages[req.messages.length - 1]?.content ?? "";

    let res: Response;
    try {
      res = await fetch("https://api.cohere.com/v1/chat", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          preamble: req.system,
          chat_history: history,
          message: lastMessage,
          max_tokens: req.maxTokens,
          temperature: req.temperature ?? 0.7,
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new AiCoreError("TIMEOUT", `Cohere timed out after ${timeoutMs}ms.`, "cohere");
      }
      throw new AiCoreError("PROVIDER_ERROR", `Cohere network error: ${err}`, "cohere");
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      throw new AiCoreError("AUTH", "Cohere rejected the API key.", "cohere");
    }
    if (res.status === 429) {
      throw new AiCoreError("RATE_LIMIT", "Cohere rate limit hit.", "cohere");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AiCoreError("PROVIDER_ERROR", `Cohere ${res.status}: ${text.slice(0, 300)}`, "cohere");
    }

    const data = await res.json();
    const text = (data?.text ?? "").trim();
    if (!text) {
      throw new AiCoreError("INVALID_RESPONSE", "Cohere returned no text content.", "cohere");
    }

    return {
      text,
      provider: "cohere",
      model,
      latencyMs: Date.now() - start,
      wasFallback: false,
    };
  },

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new AiCoreError("NOT_CONFIGURED", "COHERE_API_KEY is not set.", "cohere");
    }
    const model = Deno.env.get("COHERE_EMBED_MODEL") || DEFAULT_EMBED_MODEL;
    const start = Date.now();
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? 12_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch("https://api.cohere.com/v1/embed", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          texts: req.input,
          input_type: "search_document",
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new AiCoreError("TIMEOUT", `Cohere embed timed out after ${timeoutMs}ms.`, "cohere");
      }
      throw new AiCoreError("PROVIDER_ERROR", `Cohere embed network error: ${err}`, "cohere");
    }
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AiCoreError("PROVIDER_ERROR", `Cohere embed ${res.status}: ${text.slice(0, 300)}`, "cohere");
    }

    const data = await res.json();
    return {
      vectors: data.embeddings ?? [],
      provider: "cohere",
      model,
      latencyMs: Date.now() - start,
    };
  },
};
