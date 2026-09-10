// supabase/functions/_shared/ai-core/types.ts
//
// Vireek AI Core — shared type contracts. Zero runtime logic, zero
// provider-specific code. Everything else imports ONLY from here for
// cross-module types.

export type ProviderId =
  | "gemini"
  | "groq"
  | "cerebras"
  | "cloudflare"
  | "openrouter"
  | "cohere";

export type ProviderCapability = "chat" | "json" | "embedding" | "rerank";

export type TaskType =
  | "demo_chat"
  | "intent_classify"
  | "dashboard_answer"
  | "embedding"
  | "rerank"
  | "general";

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

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapability[];
  isConfigured(): boolean;
  chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse>;
  embed?(req: EmbeddingRequest): Promise<EmbeddingResponse>;
}

export interface RouteEntry {
  provider: ProviderId;
  priority: number;
  model: string;
}
