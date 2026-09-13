// supabase/functions/vapi-webhook/index.ts
//
// Server URL for the Vapi "Vireek Receptionist" production assistant(s).
// One Edge Function, routed internally by `message.type`:
//
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
    .select("user_id, escalation_rules, assistant_name")
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
      .select("user_id, escalation_rules, assistant_name")
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
      emergencyTarget = findEscalationTarget(tenant.escalationRules, "emergency");
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
    .select("customer_name, service_type, job_status, scheduled_datetime")
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
  }
  return parts.join(" ");
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

  let callId: string | null = null;
  if (vapiCallId) {
    const callRow = await upsertCallRow(admin, tenant, vapiCallId, { status: "booked" }, "tool-book-appointment");
    callId = callRow?.id ?? null;
  }

  const jobPayload = {
    user_id: tenant.userId,
    call_id: callId,
    customer_name: customerName,
    customer_phone: (typeof args.phone === "string" && args.phone.trim()) || callerNumber || null,
    service_type: typeof args.service_type === "string" ? args.service_type : null,
    address: typeof args.address === "string" ? args.address : null,
    scheduled_datetime: scheduledDatetime,
    job_status: "scheduled",
  };

  const { data: job, error: jobError } = await admin.from("jobs").insert(jobPayload).select("id, scheduled_datetime").maybeSingle();

  if (jobError || !job) {
    return "I wasn't able to save this appointment due to a system error — please have the office confirm it manually.";
  }

  return job.scheduled_datetime
    ? `Booked for ${customerName} on ${new Date(job.scheduled_datetime).toLocaleString()}.`
    : `Booked for ${customerName}. Exact time still needs to be confirmed.`;
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

async function handleCallLifecycleEvent(admin: SupabaseClient, message: VapiMessage, requestId: string) {
  const tenant = await resolveTenant(admin, message, requestId);
  if (!tenant) {
    logEvent("lifecycle_event_no_tenant", requestId, { type: message.type });
    // 200, not an error: Vapi doesn't need to retry an event we simply
    // can't attribute to a tenant (e.g. a stale/demo assistant id).
    return jsonResponse({ received: true });
  }

  const vapiCallId = message.call?.id;
  const patch: Record<string, unknown> = {
    caller_phone: message.call?.customer?.number ?? null,
    caller_name: message.call?.customer?.name ?? null,
  };

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
