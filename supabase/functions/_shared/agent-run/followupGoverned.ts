// supabase/functions/_shared/agent-run/followupGoverned.ts
//
// Bridge between followup-agent-dispatcher and the agent run runtime. The dispatcher keeps ALL of its
// own business logic (DNC, stop conditions, constitution, step selection, coordination bid,
// scheduleNext). Only the actual contact (SMS / call) moves behind the governed path:
//   runtime flag → one run per (enrollment, step) → runTool (governance, lease, breaker, budget, ledger)
//
// Outcome mapping preserves legacy semantics:
//   sent               → dispatcher continues exactly as before (scheduleNext), then calls completeFollowupRun
//   parked             → try again later; attempt_count NOT incremented (the ledger owns retry counting)
//   awaiting_approval  → try again later; nothing sent
//   failed             → same bookkeeping as the legacy failure branch (attempts → skip step after 3)
//   stopped            → enrollment is stopped with a reason (governance reject / needs human)

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { runTool, type RuntimeDeps } from "./executor.ts";
import { buildFollowupRegistry, FOLLOWUP_AGENT, FOLLOWUP_SCOPES, type FollowupToolDeps } from "./followupTools.ts";
import type { RunHandle } from "./store.ts";

export interface FollowupEnrollment {
  id: string;
  user_id: string;
  campaign_type: string;
  lead_id: string | null;
  job_id: string | null;
  customer_name: string;
  customer_phone: string | null;
}

export type GovernedFollowupOutcome =
  | { kind: "sent"; run: RunHandle; replayed: boolean }
  | { kind: "parked"; retryAt: Date; reason: string }
  | { kind: "awaiting_approval" }
  | { kind: "failed"; reason: string }
  | { kind: "stopped"; reason: string };

const DEFAULT_PARK_MS = 15 * 60_000;
const APPROVAL_PARK_MS = 60 * 60_000;

export async function runGovernedFollowup(p: {
  base: Omit<RuntimeDeps, "registry">;
  toolDeps: Omit<FollowupToolDeps, "admin"> & { admin: SupabaseClient };
  enrollment: FollowupEnrollment;
  channel: "sms" | "call";
  stepNumber: number;
  smsBody?: string;
}): Promise<GovernedFollowupOutcome> {
  const { enrollment: e, stepNumber } = p;
  const now = p.base.now ?? Date.now;
  const registry = buildFollowupRegistry(p.toolDeps);
  const deps: RuntimeDeps = { ...p.base, registry };
  const ref = `followup:${e.id}:${stepNumber}`;

  const run = await p.base.store.startRun({
    userId: e.user_id,
    agentSource: FOLLOWUP_AGENT,
    triggerRef: ref,
    correlationId: ref,
    plan: { campaign: e.campaign_type, channel: p.channel, step: stepNumber },
    scopes: FOLLOWUP_SCOPES,
    limits: { max_steps: 2, max_contacts: 1, max_cost_cents: 100 },
    deadlineSeconds: 48 * 3600,
  });

  // A closed run for this exact step: the contact already happened (or was definitively stopped).
  if (run.status === "succeeded") return { kind: "sent", run, replayed: true };
  if (run.status !== "running" && run.status !== "awaiting_approval") return { kind: "failed", reason: `run_${run.status}` };

  const args: Record<string, unknown> = {
    enrollmentId: e.id, stepNumber, campaignType: e.campaign_type, to: e.customer_phone ?? "",
    customerName: e.customer_name || "Customer",
  };
  if (e.lead_id) args.leadId = e.lead_id;
  if (e.job_id) args.jobId = e.job_id;
  if (p.channel === "sms") args.body = p.smsBody ?? "";

  const out = await runTool(deps, run, { tool: p.channel === "sms" ? "followup_send_sms" : "followup_place_call", rawArgs: args, stepIndex: 0 });

  switch (out.kind) {
    case "ok":
      return { kind: "sent", run, replayed: out.replayed };
    case "awaiting_approval":
      return { kind: "awaiting_approval" };
    case "retry_later":
      return { kind: "parked", retryAt: out.retryAt ?? new Date(now() + DEFAULT_PARK_MS), reason: out.reason };
    case "blocked":
      if (out.reason === "governance_rejected") {
        await p.base.store.finishRun(run.runId, run.userId, "cancelled", out.reason);
        return { kind: "stopped", reason: "blocked_by_governance" };
      }
      await p.base.store.finishRun(run.runId, run.userId, "failed", out.reason);
      return { kind: "failed", reason: out.reason };
    case "escalate":
      await p.base.escalate({
        run, stepIndex: 0, tool: p.channel === "sms" ? "followup_send_sms" : "followup_place_call",
        reason: out.reason, errorClass: out.errorClass, deadLetter: Boolean(out.deadLetter),
        context: { enrollment_id: e.id, campaign_type: e.campaign_type, step: stepNumber, channel: p.channel },
      });
      await p.base.store.finishRun(run.runId, run.userId, out.deadLetter ? "dead_letter" : "escalated", out.reason);
      return { kind: "stopped", reason: `needs_human: ${out.reason}`.slice(0, 200) };
  }
}

export const approvalParkMs = APPROVAL_PARK_MS;

/** Call after the dispatcher's scheduleNext succeeded, so a crash in between replays instead of resending. */
export async function completeFollowupRun(base: Pick<RuntimeDeps, "store">, run: RunHandle): Promise<void> {
  await base.store.finishRun(run.runId, run.userId, "succeeded");
}
