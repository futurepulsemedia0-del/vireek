// supabase/functions/_shared/ai-core/providers/openai-compatible.ts
//
// Factory for every provider that speaks the OpenAI chat-completions
// wire format (POST {baseUrl}/chat/completions with Bearer auth). This
// covers Groq, Mistral, OpenAI, OpenRouter, Together, DeepSeek, Fireworks,
// and Cerebras — so adding one more of these later is a 5-line config
// entry below, NOT a new file.
//
// Cloudflare Workers AI and Cohere have different wire formats and get
// their own adapter files (cloudflare.ts, cohere.ts).

import type {
  ProviderId,
  ProviderAdapter,
  NormalizedChatRequest,
  NormalizedChatResponse,
} from "../types.ts";
import { AiCoreError } from "../types.ts";

interface OpenAiCompatConfig {
  id: ProviderId;
  baseUrl: string;          // e.g. "https://api.groq.com/openai/v1"
  apiKeyEnvVar: string;     // e.g. "GROQ_API_KEY"
  modelEnvVar: string;      // e.g. "GROQ_MODEL"
  defaultModel: string;
  /** Some providers (OpenRouter) want extra required headers. */
  extraHeaders?: Record<string, string>;
}

function makeOpenAiCompatAdapter(cfg: OpenAiCompatConfig): ProviderAdapter {
  const getApiKey = () => Deno.env.get(cfg.apiKeyEnvVar);
  const getModel = () => Deno.env.get(cfg.modelEnvVar) || cfg.defaultModel;

  return {
    id: cfg.id,
    capabilities: ["chat", "json"],

    isConfigured(): boolean {
      return !!getApiKey();
    },

    async chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new AiCoreError("NOT_CONFIGURED", `${cfg.apiKeyEnvVar} is not set.`, cfg.id);
      }

      const model = getModel();
      const start = Date.now();
      const controller = new AbortController();
      const timeoutMs = req.timeoutMs ?? 12_000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            ...(cfg.extraHeaders ?? {}),
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
          throw new AiCoreError("TIMEOUT", `${cfg.id} timed out after ${timeoutMs}ms.`, cfg.id);
        }
        throw new AiCoreError("PROVIDER_ERROR", `${cfg.id} network error: ${err}`, cfg.id);
      }
      clearTimeout(timer);

      if (res.status === 401 || res.status === 403) {
        throw new AiCoreError("AUTH", `${cfg.id} rejected the API key.`, cfg.id);
      }
      if (res.status === 429) {
        throw new AiCoreError("RATE_LIMIT", `${cfg.id} rate limit hit.`, cfg.id);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new AiCoreError("PROVIDER_ERROR", `${cfg.id} ${res.status}: ${text.slice(0, 300)}`, cfg.id);
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();

      if (!text) {
        throw new AiCoreError("INVALID_RESPONSE", `${cfg.id} returned no text content.`, cfg.id);
      }

      return {
        text,
        provider: cfg.id,
        model,
        latencyMs: Date.now() - start,
        wasFallback: false,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Every OpenAI-compatible provider is just a config entry. To add a new one
// that speaks this same protocol: add one object here + register it in
// registry.ts. No other file changes.
// ---------------------------------------------------------------------------

export const groqAdapter = makeOpenAiCompatAdapter({
  id: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKeyEnvVar: "GROQ_API_KEY",
  modelEnvVar: "GROQ_MODEL",
  defaultModel: "llama-3.3-70b-versatile",
});

export const cerebrasAdapter = makeOpenAiCompatAdapter({
  id: "cerebras",
  baseUrl: "https://api.cerebras.ai/v1",
  apiKeyEnvVar: "CEREBRAS_API_KEY",
  modelEnvVar: "CEREBRAS_MODEL",
  defaultModel: "llama-3.3-70b",
});

export const mistralAdapter = makeOpenAiCompatAdapter({
  id: "mistral",
  baseUrl: "https://api.mistral.ai/v1",
  apiKeyEnvVar: "MISTRAL_API_KEY",
  modelEnvVar: "MISTRAL_MODEL",
  defaultModel: "mistral-large-latest",
});

export const openaiAdapter = makeOpenAiCompatAdapter({
  id: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnvVar: "OPENAI_API_KEY",
  modelEnvVar: "OPENAI_MODEL",
  defaultModel: "gpt-4o-mini",
});

export const openrouterAdapter = makeOpenAiCompatAdapter({
  id: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyEnvVar: "OPENROUTER_API_KEY",
  modelEnvVar: "OPENROUTER_MODEL",
  defaultModel: "openrouter/auto",
  extraHeaders: { "HTTP-Referer": "https://vireek.com", "X-Title": "Vireek AI Core" },
});

export const togetherAdapter = makeOpenAiCompatAdapter({
  id: "together",
  baseUrl: "https://api.together.xyz/v1",
  apiKeyEnvVar: "TOGETHER_API_KEY",
  modelEnvVar: "TOGETHER_MODEL",
  defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
});

export const deepseekAdapter = makeOpenAiCompatAdapter({
  id: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  apiKeyEnvVar: "DEEPSEEK_API_KEY",
  modelEnvVar: "DEEPSEEK_MODEL",
  defaultModel: "deepseek-chat",
});

export const fireworksAdapter = makeOpenAiCompatAdapter({
  id: "fireworks",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  apiKeyEnvVar: "FIREWORKS_API_KEY",
  modelEnvVar: "FIREWORKS_MODEL",
  defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
});
