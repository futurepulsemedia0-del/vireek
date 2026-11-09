// supabase/functions/_shared/agent-run/governedSms.ts
//
// Drop-in governed replacement for a single `sendCompliantSms(...)` call in an autonomous (cron/agent)
// function. One call site changes; the function keeps its own selection logic, its own "already sent"
// marker and its own error handling. What the runtime adds, only for tenants whose flag is ON:
//   governance (authorizeAgentAction) · cross-agent lease on the customer's phone · circuit breaker ·
//   budget · idempotent ledger (a crash between "SMS sent" and the caller's own marker update can no longer
//   re-send on the next tick: the closed run replays) · deterministic crash reconciliation via Twilio lookup.
// Flag OFF (default) / kill switch / any flag error → `legacy()` runs, i.e. byte-for-byte old behavior.
//
// Result shape is structurally compatible with SendSmsResult for callers that only read ok / reason.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { ToolError } from "./core.ts";
import { runTool, type RuntimeDeps } from "./executor.ts";
import { mapSmsFailure } from "./followupTools.ts";
import { isAgentRuntimeEnabled } from "./runtimeFlags.ts";
import { ToolRegistry, type ToolDef } from "./toolRegistry.ts";
import { normalizePhoneE164, type SmsLookup } from "./twilioLookup.ts";

export const GENERIC_SMS_SLUG = "agent_send_sms";

export type GovernedSmsResult =
  | { ok: true; sid?: string; deferred?: boolean; governed: boolean }
  | { ok: false; reason: string; detail?: string; governed: boolean; /** nothing was sent; the caller should simply retry on its next tick */ retryLater?: boolean };

type RawSend = { ok: true; sid?: string; deferred?: boolean } | { ok: false; reason: string; detail?: string };

export interface GovernedSmsParams {
  base: Omit<RuntimeDeps, "registry">;
  admin: SupabaseClient;
  userId: string;
  /** stable agent id, also the runtime-flag key and governance agent_source */
  agentSource: string;
  /** unique per business event ("no-show:<jobId>:<token>"); a repeat resumes/replays the same run */
  triggerRef: string;
  to: string;
  body: string;
  entity: { table: "jobs" | "invoices" | "customers" | "leads"; id: string };
  sendSms: (admin: SupabaseClient, userId: string, to: string, body: string, opts: { dedupeKey: string } & Record<string, unknown>) => Promise<RawSend>;
  /** Extra options the legacy call passed (purpose, customerId, source, skipQuietHours…). Set by CODE, never by the model. */
  sendOpts?: Record<string, unknown>;
  lookupSms: SmsLookup;
  /** the exact pre-existing call, executed when the runtime is not enabled for this tenant */
  legacy: () => Promise<RawSend>;
  timeoutMs?: number;
}

export function buildGenericSmsRegistry(deps: Pick<GovernedSmsParams, "sendSms" | "lookupSms" | "admin" | "timeoutMs" | "sendOpts">): ToolRegistry {
  const tool: ToolDef<any> = {
    name: "agent_send_sms",
    description: "Send one customer SMS through the compliant sender.",
    params: {
      type: "object",
      required: ["to", "body", "entityTable", "entityId"],
      properties: {
        to: { type: "string", minLength: 5, maxLength: 40 },
        body: { type: "string", minLength: 1, maxLength: 1600 },
        entityTable: { type: "string", enum: ["jobs", "invoices", "customers", "leads"] },
        entityId: { type: "string", format: "uuid" },
      },
    },
    requiredScope: "messaging:send",
    risk: "customer_contact",
    governanceSlug: GENERIC_SMS_SLUG,
    timeoutMs: deps.timeoutMs ?? 30_000,
    retry: { maxAttempts: 3, baseMs: 15 * 60_000, maxMs: 60 * 60_000 },
    idempotency: "verify_before_retry",
    provider: "twilio",
    target: (a) => ({ table: a.entityTable, id: a.entityId }),
    leaseEntity: (a) => ({ table: "contact_phone", id: normalizePhoneE164(a.to), virtual: true }),
    execute: async (a, ctx) => {
      // dedupeKey only affects the deferred (quiet-hours) queue; the direct path is protected by verify()
      const r = await deps.sendSms(deps.admin, ctx.userId, a.to, a.body, { ...(deps.sendOpts ?? {}), dedupeKey: ctx.idempotencyKey });
      if (r.ok) return { sid: r.sid ?? null, deferred: r.deferred === true };
      throw mapSmsFailure(r as never);
    },
    verify: async (a, result, ctx) => {
      if (result) return { ok: true };
      // lookup mode after a crash/timeout: did Twilio accept this exact message during this run?
      const found = await deps.lookupSms({ to: a.to, body: a.body, createdAfterMs: ctx.runStartedAt - 60_000 });
      if (found === "unavailable") throw new ToolError("cannot confirm with Twilio whether the SMS was sent", "ambiguous_input", true, false);
      return found ? { ok: true, result: { sid: found.sid, recovered: true } } : { ok: false, reason: "twilio has no matching message" };
    },
  };
  return new ToolRegistry().register(tool);
}

export async function sendSmsGoverned(p: GovernedSmsParams): Promise<GovernedSmsResult> {
  if (!(await isAgentRuntimeEnabled(p.admin, p.userId, p.agentSource))) {
    const r = await p.legacy();
    return { ...r, governed: false } as GovernedSmsResult;
  }
  const deps: RuntimeDeps = { ...p.base, registry: buildGenericSmsRegistry(p) };
  const run = await p.base.store.startRun({
    userId: p.userId, agentSource: p.agentSource, triggerRef: p.triggerRef, correlationId: p.triggerRef,
    plan: { channel: "sms", entity: p.entity }, scopes: ["messaging:send"],
    limits: { max_steps: 1, max_contacts: 1, max_cost_cents: 50 }, deadlineSeconds: 24 * 3600,
  });
  if (run.status === "succeeded") return { ok: true, governed: true }; // already sent by an earlier tick
  if (run.status !== "running" && run.status !== "awaiting_approval") {
    return { ok: false, reason: `RUN_${run.status.toUpperCase()}`, governed: true };
  }

  const out = await runTool(deps, run, {
    tool: "agent_send_sms",
    rawArgs: { to: p.to, body: p.body, entityTable: p.entity.table, entityId: p.entity.id },
    stepIndex: 0,
  });

  switch (out.kind) {
    case "ok":
      await p.base.store.finishRun(run.runId, run.userId, "succeeded");
      return { ok: true, sid: typeof out.result.sid === "string" ? out.result.sid : undefined, deferred: out.result.deferred === true, governed: true };
    case "awaiting_approval":
      return { ok: false, reason: "AWAITING_APPROVAL", governed: true, retryLater: true };
    case "retry_later":
      return { ok: false, reason: out.reason, governed: true, retryLater: true };
    case "blocked":
      await p.base.store.finishRun(run.runId, run.userId, out.reason === "governance_rejected" ? "cancelled" : "failed", out.reason);
      return { ok: false, reason: out.reason === "governance_rejected" ? "BLOCKED_BY_GOVERNANCE" : out.reason, governed: true };
    case "escalate":
      await p.base.escalate({
        run, stepIndex: 0, tool: "agent_send_sms", reason: out.reason, errorClass: out.errorClass, deadLetter: Boolean(out.deadLetter),
        context: { agent: p.agentSource, trigger: p.triggerRef, entity: p.entity },
      });
      await p.base.store.finishRun(run.runId, run.userId, out.deadLetter ? "dead_letter" : "escalated", out.reason);
      return { ok: false, reason: "NEEDS_HUMAN", detail: out.reason, governed: true };
  }
}
