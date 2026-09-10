// supabase/functions/_shared/ai-core/types.ts
//
// Vireek AI Core — shared type contracts.
// Every provider adapter, the router, and both edge functions (demo-chat,
// ai-assistant-query) import ONLY from here for cross-module types. This
// file has zero runtime logic and zero provider-specific code — it exists
// so adding a new provider never requires touching the router's types.

/** Canonical identifier for every supported AI provider. Add new ones here
 *  only — nothing else in the core should hardcode provider names. */
export type ProviderId =
  | "anthropic"
  | "gemini"
  | "groq"
  | "cerebras"
  | "cloudflare"
  | "mistral"
  | "cohere"
  | "openai"
  | "openrouter"
  | "together"
  | "deepseek"
  | "fireworks";

/** What a provider adapter can actually do. The router uses this to avoid
 *  routing an embedding/rerank task to a chat-only provider and vice versa. */
export type ProviderCapability = "chat" | "json" | "embedding" | "rerank";

/** Logical job the request is trying to accomplish. The router picks a
 *  provider ordering PER task, not globally — e.g. Cohere is never picked
 *  for "chat" tasks, only "embedding"/"rerank". */
export type TaskType =
  | "demo_chat"        // public landing-page "Talk to Sarah" widget
  | "intent_classify"  // dashboard AI assistant: question -> fixed intent
  | "dashboard_answer"  // dashboard AI assistant: facts -> natural language
  | "embedding"
  | "rerank"
  | "general";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Fully normalized request every adapter receives. Adapters translate this
 *  into whatever shape their provider's API actually wants. */
export interface NormalizedChatRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  /** Ask the provider to return strict JSON when it supports it natively
   *  (e.g. response_format). Adapters that can't do this natively should
   *  still forward the instruction via the system prompt — never silently
   *  ignore it. */
  jsonMode?: boolean;
  /** Per-request timeout override, in ms. Falls back to router default. */
  timeoutMs?: number;
}

export interface NormalizedChatResponse {
  text: string;
  provider: ProviderId;
  model: string;
  latencyMs: number;
  /** True if this response came from a fallback provider, not the primary
   *  pick for this task — useful for observability without changing the
   *  response contract the frontend depends on. */
  wasFallback: boolean;
}

export interface EmbeddingRequest {
  input: string[];
  timeoutMs?: number;
}

export interface EmbeddingResponse {
  vectors: number[][];
  provider: ProviderId;
  model: string;
  latencyMs: number;
}

/** Normalized error every adapter must throw as, instead of letting raw
 *  fetch/HTTP errors escape. The router pattern-matches on `.code`, never
 *  on provider-specific error shapes or status codes. */
export type AiCoreErrorCode =
  | "NOT_CONFIGURED"   // missing API key / secret for this provider
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "AUTH"
  | "INVALID_RESPONSE" // provider returned 200 but unusable content
  | "PROVIDER_ERROR"   // any other non-2xx from the provider
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

/** The interface every provider adapter must implement. Adding a provider =
 *  writing one file that implements this + registering it — nothing else
 *  in the codebase changes. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapability[];

  /** Cheap sync check — is this provider's secret actually present in env?
   *  The router uses this to skip unconfigured providers before spending a
   *  network round-trip on a guaranteed NOT_CONFIGURED error. */
  isConfigured(): boolean;

  chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse>;

  /** Optional — only providers with capabilities.includes("embedding") need
   *  to implement this. Others can omit it entirely. */
  embed?(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}

/** One entry in the router's provider table for a given task. */
export interface RouteEntry {
  provider: ProviderId;
  /** Lower runs first. Ties broken by registration order. */
  priority: number;
  model: string;
}
