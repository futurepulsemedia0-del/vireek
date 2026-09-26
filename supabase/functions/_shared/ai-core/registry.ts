// supabase/functions/_shared/ai-core/registry.ts
//
// Vireek AI Core — Provider Registry. Task -> ordered provider chain.
// Add/remove/reorder a provider by editing this file only.

import type { ProviderAdapter, ProviderId, RouteEntry, TaskType } from "./types.ts";

import { geminiAdapter } from "./providers/gemini.ts";
import { groqAdapter } from "./providers/groq.ts";
import { cerebrasAdapter } from "./providers/cerebras.ts";
import { cloudflareAdapter } from "./providers/cloudflare.ts";
import { openrouterAdapter } from "./providers/openrouter.ts";
import { anthropicAdapter } from "./providers/anthropic.ts";
import { cohereAdapter } from "./providers/cohere.ts";

export const ALL_ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  gemini: geminiAdapter,
  groq: groqAdapter,
  cerebras: cerebrasAdapter,
  cloudflare: cloudflareAdapter,
  openrouter: openrouterAdapter,
  anthropic: anthropicAdapter,
  cohere: cohereAdapter,
};

// Gemini -> Groq -> Cerebras -> Cloudflare -> OpenRouter, exactly as required.
const DEFAULT_CHAIN: RouteEntry[] = [
  { provider: "gemini", priority: 10, model: "gemini-2.5-flash" },
  { provider: "groq", priority: 20, model: "llama-3.3-70b-versatile" },
  { provider: "cerebras", priority: 30, model: "llama-3.3-70b" },
  { provider: "cloudflare", priority: 40, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  { provider: "openrouter", priority: 50, model: "openrouter/auto" },
];

// Structured JSON classification needs a provider that reliably honors
// response_format json_object. Cloudflare's Workers AI models don't, so
// it's excluded here — same 5-provider order otherwise.
const JSON_CHAIN: RouteEntry[] = DEFAULT_CHAIN.filter((e) => e.provider !== "cloudflare");

export const TASK_ROUTES: Record<TaskType, RouteEntry[]> = {
  demo_chat: DEFAULT_CHAIN,
  general: DEFAULT_CHAIN,
  dashboard_answer: DEFAULT_CHAIN,
  intent_classify: JSON_CHAIN,
  call_intelligence: JSON_CHAIN,
  business_decision_engine: JSON_CHAIN,
  causal_world_simulator: JSON_CHAIN,
   continual_identity_learner: JSON_CHAIN,
  cash_flow_narrative: JSON_CHAIN,
  regional_demand_narrative: JSON_CHAIN,
  business_insights: JSON_CHAIN,
  dispatch_copilot: JSON_CHAIN,
  onboarding_extract: JSON_CHAIN,
  onboarding_concierge: DEFAULT_CHAIN,
  next_best_action_engine: JSON_CHAIN,
  callback_root_cause: JSON_CHAIN,
  business_scientist_hypothesis: JSON_CHAIN,
  causal_shock_extract: JSON_CHAIN,
  causal_shock_cascade: JSON_CHAIN,
  opportunity_cost_ranking: JSON_CHAIN,
  business_drift_narrative: JSON_CHAIN,
};
export function getRouteForTask(task: TaskType): RouteEntry[] {
  return [...(TASK_ROUTES[task] ?? DEFAULT_CHAIN)].sort((a, b) => a.priority - b.priority);
}
