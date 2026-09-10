// supabase/functions/_shared/ai-core/index.ts
//
// Vireek AI Core — public entry point. Every edge function talks to the
// AI system ONLY through this file.

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
  useFullKnowledgeBrief?: boolean;
  extraInstructions?: string;
}

export interface AskVireekAiResult {
  text: string;
  meta: {
    provider: string;
    model: string;
    latencyMs: number;
    wasFallback: boolean;
    attempts: RouteChatResult["attempts"];
  };
}

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

export function safeFallbackMessage(err: unknown): string {
  if (err instanceof AiCoreError && err.code === "ALL_PROVIDERS_FAILED") {
    return "I'm having trouble responding right now — please try again in a moment.";
  }
  return "Something went wrong. Please try again.";
}

export type { TaskType, ChatMessage } from "./types.ts";
export { AiCoreError } from "./types.ts";
