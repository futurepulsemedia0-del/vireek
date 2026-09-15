// supabase/functions/vapi-webhook/index.ts
//
// Server URL for the Vapi "Vireek Receptionist" production assistant(s).
// One Edge Function, routed internally by `message.type`:
//   - assistant-request             -> BEFORE the call connects: inject a
//                                       `caller_context` template variable
//                                       (returning-caller name + warranty
//                                       status) so the assistant's system
//                                       prompt can reference {{caller_context}}
//   - transfer-destination-request  -> live call transfer to profiles.forwarding_number
//   - tool-calls                    -> book_appointment / lookup_customer /
//                                       check_weather / flag_emergency_call /
//                                       request_human_transfer / lookup_price
//   - status-update / end-of-call-report / hang / other lifecycle events
//                                    -> upsert the `calls` row (drives the
//                                       existing emergency-notification DB
//                                       trigger — see 20260831090000_notifications_and_audit_log.sql)
//
// ─────────────────────────────────────────────────────────────────────────
// IMPORTANT — read before trusting this in production
// ─────────────────────────────────────────────────────────────────────────
// This was written from Vapi's documented Server URL contract as of this
// assistant's last verified knowledge. I do not have live web access in
// this environment, so I could not re-check https://docs.vapi.ai at the
// moment this file was generated. Two things are worth explicitly
// re-verifying against current Vapi docs before you rely on this in
// production, because Vapi has changed these shapes before:
//   1. The exact header name Vapi sends its Server URL secret in
//      (implemented here as `x-vapi-secret`, matching the assistant-level
//      "Server URL Secret" feature).
//   2. The exact response shape expected for `transfer-destination-request`
//      (implemented here as `{ destination: { type: "number", number, message } }`)
//      and for `tool-calls` (`{ results: [{ toolCallId, result }] }`).
// If either has changed, log the raw payload (see `logEvent`) on a real
// call and adjust the two response builders near the bottom of this file
// accordingly — the tenant-resolution, security, and database logic below
// do not depend on that shape and will keep working either way.
//
// ─────────────────────────────────────────────────────────────────────────
// Required secrets (set with `supabase secrets set`, never hardcode):
//   SUPABASE_URL                — already provided by the platform
//   SUPABASE_SERVICE_ROLE_KEY   — already provided by the platform
//   VAPI_SERVER_SECRET          — the same value you put in the Vapi
//                                  assistant's "Server URL Secret" field
// ─────────────────────────────────────────────────────────────────────────
//
// Deploy:
//   supabase functions deploy vapi-webhook --no-verify-jwt
//
// (--no-verify-jwt is required: Vapi calls this endpoint server-to-server
// with its own secret, not a Supabase user JWT, so Supabase's built-in JWT
// gate must be disabled for this function specifically.)

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { assignBestTechnician } from "../_shared/dispatch/assign.ts";
import { analyzeCallIntelligence } from "../_shared/ai-core/callIntelligence.ts";

// ---------------------------------------------------------------------------
// Types (only the fields we actually read — Vapi payloads carry much more)
// ---------------------------------------------------------------------------

interface VapiCall {
  id?: string;
  assistantId?: string;
  phoneNumberId?: string;
  customer?: { number?: string | null; name?: string | null } | null;
  startedAt?: string;
  endedAt?: string;
}

interface VapiToolCallFunction {
  name?: string;
  arguments?: unknown;
}

interface VapiToolCall {
  id?: string;
  toolCallId?: string;
  type?: string;
  function?: VapiToolCallFunction;
}

interface VapiMessage {
  type?: string;
  call?: VapiCall;
  phoneNumber?: { id?: string; number?: string };
  toolCalls?: VapiToolCall[];
  toolCallList?: VapiToolCall[];
  transcript?: string;
  summary?: string;
  recordingUrl?: string;
  endedReason?: string;
  durationSeconds?: number;
  artifact?: {
    transcript?: string;
    recordingUrl?: string;
    recording?: { stereoUrl?: string; mono?: { combinedUrl?: string } };
  };
  analysis?: {
    summary?: string;
    successEvaluation?: string | boolean;
  };
}

interface VapiWebhookBody {
  message?: VapiMessage;
}

interface TenantContext {
  userId: string;
  forwardingNumber: string | null;
  escalationRules: EscalationRule[] | null;
  assistantName: string | null;
  assistantId: string | null;
  onCallSchedule: OnCallEntry[] | null;
  surgeModeEnabled: boolean;
  surgeModeMessage: string | null;
  surgeModePriority: string | null;
  surgeMaxBookingsPerDay: number | null;
  businessHours: BusinessHoursMap | null;
  holidays: HolidayEntry[] | null;
  afterHoursFee: number | null;
  afterHoursFeeNote: string | null;
  commercialSlaPolicy: string | null;
}
interface EscalationRule {
  id?: string;
  trigger?: "emergency" | "after_hours" | "no_answer" | "human_request";
  action?: "transfer" | "sms" | "email";
  target?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-vapi-secret",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Never put a phone number, transcript, or secret in a log line.
function logEvent(event: string, requestId: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, requestId, ...redact(extra) }));
}

function logError(event: string, requestId: string, error: unknown, extra: Record<string, unknown> = {}) {
  console.error(
    JSON.stringify({
      event,
      requestId,
      error: error instanceof Error ? error.message : String(error),
      ...redact(extra),
    }),
  );
}
// Persists an incoming-webhook event to `webhook_logs` so it's visible in
// the dashboard's Webhook Logs page. Fire-and-forget: never let a logging
// failure break the actual webhook response.
async function logToDb(
  admin: SupabaseClient,
  opts: {
    userId?: string | null;
    eventType: string;
    status: 'success' | 'error';
    requestId: string;
    errorMessage?: string;
  },
) {
  try {
    await admin.from('webhook_logs').insert({
      user_id: opts.userId ?? null,
      direction: 'incoming',
      event_type: opts.eventType,
      status: opts.status,
      request_id: opts.requestId,
      error_message: opts.errorMessage ?? null,
    });
  } catch {
    // Table may not exist yet if the migration hasn't been applied —
    // never let this break the real webhook handling.
  }
}

const SENSITIVE_KEYS = new Set([
  "transcript",
  "phone",
  "caller_phone",
  "customer_phone",
  "forwarding_number",
  "number",
  "secret",
  "authorization",
]);

function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = typeof v === "string" ? maskPhone(v) : "[redacted]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function maskPhone(value: string): string {
  if (!value) return value;
  return value.length > 4 ? `***${value.slice(-4)}` : "***";
}

// E.164-ish validation — reject anything that isn't a plausible phone
// number before it's ever used as a transfer destination or SMS target.
const E164_RE = /^\+[1-9]\d{6,14}$/;

function isValidE164(value: string | null | undefined): value is string {
  return typeof value === "string" && E164_RE.test(value);
}

// ---------------------------------------------------------------------------
// Tenant resolution
// ---------------------------------------------------------------------------
//
// Priority order (per spec):
//   1. Vapi-provided call.assistantId  (cannot be spoofed by the caller —
//      it's generated by Vapi itself once the request's secret is verified)
//   2. Vapi-provided call.phoneNumberId / phoneNumber.id
//   3. fail safely (return null) — we never fall back to a client-supplied
//      user_id anywhere in this file.

async function resolveTenant(
  admin: SupabaseClient,
  message: VapiMessage,
  requestId: string,
): Promise<TenantContext | null> {
  const assistantId = message.call?.assistantId;
  const phoneNumberId = message.call?.phoneNumberId ?? message.phoneNumber?.id;

  if (!assistantId && !phoneNumberId) {
    logEvent("tenant_resolution_missing_identifiers", requestId, {});
    return null;
  }

  let query = admin
    .from("business_profile")
    .select("user_id, escalation_rules, assistant_name, vapi_assistant_id, on_call_schedule, surge_mode_enabled, surge_mode_message, surge_mode_priority, surge_max_bookings_per_day, business_hours, holidays, after_hours_fee, after_hours_fee_note, commercial_sla_policy")
    .limit(1);

  if (assistantId) {
    query = query.eq("vapi_assistant_id", assistantId);
  } else if (phoneNumberId) {
    query = query.eq("vapi_phone_number_id", phoneNumberId);
  }

  const { data: businessRows, error: businessError } = await query;

  if (businessError) {
    logError("tenant_resolution_query_failed", requestId, businessError);
    return null;
  }

  const business = businessRows?.[0];

  // If assistantId lookup found nothing, try phoneNumberId as a fallback
  // (some events only carry one of the two identifiers).
  let resolvedBusiness = business;
  if (!resolvedBusiness && assistantId && phoneNumberId) {
    const { data: fallbackRows, error: fallbackError } = await admin
      .from("business_profile")
      .select("user_id, escalation_rules, assistant_name, vapi_assistant_id")
      .eq("vapi_phone_number_id", phoneNumberId)
      .limit(1);
    if (fallbackError) {
      logError("tenant_resolution_fallback_query_failed", requestId, fallbackError);
    } else {
      resolvedBusiness = fallbackRows?.[0];
    }
  }

  if (!resolvedBusiness) {
    logEvent("tenant_resolution_no_match", requestId, { assistant_id: assistantId ?? null, phone_number_id: phoneNumberId ?? null });
    return null;
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("forwarding_number")
    .eq("id", resolvedBusiness.user_id)
    .maybeSingle();

  if (profileError) {
    logError("tenant_resolution_profile_lookup_failed", requestId, profileError);
  }

  return {
    userId: resolvedBusiness.user_id,
    forwardingNumber: profile?.forwarding_number ?? null,
    escalationRules: (resolvedBusiness.escalation_rules as EscalationRule[] | null) ?? null,
    assistantName: resolvedBusiness.assistant_name ?? null,
    assistantId: resolvedBusiness.vapi_assistant_id ?? null,
    onCallSchedule: (resolvedBusiness.on_call_schedule as OnCallEntry[] | null) ?? null,
    surgeModeEnabled: Boolean(resolvedBusiness.surge_mode_enabled),
    surgeModeMessage: resolvedBusiness.surge_mode_message ?? null,
    surgeModePriority: resolvedBusiness.surge_mode_priority ?? null,
    surgeMaxBookingsPerDay: resolvedBusiness.surge_max_bookings_per_day ?? null,
    businessHours: (resolvedBusiness.business_hours as BusinessHoursMap | null) ?? null,
    holidays: (resolvedBusiness.holidays as HolidayEntry[] | null) ?? null,
    afterHoursFee: resolvedBusiness.after_hours_fee ?? null,
    afterHoursFeeNote: resolvedBusiness.after_hours_fee_note ?? null,
    commercialSlaPolicy: resolvedBusiness.commercial_sla_policy ?? null,
  };
}

function findEscalationTarget(
  rules: EscalationRule[] | null,
  trigger: EscalationRule["trigger"],
): string | null {
  if (!rules) return null;
  const rule = rules.find((r) => r.trigger === trigger && r.action === "transfer" && isValidE164(r.target));
  return rule?.target ?? null;
}

// ---------------------------------------------------------------------------
// calls table helper — upsert-by-vapi_call_id so multiple events for the
// same call (tool-calls, then end-of-call-report) land on one row instead
// of creating duplicates.
// ---------------------------------------------------------------------------

async function upsertCallRow(
  admin: SupabaseClient,
  tenant: TenantContext,
  vapiCallId: string | undefined,
  patch: Record<string, unknown>,
  requestId: string,
): Promise<{ id: string; user_id: string } | null> {
  if (!vapiCallId) {
    logEvent("call_upsert_skipped_no_vapi_call_id", requestId, {});
    return null;
  }

  const { data: existing, error: findError } = await admin
    .from("calls")
    .select("id, user_id")
    .eq("vapi_call_id", vapiCallId)
    .eq("user_id", tenant.userId)
    .maybeSingle();

  if (findError) {
    logError("call_upsert_lookup_failed", requestId, findError);
    return null;
  }

  if (existing) {
    const { data: updated, error: updateError } = await admin
      .from("calls")
      .update(patch)
      .eq("id", existing.id)
      .eq("user_id", tenant.userId) // tenant isolation, belt-and-suspenders even with service role
      .select("id, user_id")
      .maybeSingle();

    if (updateError) {
      logError("call_upsert_update_failed", requestId, updateError);
      return existing;
    }
    return updated ?? existing;
  }

  const { data: inserted, error: insertError } = await admin
    .from("calls")
    .insert({ ...patch, vapi_call_id: vapiCallId, user_id: tenant.userId })
    .select("id, user_id")
    .maybeSingle();

  if (insertError) {
    logError("call_upsert_insert_failed", requestId, insertError);
    return null;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// transfer-destination-request
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Caller intelligence — used by assistant-request (below) to let the AI
// greet a returning caller by name and know their last job/warranty status
// BEFORE the conversation starts, instead of waiting for it to decide to
// call the lookup_customer tool mid-call.
// ---------------------------------------------------------------------------

async function buildCallerContextVariable(
  admin: SupabaseClient,
  tenant: TenantContext,
  callerNumber: string | null,
): Promise<string> {
  if (!callerNumber) {
    return "No caller ID was available for this call — treat this as a new caller.";
  }

  const { data: pastCalls } = await admin
    .from("calls")
    .select("caller_name")
    .eq("user_id", tenant.userId)
    .eq("caller_phone", callerNumber)
    .order("call_datetime", { ascending: false })
    .limit(1);

  const { data: pastJobs } = await admin
    .from("jobs")
    .select("customer_name, service_type, job_status, scheduled_datetime, warranty_expires_at")
    .eq("user_id", tenant.userId)
    .eq("customer_phone", callerNumber)
    .order("scheduled_datetime", { ascending: false })
    .limit(1);

  const knownName = pastJobs?.[0]?.customer_name || pastCalls?.[0]?.caller_name || null;
  const latestJob = pastJobs?.[0];

  if (!knownName && !latestJob) {
    return "This is a new caller with no prior history on file — greet them normally and do not imply you already know them.";
  }

  const parts: string[] = [
    `Returning caller${knownName ? ` named ${knownName}` : ""}. You may greet them by name naturally.`,
  ];

  if (latestJob) {
    parts.push(
      `Last service: ${latestJob.service_type ?? "a service call"} (${latestJob.job_status})${
        latestJob.scheduled_datetime ? ` on ${new Date(latestJob.scheduled_datetime).toDateString()}` : ""
      }.`,
    );

    if (latestJob.warranty_expires_at) {
      const stillCovered = new Date(latestJob.warranty_expires_at).getTime() >= Date.now();
      parts.push(
        stillCovered
          ? `That job is still under warranty until ${new Date(latestJob.warranty_expires_at).toDateString()} — if this call is about the same issue, say so and don't quote a repair charge before the office confirms.`
          : `That job's warranty has expired, so treat any related issue as a new billable visit.`,
      );
    }
  }

  parts.push("Only state facts given here — never invent details about the caller or their history.");

  return parts.join(" ");
}
// ---------------------------------------------------------------------------
// Commercial vs Residential — Sameday advertises "adapts to residential
// priorities and commercial SLAs" as a differentiator. Looks up the
// caller's most recent job for customer_type/SLA fields (see
// 20260913080000_commercial_residential_customer_type.sql) and combines it
// with the business's own free-text commercial_sla_policy, so the AI can
// treat a commercial, SLA-bound account differently — with no policy
// specifics hardcoded here.
// ---------------------------------------------------------------------------

async function buildCustomerTypeContextVariable(
  admin: SupabaseClient,
  tenant: TenantContext,
  callerNumber: string | null,
): Promise<string> {
  if (!callerNumber) {
    return "";
  }

  const { data: pastJobs } = await admin
    .from("jobs")
    .select("customer_type, sla_response_hours, contract_reference")
    .eq("user_id", tenant.userId)
    .eq("customer_phone", callerNumber)
    .order("scheduled_datetime", { ascending: false })
    .limit(1);

  const latestJob = pastJobs?.[0];
  const parts: string[] = [];

  if (latestJob?.customer_type === "commercial") {
    parts.push(
      `This caller is a COMMERCIAL account${
        latestJob.contract_reference ? ` (contract/reference: ${latestJob.contract_reference})` : ""
      }.`,
    );
    if (latestJob.sla_response_hours) {
      parts.push(
        `They have a contracted ${latestJob.sla_response_hours}-hour response SLA — treat scheduling for this call as priority and don't offer a slower timeline than that without flagging it.`,
      );
    }
  } else if (latestJob?.customer_type === "residential") {
    parts.push("This caller is a residential customer — standard scheduling and pricing applies.");
  }

  if (tenant.commercialSlaPolicy) {
    parts.push(`Business policy for commercial/SLA accounts: ${tenant.commercialSlaPolicy}`);
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// assistant-request — Vapi calls this right as the call starts, BEFORE the
// assistant says anything, letting the server return per-call overrides.
//
// We do NOT reconstruct the whole assistant config here — voice, tone, and
// the base system prompt still live on the assistant itself in the Vapi
// dashboard. We only inject one template variable, `caller_context`, which
// the business's system prompt should reference (e.g. include the line
// "Caller info: {{caller_context}}" in the prompt). That keeps the blast
// radius small: if this lookup is slow or fails, the call still proceeds.
//
// Note: assistant-request events typically won't carry call.assistantId yet
// (that's literally what we're being asked to supply) — resolveTenant
// already falls back to phoneNumberId in that case, so no change needed
// there.
//
// NOT LIVE-VERIFIED — same caveat as the file header: re-check the current
// `assistant-request` response shape (`assistantId` + `assistantOverrides.
// variableValues`) against Vapi's docs before relying on this in
// production, and specifically confirm what an empty `{}` response does
// when no tenant matches — it should fall back to a default assistant on
// the phone number, but that must be verified, since a wrong shape here
// could drop the call instead of just skipping personalization.
// ---------------------------------------------------------------------------

import { buildRecordingConsentNotice } from "../_shared/compliance/recordingConsent.ts";
async function handleAssistantRequest(admin: SupabaseClient, message: VapiMessage, requestId: string) {
  const tenant = await resolveTenant(admin, message, requestId);

  if (!tenant || !tenant.assistantId) {
    logEvent("assistant_request_no_tenant", requestId, {});
    return jsonResponse({});
  }

  const callerNumber = message.call?.customer?.number ?? null;
  const callerContext = await buildCallerContextVariable(admin, tenant, callerNumber);
  const customerTypeContext = await buildCustomerTypeContextVariable(admin, tenant, callerNumber);
  const surgeContext = buildSurgeContextVariable(tenant);
  const afterHoursContext = buildAfterHoursContextVariable(tenant, new Date());
  const recordingConsentContext = buildRecordingConsentNotice(callerNumber);

  logEvent("assistant_request_resolved", requestId, {
    user_id: tenant.userId,
    caller_known: callerContext.startsWith("Returning caller"),
    surge_mode_active: tenant.surgeModeEnabled,
    after_hours: afterHoursContext.length > 0,
  });

  return jsonResponse({
    assistantId: tenant.assistantId,
    assistantOverrides: {
      variableValues: {
        caller_context: callerContext,
        customer_type_context: customerTypeContext,
        surge_context: surgeContext,
        after_hours_context: afterHoursContext,
        recording_consent_context: recordingConsentContext,
      },
    },
  });
}
// ---------------------------------------------------------------------------
// Surge Mode — when a business owner flips this on (storm/heat-wave call
// spikes), inject guidance into the assistant's system prompt via the
// `surge_context` template variable (see handleAssistantRequest below).
// Returns "" when surge mode is off, so {{surge_context}} in the prompt
// just renders empty and changes nothing.
// ---------------------------------------------------------------------------

function buildSurgeContextVariable(tenant: TenantContext): string {
  if (!tenant.surgeModeEnabled) {
    return "";
  }
  const parts: string[] = ["SURGE MODE IS ACTIVE."];
  if (tenant.surgeModePriority) {
    parts.push(`Prioritize calls about: ${tenant.surgeModePriority}.`);
  }
  if (tenant.surgeModeMessage) {
    parts.push(`Mention to callers: "${tenant.surgeModeMessage}"`);
  }
  if (tenant.surgeMaxBookingsPerDay) {
    parts.push(
      `Today's booking capacity is limited to ${tenant.surgeMaxBookingsPerDay} jobs — if a caller can't be booked today because capacity is full, offer the next available day instead.`,
    );
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// On-call schedule resolution — picks whoever is on duty right now from
// business_profile.on_call_schedule, so emergency calls route to a rotating
// on-call person (or a different weekend number) instead of one fixed
// technician. See the migration comment for the exact jsonb shape.
//
// All matching below runs in the Edge Function runtime's local time
// (typically UTC). If a business operates in a different timezone, the
// weekday/day-of-month boundaries will be off by the UTC offset — worth
// adding a per-business timezone column if that turns out to matter.
// ---------------------------------------------------------------------------

interface OnCallRule {
  type: "weekday" | "even_odd" | "date_range";
  days?: number[];
  parity?: "even" | "odd";
  start?: string;
  end?: string;
}

interface OnCallEntry {
  id?: string;
  label?: string;
  phone?: string;
  rule?: OnCallRule;
}

function resolveOnCallTarget(schedule: OnCallEntry[] | null, now: Date): string | null {
  if (!schedule || schedule.length === 0) return null;

  for (const entry of schedule) {
    if (!isValidE164(entry.phone)) continue;
    const rule = entry.rule;
    if (!rule) continue;

    if (rule.type === "weekday" && Array.isArray(rule.days) && rule.days.includes(now.getUTCDay())) {
      return entry.phone;
    }
    if (rule.type === "even_odd" && rule.parity) {
      const isEven = now.getUTCDate() % 2 === 0;
      if ((rule.parity === "even") === isEven) return entry.phone;
    }
    if (rule.type === "date_range" && rule.start && rule.end) {
      const todayStr = now.toISOString().slice(0, 10);
      if (todayStr >= rule.start && todayStr <= rule.end) return entry.phone;
    }
  }

  return null;
}
// ---------------------------------------------------------------------------
// After-hours fee disclosure — computes whether a given moment (either
// "right now" for the live call, or a proposed booking time) falls
// outside the business's configured hours, so the fee can be disclosed
// BEFORE booking rather than surprising the customer on the invoice.
//
// All matching runs in the Edge Function runtime's local time (typically
// UTC). If a business operates in a different timezone, the open/close
// boundaries will be off by the UTC offset — same caveat as the on-call
// schedule above; worth adding a per-business timezone column if that
// turns out to matter in practice.
// ---------------------------------------------------------------------------

interface DayHours {
  open?: string;
  close?: string;
  closed?: boolean;
}

type BusinessHoursMap = Partial<Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", DayHours>>;

interface HolidayEntry {
  id?: string;
  date?: string;
  label?: string;
  message?: string;
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function isAfterHoursAt(
  businessHours: BusinessHoursMap | null,
  holidays: HolidayEntry[] | null,
  checkTime: Date,
): boolean {
  const dateStr = checkTime.toISOString().slice(0, 10);
  if (holidays?.some((h) => h.date === dateStr)) {
    return true; // a configured holiday closure counts as after-hours
  }

  if (!businessHours) return false; // no hours configured — don't guess a fee applies

  const dayKey = DAY_KEYS[checkTime.getUTCDay()];
  const hours = businessHours[dayKey];
  if (!hours || hours.closed || !hours.open || !hours.close) {
    return true;
  }

  const minutesNow = checkTime.getUTCHours() * 60 + checkTime.getUTCMinutes();
  const [openH, openM] = hours.open.split(":").map(Number);
  const [closeH, closeM] = hours.close.split(":").map(Number);
  return minutesNow < openH * 60 + openM || minutesNow >= closeH * 60 + closeM;
}

function buildAfterHoursContextVariable(tenant: TenantContext, now: Date): string {
  if (!tenant.afterHoursFee) return "";
  if (!isAfterHoursAt(tenant.businessHours, tenant.holidays, now)) return "";
  return (
    tenant.afterHoursFeeNote ??
    `This call is happening after hours. Let the caller know a $${tenant.afterHoursFee} after-hours fee applies before confirming any booking.`
  );
}
async function handleTransferDestinationRequest(
  admin: SupabaseClient,
  message: VapiMessage,
  requestId: string,
) {
  const tenant = await resolveTenant(admin, message, requestId);

  if (!tenant) {
    logEvent("transfer_no_tenant", requestId, {});
    // Safe, controlled failure: no destination we can vouch for exists, so
    // we don't guess a number. Vapi's assistant will hear this back and can
    // apologize / take a message instead of silently failing.
    return jsonResponse({ error: "No matching business configuration found for this call." }, 200);
  }

  // If the calling assistant already has emergency context flagged for this
  // call (set via the flag_emergency_call tool earlier in the same call),
  // prefer a configured emergency escalation target over the general
  // forwarding number.
  const vapiCallId = message.call?.id;
  let emergencyTarget: string | null = null;

  let humanTransferTarget: string | null = null;

  if (vapiCallId) {
    const { data: callRow } = await admin
      .from("calls")
      .select("is_emergency, human_transfer_requested")
      .eq("vapi_call_id", vapiCallId)
      .eq("user_id", tenant.userId)
      .maybeSingle();

    if (callRow?.is_emergency) {
      emergencyTarget =
        resolveOnCallTarget(tenant.onCallSchedule, new Date()) ??
        findEscalationTarget(tenant.escalationRules, "emergency");
    }
    if (callRow?.human_transfer_requested) {
      humanTransferTarget = findEscalationTarget(tenant.escalationRules, "human_request");
    }
  }

  const destinationNumber = emergencyTarget ?? humanTransferTarget ?? tenant.forwardingNumber;

  if (!isValidE164(destinationNumber)) {
    logEvent("transfer_no_valid_number", requestId, { user_id: tenant.userId });
    return jsonResponse(
      { error: "This business has not configured a valid forwarding number yet." },
      200,
    );
  }

  logEvent("transfer_resolved", requestId, {
    user_id: tenant.userId,
    used_emergency_target: Boolean(emergencyTarget),
    used_human_transfer_target: Boolean(humanTransferTarget),
  });

  return jsonResponse({
    destination: {
      type: "number",
      number: destinationNumber,
      message: emergencyTarget
        ? "This is an emergency — connecting you now, please hold."
        : humanTransferTarget
          ? "Connecting you with a team member now, please hold."
          : "One moment, connecting you now.",
    },
  });
}

// ---------------------------------------------------------------------------
// tool-calls
// ---------------------------------------------------------------------------

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

async function toolLookupCustomer(
  admin: SupabaseClient,
  tenant: TenantContext,
  args: Record<string, unknown>,
  callerNumber: string | null,
): Promise<string> {
  const phone = (typeof args.phone === "string" && args.phone.trim()) || callerNumber;
  if (!phone) {
    return "No phone number was provided, so I can't look up this customer.";
  }

  const { data: pastCalls, error: callsError } = await admin
    .from("calls")
    .select("caller_name, summary, call_datetime, status")
    .eq("user_id", tenant.userId)
    .eq("caller_phone", phone)
    .order("call_datetime", { ascending: false })
    .limit(3);

  const { data: pastJobs, error: jobsError } = await admin
    .from("jobs")
    .select("customer_name, service_type, job_status, scheduled_datetime, warranty_expires_at, warranty_notes, customer_type, sla_response_hours, contract_reference")
    .eq("user_id", tenant.userId)
    .eq("customer_phone", phone)
    .order("scheduled_datetime", { ascending: false })
    .limit(3);

  if (callsError || jobsError) {
    return "I couldn't reach the customer records system right now.";
  }

  if ((!pastCalls || pastCalls.length === 0) && (!pastJobs || pastJobs.length === 0)) {
    return "This looks like a new customer — no prior calls or jobs on file.";
  }

  const parts: string[] = [];
  if (pastCalls && pastCalls.length > 0) {
    const latest = pastCalls[0];
    parts.push(
      `Returning caller${latest.caller_name ? ` (${latest.caller_name})` : ""}, last called ${new Date(
        latest.call_datetime,
      ).toDateString()}${latest.summary ? `: ${latest.summary}` : "."}`,
    );
  }
  if (pastJobs && pastJobs.length > 0) {
    const latestJob = pastJobs[0];
    parts.push(
      `Most recent job: ${latestJob.service_type ?? "service"} (${latestJob.job_status})${
        latestJob.scheduled_datetime ? ` on ${new Date(latestJob.scheduled_datetime).toDateString()}` : ""
      }.`,
    );

    if (latestJob.warranty_expires_at) {
      const warrantyDate = new Date(latestJob.warranty_expires_at);
      const stillCovered = warrantyDate.getTime() >= Date.now();
      parts.push(
        stillCovered
          ? `This job is still under warranty until ${warrantyDate.toDateString()}${
              latestJob.warranty_notes ? ` (${latestJob.warranty_notes})` : ""
            } — check with the caller whether the new issue is related before quoting a repair charge.`
          : `That job's warranty expired ${warrantyDate.toDateString()}, so a new visit for it would not be covered.`,
      );
    }
    if (latestJob.customer_type === "commercial") {
      parts.push(
        `This is a COMMERCIAL account${
          latestJob.contract_reference ? ` (contract/reference: ${latestJob.contract_reference})` : ""
        }.`,
      );
      if (latestJob.sla_response_hours) {
        parts.push(
          `Contracted SLA: respond within ${latestJob.sla_response_hours} hours — treat this as priority.`,
        );
      }
    } else if (latestJob.customer_type === "residential") {
      parts.push("This is a residential customer — standard scheduling and pricing applies.");
    }
  }

  // Membership upsell hook — see 20260912060000_quote_followups_and_financing.sql
  // and MembershipsPage.tsx. This is what actually lets Sarah know a caller's
  // membership status instead of just showing it in the dashboard.
  const { data: existingMembership } = await admin
    .from("memberships")
    .select("status, plan:membership_plans(name)")
    .eq("user_id", tenant.userId)
    .eq("customer_phone", phone)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingMembership) {
    const planName = (existingMembership as { plan?: { name?: string } | null }).plan?.name ?? "a membership plan";
    if (existingMembership.status === "active") {
      parts.push(`This customer already has an active membership (${planName}) — no need to pitch one.`);
    } else if (existingMembership.status === "offered") {
      parts.push(`This customer was previously offered ${planName} but hasn't started it — a good moment to follow up on that.`);
    }
  } else {
    const { data: activePlans } = await admin
      .from("membership_plans")
      .select("name")
      .eq("user_id", tenant.userId)
      .eq("active", true)
      .limit(1);
    if (activePlans && activePlans.length > 0) {
      parts.push(`This customer has no membership on file — "${activePlans[0].name}" is available to offer if it fits the call.`);
    }
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Server-side technician suggestion — a lightweight port of
// src/lib/dispatch.ts's suggestTechnicians() ranking (skill match +
// remaining capacity that day), so a hint can be attached to the job the
// moment Sarah books it over the phone.
//
// This writes only an informational `dispatch_note` — never
// `assigned_technician_id`. That column means a HUMAN has committed the
// job to a technician and drives the Dispatch Board's "unassigned jobs"
// queue (see DispatchBoardPage.tsx); writing to it here would silently
// skip human review. The Dispatch Board's own live ranking stays the
// real source of truth — this is just a head start for whoever opens it.
//
// Deliberately conservative: if nobody has this exact service_type listed
// in their `skills`, we return null rather than guessing at a "closest"
// match, since a wrong guess in a dispatch note is worse than no note.
// ---------------------------------------------------------------------------

async function suggestTechnicianNote(
  admin: SupabaseClient,
  tenant: TenantContext,
  serviceType: string | null,
  scheduledDatetime: string | null,
): Promise<string | null> {
  if (!serviceType) return null;

  const { data: technicians } = await admin
    .from("team_members")
    .select("id, member_name, member_email, skills, max_jobs_per_day")
    .eq("account_owner_id", tenant.userId)
    .eq("role", "technician")
    .eq("invite_status", "active")
    .eq("dispatch_enabled", true);

  if (!technicians || technicians.length === 0) return null;

  const skilled = technicians.filter((t) => Array.isArray(t.skills) && t.skills.includes(serviceType));
  if (skilled.length === 0) return null;

  let dayStart: Date | null = null;
  let dayEnd: Date | null = null;
  if (scheduledDatetime) {
    dayStart = new Date(scheduledDatetime);
    dayStart.setUTCHours(0, 0, 0, 0);
    dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  }

  let best: { name: string; load: number; capacity: number } | null = null;

  for (const tech of skilled) {
    let load = 0;
    if (dayStart && dayEnd) {
      const { count } = await admin
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", tenant.userId)
        .eq("assigned_technician_id", tech.id)
        .gte("scheduled_datetime", dayStart.toISOString())
        .lt("scheduled_datetime", dayEnd.toISOString());
      load = count ?? 0;
    }
    const capacity = tech.max_jobs_per_day || 6;
    if (load >= capacity) continue;
    if (!best || capacity - load > best.capacity - best.load) {
      best = { name: tech.member_name ?? tech.member_email, load, capacity };
    }
  }

  if (!best) return null;
  return `Suggested technician: ${best.name} (skill match: ${serviceType}, ${best.load}/${best.capacity} jobs that day). A human dispatcher should confirm before assigning.`;
}

async function toolBookAppointment(
  admin: SupabaseClient,
  tenant: TenantContext,
  args: Record<string, unknown>,
  vapiCallId: string | undefined,
  callerNumber: string | null,
): Promise<string> {
  const customerName = typeof args.customer_name === "string" ? args.customer_name.trim() : "";
  if (!customerName) {
    return "I need the customer's name before I can book this appointment.";
  }

  const scheduledDatetime = typeof args.scheduled_datetime === "string" ? args.scheduled_datetime : null;
  if (scheduledDatetime && Number.isNaN(Date.parse(scheduledDatetime))) {
    return "That appointment date/time isn't valid — please confirm the date and time with the customer.";
  }

  if (tenant.surgeModeEnabled && tenant.surgeMaxBookingsPerDay && scheduledDatetime) {
    const dayStart = new Date(scheduledDatetime);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const { count } = await admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", tenant.userId)
      .gte("scheduled_datetime", dayStart.toISOString())
      .lt("scheduled_datetime", dayEnd.toISOString());

    if ((count ?? 0) >= tenant.surgeMaxBookingsPerDay) {
      return `Surge mode is active and today's booking capacity (${tenant.surgeMaxBookingsPerDay}) is already full — offer the customer the next available day instead of booking this one.`;
    }
  }

  let callId: string | null = null;
  if (vapiCallId) {
    const callRow = await upsertCallRow(admin, tenant, vapiCallId, { status: "booked" }, "tool-book-appointment");
    callId = callRow?.id ?? null;
  }

  const serviceType = typeof args.service_type === "string" ? args.service_type : null;
  const dispatchNote = await suggestTechnicianNote(admin, tenant, serviceType, scheduledDatetime);

  const jobPayload = {
    user_id: tenant.userId,
    call_id: callId,
    customer_name: customerName,
    customer_phone: (typeof args.phone === "string" && args.phone.trim()) || callerNumber || null,
    service_type: serviceType,
    address: typeof args.address === "string" ? args.address : null,
    scheduled_datetime: scheduledDatetime,
    job_status: "scheduled",
    dispatch_note: dispatchNote,
  };

  const { data: job, error: jobError } = await admin
    .from("jobs")
    .insert(jobPayload)
    .select("id, scheduled_datetime, service_type, address")
    .maybeSingle();

  if (jobError || !job) {
    return "I wasn't able to save this appointment due to a system error — please have the office confirm it manually.";
  }

  const baseMessage = job.scheduled_datetime
    ? `Booked for ${customerName} on ${new Date(job.scheduled_datetime).toLocaleString()}.`
    : `Booked for ${customerName}. Exact time still needs to be confirmed.`;

  const { data: profile } = await admin
    .from("business_profile")
    .select("ai_dispatch_enabled")
    .eq("user_id", tenant.userId)
    .maybeSingle();

  if (profile?.ai_dispatch_enabled) {
    const assignment = await assignBestTechnician(admin, tenant.userId, job);

    if (assignment.technicianName) {
      return `${baseMessage} Assigned to ${assignment.technicianName}.`;
    }
  }

  return baseMessage;
}

async function toolCheckWeather(args: Record<string, unknown>): Promise<string> {
  const location = typeof args.location === "string" ? args.location.trim() : "";
  if (!location) {
    return "I need a city or zip code to check the weather.";
  }

  try {
    // Open-Meteo: free, keyless, no account required — a real lookup, not a
    // simulated one. (If Vireek later wants a branded/paid provider, swap
    // this block; no other part of the file depends on it.)
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(location)}`,
    );
    if (!geoRes.ok) throw new Error(`geocoding_http_${geoRes.status}`);
    const geo = await geoRes.json();
    const place = geo?.results?.[0];
    if (!place) {
      return `I couldn't find a location matching "${location}".`;
    }

    const forecastRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit`,
    );
    if (!forecastRes.ok) throw new Error(`forecast_http_${forecastRes.status}`);
    const forecast = await forecastRes.json();
    const current = forecast?.current;
    if (!current) {
      return `I found ${place.name} but couldn't get current conditions right now.`;
    }

    return `Current conditions near ${place.name}: ${Math.round(current.temperature_2m)}°F, wind ${Math.round(
      current.wind_speed_10m,
    )} mph.`;
  } catch (error) {
    console.error(JSON.stringify({ event: "check_weather_failed", error: error instanceof Error ? error.message : String(error) }));
    return "I couldn't reach the weather service right now — I'll continue without that information.";
  }
}
// ---------------------------------------------------------------------------
// lookup_price — feature 45, "Live Price Book". Lets the assistant quote a
// real, tenant-configured price during the call instead of guessing or
// promising to "have someone call back with pricing."
// ---------------------------------------------------------------------------

async function toolLookupPrice(
  admin: SupabaseClient,
  tenant: TenantContext,
  args: Record<string, unknown>,
): Promise<string> {
  const query = typeof args.service === "string" ? args.service.trim() : "";
  if (!query) {
    return "I need to know which service they're asking about before I can quote a price.";
  }

  const { data: items, error } = await admin
    .from("price_book_items")
    .select("service_name, category, pricing_model, price_cents, price_max_cents, unit_label, keywords")
    .eq("user_id", tenant.userId)
    .eq("active", true);

  if (error) {
    return "I couldn't reach the price list right now — let the caller know a team member will confirm pricing.";
  }
  if (!items || items.length === 0) {
    return "No price list has been set up for this business yet — let the caller know a team member will follow up with pricing.";
  }

  const needle = query.toLowerCase();
  const scored = items
    .map((item) => {
      const haystacks = [item.service_name, item.category ?? "", ...(item.keywords ?? [])].map((s: string) => s.toLowerCase());
      const exact = haystacks.some((h) => h === needle);
      const partial = haystacks.some((h) => h.includes(needle) || needle.includes(h));
      return { item, score: exact ? 2 : partial ? 1 : 0 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return `Nothing on the price list matches "${query}" — let the caller know a team member will confirm that price.`;
  }

  const matches = scored.slice(0, 3).map(({ item }) => formatPriceLine(item));
  return matches.length === 1 ? matches[0] : `A few things matched "${query}": ${matches.join(" ")}`;
}

function formatPriceLine(item: {
  service_name: string;
  pricing_model: string;
  price_cents: number;
  price_max_cents: number | null;
  unit_label: string | null;
}): string {
  const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
  const unit = item.unit_label ? ` ${item.unit_label}` : "";

  switch (item.pricing_model) {
    case "starting_at":
      return `${item.service_name}: starting at ${money(item.price_cents)}${unit}.`;
    case "range":
      return `${item.service_name}: ${money(item.price_cents)}–${money(item.price_max_cents ?? item.price_cents)}${unit}.`;
    case "hourly":
      return `${item.service_name}: ${money(item.price_cents)}${unit || "/hour"}.`;
    default:
      return `${item.service_name}: ${money(item.price_cents)}${unit}.`;
  }
}

async function toolFlagEmergencyCall(
  admin: SupabaseClient,
  tenant: TenantContext,
  args: Record<string, unknown>,
  vapiCallId: string | undefined,
  callerNumber: string | null,
  callerName: string | null,
): Promise<string> {
  const reason = typeof args.reason === "string" ? args.reason : typeof args.description === "string" ? args.description : null;

  const escalationTarget = findEscalationTarget(tenant.escalationRules, "emergency");

  const patch: Record<string, unknown> = {
    is_emergency: true,
    caller_phone: callerNumber,
    caller_name: callerName,
    summary: reason,
    status: "new_lead",
  };
  if (escalationTarget) {
    patch.escalated_to = escalationTarget;
    patch.escalated_at = new Date().toISOString();
  }

  const callRow = await upsertCallRow(admin, tenant, vapiCallId, patch, "tool-flag-emergency");

  if (!callRow) {
    // Even if the DB write failed, tell the assistant to keep treating this
    // as an emergency in-conversation — never let a persistence failure
    // silently downgrade emergency handling.
    return "This has been treated as an emergency. Please connect the caller to the on-call number immediately regardless of system status.";
  }

  // Inserting/updating `calls.is_emergency = true` fires the existing
  // `trigger_notify_emergency_call` trigger (see
  // 20260831090000_notifications_and_audit_log.sql), which creates the
  // dashboard/notification-center alert — we don't duplicate that logic here.
  return escalationTarget
    ? "Emergency flagged and the on-call contact will be notified. Please transfer the caller now."
    : "Emergency flagged. This business has no dedicated emergency contact configured, so please transfer to the main forwarding number now.";
}
// ---------------------------------------------------------------------------
// request_human_transfer — caller explicitly asks for a live person,
// independent of flag_emergency_call (no emergency implied). Mirrors the
// is_emergency pattern: sets a flag on the calls row, which
// handleTransferDestinationRequest then checks to pick the right
// escalation target (falls back to the general forwarding number if no
// "human_request" rule is configured).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// pitch_membership / record_membership_decision — AI upsell during the
// call. membership_plans / memberships already existed (dashboard CRUD +
// funnel tracking with status offered/active/cancelled) — this is the
// only piece that was missing: something that actually offers it live.
// ---------------------------------------------------------------------------

async function toolPitchMembership(
  admin: SupabaseClient,
  tenant: TenantContext,
  callerNumber: string | null,
  callerName: string | null,
): Promise<string> {
  const { data: plans, error } = await admin
    .from("membership_plans")
    .select("id, name, price_cents, billing_interval, benefits")
    .eq("user_id", tenant.userId)
    .eq("active", true)
    .limit(2);

  if (error) {
    return "I couldn't reach the membership plan details right now — don't pitch a plan on this call.";
  }
  if (!plans || plans.length === 0) {
    return "This business doesn't have a membership plan configured — nothing to offer.";
  }

  const plan = plans[0];
  const dollars = (plan.price_cents / 100).toFixed(plan.price_cents % 100 === 0 ? 0 : 2);
  const interval = plan.billing_interval === "yearly" ? "year" : "month";
  const benefitsLine = plan.benefits?.length ? ` Includes: ${plan.benefits.join(", ")}.` : "";

  if (callerNumber) {
    await admin.from("memberships").insert({
      user_id: tenant.userId,
      plan_id: plan.id,
      customer_name: callerName || "Caller",
      customer_phone: callerNumber,
      status: "offered",
    });
  }

  return `Pitch this to the caller: the ${plan.name} is $${dollars}/${interval}.${benefitsLine} Ask if they'd like to sign up right now.`;
}

async function toolRecordMembershipDecision(
  admin: SupabaseClient,
  tenant: TenantContext,
  args: Record<string, unknown>,
  callerNumber: string | null,
): Promise<string> {
  const accepted = args.accepted === true || args.accepted === "true";
  if (!callerNumber) {
    return "No caller phone number on this call, so I can't record a membership decision.";
  }

  const { data: offer } = await admin
    .from("memberships")
    .select("id")
    .eq("user_id", tenant.userId)
    .eq("customer_phone", callerNumber)
    .eq("status", "offered")
    .order("offered_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!offer) {
    return "No pending membership offer found for this caller to update.";
  }

  if (accepted) {
    await admin.from("memberships").update({ status: "active", started_at: new Date().toISOString() }).eq("id", offer.id);
    return "Recorded — the caller signed up for the membership. Thank them and let them know a confirmation will follow.";
  }

  return "Recorded that the caller wasn't ready to sign up today. The offer stays on file in case they change their mind.";
}
async function toolCheckBillingStatus(
  admin: SupabaseClient,
  tenant: TenantContext,
  callerNumber: string | null,
): Promise<string> {
  if (!callerNumber) {
    return "I don't have a phone number for this caller, so I can't look up billing.";
  }

  const { data: jobs, error } = await admin
    .from("jobs")
    .select("service_type, invoice_amount, invoice_status, scheduled_datetime")
    .eq("user_id", tenant.userId)
    .eq("customer_phone", callerNumber)
    .order("created_at", { ascending: false })
    .limit(3);

  if (error) {
    return "I couldn't reach the billing system right now — let the caller know a team member will follow up.";
  }
  if (!jobs || jobs.length === 0) {
    return "No jobs or invoices are on file for this phone number.";
  }

  const unpaid = jobs.filter((j) => j.invoice_status !== "paid" && j.invoice_amount != null);
  if (unpaid.length === 0) {
    return "Every invoice on file for this caller is already marked paid — nothing outstanding.";
  }

  const lines = unpaid.map(
    (j) =>
      `${j.service_type ?? "Service"}: $${Number(j.invoice_amount).toFixed(2)} (${j.invoice_status === "sent" ? "invoice sent, unpaid" : "not yet invoiced"})`,
  );
  return `Here's what's outstanding: ${lines.join("; ")}.`;
}

// ---------------------------------------------------------------------------
// reschedule_appointment — lets the caller move their own upcoming job
// without a human. Clears assigned_technician_id rather than trying to
// re-assign automatically — there's no AI Dispatcher yet (separate
// feature), so an unassigned job after a reschedule is meant to surface
// on the Dispatch Board for a human to re-assign.
// ---------------------------------------------------------------------------

async function toolRescheduleAppointment(
  admin: SupabaseClient,
  tenant: TenantContext,
  args: Record<string, unknown>,
  callerNumber: string | null,
): Promise<string> {
  if (!callerNumber) {
    return "I don't have a phone number for this caller, so I can't find their appointment.";
  }

  const newDatetimeRaw = typeof args.new_datetime === "string" ? args.new_datetime : "";
  const newDatetime = newDatetimeRaw ? new Date(newDatetimeRaw) : null;
  if (!newDatetime || Number.isNaN(newDatetime.getTime())) {
    return "That doesn't look like a valid date/time — ask the caller for a specific day and time and try again.";
  }
  if (newDatetime.getTime() < Date.now()) {
    return "That time is in the past — ask the caller for a future date and time.";
  }

  const { data: job, error: findError } = await admin
    .from("jobs")
    .select("id, service_type")
    .eq("user_id", tenant.userId)
    .eq("customer_phone", callerNumber)
    .eq("job_status", "scheduled")
    .gte("scheduled_datetime", new Date().toISOString())
    .order("scheduled_datetime", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (findError) {
    return "I couldn't reach the scheduling system right now — let the caller know a team member will follow up.";
  }
  if (!job) {
    return "No upcoming appointment was found for this phone number to reschedule.";
  }

  const { error: updateError } = await admin
    .from("jobs")
    .update({ scheduled_datetime: newDatetime.toISOString(), assigned_technician_id: null })
    .eq("id", job.id);

  if (updateError) {
    return "Something went wrong moving the appointment — let the caller know a team member will confirm manually.";
  }

  return `Done — the ${job.service_type ?? "appointment"} is now scheduled for ${newDatetime.toLocaleString()}. Let the caller know the technician assignment will be confirmed before then.`;
}
async function toolRequestHumanTransfer(
  admin: SupabaseClient,
  tenant: TenantContext,
  args: Record<string, unknown>,
  vapiCallId: string | undefined,
  callerNumber: string | null,
  callerName: string | null,
): Promise<string> {
  const reason = typeof args.reason === "string" ? args.reason : null;

  const escalationTarget = findEscalationTarget(tenant.escalationRules, "human_request");

  const patch: Record<string, unknown> = {
    human_transfer_requested: true,
    caller_phone: callerNumber,
    caller_name: callerName,
  };
  if (reason) {
    patch.summary = reason;
  }

  const callRow = await upsertCallRow(admin, tenant, vapiCallId, patch, "tool-request-human-transfer");

  if (!callRow) {
    return "Understood — please connect the caller to a live person now regardless of system status.";
  }

  return escalationTarget
    ? "Got it — connecting the caller to a live team member now."
    : "Got it — this business has no dedicated live-transfer number configured, so please connect the caller to the main forwarding number now.";
}
async function handleToolCalls(admin: SupabaseClient, message: VapiMessage, requestId: string) {
  const tenant = await resolveTenant(admin, message, requestId);
  const toolCalls = message.toolCalls ?? message.toolCallList ?? [];

  if (!tenant) {
    logEvent("tool_calls_no_tenant", requestId, {});
    const results = toolCalls.map((tc) => ({
      toolCallId: tc.id ?? tc.toolCallId ?? "",
      result: "This call could not be matched to a business account, so no action was taken.",
    }));
    return jsonResponse({ results });
  }

  const vapiCallId = message.call?.id;
  const callerNumber = message.call?.customer?.number ?? null;
  const callerName = message.call?.customer?.name ?? null;

  const results = await Promise.all(
    toolCalls.map(async (tc) => {
      const toolCallId = tc.id ?? tc.toolCallId ?? "";
      const name = tc.function?.name ?? "";
      const args = parseToolArguments(tc.function?.arguments);

      logEvent("tool_call_received", requestId, { user_id: tenant.userId, tool: name });

      let result: string;
      try {
        switch (name) {
          case "lookup_customer":
            result = await toolLookupCustomer(admin, tenant, args, callerNumber);
            break;
          case "book_appointment":
            result = await toolBookAppointment(admin, tenant, args, vapiCallId, callerNumber);
            break;
          case "check_weather":
            result = await toolCheckWeather(args);
            break;
          case "lookup_price":
            result = await toolLookupPrice(admin, tenant, args);
            break;
          case "flag_emergency_call":
            result = await toolFlagEmergencyCall(admin, tenant, args, vapiCallId, callerNumber, callerName);
            break;
          case "request_human_transfer":
            result = await toolRequestHumanTransfer(admin, tenant, args, vapiCallId, callerNumber, callerName);
            break;
          case "pitch_membership":
            result = await toolPitchMembership(admin, tenant, callerNumber, callerName);
            break;
          case "record_membership_decision":
            result = await toolRecordMembershipDecision(admin, tenant, args, callerNumber);
            break;
          case "check_billing_status":
            result = await toolCheckBillingStatus(admin, tenant, callerNumber);
            break;
          case "reschedule_appointment":
            result = await toolRescheduleAppointment(admin, tenant, args, callerNumber);
            break;
          case "capture_insurance_claim":
            result = await toolCaptureInsuranceClaim(admin, tenant, args, vapiCallId, callerNumber, callerName);
            break;
          default:
            logEvent("tool_call_unknown", requestId, { tool: name });
            result = `Tool "${name}" is not implemented by this webhook.`;
        }
      } catch (error) {
        logError("tool_call_failed", requestId, error, { tool: name });
        result = "Something went wrong handling this action — please continue the call and have the office follow up.";
      }

      return { toolCallId, result };
    }),
  );

  return jsonResponse({ results });
}

// ---------------------------------------------------------------------------
// call lifecycle events (status-update, end-of-call-report, hang, etc.)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Call source attribution — looks up which tracking number was dialed (see
// call_tracking_numbers / calls.source_channel in
// 20260913040000_call_attribution.sql), so a call from a Google Business
// Profile listing can be told apart from one dialed off the website, a
// print ad, etc. Multiple tracking numbers can all route to the SAME Vapi
// assistant (that's the point — one AI, several numbers), so this is
// intentionally separate from resolveTenant's assistant/business lookup.
// Returns null for any number that isn't registered — existing
// single-number accounts see no behavior change.
// ---------------------------------------------------------------------------

async function resolveCallSource(admin: SupabaseClient, phoneNumberId: string | undefined): Promise<string | null> {
  if (!phoneNumberId) return null;
  const { data } = await admin
    .from("call_tracking_numbers")
    .select("source")
    .eq("vapi_phone_number_id", phoneNumberId)
    .maybeSingle();
  return data?.source ?? null;
}

// ---------------------------------------------------------------------------
// capture_insurance_claim — for restoration businesses (water/fire/storm
// damage), most jobs run through the customer's insurance rather than
// out-of-pocket. Lets Sarah collect the claim basics during the call and
// hand them to the office's claims workflow. Inserts into
// `insurance_claims`, which fires the SAME dispatch_customer_webhook()
// trigger already used for calls/leads/jobs (see
// 20260913050000_insurance_claims.sql) — this function does not send
// email/SMS itself, it relies entirely on that existing delivery path.
// ---------------------------------------------------------------------------

async function toolCaptureInsuranceClaim(
  admin: SupabaseClient,
  tenant: TenantContext,
  args: Record<string, unknown>,
  vapiCallId: string | undefined,
  callerNumber: string | null,
  callerName: string | null,
): Promise<string> {
  const customerName =
    (typeof args.customer_name === "string" && args.customer_name.trim()) || callerName || null;

  let callId: string | null = null;
  if (vapiCallId) {
    const { data: existingCall } = await admin
      .from("calls")
      .select("id")
      .eq("vapi_call_id", vapiCallId)
      .eq("user_id", tenant.userId)
      .maybeSingle();
    callId = existingCall?.id ?? null;
  }

  const claimPayload = {
    user_id: tenant.userId,
    call_id: callId,
    customer_name: customerName,
    customer_phone: (typeof args.phone === "string" && args.phone.trim()) || callerNumber || null,
    insurance_company: typeof args.insurance_company === "string" ? args.insurance_company : null,
    policy_number: typeof args.policy_number === "string" ? args.policy_number : null,
    claim_number: typeof args.claim_number === "string" ? args.claim_number : null,
    date_of_loss: typeof args.date_of_loss === "string" ? args.date_of_loss : null,
    damage_type: typeof args.damage_type === "string" ? args.damage_type : null,
    adjuster_name: typeof args.adjuster_name === "string" ? args.adjuster_name : null,
    adjuster_phone: typeof args.adjuster_phone === "string" ? args.adjuster_phone : null,
    notes: typeof args.notes === "string" ? args.notes : null,
    status: "new",
  };

  const { error } = await admin.from("insurance_claims").insert(claimPayload);

  if (error) {
    return "I wasn't able to save the insurance details right now — please let the office know this is an insurance claim so they can follow up manually.";
  }

  return "Got it — I've logged this as an insurance claim for our claims team to follow up on.";
}
function mapEndedReasonToOutboundStatus(endedReason: string | undefined, durationSeconds: number | null): string {
  const r = (endedReason ?? "").toLowerCase();
  if (r.includes("voicemail")) return "voicemail_left";
  if (r.includes("no-answer") || r.includes("did-not-answer") || r.includes("busy")) return "no_answer";
  if (durationSeconds && durationSeconds > 5) return "connected";
  return "no_answer";
}

async function updateOutboundCallStatus(admin: SupabaseClient, outboundCallId: string, message: VapiMessage) {
  if (message.type !== "end-of-call-report") return; // ignore intermediate status-update events for outbound rows

  let durationSeconds = message.durationSeconds ?? null;
  if (durationSeconds == null && message.call?.startedAt && message.call?.endedAt) {
    const started = Date.parse(message.call.startedAt);
    const ended = Date.parse(message.call.endedAt);
    if (!Number.isNaN(started) && !Number.isNaN(ended) && ended >= started) {
      durationSeconds = Math.round((ended - started) / 1000);
    }
  }

  await admin
    .from("outbound_calls")
    .update({
      status: mapEndedReasonToOutboundStatus(message.endedReason, durationSeconds),
      outcome_notes: message.summary ?? message.analysis?.summary ?? message.endedReason ?? null,
    })
    .eq("id", outboundCallId);
}

async function handleCallLifecycleEvent(admin: SupabaseClient, message: VapiMessage, requestId: string) {
  const tenant = await resolveTenant(admin, message, requestId);
  if (!tenant) {
    logEvent("lifecycle_event_no_tenant", requestId, { type: message.type });
    // 200, not an error: Vapi doesn't need to retry an event we simply
    // can't attribute to a tenant (e.g. a stale/demo assistant id).
    return jsonResponse({ received: true });
  }

  const vapiCallId = message.call?.id;
  const trackingSource = await resolveCallSource(admin, message.phoneNumber?.id);

  const patch: Record<string, unknown> = {
    caller_phone: message.call?.customer?.number ?? null,
    caller_name: message.call?.customer?.name ?? null,
    source_channel: trackingSource,
  };

  // Lead source attribution — see 20260912070000_call_source_attribution.sql.
  // Only meaningful if the business has set up additional tracking numbers
  // in Call Sources; otherwise this simply finds nothing and the call shows
  // as unattributed, which is the honest default.
  const dialedPhoneNumberId = message.call?.phoneNumberId ?? message.phoneNumber?.id;

  if (dialedPhoneNumberId) {
    const { data: matchedSource } = await admin
      .from("call_sources")
      .select("label")
      .eq("user_id", tenant.userId)
      .eq("vapi_phone_number_id", dialedPhoneNumberId)
      .maybeSingle();

    if (matchedSource?.label) {
      patch.source_label = matchedSource.label;
    }
  }

  if (message.type === "end-of-call-report") {
    const transcript = message.transcript ?? message.artifact?.transcript ?? null;
    const recordingUrl =
      message.recordingUrl ?? message.artifact?.recordingUrl ?? message.artifact?.recording?.stereoUrl ?? null;
    const summary = message.summary ?? message.analysis?.summary ?? null;

    let durationSeconds = message.durationSeconds ?? null;
    if (durationSeconds == null && message.call?.startedAt && message.call?.endedAt) {
      const started = Date.parse(message.call.startedAt);
      const ended = Date.parse(message.call.endedAt);
      if (!Number.isNaN(started) && !Number.isNaN(ended) && ended >= started) {
        durationSeconds = Math.round((ended - started) / 1000);
      }
    }

    Object.assign(patch, {
      transcript,
      recording_url: recordingUrl,
      summary,
      duration_seconds: durationSeconds,
    });

    // Call Intelligence — best-effort enrichment, must never block the
    // calls-row upsert below if the AI call is slow or fails.
    if (transcript) {
      const intelligence = await analyzeCallIntelligence(transcript, summary);
      if (intelligence) {
        Object.assign(patch, intelligence);
        logEvent("call_intelligence_computed", requestId, {
          call_score: intelligence.call_score,
          sentiment: intelligence.sentiment,
          booking_outcome: intelligence.booking_outcome,
        });
      }
    }
  }

  const callRow = await upsertCallRow(admin, tenant, vapiCallId, patch, requestId);
  logEvent("lifecycle_event_processed", requestId, {
    type: message.type,
    user_id: tenant.userId,
    call_row_found: Boolean(callRow),
  });

  return jsonResponse({ received: true });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const requestId = crypto.randomUUID();

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // ---- Auth: verify this request actually came from Vapi -----------------
  const expectedSecret = Deno.env.get("VAPI_SERVER_SECRET");
  if (!expectedSecret) {
    logError("config_error_missing_secret", requestId, "VAPI_SERVER_SECRET is not set");
    return jsonResponse({ error: "Server not configured" }, 500);
  }

  const providedSecret = req.headers.get("x-vapi-secret");
  if (providedSecret !== expectedSecret) {
    logEvent("unauthorized_request", requestId, {});
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  // ---- Parse body ----------------------------------------------------------
  let body: VapiWebhookBody;
  try {
    body = (await req.json()) as VapiWebhookBody;
  } catch (error) {
    logError("invalid_json_body", requestId, error);
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const message = body?.message;
  if (!message || !message.type) {
    logEvent("malformed_payload", requestId, {});
    return jsonResponse({ error: "Missing message.type" }, 400);
  }

  // ---- Supabase admin client -------------------------------------------
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    logError("config_error_missing_supabase_env", requestId, "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
    return jsonResponse({ error: "Server not configured" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  logEvent("webhook_received", requestId, { type: message.type });
  await logToDb(admin, { eventType: message.type, status: "success", requestId });

  try {
    switch (message.type) {
      case "assistant-request":
        return await handleAssistantRequest(admin, message, requestId);

      case "transfer-destination-request":
        return await handleTransferDestinationRequest(admin, message, requestId);

      case "tool-calls":
        return await handleToolCalls(admin, message, requestId);

      case "status-update":
      case "end-of-call-report":
      case "hang":
      case "speech-update":
        return await handleCallLifecycleEvent(admin, message, requestId);

      default:
        logEvent("unhandled_event_type", requestId, { type: message.type });
        return jsonResponse({ received: true });
    }
  } catch (error) {
    logError("unhandled_exception", requestId, error, { type: message.type });
    await logToDb(admin, {
      eventType: message.type,
      status: "error",
      requestId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
