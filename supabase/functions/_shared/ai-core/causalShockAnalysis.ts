// supabase/functions/_shared/ai-core/causalShockAnalysis.ts
//
// Causal Shock Simulator — advisory layer. Two responsibilities, kept
// separate on purpose: (1) turn a free-text question into structured
// shock parameters, BEFORE any deterministic computation happens; (2)
// turn already-computed impact numbers into a causal narrative, AFTER
// computation. Neither function touches the database or invents a
// number — same contract as businessDecisions.ts.

import { askVireekAi } from "./index.ts";

export type ShockType = "technician_unavailable" | "payment_outage" | "demand_surge" | "supply_shortage" | "other";

export interface ShockExtraction {
  shock_type: ShockType;
  technician_count: number | null;
  duration_hours: number | null;
  surge_multiplier: number | null;
  affected_service_type: string | null;
  part_or_supplier_name: string | null;
  restated_scenario: string;
}

const VALID_SHOCK_TYPES = new Set<ShockType>([
  "technician_unavailable", "payment_outage", "demand_surge", "supply_shortage", "other",
]);

function numOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null;
}

export async function extractShockScenario(question: string): Promise<ShockExtraction> {
  const fallback: ShockExtraction = {
    shock_type: "other",
    technician_count: null,
    duration_hours: null,
    surge_multiplier: null,
    affected_service_type: null,
    part_or_supplier_name: null,
    restated_scenario: question.slice(0, 200),
  };

  try {
    const result = await askVireekAi({
      task: "causal_shock_extract",
      jsonMode: true,
      maxTokens: 400,
      temperature: 0.1,
      messages: [{ role: "user", content: question.slice(0, 1000) }],
    });
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    const shockType = typeof parsed.shock_type === "string" && VALID_SHOCK_TYPES.has(parsed.shock_type as ShockType)
      ? (parsed.shock_type as ShockType)
      : "other";
    return {
      shock_type: shockType,
      technician_count: numOrNull(parsed.technician_count),
      duration_hours: numOrNull(parsed.duration_hours),
      surge_multiplier: numOrNull(parsed.surge_multiplier),
      affected_service_type: strOrNull(parsed.affected_service_type),
      part_or_supplier_name: strOrNull(parsed.part_or_supplier_name),
      restated_scenario: strOrNull(parsed.restated_scenario) ?? fallback.restated_scenario,
    };
  } catch {
    return fallback;
  }
}

export interface CascadeStep {
  order: number;
  domain: "jobs" | "crew" | "customer" | "sla" | "cash" | "reputation";
  headline: string;
  detail: string;
}
export interface ResponsePlanStep {
  step: string;
  owner: "dispatcher" | "owner" | "technician" | "customer_service" | "finance";
  urgency: "immediate" | "today" | "this_week";
}
export interface CascadeResult {
  cascade: CascadeStep[];
  response_plan: ResponsePlanStep[];
  summary: string;
}

const VALID_DOMAINS = new Set(["jobs", "crew", "customer", "sla", "cash", "reputation"]);
const VALID_OWNERS = new Set(["dispatcher", "owner", "technician", "customer_service", "finance"]);
const VALID_URGENCY = new Set(["immediate", "today", "this_week"]);

export async function analyzeCausalCascade(
  question: string,
  impact: Record<string, unknown>,
): Promise<CascadeResult> {
  const empty: CascadeResult = { cascade: [], response_plan: [], summary: "" };
  if (!impact || Object.keys(impact).length === 0) return empty;

  try {
    const result = await askVireekAi({
      task: "causal_shock_cascade",
      jsonMode: true,
      maxTokens: 1400,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content:
            `Original question: "${question.slice(0, 500)}"\n\n` +
            `Impact numbers already computed from this business's real data — treat as ground truth, never recompute or contradict:\n${JSON.stringify(impact, null, 2)}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text) as Record<string, unknown>;

    const cascade: CascadeStep[] = (Array.isArray(parsed.cascade) ? parsed.cascade : [])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .filter((s) => VALID_DOMAINS.has(String(s.domain)) && typeof s.headline === "string" && typeof s.detail === "string")
      .slice(0, 8)
      .map((s, i) => ({
        order: numOrNull(s.order) ?? i + 1,
        domain: s.domain as CascadeStep["domain"],
        headline: (s.headline as string).slice(0, 120),
        detail: (s.detail as string).slice(0, 400),
      }))
      .sort((a, b) => a.order - b.order);

    const response_plan: ResponsePlanStep[] = (Array.isArray(parsed.response_plan) ? parsed.response_plan : [])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .filter((s) => typeof s.step === "string" && VALID_OWNERS.has(String(s.owner)) && VALID_URGENCY.has(String(s.urgency)))
      .slice(0, 6)
      .map((s) => ({
        step: (s.step as string).slice(0, 300),
        owner: s.owner as ResponsePlanStep["owner"],
        urgency: s.urgency as ResponsePlanStep["urgency"],
      }));

    const summary = typeof parsed.summary === "string" ? parsed.summary.slice(0, 500) : "";

    return { cascade, response_plan, summary };
  } catch {
    return empty;
  }
}
