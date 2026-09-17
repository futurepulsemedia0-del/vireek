// supabase/functions/_shared/ai-core/types.ts
//
// Vireek AI Core — shared type contracts. Zero runtime logic, zero
// provider-specific code. Every other ai-core file imports ONLY from
// this file for cross-module types.

export type ProviderId = "gemini" | "groq" | "cerebras" | "cloudflare" | "openrouter" | "anthropic";

export type TaskType =
  | "demo_chat"
  | "intent_classify"
  | "dashboard_answer"
  | "general"
  | "call_intelligence"
  | "business_insights"
  | "dispatch_copilot";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface NormalizedChatRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
}

export interface NormalizedChatResponse {
  text: string;
  provider: ProviderId;
  model: string;
  latencyMs: number;
  wasFallback: boolean;
}

/**
 * Called once per incremental text delta while a provider streams its
 * reply. Adapters call this as soon as tokens are available — never
 * buffered — so the caller (the router, then the edge function, then the
 * browser) can forward each piece the moment it exists.
 */
export type ChatStreamHandler = (delta: string) => void;

export type AiCoreErrorCode =
  | "NOT_CONFIGURED"
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "AUTH"
  | "INVALID_RESPONSE"
  | "PROVIDER_ERROR"
  | "ALL_PROVIDERS_FAILED";

export class AiCoreError extends Error {
  readonly code: AiCoreErrorCode;
  readonly provider?: ProviderId;

  constructor(code: AiCoreErrorCode, message: string, provider?: ProviderId) {
    super(message);
    this.name = "AiCoreError";
    this.code = code;
    this.provider = provider;
  }
}

export interface EmbeddingRequest {
  /** One or more strings to embed in a single batch call. */
  input: string[];
  timeoutMs?: number;
  /**
   * Cohere's embed models are asymmetric: a chunk being stored for later
   * retrieval should be embedded as "search_document", while the user's
   * live question should be embedded as "search_query" — using the wrong
   * one for either side measurably hurts match quality. Defaults to
   * "search_document" (the ingestion-script use case) so existing calls
   * that don't pass this keep working unchanged.
   */
  inputType?: "search_document" | "search_query";
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  isConfigured(): boolean;
  chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse>;
  /**
   * Optional streaming variant. When present, the router prefers this over
   * `chat()` for streaming callers and invokes `onDelta` for every chunk of
   * text as it arrives from the provider. Providers without a streaming
   * wire format simply omit this — the router falls back to calling
   * `chat()` and delivering the whole reply as a single chunk, so every
   * provider still "streams" from the caller's point of view.
   */
  chatStream?(req: NormalizedChatRequest, onDelta: ChatStreamHandler): Promise<NormalizedChatResponse>;
}

export interface RouteEntry {
  provider: ProviderId;
  priority: number;
  model: string;
}
