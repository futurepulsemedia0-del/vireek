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
import { createKeyPool, parseKeyEntries, withKeyFailover } from "../keyPool.ts";
import type { KeyPool } from "../keyPool.ts";
import { recordKeyEvent } from "../keyHealthStore.ts";

const DEFAULT_MODEL = "gemini-2.5-flash";

let pool: KeyPool | null = null;
let poolSignature = "";

/** Ordered, sticky key pool. GEMINI_API_KEY (legacy) is always first; GEMINI_API_KEYS adds more. */
function getPool(): KeyPool {
  const legacy = Deno.env.get("GEMINI_API_KEY");
  const multi = Deno.env.get("GEMINI_API_KEYS");
  const signature = `${legacy ?? ""}\u0000${multi ?? ""}`;
  if (!pool || signature !== poolSignature) {
    pool = createKeyPool("gemini", parseKeyEntries(multi, legacy), { onEvent: recordKeyEvent });
    poolSignature = signature;
  }
  return pool;
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
      ...(req.jsonMode ? { response_mime_type: "application/json" } : {}),
    },
  };
}

/** Pulls the text out of one Gemini `generateContent`-shaped JSON payload. */
function extractText(data: unknown): string {
  const candidates = (data as { candidates?: { content?: { parts?: { text?: string }[] } }[] })?.candidates;
  return (candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

interface KeyedGemini {
  chat(req: NormalizedChatRequest, apiKey: string): Promise<NormalizedChatResponse>;
  chatStream(req: NormalizedChatRequest, onDelta: ChatStreamHandler, apiKey: string): Promise<NormalizedChatResponse>;
}

const geminiCore: KeyedGemini = {
  async chat(req: NormalizedChatRequest, apiKey: string): Promise<NormalizedChatResponse> {
    const model = getModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

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

  async chatStream(req: NormalizedChatRequest, onDelta: ChatStreamHandler, apiKey: string): Promise<NormalizedChatResponse> {

    const model = getModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

    const start = Date.now();
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? 20_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
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
  const text = await res.text().catch(() => "");
  console.error("[GEMINI ERROR]", res.status, text.slice(0, 500));
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

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",

  isConfigured(): boolean {
    return getPool().size() > 0;
  },

  chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
    return withKeyFailover(getPool(), "gemini", (apiKey) => geminiCore.chat(req, apiKey));
  },

  // AUTH is returned by the HTTP status before any token is streamed, so failing over to the next
  // key can never duplicate output already delivered to the caller.
  chatStream(req: NormalizedChatRequest, onDelta: ChatStreamHandler): Promise<NormalizedChatResponse> {
    return withKeyFailover(getPool(), "gemini", (apiKey) => geminiCore.chatStream(req, onDelta, apiKey));
  },
};
