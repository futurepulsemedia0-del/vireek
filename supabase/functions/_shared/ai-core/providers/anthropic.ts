// supabase/functions/_shared/ai-core/providers/anthropic.ts
//
// Anthropic adapter — same shape and conventions as the other providers
// in this folder (gemini.ts, groq.ts, cerebras.ts, openrouter.ts).
// Required secret: ANTHROPIC_API_KEY
// Optional secret: ANTHROPIC_MODEL
//
// Not wired into any TASK_ROUTES chain by default (see registry.ts) — it
// is registered in ALL_ADAPTERS so it type-checks and can be called
// directly or added to a chain, but it won't change existing routing
// behavior until it's explicitly added to a route.

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

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",

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

    // The Messages API has no `response_format` knob like the OpenAI-style
    // providers. The closest equivalent is instructing it in the system
    // prompt and nudging the model with a strict rule.
    const system = req.jsonMode
      ? `${req.system}\n\nRespond with ONLY a single valid JSON object. No prose, no markdown code fences, no explanation before or after it.`
      : req.system;

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
          temperature: req.temperature ?? 0.7,
          system,
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
    if (res.status === 529) {
      // Anthropic-specific "overloaded_error" — transient, same treatment
      // as a rate limit so the router's retry/fallback logic kicks in.
      throw new AiCoreError("RATE_LIMIT", "Anthropic is temporarily overloaded.", "anthropic");
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
      const stopReason = data?.stop_reason ? ` (stop_reason: ${data.stop_reason})` : "";
      throw new AiCoreError("INVALID_RESPONSE", `Anthropic returned no text content${stopReason}.`, "anthropic");
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
