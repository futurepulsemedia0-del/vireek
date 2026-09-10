// supabase/functions/_shared/ai-core/types.ts
//
// Vireek AI Core — shared type contracts. Zero runtime logic, zero
// provider-specific code. Every other ai-core file imports ONLY from
// this file for cross-module types.

export type ProviderId = "gemini" | "groq" | "cerebras" | "cloudflare" | "openrouter";

export type TaskType = "demo_chat" | "intent_classify" | "dashboard_answer" | "general";

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
  isConfigured(): boolean;
  chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse>;
}

export interface RouteEntry {
  provider: ProviderId;
  priority: number;
  model: string;
}
