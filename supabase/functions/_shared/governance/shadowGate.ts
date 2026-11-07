// supabase/functions/_shared/governance/shadowGate.ts
// Rollout wrapper around authorizeAgentAction: SHADOW first, enforce per action class.
//   GOVERNANCE_ENFORCE=""                       -> shadow for everything (default)
//   GOVERNANCE_ENFORCE="outbound_dial,followup_dispatch" -> enforce those slugs only
//   GOVERNANCE_ENFORCE="all"                    -> enforce everything
// Shadow: the decision is computed and audited, a would-block is LOGGED, the caller proceeds.
// Enforce: pending_approval / rejected / gate error => allow=false (fail closed).
import { authorizeAgentAction, type AuthorizeAgentActionParams } from "./agentGovernance.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export function isEnforced(slug: string): boolean {
  const v = (Deno.env.get("GOVERNANCE_ENFORCE") ?? "").trim();
  if (!v) return false;
  if (v === "all") return true;
  return v.split(",").map((s) => s.trim()).includes(slug);
}

export interface GateResult {
  allow: boolean;
  enforced: boolean;
  decision?: string;
  logId?: string;
  wouldBlock?: string;
}

export async function governedGate(
  admin: SupabaseClient,
  params: AuthorizeAgentActionParams,
  authorize: typeof authorizeAgentAction = authorizeAgentAction,
): Promise<GateResult> {
  const enforced = isEnforced(String(params.actionSlug));
  const note = (reason: string) => console.warn(JSON.stringify({
    event: enforced ? "governance_blocked" : "governance_would_block",
    action_slug: params.actionSlug, agent_source: params.agentSource, reason,
  }));
  try {
    const a = await authorize(admin, params);
    if (a.decision === "pending_approval" || a.decision === "rejected") {
      note(a.decision);
      return { allow: !enforced, enforced, decision: a.decision, logId: a.logId, wouldBlock: a.decision };
    }
    return { allow: true, enforced, decision: a.decision, logId: a.logId };
  } catch (err) {
    note("gate_error");
    console.error(JSON.stringify({ event: "governance_gate_error", error: err instanceof Error ? err.message : String(err) }));
    return { allow: !enforced, enforced, wouldBlock: "gate_error" };
  }
}
