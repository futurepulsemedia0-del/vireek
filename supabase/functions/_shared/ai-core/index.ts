// supabase/functions/_shared/ai-core/index.ts
//
// Vireek AI Core — public entry point. Every edge function talks to the
// AI system ONLY through this file. It never imports an adapter, the
// registry, or the router directly — this is what makes "add a provider
// without touching the frontend or business logic" actually true.
//
// Flow implemented here (matches the target architecture):
//   validate input -> apply Vireek identity/policy -> attach knowledge
//   -> route to best available provider with fallback -> normalize
//   response -> return.

import type { ChatMessage, TaskType } from "./types.ts";
import { AiCoreError } from "./types.ts";
import { buildSystemPrompt } from "./identity.ts";
import { routeChat, type RouteChatResult } from "./router.ts";

export interface AskVireekAiOptions {
  task: TaskType;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  /** Grounds the system prompt in the full brand knowledge brief instead
   *  of keyword-matched topics — use for short conversational tasks like
   *  demo_chat where there's no single "topic" to match against. */
  useFullKnowledgeBrief?: boolean;
  /** Extra system-prompt instructions specific to this call (e.g. the
   *  exact intent enum + JSON shape for intent_classify). Business logic
   *  that belongs to the CALLER, not to the identity layer. */
  extraInstructions?: string;
}

export interface AskVireekAiResult {
  text: string;
  /** Everything a caller needs for logging/observability without leaking
   *  it to the end user — see observability.ts for how to record this. */
  meta: {
    provider: string;
    model: string;
    latencyMs: number;
    wasFallback: boolean;
    attempts: RouteChatResult["attempts"];
  };
}

/**
 * The one function that answers a chat-shaped request anywhere in Vireek.
 * demo-chat and ai-assistant-query both call this instead of fetching any
 * provider's API directly.
 */
export async function askVireekAi(opts: AskVireekAiOptions): Promise<AskVireekAiResult> {
  if (!opts.messages.length) {
    throw new AiCoreError("INVALID_RESPONSE", "No messages provided to askVireekAi.");
  }

  const lastUserMessage = [...opts.messages].reverse().find((m) => m.role === "user")?.content ?? "";

  const system = buildSystemPrompt({
    task: opts.task,
    userQuestion: lastUserMessage,
    useFullKnowledgeBrief: opts.useFullKnowledgeBrief,
    extraInstructions: opts.extraInstructions,
  });

  const result = await routeChat(opts.task, {
    system,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    jsonMode: opts.jsonMode,
    timeoutMs: opts.timeoutMs,
  });

  return {
    text: result.response.text,
    meta: {
      provider: result.response.provider,
      model: result.response.model,
      latencyMs: result.response.latencyMs,
      wasFallback: result.response.wasFallback,
      attempts: result.attempts,
    },
  };
}

/**
 * Convenience for the two hardest failure paths every edge function needs:
 * every provider failed, or something unexpected blew up. Returns a clean,
 * user-safe message — never a stack trace or provider error text.
 */
export function safeFallbackMessage(err: unknown): string {
  if (err instanceof AiCoreError && err.code === "ALL_PROVIDERS_FAILED") {
    return "I'm having trouble responding right now — please try again in a moment.";
  }
  return "Something went wrong. Please try again.";
}

export type { TaskType, ChatMessage } from "./types.ts";
export { AiCoreError } from "./types.ts";
