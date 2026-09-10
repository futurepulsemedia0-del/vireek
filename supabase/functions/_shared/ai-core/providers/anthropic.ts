// supabase/functions/_shared/ai-core/providers/anthropic.ts
//
// Anthropic adapter — wraps the exact same API call your edge functions
// already made directly, just behind the common ProviderAdapter interface.
// No behavior change versus the original demo-chat/ai-assistant-query code.

import type {
  ProviderAdapter,
  NormalizedChatRequest,
  NormalizedChatResponse,
} from "../types.ts";
import { AiCoreError } from "../types.ts";

const DEFAULT_MODEL = "claude-sonnet-5";
const API_URL = "https://api.anthropic.com/v1/messages";

function getApiKey(): string | undefined {
  return Deno.env.get("ANTHROPIC_API_KEY");
}

function getModel(): string {
  return Deno.env.get("ANTHROPIC_MODEL") || DEFAULT_MODEL;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
  }
}

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  capabilities: ["chat", "json"],

  isConfigured(): boolean {
    return !!getApiKey();
  },

  async chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new AiCoreError("NOT_CONFIGURED", "ANTHROPIC_API_KEY is not set.", "anthropic");
    }

    const model = getModel();
    const start = Date.now();
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? 12_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages,
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new AiCoreError("TIMEOUT", `Anthropic timed out after ${timeoutMs}ms.`, "anthropic");
      }
      throw new AiCoreError("PROVIDER_ERROR", `Anthropic network error: ${err}`, "anthropic");
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      throw new AiCoreError("AUTH", "Anthropic rejected the API key.", "anthropic");
    }
    if (res.status === 429) {
      throw new AiCoreError("RATE_LIMIT", "Anthropic rate limit hit.", "anthropic");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AiCoreError("PROVIDER_ERROR", `Anthropic ${res.status}: ${text.slice(0, 300)}`, "anthropic");
    }

    const data = await res.json();
    const text = (data.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new AiCoreError("INVALID_RESPONSE", "Anthropic returned no text content.", "anthropic");
    }

    return {
      text,
      provider: "anthropic",
      model,
      latencyMs: Date.now() - start,
      wasFallback: false, // set by the router, not the adapter
    };
  },
};
