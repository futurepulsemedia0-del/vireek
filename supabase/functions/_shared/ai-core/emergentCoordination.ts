// supabase/functions/_shared/ai-core/emergentCoordination.ts
//
// Emergent Coordination Mechanism
// --------------------------------------------------------------------
// Problem: Vireek's background agents (service-recovery-agent,
// followup-agent-dispatcher, membership-lifecycle-agent, marketing
// dispatchers, ...) each run on independent cron schedules and decide
// FOR THEMSELVES whether to contact a customer, with no visibility
// into what the others are doing. This is NOT a central dispatcher
// that hardcodes "recovery always beats marketing" — every agent
// keeps its own domain judgment. It only posts a bid, right before it
// would contact the customer, for the (target, action_category) slot.
// Arbitration (submit_coordination_bid() in
// supabase/migrations/20261203000000_emergent_agent_coordination.sql)
// happens the instant a bid lands, against whatever bids already
// exist for that slot — since agents never coordinate their bid
// timing, WHO wins emerges from arrival order + each agent's earned
// reputation, not a fixed priority table. Call
// recordCoordinationOutcome() once you know what happened, so future
// arbitration reflects which agents' contacts actually work.
//
// USAGE (right after your agent decides it WANTS to contact someone,
// right before it actually does):
//
//   const claim = await claimCoordinationSlot(admin, {
//     userId: enrollment.user_id,
//     agentSource: "followup-agent-dispatcher",
//     actionCategory: "customer_contact",
//     targetTable: "leads",
//     targetId: enrollment.lead_id,
//     baseScore: 40, // this agent's OWN urgency/value estimate, 0-100
//     contactChannel: channel,
//     reasoning: `${enrollment.campaign_type} step ${stepNumber}`,
//   });
//   if (claim.decision === "deferred") return; // another agent currently holds this slot
//   // ... actually send/call ...
//   await recordCoordinationOutcome(admin, claim.bidId, result.ok ? "success" : "failed");

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export type CoordinationDecision = "won" | "deferred";
export type CoordinationOutcome = "success" | "no_response" | "failed";

export interface ClaimCoordinationSlotParams {
  userId: string;
  agentSource: string;
  actionCategory: string;
  targetTable: string;
  targetId: string;
  /** This agent's own 0-100 urgency/value estimate — never a shared cross-agent scale. */
  baseScore: number;
  contactChannel?: string;
  reasoning?: string;
  windowMinutes?: number;
}

export interface CoordinationClaim {
  decision: CoordinationDecision;
  bidId: string;
  deferUntil?: string;
  incumbentAgent?: string;
}

/**
 * Posts this agent's bid and returns the arbitration result.
 *
 * Fails OPEN ("won") on a DB error: a missed coordination check just
 * risks a possible double-contact, which is a far better failure mode
 * than every calling agent silently stopping the moment the
 * coordination tables have a hiccup.
 */
export async function claimCoordinationSlot(
  admin: SupabaseClient,
  params: ClaimCoordinationSlotParams,
): Promise<CoordinationClaim> {
  const { data, error } = await admin.rpc("submit_coordination_bid", {
    p_user_id: params.userId,
    p_agent_source: params.agentSource,
    p_action_category: params.actionCategory,
    p_target_table: params.targetTable,
    p_target_id: params.targetId,
    p_base_score: params.baseScore,
    p_reasoning: params.reasoning ?? null,
    p_contact_channel: params.contactChannel ?? null,
    p_window_minutes: params.windowMinutes ?? 30,
  });

  if (error) {
    console.error(JSON.stringify({
      event: "coordination_bid_failed",
      agent_source: params.agentSource,
      target_table: params.targetTable,
      target_id: params.targetId,
      error: error.message,
    }));
    return { decision: "won", bidId: "" };
  }

  return {
    decision: data.decision as CoordinationDecision,
    bidId: data.bid_id as string,
    deferUntil: data.defer_until as string | undefined,
    incumbentAgent: data.incumbent_agent as string | undefined,
  };
}

/** Call once you know what happened, so reputation adapts. No-op if bidId is empty (the fail-open case above). */
export async function recordCoordinationOutcome(
  admin: SupabaseClient,
  bidId: string,
  outcome: CoordinationOutcome,
): Promise<void> {
  if (!bidId) return;
  const { error } = await admin.rpc("record_coordination_outcome", { p_bid_id: bidId, p_outcome: outcome });
  if (error) {
    console.error(JSON.stringify({ event: "coordination_outcome_failed", bid_id: bidId, error: error.message }));
  }
}
