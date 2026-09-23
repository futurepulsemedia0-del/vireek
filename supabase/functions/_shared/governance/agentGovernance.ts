// supabase/functions/_shared/governance/agentGovernance.ts
//
// Single choke point for every autonomous agent action that should be
// governed: permission on/off, spending limits, human-in-the-loop
// approval, and an append-only audit trail with optional rollback.
// Mirrors the existing isAutomationEnabled() / sendCompliantSms()
// pattern in this codebase — call authorizeAgentAction() before doing
// anything customer-facing or costly, then ALWAYS call
// recordAgentActionOutcome() right after you act (success or failure).
//
// The decision logic itself lives in evaluate_agent_action() in
// supabase/migrations/20261121000000_ai_agent_governance.sql — kept in
// SQL so this gate and the dashboard's own RPCs can never disagree
// about what "approved" means.
//
// Typical use inside a cron-driven agent:
//
//   const auth = await authorizeAgentAction(admin, {
//     userId: run.user_id,
//     actionSlug: "workflow_sms",
//     agentSource: "workflow-engine-executor",
//     targetTable: "workflow_runs",
//     targetId: run.id,
//     reasoning: `Send step ${step.id} SMS to ${run.customer_phone}`,
//   });
//   if (auth.decision === "pending_approval" || auth.decision === "rejected") {
//     return { ok: false, terminal: false, error: `Awaiting/blocked: ${auth.decision}` };
//   }
//   const result = await sendCompliantSms(admin, run.user_id, run.customer_phone, body);
//   await recordAgentActionOutcome(admin, auth.logId, {
//     status: result.ok ? "executed" : "failed",
//     error: result.ok ? undefined : result.reason,
//   });

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export type AgentActionSlug =
  | "workflow_sms"
  | "workflow_call"
  | "outbound_dial"
  | "followup_dispatch"
  | "financing_offer"
  | "marketing_campaign_send"
  | "membership_lifecycle_action"
  | "business_decision_auto_action"
  | (string & {}); // extend agent_action_catalog with new slugs as new agents are wired in

export type AgentActionDecision = "auto_approved" | "approved" | "pending_approval" | "rejected";

export interface AuthorizeAgentActionParams {
  userId: string;
  actionSlug: AgentActionSlug;
  /** Edge function name, for display in the audit trail (e.g. "workflow-engine-executor"). */
  agentSource: string;
  /** Table + row this action targets — required for idempotency and for rollback. */
  targetTable?: string;
  targetId?: string;
  /** Only set this when the action has a real dollar cost (SMS/call spend, a financing offer, ...). */
  amountCents?: number;
  /** The agent's own plain-language reason — shown to the human reviewer. */
  reasoning?: string;
  payload?: Record<string, unknown>;
  /** Snapshot of the row BEFORE you mutate it, if this action is reversible. */
  beforeState?: Record<string, unknown> | null;
  /** Exact columns/values to restore on rollback — only the columns you're about to change. */
  rollbackPatch?: Record<string, unknown> | null;
  correlationId?: string;
}

export interface AgentActionAuthorization {
  decision: AgentActionDecision;
  logId: string;
  /** true when an earlier proposal for the same target was found instead of a fresh evaluation. */
  existing: boolean;
}

/**
 * Call this BEFORE taking any action an autonomous agent performs.
 *
 * - "auto_approved" or "approved" -> go ahead and execute now, then
 *   call recordAgentActionOutcome(logId, ...).
 * - "pending_approval" -> do NOT execute. A human needs to approve it
 *   from Dashboard -> Agent Governance first. Your next cron run will
 *   see the SAME target return "approved" (idempotent), so just return
 *   early this run and let the next scan pick it back up.
 * - "rejected" -> do NOT execute, and don't propose this exact target
 *   again — either a human said no, or the action type is disabled.
 *
 * Fails CLOSED: unlike the on/off automation gate elsewhere in this
 * codebase, a DB error here throws instead of defaulting to "allowed" —
 * an ungoverned autonomous action is the worse failure mode.
 */
export async function authorizeAgentAction(
  admin: SupabaseClient,
  params: AuthorizeAgentActionParams,
): Promise<AgentActionAuthorization> {
  const { data, error } = await admin.rpc("evaluate_agent_action", {
    p_user_id: params.userId,
    p_action_slug: params.actionSlug,
    p_agent_source: params.agentSource,
    p_target_table: params.targetTable ?? null,
    p_target_id: params.targetId ?? null,
    p_amount_cents: params.amountCents ?? null,
    p_reasoning: params.reasoning ?? null,
    p_payload: params.payload ?? {},
    p_before_state: params.beforeState ?? null,
    p_rollback_patch: params.rollbackPatch ?? null,
    p_correlation_id: params.correlationId ?? null,
  });

  if (error) {
    console.error(JSON.stringify({
      event: "agent_governance_eval_failed",
      user_id: params.userId,
      action_slug: params.actionSlug,
      error: error.message,
    }));
    throw new Error(`Agent governance check failed: ${error.message}`);
  }

  return { decision: data.decision, logId: data.log_id, existing: Boolean(data.existing) };
}

/** Call this immediately after executing (or failing to execute) an authorized action. */
export async function recordAgentActionOutcome(
  admin: SupabaseClient,
  logId: string,
  outcome: { status: "executed" | "failed"; error?: string; afterState?: Record<string, unknown> },
): Promise<void> {
  const { error } = await admin.rpc("record_agent_action_outcome", {
    p_log_id: logId,
    p_status: outcome.status,
    p_error: outcome.error ?? null,
    p_after_state: outcome.afterState ?? null,
  });
  if (error) {
    // Logged, not thrown — the real-world action already happened (or
    // failed) by this point; a bookkeeping write failure shouldn't crash
    // the agent's run or roll back work that's already done.
    console.error(JSON.stringify({ event: "agent_governance_outcome_failed", log_id: logId, error: error.message }));
  }
}
