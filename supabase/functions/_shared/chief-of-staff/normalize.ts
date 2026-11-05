// supabase/functions/_shared/chief-of-staff/normalize.ts
//
// Maps rows that existing engines ALREADY produced into CosCandidates. Nothing is recomputed or invented:
// every number comes from the source row, every candidate cites that row, and anything the source does not
// provide (confidence, impact) stays null.

import type { Actual, GoalProgress } from "./progress.ts";
import {
  LIMITS, type CosCandidate, type Effect, type Evidence, type GoalMetric, type OwnerRole, type RecDomain, type RecKind,
} from "./types.ts";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clampPriority = (n: unknown, fallback = 50) => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(100, Math.max(0, v));
};
const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const safeHref = (h: unknown, fallback: string): string =>
  typeof h === "string" && /^\/dashboard(\/[A-Za-z0-9_\-./?=&%#]*)?$/.test(h) && h.length <= 300 ? h : fallback;

/** "$1,250" / "$1,250 at risk" -> 125000. Returns null if there is no dollar figure. */
export function parseUsdLabelToCents(label: string | null | undefined): number | null {
  if (!label) return null;
  const m = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(label);
  if (!m) return null;
  const dollars = Number((m[1] ?? "0").replace(/,/g, ""));
  const cents = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
  const total = dollars * 100 + cents;
  return Number.isSafeInteger(total) ? total : null;
}

const ROUTES = {
  nba: "/dashboard/next-best-actions",
  opportunity: "/dashboard/opportunity-cost",
  capacity: "/dashboard/capacity-demand",
  governance: "/dashboard/agent-governance",
  calls: "/dashboard/calls",
  jobs: "/dashboard/jobs",
  profitability: "/dashboard/profitability",
  goals: "/dashboard/goals",
  decisionEngine: "/dashboard/decision-engine",
} as const;

// ---------------------------------------------------------------------------
// next-best-actions
// ---------------------------------------------------------------------------

export interface NbaRow {
  id: string; category: string; title: string; reasoning: string; recommended_action: string;
  priority_score: number; amount_label: string | null; entity_type: string | null; entity_id: string | null;
  entity_label: string | null; cta_href: string | null; action_date: string;
}

const NBA_MAP: Record<string, { kind: RecKind; domain: RecDomain; owner: OwnerRole; effects: Effect[] }> = {
  estimate_risk: { kind: "leak", domain: "customer", owner: "csr", effects: ["contacts_customer"] },
  invoice_risk: { kind: "leak", domain: "finance", owner: "owner", effects: ["contacts_customer"] },
  churn_risk: { kind: "risk", domain: "customer", owner: "csr", effects: ["contacts_customer"] },
  capacity_gap: { kind: "capacity_gap", domain: "capacity", owner: "dispatcher", effects: [] },
};

export function fromNextBestAction(r: NbaRow): CosCandidate | null {
  const map = NBA_MAP[r.category];
  if (!map) return null;
  const amount = parseUsdLabelToCents(r.amount_label);
  const evidence: Evidence[] = [
    { source_table: "next_best_actions", ref: r.id, metric: "engine_reasoning", value: clip(r.reasoning, LIMITS.maxEvidenceValueChars), as_of: r.action_date },
  ];
  if (r.entity_type && r.entity_id) {
    // entity_type is a logical type ("quote", "invoice", "customer"), not always a table name.
    evidence.push({ source_table: "next_best_actions.entity", ref: `${r.entity_type}:${r.entity_id}`, metric: "subject", value: clip(r.entity_label ?? r.entity_id, 120), as_of: r.action_date });
  }
  const atRisk = map.kind === "leak" || map.kind === "risk";
  return {
    dedupe_key: `nba:${r.id}`, kind: map.kind, domain: map.domain,
    title: clip(r.title, LIMITS.maxTitleChars),
    why_it_matters: clip(r.reasoning, LIMITS.maxWhyChars),
    evidence,
    // Upper bound only: the engine reports an amount AT RISK, not an expected recovery.
    impact_low_cents: amount !== null && atRisk ? 0 : amount,
    impact_high_cents: amount,
    impact_basis: amount === null ? null : atRisk
      ? `Upper bound = amount at risk reported by next-best-actions (${r.amount_label}). Actual recovery depends on follow-up.`
      : `Value reported by next-best-actions (${r.amount_label}).`,
    confidence: null,
    confidence_basis: "next-best-actions ranks by priority and does not score confidence.",
    owner_role: map.owner, action_kind: "navigate", action_label: null,
    action_href: safeHref(r.cta_href, ROUTES.nba),
    action_command: null, works_with: [], effects: map.effects,
    subject_key: r.entity_type && r.entity_id ? `${r.entity_type}:${r.entity_id}` : null,
    priority_score: clampPriority(r.priority_score),
    source_engine: "next-best-actions", source_ref: r.id,
  };
}

// ---------------------------------------------------------------------------
// opportunity-cost-scan
// ---------------------------------------------------------------------------

export interface OppCostRow {
  id: string; entry_type: string; source_table: string; source_id: string; occurred_on: string;
  estimated_cost_cents: number; headline: string; ai_narrative: string | null; ai_recommended_action: string | null;
  priority_score: number | null;
}

const OPP_MAP: Record<string, { kind: RecKind; domain: RecDomain; owner: OwnerRole; effects: Effect[] }> = {
  idle_capacity: { kind: "capacity_gap", domain: "capacity", owner: "dispatcher", effects: [] },
  quote_stalled_followup: { kind: "leak", domain: "customer", owner: "csr", effects: ["contacts_customer"] },
  technician_low_margin_time: { kind: "leak", domain: "operations", owner: "manager", effects: [] },
};

export function fromOpportunityCost(r: OppCostRow): CosCandidate | null {
  const map = OPP_MAP[r.entry_type];
  if (!map) return null;
  const cents = Number.isSafeInteger(r.estimated_cost_cents) && r.estimated_cost_cents >= 0 ? r.estimated_cost_cents : null;
  return {
    dedupe_key: `occ:${r.id}`, kind: map.kind, domain: map.domain,
    title: clip(r.headline, LIMITS.maxTitleChars),
    why_it_matters: clip(r.ai_narrative ?? r.ai_recommended_action ?? r.headline, LIMITS.maxWhyChars),
    evidence: [{ source_table: r.source_table, ref: r.source_id, metric: r.entry_type,
      value: cents === null ? "n/a" : `${usd(cents)} estimated cost of inaction`, as_of: r.occurred_on }],
    impact_low_cents: cents, impact_high_cents: cents,
    impact_basis: cents === null ? null : "Point estimate stored by opportunity-cost-scan; no range is available.",
    confidence: null, confidence_basis: "opportunity-cost-scan does not score confidence.",
    owner_role: map.owner, action_kind: "navigate", action_label: null, action_href: ROUTES.opportunity,
    action_command: null, works_with: [], effects: map.effects,
    subject_key: map.effects.includes("contacts_customer") ? `${r.source_table}:${r.source_id}` : null,
    priority_score: clampPriority(r.priority_score), source_engine: "opportunity-cost-scan", source_ref: r.id,
  };
}

// ---------------------------------------------------------------------------
// business-decision-engine
// ---------------------------------------------------------------------------

export interface DecisionRow {
  id: string; category: string; title: string; reasoning: string; recommended_action: string;
  confidence_score: number | string; estimated_impact: number | string | null; metric_snapshot: Record<string, unknown> | null;
  created_at: string;
}

const BDE_MAP: Record<string, { kind: RecKind; domain: RecDomain; owner: OwnerRole; effects: Effect[] }> = {
  pricing: { kind: "opportunity", domain: "finance", owner: "owner", effects: [] },
  dispatch: { kind: "risk", domain: "operations", owner: "dispatcher", effects: [] },
  staffing: { kind: "capacity_gap", domain: "capacity", owner: "manager", effects: ["uses_capacity"] },
  marketing: { kind: "opportunity", domain: "marketing", owner: "owner", effects: ["increases_demand", "spends_cash"] },
  collections: { kind: "leak", domain: "finance", owner: "owner", effects: ["contacts_customer"] },
  retention: { kind: "risk", domain: "customer", owner: "csr", effects: ["contacts_customer"] },
  operations: { kind: "risk", domain: "operations", owner: "manager", effects: [] },
};

export function fromBusinessDecision(r: DecisionRow): CosCandidate | null {
  const map = BDE_MAP[r.category];
  if (!map) return null;
  const conf = Number(r.confidence_score);
  const impactDollars = r.estimated_impact === null ? null : Number(r.estimated_impact);
  const impactCents = impactDollars !== null && Number.isFinite(impactDollars) && impactDollars >= 0 ? Math.round(impactDollars * 100) : null;
  const evidence: Evidence[] = Object.entries(r.metric_snapshot ?? {})
    .filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")
    .slice(0, 8)
    .map(([k, v]) => ({ source_table: "business_decisions", ref: r.id, metric: clip(k, 60), value: clip(String(v), 120), as_of: r.created_at.slice(0, 10) }));
  if (evidence.length === 0) {
    evidence.push({ source_table: "business_decisions", ref: r.id, metric: "engine_reasoning", value: clip(r.reasoning, LIMITS.maxEvidenceValueChars), as_of: r.created_at.slice(0, 10) });
  }
  // Priority: the engine's own confidence (0-100); this engine has no separate priority score.
  return {
    dedupe_key: `bde:${r.id}`, kind: map.kind, domain: map.domain,
    title: clip(r.title, LIMITS.maxTitleChars), why_it_matters: clip(r.reasoning, LIMITS.maxWhyChars), evidence,
    impact_low_cents: impactCents, impact_high_cents: impactCents,
    impact_basis: impactCents === null ? null : "Point estimate stored by business-decision-engine; no range is available.",
    confidence: Number.isFinite(conf) ? Math.min(100, Math.max(0, Math.round(conf))) : null,
    confidence_basis: "Confidence score stored by business-decision-engine.",
    owner_role: map.owner, action_kind: "navigate", action_label: null,
    action_href: ROUTES.decisionEngine,
    action_command: null, works_with: [], effects: map.effects,
    subject_key: null, priority_score: clampPriority(Number.isFinite(conf) ? conf : 50),
    source_engine: "business-decision-engine", source_ref: r.id,
  };
}

// ---------------------------------------------------------------------------
// capacity (get_capacity_status RPC)
// ---------------------------------------------------------------------------

export interface CapacityDay { date: string; status: string; day_load: number; day_capacity: number; load_pct: number | null }

export function fromCapacityDay(d: CapacityDay): CosCandidate | null {
  if (d.status !== "full") return null;
  return {
    dedupe_key: `cap:full:${d.date}`, kind: "capacity_gap", domain: "capacity",
    title: `Capacity is full on ${d.date}`,
    why_it_matters: `${d.day_load} of ${d.day_capacity} job slots are booked (${d.load_pct ?? "n/a"}%). New demand will wait or be turned away; do not add marketing or promotions for this day.`,
    evidence: [
      { source_table: "get_capacity_status", ref: d.date, metric: "day_load", value: String(d.day_load), as_of: d.date },
      { source_table: "get_capacity_status", ref: d.date, metric: "day_capacity", value: String(d.day_capacity), as_of: d.date },
    ],
    impact_low_cents: null, impact_high_cents: null, impact_basis: null,
    confidence: null, confidence_basis: "Measured directly from scheduled jobs and technician capacity.",
    owner_role: "dispatcher", action_kind: "navigate", action_label: null, action_href: ROUTES.capacity,
    action_command: null, works_with: [], effects: [], subject_key: null, priority_score: 80,
    source_engine: "capacity-demand-control", source_ref: d.date,
  };
}

// ---------------------------------------------------------------------------
// goal pace
// ---------------------------------------------------------------------------

const GOAL_META: Record<GoalMetric, { domain: RecDomain; owner: OwnerRole; href: string; table: string }> = {
  revenue: { domain: "finance", owner: "owner", href: ROUTES.jobs, table: "jobs" },
  booked_jobs: { domain: "operations", owner: "manager", href: ROUTES.jobs, table: "jobs" },
  answer_rate: { domain: "customer", owner: "csr", href: ROUTES.calls, table: "calls" },
  gross_margin: { domain: "finance", owner: "owner", href: ROUTES.profitability, table: "job_cost_entries" },
};

const fmtGoal = (metric: GoalMetric, v: number) =>
  metric === "revenue" ? `$${Math.round(v).toLocaleString("en-US")}` : metric === "booked_jobs" ? String(Math.round(v)) : `${v}%`;

export function fromGoalProgress(
  targetId: string, p: GoalProgress, periodStart: string, periodEnd: string, today: string,
): CosCandidate | null {
  if (p.status !== "behind" || p.actual === null) return null;
  const meta = GOAL_META[p.metric];
  let low: number | null = null;
  let high: number | null = null;
  let basis: string | null = null;
  if (p.metric === "revenue" && p.expectedToDate !== null) {
    low = Math.max(0, Math.round((p.expectedToDate - p.actual) * 100));
    high = Math.max(low, Math.round((p.target - p.actual) * 100));
    basis = "Low = shortfall versus pace to date; high = remaining gap to the full target (both computed from your goal and completed-job revenue).";
  }
  return {
    dedupe_key: `goal:${targetId}:${p.status}`, kind: "risk", domain: meta.domain,
    title: `Behind on your ${p.metric.replace("_", " ")} goal`,
    why_it_matters: `${fmtGoal(p.metric, p.actual)} so far against a goal of ${fmtGoal(p.metric, p.target)} for ${periodStart} to ${periodEnd}.`,
    evidence: [
      { source_table: "cos_goal_targets", ref: targetId, metric: "target", value: fmtGoal(p.metric, p.target), as_of: today },
      { source_table: meta.table, ref: `${periodStart}..${periodEnd}`, metric: "actual", value: `${fmtGoal(p.metric, p.actual)} (${p.basis})`, as_of: today },
    ],
    impact_low_cents: low, impact_high_cents: high, impact_basis: basis,
    confidence: null, confidence_basis: "Measured from your own records; no forecast model involved.",
    owner_role: meta.owner, action_kind: "navigate", action_label: null, action_href: meta.href,
    action_command: null, works_with: [], effects: [], subject_key: null, priority_score: 70,
    source_engine: "goal-pace", source_ref: targetId,
  };
}

// ---------------------------------------------------------------------------
// agent_action_log items waiting for approval (so the brain can see what agents are about to do)
// ---------------------------------------------------------------------------

export interface PendingActionRow {
  id: string; action_slug: string; agent_source: string; amount_cents: number | null; reasoning: string | null; created_at: string;
  category: string; label: string;
}

export function fromPendingAgentAction(r: PendingActionRow): CosCandidate | null {
  if (r.category !== "marketing") return null; // the only category with a demand effect today
  return {
    dedupe_key: `gov:${r.id}`, kind: "opportunity", domain: "marketing",
    title: `Awaiting your approval: ${clip(r.label, 120)}`,
    why_it_matters: clip(r.reasoning ?? `${r.agent_source} wants to run "${r.label}".`, LIMITS.maxWhyChars),
    evidence: [{ source_table: "agent_action_log", ref: r.id, metric: "pending_approval", value: r.amount_cents === null ? r.action_slug : `${r.action_slug}, ${usd(r.amount_cents)}`, as_of: r.created_at.slice(0, 10) }],
    impact_low_cents: null, impact_high_cents: null, impact_basis: null,
    confidence: null, confidence_basis: null,
    owner_role: "owner", action_kind: "navigate", action_label: null, action_href: ROUTES.governance,
    action_command: null, works_with: [], effects: ["increases_demand", "spends_cash"], subject_key: null, priority_score: 55,
    source_engine: "agent-governance", source_ref: r.id,
  };
}

export type { Actual };
