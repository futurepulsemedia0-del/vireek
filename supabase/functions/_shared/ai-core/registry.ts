// supabase/functions/_shared/ai-core/registry.ts
//
// Vireek AI Core — Provider Registry. Task -> ordered provider list.
// Add/remove/reorder a provider by editing this file only.

import type { ProviderAdapter, ProviderId, RouteEntry, TaskType } from "./types.ts";
import { geminiAdapter } from "./providers/gemini.ts";
import { cloudflareAdapter } from "./providers/cloudflare.ts";
import { cohereAdapter } from "./providers/cohere.ts";
import { groqAdapter, cerebrasAdapter, openrouterAdapter } from "./providers/openai-compatible.ts";

export const ALL_ADAPTERS: Partial<Record<ProviderId, ProviderAdapter>> = {
  gemini: geminiAdapter,
  groq: groqAdapter,
  cerebras: cerebrasAdapter,
  cloudflare: cloudflareAdapter,
  openrouter: openrouterAdapter,
  cohere: cohereAdapter,
};

export const TASK_ROUTES: Record<TaskType, RouteEntry[]> = {
  demo_chat: [
    { provider: "gemini", priority: 10, model: "gemini-2.5-flash" },
    { provider: "groq", priority: 20, model: "llama-3.3-70b-versatile" },
    { provider: "cerebras", priority: 30, model: "llama-3.3-70b" },
    { provider: "cloudflare", priority: 40, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
    { provider: "openrouter", priority: 50, model: "openrouter/auto" },
  ],
  intent_classify: [
    { provider: "gemini", priority: 10, model: "gemini-2.5-flash" },
    { provider: "groq", priority: 20, model: "llama-3.3-70b-versatile" },
    { provider: "cerebras", priority: 30, model: "llama-3.3-70b" },
    { provider: "openrouter", priority: 40, model: "openrouter/auto" },
  ],
  dashboard_answer: [
    { provider: "gemini", priority: 10, model: "gemini-2.5-flash" },
    { provider: "groq", priority: 20, model: "llama-3.3-70b-versatile" },
    { provider: "cerebras", priority: 30, model: "llama-3.3-70b" },
    { provider: "cloudflare", priority: 40, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  ],
  general: [
    { provider: "gemini", priority: 10, model: "gemini-2.5-flash" },
    { provider: "groq", priority: 20, model: "llama-3.3-70b-versatile" },
    { provider: "cerebras", priority: 30, model: "llama-3.3-70b" },
    { provider: "cloudflare", priority: 40, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
    { provider: "openrouter", priority: 50, model: "openrouter/auto" },
  ],
  embedding: [{ provider: "cohere", priority: 10, model: "embed-english-v3.0" }],
  rerank: [{ provider: "cohere", priority: 10, model: "" }],
};

export function getRouteForTask(task: TaskType): RouteEntry[] {
  return [...(TASK_ROUTES[task] ?? [])].sort((a, b) => a.priority - b.priority);
}
