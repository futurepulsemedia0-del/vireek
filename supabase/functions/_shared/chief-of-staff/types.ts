// supabase/functions/_shared/chief-of-staff/types.ts
//
// Shared contract for the Chief of Staff layer. Pure types + constants: no I/O, no Deno globals,
// so every rule is unit-testable under vitest.

export type RecKind = "capacity_gap" | "leak" | "risk" | "opportunity";
export type RecDomain = "capacity" | "marketing" | "finance" | "customer" | "operations" | "compliance";
export type OwnerRole = "owner" | "manager" | "dispatcher" | "csr" | "any";
export type ActionKind = "navigate" | "operator_command" | "none";
export type SourceEngine =
  | "next-best-actions"
  | "business-decision-engine"
  | "opportunity-cost-scan"
  | "capacity-demand-control"
  | "goal-pace"
  | "agent-governance";

/** Tags used ONLY for deterministic conflict detection. */
export type Effect = "increases_demand" | "uses_capacity" | "reduces_margin" | "contacts_customer" | "spends_cash";

export interface Evidence {
  /** Table / RPC the number came from. */
  source_table: string;
  /** Row id or a short query label that lets a human find the data again. */
  ref: string;
  metric: string;
  value: string;
  as_of?: string;
}

export interface CosCandidate {
  dedupe_key: string;
  kind: RecKind;
  domain: RecDomain;
  title: string;
  why_it_matters: string;
  evidence: Evidence[];
  impact_low_cents: number | null;
  impact_high_cents: number | null;
  impact_basis: string | null;
  confidence: number | null;
  confidence_basis: string | null;
  owner_role: OwnerRole;
  action_kind: ActionKind;
  action_label: string | null;
  action_href: string | null;
  action_command: string | null;
  works_with: string[];
  effects: Effect[];
  subject_key: string | null;
  priority_score: number;
  source_engine: SourceEngine;
  source_ref: string | null;
  /** Filled by arbitration. */
  status?: "open" | "suppressed";
  suppressed_reason?: string | null;
}

export const LIMITS = {
  maxCandidates: 100,
  maxTop: 5,
  maxEvidenceValueChars: 300,
  maxTitleChars: 200,
  maxWhyChars: 1200,
  maxGoalInputChars: 20_000,
  maxClarifyingQuestions: 2,
  /** A goal counts as "behind pace" below this fraction of the expected-to-date value. */
  behindPaceFactor: 0.9,
  minCallsForAnswerRate: 10,
  minJobsForMargin: 5,
  claimTtlMinutes: 10,
} as const;

export type GoalMetric = "revenue" | "booked_jobs" | "answer_rate" | "gross_margin";
export type GoalUnit = "usd" | "count" | "pct";
export const GOAL_METRICS: readonly GoalMetric[] = ["revenue", "booked_jobs", "answer_rate", "gross_margin"];
export const METRIC_UNIT: Record<GoalMetric, GoalUnit> = {
  revenue: "usd",
  booked_jobs: "count",
  answer_rate: "pct",
  gross_margin: "pct",
};
