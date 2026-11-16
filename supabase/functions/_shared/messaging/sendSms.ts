// supabase/functions/_shared/messaging/sendSms.ts
//
// The ONLY place in this codebase allowed to call Twilio's SMS API.
// Every future code path that texts a customer MUST go through
// sendCompliantSms() — it enforces two independent gates first:
//   1. A2P 10DLC campaign approval (a2pGate.ts) — fails loud here
//      instead of the message silently vanishing at the carrier.
//   2. STOP/opt-out suppression — reuses the existing dnc_suppressions
//      table/isDncSuppressed(), the same list outbound calling already
//      respects, so one opt-out blocks calls AND texts.
//
// NOT LIVE-VERIFIED: this is Twilio's documented Messages API shape as
// of this assistant's last verified knowledge — re-check
// https://www.twilio.com/docs/sms/send-messages before production use.

import { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { checkA2pApproved } from "../compliance/a2pGate.ts";
import { isDncSuppressed, normalizePhone } from "../compliance/dncCheck.ts";
import { gateOutbound, deferMessage, type Purpose } from "./quietHours.ts";
import { estimateSmsSegments, recordUsageEvent } from "../billing/usageEvents.ts";
import { asFraudDb, gateCustomerOutbound, type BlockedSend } from "../fraud/outboundGate.ts";

export type SendSmsResult =
  | { ok: true; sid: string; deferred?: false }
  | { ok: true; sid: string; deferred: true; sendAt: string }
  | { ok: false; reason: "QUIET_HOURS"; sendAt: string; detail?: string }
  /**
   * The fraud / abuse guard refused the send BEFORE any Twilio request (typed: code, retryable, retryAfterSeconds).
   * Callers must not retry it in a loop: reschedule at block.retryAt when block.retryable, otherwise stop.
   */
  | { ok: false; reason: "FRAUD_BLOCKED"; block: BlockedSend; detail?: string }
  | { ok: false; reason: "A2P_NOT_APPROVED" | "OPTED_OUT" | "NOT_CONFIGURED" | "TWILIO_ERROR" | "QUEUE_ERROR"; detail?: string };

export interface SendSmsOptions {
  purpose?: Purpose;
  customerId?: string | null;
  override?: { reason: string } | null;
  source?: string;
  dedupeKey?: string;
  /** "queue" (default) holds the message here; "caller" returns QUIET_HOURS so the caller reschedules its own row. */
  onQuiet?: "queue" | "caller";
  /** ONLY for deferred-message-dispatcher, which already re-ran the gate. */
  skipQuietHours?: boolean;
  /**
   * Purpose the FRAUD guard applies ("marketing" | "service" | "emergency"). Defaults to `purpose`, then "service".
   * Separate from `purpose` on purpose: `purpose` also drives quiet-hours windows, and changing it would change when
   * customers are texted. Callers whose traffic is promotional pass fraudPurpose: "marketing" (consent + campaign
   * approval + reserved headroom for service traffic) without altering quiet-hours behaviour.
   */
  fraudPurpose?: Purpose;
}

export async function sendCompliantSms(
  admin: SupabaseClient,
  userId: string,
  to: string,
  body: string,
  opts: SendSmsOptions = {},
): Promise<SendSmsResult> {
  const a2p = await checkA2pApproved(admin, userId);
  if (!a2p.approved) {
    return { ok: false, reason: "A2P_NOT_APPROVED", detail: a2p.status };
  }

  if (await isDncSuppressed(admin, userId, to)) {
    return { ok: false, reason: "OPTED_OUT" };
  }

  if (!opts.skipQuietHours) {
    const input = { channel: "sms" as const, to, purpose: opts.purpose, customerId: opts.customerId, override: opts.override, source: opts.source };
    const outcome = await gateOutbound(admin, userId, input);
    if (!outcome.proceed) {
      if (opts.onQuiet === "caller") return { ok: false, reason: "QUIET_HOURS", sendAt: outcome.sendAt, detail: outcome.decision.detail };
      const queued = await deferMessage(admin, userId, input, { bodyText: body, dedupeKey: opts.dedupeKey, transport: "a2p" }, outcome);
      if (!queued.queued) return { ok: false, reason: "QUEUE_ERROR", detail: queued.error };
      return { ok: true, sid: `deferred:${queued.queueId}`, deferred: true, sendAt: queued.sendAt };
    }
  }
  return sendViaTwilioGuarded(admin, userId, to, body, opts);
}

/** Injection points for tests; production uses the defaults. */
export interface TwilioSendDeps {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  env?: (key: string) => string | undefined;
  recordUsage?: typeof recordUsageEvent;
}

/**
 * The last step of sendCompliantSms: the fraud guard, then Twilio. It is the ONLY place in the codebase that reaches
 * Twilio's Messages API for customer-driven traffic, and the guard runs immediately before the request (after A2P,
 * opt-out and quiet hours, so a deferred message reserves budget once, when it is actually sent).
 * In shadow mode (fraud_settings.outbound_guard_mode, default 'shadow') a would-block is only logged.
 */
export async function sendViaTwilioGuarded(
  admin: SupabaseClient,
  userId: string,
  to: string,
  body: string,
  opts: SendSmsOptions = {},
  deps: TwilioSendDeps = {},
): Promise<SendSmsResult> {
  const env = deps.env ?? ((k: string) => Deno.env.get(k));
  const accountSid = env("TWILIO_ACCOUNT_SID");
  const authToken = env("TWILIO_AUTH_TOKEN");
  const messagingServiceSid = env("TWILIO_MESSAGING_SERVICE_SID");
  if (!accountSid || !authToken || !messagingServiceSid) {
    return { ok: false, reason: "NOT_CONFIGURED", detail: "Twilio secrets not set" };
  }

  const gate = await gateCustomerOutbound(asFraudDb(admin), {
    userId, kind: "sms", to, purpose: opts.fraudPurpose ?? opts.purpose ?? "service", source: opts.source ?? "sendCompliantSms",
  });
  if (!gate.allowed) return { ok: false, reason: "FRAUD_BLOCKED", block: gate.blocked, detail: gate.blocked.message };

  const doFetch = deps.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const res = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
    },
    body: new URLSearchParams({ MessagingServiceSid: messagingServiceSid, To: normalizePhone(to), Body: body }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, reason: "TWILIO_ERROR", detail: json?.message ?? `HTTP ${res.status}` };
  }
  await (deps.recordUsage ?? recordUsageEvent)(admin, {
    userId,
    component: "sms_segment",
    quantity: estimateSmsSegments(body),
    unit: "per_segment",
    source: "sendCompliantSms",
    ref: json.sid,
  });
  return { ok: true, sid: json.sid };
}
