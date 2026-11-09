// supabase/functions/_shared/agent-run/followupTools.ts
//
// Tools for the follow-up agent (SMS + outbound call). Declared once; executed ONLY through
// executor.runTool (governance, lease, breaker, budget, idempotent ledger).
//
// Crash-safety design (verified finding: sendCompliantSms' dedupeKey only dedupes the DEFERRED queue;
// the direct Twilio POST is NOT idempotent, and Vapi has no idempotency key either):
//   1. an "attempt row" (status queued, run_key = step idempotency key) is written BEFORE the provider call
//   2. after a crash/timeout the ledger asks verify() in lookup mode:
//        row has provider id          → effect proven, never re-send
//        no row                       → never attempted, safe to execute
//        row without id (SMS)         → ask Twilio (deterministic lookup); found → recovered, none → safe re-send
//        row without id (call)/Twilio unavailable → ambiguous → human (we NEVER guess for customer contact)

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import type { SendSmsResult } from "../messaging/sendSms.ts";
import { classifyError, ToolError } from "./core.ts";
import { ToolRegistry, type ToolDef } from "./toolRegistry.ts";
import { normalizePhoneE164, type SmsLookup } from "./twilioLookup.ts";

export const FOLLOWUP_AGENT = "followup-agent-dispatcher";
export const FOLLOWUP_SCOPES = ["messaging:send", "calls:place"] as const;
export const CONTACT_LEASE_TABLE = "contact_phone";
export const FOLLOWUP_SLUG = "followup_dispatch"; // existing catalog slug → existing tenant policies keep applying

export interface FollowupToolDeps {
  admin: SupabaseClient;
  sendSms: (admin: SupabaseClient, userId: string, to: string, body: string) => Promise<SendSmsResult>;
  lookupSms: SmsLookup;
  /** Performs the Vapi request. Throw an error carrying `.status` on HTTP failure. */
  placeCall: () => Promise<{ providerId: string | null }>;
  /** Test hook only; production uses the defaults (SMS 30s, call 20s). */
  timeoutMs?: number;
}

const baseProps = {
  enrollmentId: { type: "string", format: "uuid" },
  stepNumber: { type: "integer", minimum: 1, maximum: 5 },
  campaignType: { type: "string", enum: ["quote_followup", "appointment_reminder", "review_request_call"] },
  to: { type: "string", minLength: 5, maxLength: 40 },
  customerName: { type: "string", minLength: 1, maxLength: 200 },
  leadId: { type: "string", format: "uuid" },
  jobId: { type: "string", format: "uuid" },
} as const;
const baseRequired = ["enrollmentId", "stepNumber", "campaignType", "to", "customerName"] as const;

type Args = {
  enrollmentId: string; stepNumber: number; campaignType: string; to: string; customerName: string;
  leadId?: string; jobId?: string; body?: string;
};

function baseRow(a: Args, userId: string, key: string) {
  return {
    user_id: userId, campaign_type: a.campaignType, enrollment_id: a.enrollmentId, step_number: a.stepNumber,
    lead_id: a.leadId ?? null, job_id: a.jobId ?? null, customer_name: a.customerName, customer_phone: a.to,
    status: "queued", run_key: key,
  };
}

export function mapSmsFailure(r: Extract<SendSmsResult, { ok: false }>): ToolError {
  const msg = `${r.reason}${r.detail ? `: ${r.detail}` : ""}`;
  if (r.reason === "OPTED_OUT") return new ToolError(msg, "policy_blocked", false, false);
  if (r.reason === "TWILIO_ERROR" && /^HTTP 5\d\d$/.test(r.detail ?? "")) return new ToolError(msg, "dependency_down", false, true);
  // A2P not approved / not configured / queue error / Twilio 4xx text: retryable later, but NOT a provider outage
  return new ToolError(msg, "transient", false, false);
}

export function buildFollowupRegistry(deps: FollowupToolDeps): ToolRegistry {
  const { admin } = deps;
  const common = {
    requiredScope: "", risk: "customer_contact" as const, governanceSlug: FOLLOWUP_SLUG,
    retry: { maxAttempts: 3, baseMs: 15 * 60_000, maxMs: 60 * 60_000 },
    idempotency: "verify_before_retry" as const,
    target: (a: Args) => ({ table: "followup_agent_enrollments", id: a.enrollmentId }),
    // The customer is the shared resource, whichever agent (or human) is contacting them:
    // the lease key is the normalized phone number, identical for every agent and for the operator UI.
    leaseEntity: (a: Args) => ({ table: CONTACT_LEASE_TABLE, id: normalizePhoneE164(a.to), virtual: true }),
  };

  const sms: ToolDef<any> = {
    ...common,
    name: "followup_send_sms",
    description: "Send the follow-up SMS for one enrollment step through the compliant sender.",
    params: { type: "object", required: [...baseRequired, "body"], properties: { ...baseProps, body: { type: "string", minLength: 1, maxLength: 1600 } } },
    requiredScope: "messaging:send",
    timeoutMs: deps.timeoutMs ?? 30_000,
    provider: "twilio",
    execute: async (a: Args, ctx) => {
      const key = ctx.idempotencyKey;
      const sel = await admin.from("outbound_sms").select("id, twilio_sid").eq("user_id", ctx.userId).eq("run_key", key).maybeSingle();
      if (sel.error) throw new ToolError(`outbound_sms lookup failed: ${sel.error.message}`, "transient", false);
      if (sel.data?.twilio_sid) return { sid: sel.data.twilio_sid, deduped: true };
      if (!sel.data) {
        // intent record BEFORE the provider call, otherwise the crash window cannot be detected
        const ins = await admin.from("outbound_sms").upsert({ ...baseRow(a, ctx.userId, key), body: a.body }, { onConflict: "user_id,run_key", ignoreDuplicates: true });
        if (ins.error) throw new ToolError(`could not record send intent: ${ins.error.message}`, "transient", false);
      }
      const result = await deps.sendSms(admin, ctx.userId, a.to, a.body as string);
      if (result.ok) {
        const upd = await admin.from("outbound_sms").update({ status: "sent", twilio_sid: result.sid, sent_at: new Date().toISOString() }).eq("user_id", ctx.userId).eq("run_key", key);
        if (upd.error) console.error(JSON.stringify({ event: "followup_sms_row_update_failed", run_key: key, error: upd.error.message }));
        return { sid: result.sid, deferred: "deferred" in result && result.deferred === true };
      }
      await admin.from("outbound_sms").update({
        status: result.reason === "OPTED_OUT" ? "opted_out" : "failed", outcome_notes: result.detail ?? result.reason,
      }).eq("user_id", ctx.userId).eq("run_key", key);
      throw mapSmsFailure(result);
    },
    verify: async (a: Args, result, ctx) => {
      if (result) return result.sid ? { ok: true } : { ok: false, reason: "provider returned no sid" };
      const sel = await admin.from("outbound_sms").select("id, twilio_sid, created_at").eq("user_id", ctx.userId).eq("run_key", ctx.idempotencyKey).maybeSingle();
      if (sel.error) throw new ToolError(`verify lookup failed: ${sel.error.message}`, "transient", true, false);
      if (!sel.data) return { ok: false, reason: "no attempt recorded" };
      if (sel.data.twilio_sid) return { ok: true, result: { sid: sel.data.twilio_sid, recovered: true } };
      const found = await deps.lookupSms({ to: a.to, body: a.body as string, createdAfterMs: Date.parse(sel.data.created_at) });
      if (found === "unavailable") throw new ToolError("cannot confirm with Twilio whether the SMS was sent", "ambiguous_input", true, false);
      if (found) {
        await admin.from("outbound_sms").update({ status: "sent", twilio_sid: found.sid, sent_at: new Date().toISOString() }).eq("id", sel.data.id).eq("user_id", ctx.userId);
        return { ok: true, result: { sid: found.sid, recovered: true } };
      }
      return { ok: false, reason: "twilio has no matching message" };
    },
  };

  const call: ToolDef<any> = {
    ...common,
    name: "followup_place_call",
    description: "Place the follow-up outbound call for one enrollment step via Vapi.",
    params: { type: "object", required: [...baseRequired], properties: { ...baseProps } },
    requiredScope: "calls:place",
    timeoutMs: deps.timeoutMs ?? 20_000,
    provider: "vapi",
    execute: async (a: Args, ctx) => {
      const key = ctx.idempotencyKey;
      const sel = await admin.from("outbound_calls").select("id, vapi_call_id").eq("user_id", ctx.userId).eq("run_key", key).maybeSingle();
      if (sel.error) throw new ToolError(`outbound_calls lookup failed: ${sel.error.message}`, "transient", false);
      if (sel.data?.vapi_call_id) return { placed: true, callId: sel.data.vapi_call_id, deduped: true };
      if (!sel.data) {
        const ins = await admin.from("outbound_calls").upsert(baseRow(a, ctx.userId, key), { onConflict: "user_id,run_key", ignoreDuplicates: true });
        if (ins.error) throw new ToolError(`could not record call intent: ${ins.error.message}`, "transient", false);
      }
      try {
        const { providerId } = await deps.placeCall();
        await admin.from("outbound_calls").update({ status: "calling", vapi_call_id: providerId, called_at: new Date().toISOString() }).eq("user_id", ctx.userId).eq("run_key", key);
        return { placed: true, callId: providerId };
      } catch (e) {
        const c = classifyError(e);
        // only mark failed when we KNOW no call was placed; an ambiguous timeout stays 'queued'
        if (!c.maybeExecuted) {
          await admin.from("outbound_calls").update({ status: "failed", outcome_notes: c.message.slice(0, 300) }).eq("user_id", ctx.userId).eq("run_key", key);
        }
        throw e;
      }
    },
    verify: async (_a: Args, result, ctx) => {
      if (result) return result.placed === true ? { ok: true } : { ok: false, reason: "call not placed" };
      const sel = await admin.from("outbound_calls").select("id, vapi_call_id, status").eq("user_id", ctx.userId).eq("run_key", ctx.idempotencyKey).maybeSingle();
      if (sel.error) throw new ToolError(`verify lookup failed: ${sel.error.message}`, "transient", true, false);
      if (!sel.data) return { ok: false, reason: "no attempt recorded" };
      if (sel.data.vapi_call_id) return { ok: true, result: { placed: true, callId: sel.data.vapi_call_id, recovered: true } };
      if (sel.data.status === "failed") return { ok: false, reason: "previous attempt definitively failed" };
      throw new ToolError("call attempt exists without a provider id; cannot prove whether it was placed", "ambiguous_input", true, false);
    },
  };

  return new ToolRegistry().register(sms).register(call);
}
