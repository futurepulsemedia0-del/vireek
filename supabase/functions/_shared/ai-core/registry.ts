// supabase/functions/_shared/ai-core/registry.ts
//
// Vireek AI Core — Provider Registry.
//
// This is the ONLY file that maps tasks -> ordered provider lists. Adding,
// removing, reordering, or disabling a provider for a given task is a
// one-line edit here — nothing else in the codebase changes.
//
// Priority is a plain number (lower = tried first). Providers not present
// for a task are never considered for it, regardless of how many secrets
// are configured — this is intentional: Cohere never accidentally gets
// picked for "demo_chat" just because its key exists.

import type { ProviderAdapter, ProviderId, RouteEntry, TaskType } from "./types.ts";
import { anthropicAdapter } from "./providers/anthropic.ts";
import { geminiAdapter } from "./providers/gemini.ts";
import { cloudflareAdapter } from "./providers/cloudflare.ts";
import { cohereAdapter } from "./providers/cohere.ts";
import {
  groqAdapter,
  cerebrasAdapter,
  mistralAdapter,
  openaiAdapter,
  openrouterAdapter,
  togetherAdapter,
  deepseekAdapter,
  fireworksAdapter,
} from "./providers/openai-compatible.ts";

/** Every adapter that exists in the system, keyed by id. Registering a new
 *  provider = (1) write its adapter file, (2) add one line here. */
export const ALL_ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  groq: groqAdapter,
  cerebras: cerebrasAdapter,
  cloudflare: cloudflareAdapter,
  mistral: mistralAdapter,
  cohere: cohereAdapter,
  openai: openaiAdapter,
  openrouter: openrouterAdapter,
  together: togetherAdapter,
  deepseek: deepseekAdapter,
  fireworks: fireworksAdapter,
};

/**
 * Task -> ordered fallback chain. This is the ENTIRE routing policy for
 * the whole platform. To change "try Gemini before Groq", swap two
 * priority numbers. To retire a provider everywhere, delete its lines
 * here (its adapter file and secret can stay — it's simply never routed
 * to again).
 *
 * `model` here is a per-task override; adapters still fall back to their
 * own env-var default / hardcoded default if this is omitted.
 */
export const TASK_ROUTES: Record<TaskType, RouteEntry[]> = {
  demo_chat: [
    { provider: "anthropic", priority: 10, model: "claude-haiku-4-5-20251001" },
    { provider: "gemini", priority: 20, model: "gemini-2.5-flash" },
    { provider: "groq", priority: 30, model: "llama-3.3-70b-versatile" },
    { provider: "cerebras", priority: 40, model: "llama-3.3-70b" },
    { provider: "cloudflare", priority: 50, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
    { provider: "mistral", priority: 60, model: "mistral-large-latest" },
  ],

  intent_classify: [
    // Needs strong instruction-following for strict JSON — keep the
    // biggest/most reliable models first even though it costs a bit more;
    // this step gates a security boundary (fixed intents only).
    { provider: "anthropic", priority: 10, model: "claude-sonnet-5" },
    { provider: "gemini", priority: 20, model: "gemini-2.5-flash" },
    { provider: "mistral", priority: 30, model: "mistral-large-latest" },
    { provider: "groq", priority: 40, model: "llama-3.3-70b-versatile" },
  ],

  dashboard_answer: [
    { provider: "anthropic", priority: 10, model: "claude-haiku-4-5-20251001" },
    { provider: "gemini", priority: 20, model: "gemini-2.5-flash" },
    { provider: "groq", priority: 30, model: "llama-3.3-70b-versatile" },
    { provider: "cerebras", priority: 40, model: "llama-3.3-70b" },
  ],

  general: [
    { provider: "anthropic", priority: 10, model: "claude-sonnet-5" },
    { provider: "gemini", priority: 20, model: "gemini-2.5-flash" },
    { provider: "openai", priority: 30, model: "gpt-4o-mini" },
    { provider: "openrouter", priority: 40, model: "openrouter/auto" },
    { provider: "together", priority: 50, model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
    { provider: "fireworks", priority: 60, model: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
    { provider: "deepseek", priority: 70, model: "deepseek-chat" },
  ],

  embedding: [{ provider: "cohere", priority: 10, model: "embed-english-v3.0" }],
  rerank: [{ provider: "cohere", priority: 10, model: "" }],
};

export function getRouteForTask(task: TaskType): RouteEntry[] {
  return [...(TASK_ROUTES[task] ?? [])].sort((a, b) => a.priority - b.priority);
}
