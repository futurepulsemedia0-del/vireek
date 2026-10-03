// supabase/functions/_shared/governance/aiDecisionRecorder.ts
//
// AI Reliability & Governance Engine — edge-function side.
//
// Every edge function that makes a real AI decision records it here so it can be
// audited, evaluated and governed (see supabase/migrations/20270110000000_ai_reliability_governance_engine.sql).
//
// Two ways to use it:
//
//  1) GATE (before acting) — pre_execution, fails CLOSED like authorizeAgentAction():
//
//       const gate = await recordAiDecision(admin, {
//         userId, decisionType: "pricing", agentSource: "field-estimate",
//         title: "Quote for job 123", decision: "Quote $480", reasoning: "...",
//         confidencePct: 82, enforcement: "pre_execution",
//       });
//       if (gate.governanceAction !== "auto_approved") return; // wait for a human / blocked
//       ...act...
//       await markAiDecisionExecuted(admin, gate.recordId, { success: true });
//
//  2) LOG (after acting) — post_execution, fails OPEN (the real-world action already happened):
//
//       await recordAiDecision(admin, { ..., enforcement: "post_execution", executed: true });
//
// Later, when the real result is known, call recordAiDecisionOutcome().
// Agent Governance actions (agent_action_log) and dispatch outcomes (jobs) are bridged
// automatically by database triggers — you do NOT need to call this for those.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export type AiDecisionType =
  | "dispatch"
  | "pricing"
  | "estimate"
  | "diagnosis"
  | "triage"
  | "scheduling"
  | "followup"
  | "campaign"
  | "financing"
  | "communication"
  | "agent_action"
  | "other";

export type AiEngineKind = "llm" | "rules" | "hybrid" | "human";
export type AiEnforcement = "pre_execution" | "post_execution";
export type AiGovernanceAction = "auto_approved" | "review_required" | "blocked";
export type AiOutcome = "successful" | "partial" | "failed" | "no_effect";

export type AiErrorCategory =
  | "bad_data"
  | "wrong_reasoning"
  | "hallucination"
  | "policy_gap"
  | "stale_context"
  | "external_change"
  | "human_error"
  | "other";

export interface AiReasonFactor {
  factor: string;
  /** Relative weight of this factor (any consistent scale). */
  weight?: number;
  value?: string | number | boolean | null;
}

export interface AiDataSource {
  /** Table, API or document the decision read from. */
  source: string;
  /** Row id / reference. */
  ref?: string | null;
  fields?: string[];
}

export interface AiPolicyResult {
  policy: string;
  result: "pass" | "flag" | "block" | "skip";
  detail?: string | null;
}

export interface RecordAiDecisionParams {
  /** Account OWNER id (jobs/calls/etc. are always keyed by the owner). */
  userId: string;
  decisionType: AiDecisionType;
  /** Short label, max 200 chars. */
  title: string;
  /** What was decided. */
  decision: string;
  /** Why it was decided. */
  reasoning: string;
  /** Edge function / agent name. */
  agentSource: string;
  /** 0-100. Use toConfidencePct() to convert a 0-1 model score. Omit if the engine has none. */
  confidencePct?: number | null;
  reasonFactors?: AiReasonFactor[];
  dataUsed?: AiDataSource[];
  engineKind?: AiEngineKind;
  modelProvider?: string | null;
  modelName?: string | null;
  /** Prompt / ruleset version. */
  modelVersion?: string | null;
  subjectTable?: string | null;
  subjectId?: string | null;
  amountCents?: number | null;
  correlationId?: string | null;
  /** Default "pre_execution". */
  enforcement?: AiEnforcement;
  /** Extra policy results from other governance layers. */
  extraPolicies?: AiPolicyResult[];
  /** True if the action has already been carried out (post_execution logging). */
  executed?: boolean;
}

export interface RecordedAiDecision {
  /** null only when a post_execution write failed open. */
  recordId: string | null;
  governanceAction: AiGovernanceAction | "unrecorded";
  reviewStatus: "not_required" | "pending" | "approved" | "rejected" | "overridden" | "unrecorded";
  policies: AiPolicyResult[];
  /** true when the record could not be written and the caller was allowed to continue. */
  failedOpen: boolean;
}

/** Convert a model score to the 0-100 scale the engine stores. Returns null for missing/invalid input. */
export function toConfidencePct(value: number | null | undefined, scale: "fraction" | "percent" = "fraction"): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const pct = scale === "fraction" ? value * 100 : value;
  return Math.min(100, Math.max(0, Math.round(pct * 100) / 100));
}

/**
 * Record one AI decision and get the governance verdict.
 *
 * pre_execution (default): throws if the record cannot be written — an ungoverned autonomous
 * action is the worse failure mode. Pass { failOpen: true } to opt out.
 * post_execution: never throws; logs and returns failedOpen = true.
 */
export async function recordAiDecision(
  admin: SupabaseClient,
  params: RecordAiDecisionParams,
  options: { failOpen?: boolean } = {},
): Promise<RecordedAiDecision> {
  const enforcement: AiEnforcement = params.enforcement ?? "pre_execution";
  const failOpen = options.failOpen ?? enforcement === "post_execution";

  const { data, error } = await admin.rpc("record_ai_decision", {
    p_user_id: params.userId,
    p_decision_type: params.decisionType,
    p_title: params.title,
    p_decision: params.decision,
    p_reasoning: params.reasoning,
    p_agent_source: params.agentSource,
    p_confidence: params.confidencePct ?? null,
    p_reason_factors: params.reasonFactors ?? [],
    p_data_used: params.dataUsed ?? [],
    p_engine_kind: params.engineKind ?? "llm",
    p_model_provider: params.modelProvider ?? null,
    p_model_name: params.modelName ?? null,
    p_model_version: params.modelVersion ?? null,
    p_subject_table: params.subjectTable ?? null,
    p_subject_id: params.subjectId ?? null,
    p_amount_cents: params.amountCents === null || params.amountCents === undefined ? null : Math.round(params.amountCents),
    p_correlation_id: params.correlationId ?? null,
    p_enforcement: enforcement,
    p_extra_policies: params.extraPolicies ?? [],
    p_executed: params.executed ?? false,
  });

  if (error || !data) {
    console.error(JSON.stringify({
      event: "ai_governance_record_failed",
      agent_source: params.agentSource,
      decision_type: params.decisionType,
      enforcement,
      error: error?.message ?? "empty response",
    }));
    if (!failOpen) throw new Error(`AI governance record failed: ${error?.message ?? "empty response"}`);
    return { recordId: null, governanceAction: "unrecorded", reviewStatus: "unrecorded", policies: [], failedOpen: true };
  }

  const row = data as {
    record_id: string;
    governance_action: AiGovernanceAction;
    review_status: RecordedAiDecision["reviewStatus"];
    policies?: AiPolicyResult[];
  };

  return {
    recordId: row.record_id,
    governanceAction: row.governance_action,
    reviewStatus: row.review_status,
    policies: row.policies ?? [],
    failedOpen: false,
  };
}

/** Call right after you carry out (or fail to carry out) a gated decision. Never throws. */
export async function markAiDecisionExecuted(
  admin: SupabaseClient,
  recordId: string | null,
  result: { success: boolean; error?: string },
): Promise<void> {
  if (!recordId) return;
  const { error } = await admin.rpc("mark_ai_decision_executed", {
    p_record_id: recordId,
    p_success: result.success,
    p_error: result.error ?? null,
  });
  if (error) {
    console.error(JSON.stringify({ event: "ai_governance_mark_executed_failed", record_id: recordId, error: error.message }));
  }
}

/**
 * Report the real-world result of a decision once it is known (hours or days later).
 * Set aiWasWrong + errorCategory when the AI's decision itself was the cause of a bad outcome.
 * Leave aiWasWrong undefined for a failure whose cause is not yet attributed. Never throws.
 */
export async function recordAiDecisionOutcome(
  admin: SupabaseClient,
  recordId: string | null,
  outcome: {
    result: AiOutcome;
    financialImpactCents?: number;
    aiWasWrong?: boolean;
    errorCategory?: AiErrorCategory;
    errorExplanation?: string;
    notes?: string;
  },
): Promise<void> {
  if (!recordId) return;
  const { error } = await admin.rpc("record_ai_decision_outcome", {
    p_record_id: recordId,
    p_outcome: outcome.result,
    p_financial_impact_cents: outcome.financialImpactCents === undefined ? null : Math.round(outcome.financialImpactCents),
    p_ai_was_wrong: outcome.aiWasWrong ?? null,
    p_error_category: outcome.errorCategory ?? null,
    p_error_explanation: outcome.errorExplanation ?? null,
    p_notes: outcome.notes ?? null,
  });
  if (error) {
    console.error(JSON.stringify({ event: "ai_governance_outcome_failed", record_id: recordId, error: error.message }));
  }
}

// ---------------------------------------------------------------------------
// Dispatch evidence — explainable match-quality score for an assignment that
// assign_technician_to_job() already made. Transparent by design:
//   55  compliance-checked assignment (the RPC only assigns qualified technicians)
//  +25  the technician's skills include the job's service type
//  +20  x remaining capacity that day (0..1)
// It is a RULES score, not a probability. The Reliability dashboard's calibration
// chart shows whether it actually predicts good outcomes.
// ---------------------------------------------------------------------------

export interface DispatchJobInput {
  id: string;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
}

export interface DispatchEvidence {
  confidencePct: number | null;
  reasonFactors: AiReasonFactor[];
  dataUsed: AiDataSource[];
}

export async function buildDispatchEvidence(
  admin: SupabaseClient,
  userId: string,
  job: DispatchJobInput,
  technicianId: string,
): Promise<DispatchEvidence> {
  const dataUsed: AiDataSource[] = [
    { source: "jobs", ref: job.id, fields: ["service_type", "address", "scheduled_datetime"] },
    { source: "team_members", ref: technicianId, fields: ["skills", "service_area", "max_jobs_per_day"] },
  ];

  try {
    const { data: tech, error } = await admin
      .from("team_members")
      .select("id, skills, max_jobs_per_day")
      .eq("id", technicianId)
      .eq("account_owner_id", userId)
      .maybeSingle();
    if (error || !tech) return { confidencePct: null, reasonFactors: [], dataUsed };

    const skills: string[] = Array.isArray(tech.skills) ? tech.skills : [];
    const skillMatch = Boolean(job.service_type) && skills.includes(job.service_type as string);

    const capacity = typeof tech.max_jobs_per_day === "number" && tech.max_jobs_per_day > 0 ? tech.max_jobs_per_day : null;
    let load: number | null = null;
    if (job.scheduled_datetime && capacity !== null) {
      const d = new Date(job.scheduled_datetime);
      if (!Number.isNaN(d.getTime())) {
        const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
        const { count } = await admin
          .from("jobs")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("assigned_technician_id", technicianId)
          .in("job_status", ["scheduled", "en_route", "in_progress"])
          .gte("scheduled_datetime", dayStart.toISOString())
          .lt("scheduled_datetime", dayEnd.toISOString());
        load = count ?? null;
      }
    }

    const headroom = capacity !== null && load !== null ? Math.min(1, Math.max(0, (capacity - load) / capacity)) : 0.5;
    const confidencePct = Math.min(100, 55 + (skillMatch ? 25 : 0) + Math.round(20 * headroom));

    return {
      confidencePct,
      reasonFactors: [
        { factor: "compliance_checked_assignment", weight: 55, value: "Passed the credential / compliance gate" },
        { factor: "skill_match", weight: 25, value: skillMatch },
        {
          factor: "capacity_headroom",
          weight: 20,
          value: capacity !== null && load !== null ? `${load} of ${capacity} jobs that day` : "capacity unknown",
        },
      ],
      dataUsed,
    };
  } catch (e) {
    console.error(JSON.stringify({ event: "ai_governance_dispatch_evidence_failed", error: e instanceof Error ? e.message : String(e) }));
    return { confidencePct: null, reasonFactors: [], dataUsed };
  }
}
