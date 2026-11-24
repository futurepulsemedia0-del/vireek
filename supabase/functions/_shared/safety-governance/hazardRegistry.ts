// supabase/functions/_shared/safety-governance/hazardRegistry.ts
//
// INVENTORY of hazard-related guidance (gas, CO, electrical, refrigerant) in diagnostic content and AI prompts, plus the
// review records that cover it. Checked by `npm run safety:hazard:check` (scripts/safety/hazard-content-check.mjs).
// Human-readable view: docs/safety/hazard-content-governance.md.
//
// Rules for editing this file
//   * Add a row for every new prompt / content file that mentions a hazard domain. CI discovers candidates and fails on
//     any that are neither registered here nor acknowledged in NOT_HAZARD_GUIDANCE with a reason.
//   * HAZARD_REVIEWS is EMPTY on purpose. Reviews are made by named humans; this repository never invents one.
//     A row is added (or its expiry renewed) only after the reviewer signs off. [COUNSEL: who may review, which standard]
//   * A review is bound to the exact text via `contentHash` (run `npm run safety:hazard:check -- --print-hashes`), so editing
//     a registered text without a new review makes the check fail.

import type { HazardDomain, HazardTier, ReviewRecord } from "./hazardGovernance.ts";

export type InventoryKind = "ai_prompt" | "floor_text" | "detector" | "diagnostic_content" | "playbook_script" | "regulatory_claim";

export interface InventoryItem {
  id: string;
  kind: InventoryKind;
  tier: HazardTier;
  domains: readonly HazardDomain[];
  /** Repo-relative path. */
  file: string;
  /** Text region that is hashed: from the first occurrence of `start` to the first `end` after it (or end of file when omitted). */
  start: string;
  end?: string;
  /** Who answers for the content. Placeholder until the business assigns a person or role. */
  owner: string;
  /** Where the content reaches people or models. */
  surface: string;
  note?: string;
}

const OWNER = "[OWNER: assign]";
const F = "supabase/functions/";

export const HAZARD_INVENTORY: readonly InventoryItem[] = [
  // ---- floor: what callers hear / read first, and the deterministic detectors. Never blocked at runtime. ------------------
  { id: "floor.ontology-safety-guidance", kind: "floor_text", tier: "floor", domains: ["gas", "carbon_monoxide", "electrical"], file: `${F}_shared/vertical-ai/ontologySeed.ts`, start: "export const SAFETY_GUIDANCE", end: "\n};", owner: OWNER, surface: "voice agent + chat: spoken emergency instruction (emergencyInstruction)" },
  { id: "floor.remote-resolution-guidance", kind: "floor_text", tier: "floor", domains: ["gas", "carbon_monoxide", "electrical"], file: `${F}_shared/remote-resolution/score.ts`, start: "const SAFETY_GUIDANCE: Record<SafetyReason", end: "\n};", owner: OWNER, surface: "customer self-service remote resolution: shown when a safety hold triggers" },
  { id: "floor.remote-resolution-guidance-ui", kind: "floor_text", tier: "floor", domains: ["gas", "carbon_monoxide", "electrical"], file: "src/lib/remoteResolution.ts", start: "export const SAFETY_GUIDANCE: Record<SafetyReason", end: "\n};", owner: OWNER, surface: "customer web UI copy of the remote-resolution guidance", note: "must stay identical to the edge-function copy" },
  { id: "detector.emergency-rules", kind: "detector", tier: "floor", domains: ["gas", "carbon_monoxide", "electrical"], file: `${F}_shared/vertical-ai/emergencyRules.ts`, start: "const RULES: Rule[] = [", end: "\n];", owner: OWNER, surface: "deterministic emergency classifier (voice + chat), independent of any LLM" },
  { id: "detector.emergency-fast-path", kind: "detector", tier: "floor", domains: ["gas", "carbon_monoxide", "electrical"], file: `${F}_shared/voice-resilience/emergencyFastPath.ts`, start: "const LIFE_SAFETY", end: "\n];", owner: OWNER, surface: "degraded-mode voice detector (every degradation level)" },
  { id: "detector.remote-resolution-rules", kind: "detector", tier: "floor", domains: ["gas", "carbon_monoxide", "electrical"], file: `${F}_shared/remote-resolution/score.ts`, start: "const SAFETY_RULES", end: "\n];", owner: OWNER, surface: "safety hold in remote resolution" },
  { id: "detector.adaptive-diagnostic-hazard", kind: "detector", tier: "floor", domains: ["gas", "carbon_monoxide", "electrical"], file: `${F}_shared/adaptive-diagnostic/engine.ts`, start: "const HAZARD_PATTERNS", end: "\n];", owner: OWNER, surface: "customer diagnostic: stops the session and alerts the owner" },
  { id: "detector.request-policy-diy", kind: "detector", tier: "floor", domains: ["gas", "carbon_monoxide", "electrical", "refrigerant"], file: `${F}_shared/vertical-ai/requestPolicy.ts`, start: "const DIY_HAZARD", end: ";\n", owner: OWNER, surface: "refuses unsafe DIY requests on gas / electrical / refrigerant / safety devices" },

  { id: "detector.mass-incident-classes", kind: "detector", tier: "floor", domains: ["gas", "electrical"], file: `${F}_shared/mass-incident/core.ts`, start: 'cls: "gas_odor"', end: "\n];", owner: OWNER, surface: "mass-incident detection from inbound calls (gas odor, partial power)" },
  { id: "alert.adaptive-diagnostic-hazard", kind: "floor_text", tier: "floor", domains: ["gas", "electrical"], file: `${F}adaptive-diagnostic/index.ts`, start: 'message: "A customer reported a possible safety hazard', end: "\n", owner: OWNER, surface: "owner alert when the customer diagnostic stops on a hazard" },

  // ---- guardrail: prompt text that RESTRICTS a model near hazards. Never blocked at runtime; changes need re-review. -------
  { id: "prompt.remote-resolution", kind: "ai_prompt", tier: "guardrail", domains: ["gas", "carbon_monoxide", "electrical", "refrigerant"], file: `${F}_shared/ai-core/remoteResolutionPrompt.ts`, start: "export const REMOTE_RESOLUTION_INSTRUCTIONS", end: "`;", owner: OWNER, surface: "customer-facing remote resolution model: steps a homeowner may be told to take" },
  { id: "prompt.remote-resolution-media", kind: "ai_prompt", tier: "guardrail", domains: ["gas", "carbon_monoxide", "electrical"], file: `${F}remote-resolution/index.ts`, start: "const PHOTO_PROMPT", end: "const AUDIO_PROMPT", owner: OWNER, surface: "photo observation prompt (hazard enum)" },
  { id: "prompt.diagnosis-copilot", kind: "ai_prompt", tier: "guardrail", domains: ["gas", "carbon_monoxide", "electrical", "refrigerant"], file: `${F}diagnosis-copilot/index.ts`, start: "const SYSTEM_PROMPT", end: "`;", owner: OWNER, surface: "technician diagnosis copilot" },
  { id: "prompt.field-estimate", kind: "ai_prompt", tier: "guardrail", domains: ["gas", "carbon_monoxide", "electrical"], file: `${F}field-estimate/index.ts`, start: "const SYSTEM_PROMPT", end: "`;", owner: OWNER, surface: "field estimate from photos / audio" },
  { id: "prompt.no-surprise-assess", kind: "ai_prompt", tier: "guardrail", domains: ["gas", "carbon_monoxide", "electrical"], file: `${F}no-surprise-assess/index.ts`, start: "const SYSTEM_PROMPT", end: "`;", owner: OWNER, surface: "no-surprise assessment (risk level)" },
  { id: "prompt.live-copilot", kind: "ai_prompt", tier: "guardrail", domains: ["electrical", "refrigerant"], file: `${F}live-copilot/index.ts`, start: "const PERCEPTION_PROMPT", end: "`;", owner: OWNER, surface: "live technician copilot perception (nameplate refrigerant / electrical ratings)" },
  { id: "prompt.homeowner-assistant", kind: "ai_prompt", tier: "guardrail", domains: ["gas", "carbon_monoxide", "electrical"], file: `${F}homeowner-assistant/index.ts`, start: "const INSTRUCTIONS", end: "`;", owner: OWNER, surface: "homeowner chat assistant" },
  { id: "prompt.auto-reply", kind: "ai_prompt", tier: "guardrail", domains: ["gas", "carbon_monoxide", "electrical"], file: `${F}_shared/autoReply/prompt.ts`, start: "Safety first", end: "\n", owner: OWNER, surface: "automatic replies to inbound messages" },
  { id: "prompt.ai-core-identity", kind: "ai_prompt", tier: "guardrail", domains: ["gas"], file: `${F}_shared/ai-core/identity.ts`, start: "Treat anything urgent or dangerous", end: "\n", owner: OWNER, surface: "shared agent identity" },
  { id: "prompt.voice-persona", kind: "ai_prompt", tier: "guardrail", domains: ["gas", "carbon_monoxide", "electrical"], file: `${F}_shared/voice-brand/persona.ts`, start: "`Emergency: stay calm", end: "\n", owner: OWNER, surface: "voice persona emergency behaviour" },

  // ---- instructional: tells a person or model what to DO / CHECK / ASSERT. Blocked unless a current review exists. ---------
  { id: "content.ontology-seed", kind: "diagnostic_content", tier: "instructional", domains: ["gas", "carbon_monoxide", "electrical", "refrigerant"], file: `${F}_shared/vertical-ai/ontologySeed.ts`, start: "export const ONTOLOGY_SEED", owner: OWNER, surface: "symptom causes / checks, permit triggers used by the voice agent", note: "production rows are governed per row (vertical_ontology_entries); this registers the bundled seed copy" },
  { id: "content.diag-catalog", kind: "diagnostic_content", tier: "instructional", domains: ["refrigerant", "electrical", "gas"], file: "supabase/migrations/20270301000000_adaptive_customer_diagnostic.sql", start: "INSERT INTO public.diag_hypotheses", owner: OWNER, surface: "adaptive customer diagnostic: hypotheses and customer questions", note: "production rows are governed per row (diag_hypotheses / diag_questions)" },
  { id: "prompt.technician-simulator", kind: "ai_prompt", tier: "instructional", domains: ["gas", "electrical", "refrigerant"], file: `${F}technician-simulator/index.ts`, start: "const SCENARIO_SYSTEM", end: "`;", owner: OWNER, surface: "training scenarios with safety checks (lockout, gas test, EPA 608)" },
  { id: "script.playbooks-weather", kind: "playbook_script", tier: "instructional", domains: ["gas", "carbon_monoxide", "electrical"], file: `${F}_shared/playbooks/catalogWeather.ts`, start: "key: 'cold-snap-freeze'", owner: OWNER, surface: "agent call scripts during cold snaps (gas / CO safety messaging)" },
  { id: "script.playbooks-seasonal", kind: "playbook_script", tier: "instructional", domains: ["carbon_monoxide", "gas"], file: `${F}_shared/playbooks/catalogSeasonal.ts`, start: "carbon monoxide safety messaging", owner: OWNER, surface: "agent call scripts for heating-season inspections (CO messaging)" },
  { id: "claim.permit-rules", kind: "regulatory_claim", tier: "instructional", domains: ["gas", "carbon_monoxide", "electrical", "refrigerant"], file: `${F}_shared/permit-rules/rules.ts`, start: "export", owner: OWNER, surface: "permit / code statements for gas, electrical and refrigerant work", note: "[COUNSEL] jurisdiction-specific code claims" },
];

/** Reviews on record. EMPTY until a named human signs off. Key = InventoryItem.id. */
export const HAZARD_REVIEWS: Readonly<Record<string, ReviewRecord>> = {};

/**
 * Files that mention a hazard word inside a prompt-like string but contain NO hazard guidance (labels, enums, extraction
 * schemas, document checklists, intent taxonomies). Every entry needs a reason a reviewer can challenge.
 */
export const NOT_HAZARD_GUIDANCE: Readonly<Record<string, string>> = {
  [`${F}_shared/property-vision/taxonomy.ts`]: "finding / component label enums; no instructions",
  [`${F}permit-transaction-agent/index.ts`]: "permit document checklist; no field guidance",
  [`${F}verify-job-evidence/index.ts`]: "reports only hazards visible in a photo and says not to infer smells",
  [`${F}shadow-replay/index.ts`]: "intent classification schema",
  [`${F}generate-mission-brief/index.ts`]: "dispatch brief example wording only",
  [`${F}_shared/voice-log/extract.ts`]: "extraction schema; explicitly forbids giving instructions",
  [`${F}_shared/sarah-learn/scenarios.ts`]: "coaching scenario text for human trainees",
  [`${F}_shared/sarah-learn/prompts.ts`]: "persona style prompt; no hazard instructions",
  [`${F}_shared/permit-rules/ai.ts`]: "compliance analyst prompt covered by claim.permit-rules",
  [`${F}_shared/ovb/runtime.ts`]: "disclosure / behaviour prompt; no hazard instructions",
  [`${F}_shared/conversation-intel/engine.ts`]: "classification of hazards mentioned in recorded calls; no instructions",
  [`${F}_shared/ai-core/index.ts`]: "contains the shared identity line already registered as prompt.ai-core-identity",
  [`${F}_shared/ai-core/agentOrchestration.ts`]: "intent taxonomy descriptions",
  [`${F}_shared/vertical-ai/intake.ts`]: "intake normalisation; emergency wording comes from floor.ontology-safety-guidance",
};
