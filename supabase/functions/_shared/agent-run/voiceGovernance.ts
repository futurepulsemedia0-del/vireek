// supabase/functions/_shared/agent-run/voiceGovernance.ts
//
// Governance for the live voice agent's side-effecting tools (vapi-webhook). A caller is on the phone, so
// the contract differs from background agents:
//   * Default policy for these slugs is auto-approved (migration 20281116000000) → the call proceeds exactly
//     as before, but every attempt is now an audit row in agent_action_log. Tenants can tighten policy per slug.
//   * "pending_approval"/"rejected" cannot wait on a human mid-call: the model gets a spoken fallback
//     (offer a human transfer / office follow-up) and the row stays for the owner.
//   * Latency budget: one RPC with a hard timeout (default 1500 ms).
//   * Infrastructure failure: money fails CLOSED, booking/reschedule fail OPEN (logged), transfer is log-only
//     and never blocked (a caller asking for a human must always reach one).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { authorizeAgentAction, recordAgentActionOutcome } from "../governance/agentGovernance.ts";

export type FailMode = "open" | "closed" | "log_only";

export const VOICE_TOOL_GOVERNANCE: Readonly<Record<string, { slug: string; failMode: FailMode }>> = {
  book_appointment: { slug: "voice_book_appointment", failMode: "open" },
  reschedule_appointment: { slug: "voice_reschedule", failMode: "open" },
  collect_card_payment: { slug: "voice_collect_payment", failMode: "closed" },
  request_human_transfer: { slug: "voice_transfer_call", failMode: "log_only" },
};

export type VoiceGovernanceResult =
  | { allow: true; logId: string | null }
  | { allow: false; spoken: string };

const SPOKEN_NEEDS_OFFICE =
  "I can't complete that on my own right now — the office needs to confirm it first. Tell the caller the team will follow up shortly, and offer to transfer them to a team member.";
const SPOKEN_UNAVAILABLE_MONEY =
  "Payments aren't available on this call right now. Tell the caller the office will follow up about payment, and offer to transfer them to a team member.";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error("governance_timeout")), ms); }),
  ]).finally(() => clearTimeout(t));
}

export async function governVoiceTool(
  admin: SupabaseClient,
  p: { tool: string; tenantId: string; vapiCallId?: string | null; correlationId?: string; timeoutMs?: number; log?: (e: string, f: Record<string, unknown>) => void },
): Promise<VoiceGovernanceResult> {
  const cfg = VOICE_TOOL_GOVERNANCE[p.tool];
  if (!cfg) return { allow: true, logId: null };
  const log = p.log ?? ((e, f) => console.log(JSON.stringify({ event: e, ...f })));
  try {
    const auth = await withTimeout(
      authorizeAgentAction(admin, {
        userId: p.tenantId,
        actionSlug: cfg.slug,
        agentSource: "vapi-webhook",
        targetTable: p.vapiCallId ? "vapi_call" : undefined,
        targetId: p.vapiCallId ?? undefined,
        reasoning: `Voice agent tool ${p.tool}`,
        payload: { tool: p.tool },
        correlationId: p.correlationId,
      }),
      p.timeoutMs ?? 1500,
    );
    if (cfg.failMode === "log_only") return { allow: true, logId: auth.logId };
    if (auth.decision === "auto_approved" || auth.decision === "approved") return { allow: true, logId: auth.logId };
    return { allow: false, spoken: SPOKEN_NEEDS_OFFICE };
  } catch (e) {
    log("voice_governance_unavailable", { tool: p.tool, fail_mode: cfg.failMode, error: e instanceof Error ? e.message : String(e) });
    if (cfg.failMode === "closed") return { allow: false, spoken: SPOKEN_UNAVAILABLE_MONEY };
    return { allow: true, logId: null };
  }
}

/** Fire-and-forget bookkeeping after the tool ran. Never throws. */
export async function recordVoiceToolOutcome(admin: SupabaseClient, logId: string, ok: boolean): Promise<void> {
  try {
    await recordAgentActionOutcome(admin, logId, ok ? { status: "executed" } : { status: "failed", error: "tool_not_ok" });
  } catch { /* recordAgentActionOutcome already logs; the call must not be affected */ }
}
