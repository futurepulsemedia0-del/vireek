// supabase/functions/_shared/ai-core/providers/gemini.ts
//
// Google Gemini adapter — primary provider.
// Required secret: GEMINI_API_KEY (existing Supabase secret, not created here)
// Optional secret: GEMINI_MODEL

import type {
  ProviderAdapter,
  NormalizedChatRequest,
  NormalizedChatResponse,
  ChatStreamHandler,
} from "../types.ts";
import { AiCoreError } from "../types.ts";
import { readSseEvents } from "../sse.ts";

const DEFAULT_MODEL = "gemini-1.5-flash";

function getApiKey(): string | undefined {
  return Deno.env.get("GEMINI_API_KEY");
}
function getModel(): string {
  return Deno.env.get("GEMINI_MODEL") || DEFAULT_MODEL;
}

function buildContents(req: NormalizedChatRequest) {
  return req.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

function buildRequestBody(req: NormalizedChatRequest) {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: buildContents(req),
    generationConfig: {
      maxOutputTokens: req.maxTokens,
      temperature: req.temperature ?? 0.7,
      ...(req.jsonMode ? { responseMimeType: "application/json" } : {}),
    },
  };
}

/** Pulls the text out of one Gemini `generateContent`-shaped JSON payload. */
function extractText(data: unknown): string {
  const candidates = (data as { candidates?: { content?: { parts?: { text?: string }[] } }[] })?.candidates;
  return (candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",

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
        body: JSON.stringify(buildRequestBody(req)),
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
      // Covers 400 (bad request/invalid model) and any other non-2xx —
      // treated as a transient/provider error so the router falls through
      // to the next provider instead of surfacing it to the user.
      const text = await res.text().catch(() => "");
      throw new AiCoreError("PROVIDER_ERROR", `Gemini ${res.status}: ${text.slice(0, 300)}`, "gemini");
    }

    const data = await res.json();
    const text = extractText(data).trim();

    if (!text) {
      throw new AiCoreError("INVALID_RESPONSE", "Gemini returned no text content.", "gemini");
    }

    return { text, provider: "gemini", model, latencyMs: Date.now() - start, wasFallback: false };
  },

  async chatStream(req: NormalizedChatRequest, onDelta: ChatStreamHandler): Promise<NormalizedChatResponse> {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new AiCoreError("NOT_CONFIGURED", "GEMINI_API_KEY is not set.", "gemini");
    }

    const model = getModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    const start = Date.now();
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? 20_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildRequestBody(req)),
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new AiCoreError("TIMEOUT", `Gemini timed out after ${timeoutMs}ms.`, "gemini");
      }
      throw new AiCoreError("PROVIDER_ERROR", `Gemini network error: ${err}`, "gemini");
    }

    if (res.status === 401 || res.status === 403) {
      clearTimeout(timer);
      throw new AiCoreError("AUTH", "Gemini rejected the API key.", "gemini");
    }
    if (res.status === 429) {
      clearTimeout(timer);
      throw new AiCoreError("RATE_LIMIT", "Gemini rate limit hit.", "gemini");
    }
    if (!res.ok) {
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      throw new AiCoreError("PROVIDER_ERROR", `Gemini ${res.status}: ${text.slice(0, 300)}`, "gemini");
    }

    let full = "";
    try {
      for await (const payload of readSseEvents(res)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // skip a malformed/partial frame rather than aborting the whole stream
        }
        const delta = extractText(parsed);
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      }
    } catch (err) {
      clearTimeout(timer);
      if (full) {
        // We already streamed real content to the caller — treat what we
        // have as the answer rather than throwing it away.
        return { text: full.trim(), provider: "gemini", model, latencyMs: Date.now() - start, wasFallback: false };
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new AiCoreError("TIMEOUT", `Gemini stream timed out after ${timeoutMs}ms.`, "gemini");
      }
      throw new AiCoreError("PROVIDER_ERROR", `Gemini stream error: ${err}`, "gemini");
    }
    clearTimeout(timer);

    const text = full.trim();
    if (!text) {
      throw new AiCoreError("INVALID_RESPONSE", "Gemini returned no text content.", "gemini");
    }

    return { text, provider: "gemini", model, latencyMs: Date.now() - start, wasFallback: false };
  },
};
