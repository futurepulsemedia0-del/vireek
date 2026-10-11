// supabase/functions/_shared/messaging/quietHours.ts
//
// The ONE gate every outbound SMS / email / call / campaign step passes through.
// Pure rules live in quietHoursCore.ts; this file adds the database side:
//   - load the business window + the customer's timezone inputs
//   - audit emergency / manual overrides and deferrals (messaging_gate_events)
//   - queue held messages (deferred_messages), released by deferred-message-dispatcher
//
// Fail-safe direction: if settings or customer lookups fail we fall back to the
// DEFAULT window (still enforced) — we never fall back to "send anyway".
// Callers that own their own queue row (campaign enrollments, outbound_calls) use
// gateOutbound() and simply reschedule their row to `sendAt`; fire-and-forget senders
// use gateAndDefer() which queues the message itself.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  decideSend,
  jitterMs,
  normalizeSettings,
  resolveCustomerTimezone,
  type Channel,
  type Decision,
  type Purpose,
  type QuietHoursSettings,
} from "./quietHoursCore.ts";

export type { Channel, Purpose } from "./quietHoursCore.ts";

export interface GateInput {
  channel: Channel;
  /** Phone (sms/call) or email address. */
  to: string;
  purpose?: Purpose; // default "service"
  customerId?: string | null;
  /** Used for timezone detection when there is no customer row. */
  address?: string | null;
  /** Owner-confirmed override (service messages only; marketing can never override). */
  override?: { reason: string } | null;
  /** Calling function name, stored on audit rows. */
  source?: string;
  now?: Date;
}

export type GateOutcome =
  | { proceed: true; decision: Extract<Decision, { allowed: true }> }
  | { proceed: false; decision: Extract<Decision, { allowed: false }>; sendAt: string };

interface LoadedContext {
  settings: QuietHoursSettings;
  customerTimezone: string | null;
  customerAddress: string | null;
  customerPhone: string | null;
}

function digits(v: string): string {
  return v.replace(/\D/g, "");
}

function phoneVariants(raw: string): string[] {
  const d = digits(raw);
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return Array.from(new Set([raw, d, ten, `+1${ten}`, `+${d}`, `1${ten}`].filter(Boolean)));
}

async function loadContext(admin: SupabaseClient, userId: string, input: GateInput): Promise<LoadedContext> {
  let settings = normalizeSettings(null, null);
  try {
    const { data } = await admin.from("business_profile").select("timezone, quiet_hours").eq("user_id", userId).maybeSingle();
    settings = normalizeSettings(data?.quiet_hours, data?.timezone);
  } catch (e) {
    console.error(JSON.stringify({ event: "quiet_hours_settings_failed", user_id: userId, error: String(e) }));
  }

  let row: { timezone: string | null; address: string | null; phone: string | null } | null = null;
  try {
    if (input.customerId) {
      const { data } = await admin.from("customers").select("timezone, address, phone").eq("id", input.customerId).eq("user_id", userId).maybeSingle();
      row = data ?? null;
    } else if (input.channel === "email") {
      const { data } = await admin.from("customers").select("timezone, address, phone").eq("user_id", userId).eq("email", input.to).maybeSingle();
      row = data ?? null;
    } else {
      const { data } = await admin.from("customers").select("timezone, address, phone").eq("user_id", userId).in("phone", phoneVariants(input.to)).limit(1).maybeSingle();
      row = data ?? null;
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "quiet_hours_customer_lookup_failed", user_id: userId, error: String(e) }));
  }

  return {
    settings,
    customerTimezone: row?.timezone ?? null,
    customerAddress: row?.address ?? input.address ?? null,
    customerPhone: input.channel === "email" ? row?.phone ?? null : input.to,
  };
}

async function audit(
  admin: SupabaseClient,
  userId: string,
  input: GateInput,
  decision: Decision,
  extra: { decision: "deferred" | "emergency_override" | "manual_override"; sendAt?: string; deferredId?: string | null },
): Promise<void> {
  try {
    await admin.from("messaging_gate_events").insert({
      user_id: userId,
      channel: input.channel,
      purpose: input.purpose ?? "service",
      decision: extra.decision,
      reason: decision.reason,
      timezone: decision.timezone,
      tz_source: decision.tzSource,
      send_at: extra.sendAt ?? null,
      override_reason: extra.decision === "manual_override" ? input.override?.reason?.slice(0, 300) ?? null : null,
      deferred_message_id: extra.deferredId ?? null,
      source: input.source ?? null,
    });
  } catch (e) {
    console.error(JSON.stringify({ event: "messaging_gate_audit_failed", user_id: userId, error: String(e) }));
  }
}

/** Decide only. Overrides are audited; deferrals are NOT queued (caller reschedules its own row). */
export async function gateOutbound(admin: SupabaseClient, userId: string, input: GateInput): Promise<GateOutcome> {
  const purpose = input.purpose ?? "service";
  const now = input.now ?? new Date();
  const ctx = await loadContext(admin, userId, input);
  const tz = resolveCustomerTimezone({
    explicit: ctx.customerTimezone,
    address: ctx.customerAddress,
    phone: ctx.customerPhone,
    businessTimezone: ctx.settings.timezone,
  });

  const decision = decideSend({ channel: input.channel, purpose, settings: ctx.settings, tz, now, manualOverride: input.override ?? null });

  if (decision.allowed) {
    if (decision.reason === "EMERGENCY_OVERRIDE" || decision.reason === "MANUAL_OVERRIDE") {
      await audit(admin, userId, { ...input, purpose }, decision, {
        decision: decision.reason === "EMERGENCY_OVERRIDE" ? "emergency_override" : "manual_override",
      });
    }
    return { proceed: true, decision };
  }

  // Spread the morning rush so a whole queue doesn't fire at 08:00:00.
  const jittered = new Date(new Date(decision.sendAt).getTime() + jitterMs(`${userId}:${input.to}:${input.source ?? ""}`)).toISOString();
  return { proceed: false, decision, sendAt: jittered };
}

export interface DeferPayload {
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
  /** Stable key so retries/cron re-runs never queue the same message twice. */
  dedupeKey?: string | null;
  /** a2p = sendCompliantSms path; plain = notify/deliver.ts path (default). */
  transport?: "a2p" | "plain";
}

export type DeferResult = { queued: true; queueId: string; sendAt: string } | { queued: false; error: string };

/** Queue a message for later delivery (also audits the deferral). */
export async function deferMessage(
  admin: SupabaseClient,
  userId: string,
  input: GateInput,
  payload: DeferPayload,
  outcome: Extract<GateOutcome, { proceed: false }>,
): Promise<DeferResult> {
  const purpose = input.purpose ?? "service";
  const row = {
    user_id: userId,
    channel: input.channel,
    transport: payload.transport ?? "plain",
    purpose,
    to_address: input.to,
    subject: payload.subject ?? null,
    body_text: payload.bodyText,
    body_html: payload.bodyHtml ?? null,
    customer_id: input.customerId ?? null,
    source: input.source ?? null,
    dedupe_key: payload.dedupeKey ?? null,
    send_after: outcome.sendAt,
    timezone: outcome.decision.timezone,
    tz_source: outcome.decision.tzSource,
    defer_reason: outcome.decision.reason,
  };

  const { data, error } = await admin.from("deferred_messages").insert(row).select("id, send_after").single();
  if (error) {
    // 23505 = dedupe hit: the same message is already queued — treat as success.
    if ((error as { code?: string }).code === "23505" && payload.dedupeKey) {
      const { data: existing } = await admin
        .from("deferred_messages")
        .select("id, send_after")
        .eq("user_id", userId)
        .eq("dedupe_key", payload.dedupeKey)
        .in("status", ["queued", "sending"])
        .maybeSingle();
      if (existing) return { queued: true, queueId: existing.id as string, sendAt: existing.send_after as string };
    }
    console.error(JSON.stringify({ event: "deferred_enqueue_failed", user_id: userId, error: error.message }));
    return { queued: false, error: error.message };
  }

  await audit(admin, userId, { ...input, purpose }, outcome.decision, { decision: "deferred", sendAt: outcome.sendAt, deferredId: data.id as string });
  return { queued: true, queueId: data.id as string, sendAt: data.send_after as string };
}

/** Convenience for fire-and-forget senders: decide, and queue if held. */
export async function gateAndDefer(
  admin: SupabaseClient,
  userId: string,
  input: GateInput,
  payload: DeferPayload,
): Promise<{ proceed: true; decision: Extract<Decision, { allowed: true }> } | { proceed: false; result: DeferResult; sendAt: string }> {
  const outcome = await gateOutbound(admin, userId, input);
  if (outcome.proceed) return outcome;
  const result = await deferMessage(admin, userId, input, payload, outcome);
  return { proceed: false, result, sendAt: outcome.sendAt };
}
