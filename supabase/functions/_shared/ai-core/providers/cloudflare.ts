// supabase/functions/_shared/ai-core/providers/cloudflare.ts
//
// Cloudflare Workers AI adapter. Different wire format from the OpenAI-
// compatible group: auth via account ID in the URL path + bearer token,
// and the response shape is { result: { response: "..." } }.
//
// Required secrets: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
// Optional secret: CLOUDFLARE_MODEL

import type {
  ProviderAdapter,
  NormalizedChatRequest,
  NormalizedChatResponse,
} from "../types.ts";
import { AiCoreError } from "../types.ts";

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function getAccountId(): string | undefined {
  return Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
}
function getApiToken(): string | undefined {
  return Deno.env.get("CLOUDFLARE_API_TOKEN");
}
function getModel(): string {
  return Deno.env.get("CLOUDFLARE_MODEL") || DEFAULT_MODEL;
}

export const cloudflareAdapter: ProviderAdapter = {
  id: "cloudflare",
  capabilities: ["chat"],

  isConfigured(): boolean {
    return !!getAccountId() && !!getApiToken();
  },

  async chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
    const accountId = getAccountId();
    const apiToken = getApiToken();
    if (!accountId || !apiToken) {
      throw new AiCoreError(
        "NOT_CONFIGURED",
        "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set.",
        "cloudflare",
      );
    }

    const model = getModel();
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    const start = Date.now();
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? 12_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          max_tokens: req.maxTokens,
          temperature: req.temperature ?? 0.7,
          messages: [{ role: "system", content: req.system }, ...req.messages],
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new AiCoreError("TIMEOUT", `Cloudflare timed out after ${timeoutMs}ms.`, "cloudflare");
      }
      throw new AiCoreError("PROVIDER_ERROR", `Cloudflare network error: ${err}`, "cloudflare");
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      throw new AiCoreError("AUTH", "Cloudflare rejected the API token.", "cloudflare");
    }
    if (res.status === 429) {
      throw new AiCoreError("RATE_LIMIT", "Cloudflare rate limit hit.", "cloudflare");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AiCoreError("PROVIDER_ERROR", `Cloudflare ${res.status}: ${text.slice(0, 300)}`, "cloudflare");
    }

    const data = await res.json();
    const text = (data?.result?.response ?? "").trim();

    if (!text) {
      throw new AiCoreError("INVALID_RESPONSE", "Cloudflare returned no text content.", "cloudflare");
    }

    return {
      text,
      provider: "cloudflare",
      model,
      latencyMs: Date.now() - start,
      wasFallback: false,
    };
  },
};
