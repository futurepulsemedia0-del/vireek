// supabase/functions/browser-extension/index.ts
//
// API for the Vireek Chrome extension (chrome-extension/): quick lead capture + click-to-call.
// Authenticated with the user's Supabase JWT (platform JWT check ON), like pbx-actions.
// Tenant = get_account_owner_id(); lead writes go through the CALLER's client so RLS applies.
//
//   POST { action: "whoami" }
//   POST { action: "capture_lead", request_id, name?, phone?, email?, company?, service?, note?, page_url?, page_title? }
//   POST { action: "click_to_call", request_id, to, lead_id?, override_reason? }
//   POST { action: "call_status", id }
//   POST { action: "recent", limit? }
//
// Click-to-call = callback bridge: the agent's own phone rings first (pbx extension mobile, else
// profiles.phone); when answered, the customer is dialled showing the business number.
// Gates: E.164 + premium/service-code block, country allow-list, DNC, quiet hours, rate limit, MFA.
//
// Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (already used by the phone system), SITE_URL.
// Deploy: supabase functions deploy browser-extension      (JWT verification stays ON)

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { isDncSuppressed } from "../_shared/compliance/dncCheck.ts";
import { gateOutbound } from "../_shared/messaging/quietHours.ts";
import { resolveCallerId } from "../_shared/pbx/runtime.ts";
import { twilioApi } from "../_shared/pbx/twilio.ts";
import {
  MAX_BODY_BYTES, blockedDestination, buildBridgeTwiml, buildLeadNotes, countryAllowed, isTerminalStatus,
  isValidE164, isValidRequestId, jwtClaims, leadMatchFilter, mapProviderStatus, mapTwilioError, maskPhone,
  mfaState, normalizeLeadInput, pickCallerId, rateLimitDecision, safePageUrl, toE164,
} from "../_shared/browser-extension/logic.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json", ...extra } });
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) =>
  json({ error, code, ...extra }, status);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALLS_PER_MINUTE = 5;
const CALLS_PER_DAY = 150;
const CAPTURES_PER_MINUTE = 30;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Method not allowed");

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return fail(401, "not_authenticated", "Please sign in again.");

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, "payload_too_large", "Request too large.");
  let body: Row;
  try { body = JSON.parse(raw); } catch { return fail(400, "bad_request", "Invalid JSON."); }
  if (!body || typeof body !== "object" || typeof body.action !== "string") return fail(400, "bad_request", "action is required.");

  const { data: owner } = await userClient.rpc("get_account_owner_id");
  if (!owner) return fail(403, "no_account", "No Vireek account found for this user.");

  const mfa = mfaState(jwtClaims(authHeader), (user as Row).factors);
  if (!mfa.satisfied) return fail(403, "mfa_required", "Verify your authenticator code to continue.");

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const ctx = { admin, userClient, user: user as Row, owner: owner as string };

  try {
    switch (body.action) {
      case "whoami": return await whoami(ctx);
      case "capture_lead": return await captureLead(ctx, body);
      case "click_to_call": return await clickToCall(ctx, body);
      case "call_status": return await callStatus(ctx, body);
      case "recent": return await recent(ctx, body);
      default: return fail(400, "unknown_action", "Unknown action.");
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "browser_extension_error", action: body.action, error: String(e).slice(0, 300) }));
    return fail(500, "internal_error", "Something went wrong. Please try again.");
  }
});

type Ctx = { admin: SupabaseClient; userClient: SupabaseClient; user: Row; owner: string };

const twilioConfigured = () => Boolean(Deno.env.get("TWILIO_ACCOUNT_SID") && Deno.env.get("TWILIO_AUTH_TOKEN"));
const appUrl = () => (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");
const displayName = (u: Row, p: Row | null) => String(p?.full_name || u.user_metadata?.full_name || u.email || "").slice(0, 80);

async function agentPhone(c: Ctx): Promise<{ e164: string | null; ext: Row | null }> {
  const { data: ext } = await c.admin.from("pbx_extensions").select("*")
    .eq("account_owner_id", c.owner).eq("user_id", c.user.id).maybeSingle();
  const fromExt = isValidE164(ext?.mobile_e164) ? ext!.mobile_e164 : null;
  if (fromExt) return { e164: fromExt, ext };
  const { data: prof } = await c.admin.from("profiles").select("phone").eq("id", c.user.id).maybeSingle();
  return { e164: toE164(prof?.phone), ext: ext ?? null };
}

async function callerId(c: Ctx, ext: Row | null): Promise<string | null> {
  const candidates: Array<string | null> = [];
  if (ext) { try { candidates.push((await resolveCallerId(c.admin, ext))?.e164 ?? null); } catch { /* pbx not set up */ } }
  const { data: nums } = await c.admin.from("phone_numbers").select("phone_number, is_primary, voice_enabled, status")
    .eq("account_id", c.owner).eq("status", "active").eq("voice_enabled", true)
    .order("is_primary", { ascending: false }).order("created_at", { ascending: true }).limit(5);
  for (const n of (nums ?? []) as Row[]) candidates.push(n.phone_number);
  return pickCallerId(candidates);
}

async function whoami(c: Ctx): Promise<Response> {
  const [{ data: prof }, { data: ownerProf }, agent] = await Promise.all([
    c.admin.from("profiles").select("full_name").eq("id", c.user.id).maybeSingle(),
    c.admin.from("profiles").select("company_name").eq("id", c.owner).maybeSingle(),
    agentPhone(c),
  ]);
  const cid = twilioConfigured() && agent.e164 ? await callerId(c, agent.ext) : null;
  const reason = !twilioConfigured() ? "calling_not_configured" : !agent.e164 ? "no_agent_phone" : !cid ? "no_caller_id" : null;
  const { data: st } = await c.admin.from("pbx_settings").select("outbound_country_codes").eq("account_owner_id", c.owner).maybeSingle();
  return json({
    user: { id: c.user.id, email: c.user.email, name: displayName(c.user, prof) },
    company: ownerProf?.company_name ?? null,
    app_url: appUrl() || null,
    features: {
      lead_capture: { enabled: true },
      click_to_call: { enabled: reason === null, reason, agent_hint: maskPhone(agent.e164), caller_id_hint: maskPhone(cid) },
    },
    country_codes: st?.outbound_country_codes ?? ["+1"],
  });
}

/** Claims the idempotency slot. Returns the existing event when this request was already processed. */
async function claim(c: Ctx, kind: string, requestId: string, extra: Row): Promise<{ event: Row; replay: boolean } | null> {
  const { data, error } = await c.admin.from("browser_extension_events").insert({
    account_owner_id: c.owner, user_id: c.user.id, kind, request_id: requestId, status: "pending", ...extra,
  }).select("*").single();
  if (data) return { event: data, replay: false };
  if (error?.code === "23505") {
    const { data: ex } = await c.admin.from("browser_extension_events").select("*")
      .eq("user_id", c.user.id).eq("kind", kind).eq("request_id", requestId).maybeSingle();
    if (ex) return { event: ex, replay: true };
  }
  throw new Error(`event_insert_failed: ${error?.message}`);
}
const patch = (c: Ctx, id: string, p: Row) => c.admin.from("browser_extension_events").update(p).eq("id", id);
const since = (ms: number) => new Date(Date.now() - ms).toISOString();

async function count(c: Ctx, kind: string, ms: number): Promise<number> {
  const { count: n } = await c.admin.from("browser_extension_events").select("id", { count: "exact", head: true })
    .eq("user_id", c.user.id).eq("kind", kind).gte("created_at", since(ms));
  return n ?? 0;
}

async function captureLead(c: Ctx, body: Row): Promise<Response> {
  const parsed = normalizeLeadInput(body);
  if (!parsed.ok) return fail(422, "invalid_input", parsed.error, { field: parsed.field });
  const l = parsed.value;

  const rl = rateLimitDecision({ minuteCount: await count(c, "lead_capture", 60_000), dayCount: 0, perMinute: CAPTURES_PER_MINUTE, perDay: 1 });
  if (!rl.ok) return fail(429, "rate_limited", "Too many captures. Slow down for a minute.", { retry_after: rl.retryAfterSeconds });

  const slot = await claim(c, "lead_capture", l.requestId, { page_host: l.pageHost });
  if (!slot) return fail(500, "internal_error", "Could not record the request.");
  if (slot.replay) {
    return json({ ok: true, replay: true, duplicate: slot.event.status === "duplicate", lead_id: slot.event.lead_id, lead_url: leadUrl(slot.event.lead_id) });
  }
  const eventId = slot.event.id as string;

  const { data: prof } = await c.admin.from("profiles").select("full_name").eq("id", c.user.id).maybeSingle();
  const notes = buildLeadNotes(l, displayName(c.user, prof) || null, new Date().toISOString());

  const filter = leadMatchFilter(l.phone, l.email);
  if (filter) {
    const { data: dup, error: dupErr } = await c.userClient.from("leads").select("id, name, stage, notes")
      .or(filter).is("deleted_at", null).order("created_at", { ascending: false }).limit(1);
    if (dupErr) console.error(JSON.stringify({ event: "browser_extension_dedupe_failed", error: dupErr.message }));
    const hit = dup?.[0] as Row | undefined;
    if (hit) {
      if (l.note) {
        const merged = `${hit.notes ? `${hit.notes}\n\n` : ""}${notes}`.slice(0, 8000);
        await c.userClient.from("leads").update({ notes: merged }).eq("id", hit.id);
      }
      await patch(c, eventId, { status: "duplicate", lead_id: hit.id });
      return json({ ok: true, duplicate: true, lead_id: hit.id, lead_name: hit.name, stage: hit.stage, lead_url: leadUrl(hit.id) });
    }
  }

  const { data: lead, error } = await c.userClient.from("leads").insert({
    user_id: c.owner, name: l.name, phone: l.phone, email: l.email, service_interested: l.service,
    notes, source: "chrome_extension", stage: "new", tags: ["chrome-extension"],
  }).select("id, name, stage").single();
  if (error || !lead) {
    await patch(c, eventId, { status: "failed", error_code: "lead_insert_failed", error_message: String(error?.message ?? "").slice(0, 300) });
    console.error(JSON.stringify({ event: "browser_extension_lead_insert_failed", error: error?.message }));
    return fail(error?.code === "42501" ? 403 : 502, "lead_insert_failed", "The lead could not be saved. Please try again.");
  }
  await patch(c, eventId, { status: "captured", lead_id: lead.id });
  return json({ ok: true, duplicate: false, lead_id: lead.id, lead_name: lead.name, stage: lead.stage, lead_url: leadUrl(lead.id) }, 201);
}
const leadUrl = (id: string | null) => (id && appUrl() ? `${appUrl()}/dashboard/leads/${id}` : null);

async function clickToCall(c: Ctx, body: Row): Promise<Response> {
  if (!isValidRequestId(body.request_id)) return fail(422, "invalid_input", "A valid request_id is required.", { field: "request_id" });
  const to = toE164(body.to);
  if (!to) return fail(422, "invalid_number", "That phone number is not valid.", { field: "to" });
  const blocked = blockedDestination(to);
  if (blocked) return fail(422, blocked, "Calls to that number are not allowed.");
  if (!twilioConfigured()) return fail(503, "calling_not_configured", "Click-to-call is not enabled for this account yet.");

  const { data: st } = await c.admin.from("pbx_settings").select("outbound_country_codes").eq("account_owner_id", c.owner).maybeSingle();
  if (!countryAllowed(to, st?.outbound_country_codes)) return fail(403, "destination_not_permitted", "Calling that country is not enabled for your account.");

  const agent = await agentPhone(c);
  if (!agent.e164) return fail(409, "no_agent_phone", "Add your mobile number in Vireek (Settings > Profile) so we can ring you first.");
  if (agent.e164 === to) return fail(422, "self_call", "That is your own phone number.");

  let leadId: string | null = null;
  if (body.lead_id !== undefined && body.lead_id !== null) {
    if (typeof body.lead_id !== "string" || !UUID.test(body.lead_id)) return fail(422, "invalid_input", "Invalid lead.", { field: "lead_id" });
    const { data: lead } = await c.userClient.from("leads").select("id").eq("id", body.lead_id).maybeSingle();
    if (!lead) return fail(404, "lead_not_found", "Lead not found.");
    leadId = lead.id;
  }

  const rl = rateLimitDecision({
    minuteCount: await count(c, "click_to_call", 60_000), dayCount: await count(c, "click_to_call", 86_400_000),
    perMinute: CALLS_PER_MINUTE, perDay: CALLS_PER_DAY,
  });
  if (!rl.ok) return fail(429, "rate_limited", "Call limit reached. Try again later.", { retry_after: rl.retryAfterSeconds });

  if (await isDncSuppressed(c.admin, c.owner, to)) return fail(409, "dnc_suppressed", "This number is on your Do-Not-Call list.");

  const override = typeof body.override_reason === "string" && body.override_reason.trim() ? { reason: body.override_reason.trim().slice(0, 200) } : null;
  const gate = await gateOutbound(c.admin, c.owner, {
    channel: "call", to, purpose: leadId ? "service" : "marketing", source: "browser-extension", override,
  });
  if (!gate.proceed) {
    return fail(409, "quiet_hours", "Outside permitted calling hours for this contact.", { send_at: gate.sendAt, local_time: gate.decision.localTime });
  }

  const from = await callerId(c, agent.ext);
  if (!from) return fail(409, "no_caller_id", "No active business phone number is available for calling.");

  const page = safePageUrl(body.page_url);
  const slot = await claim(c, "click_to_call", body.request_id, {
    to_number: to, from_number: from, agent_hint: maskPhone(agent.e164), lead_id: leadId, page_host: page?.host ?? null,
  });
  if (!slot) return fail(500, "internal_error", "Could not record the request.");
  if (slot.replay) return json({ ok: true, replay: true, ...publicEvent(slot.event) });

  const eventId = slot.event.id as string;
  try {
    const twiml = buildBridgeTwiml({ customerE164: to, callerId: from, whisper: "Vireek is connecting your call. Please hold." });
    const res = await twilioApi("Calls.json", { form: { To: agent.e164, From: from, Twiml: twiml, Timeout: "22" } });
    await patch(c, eventId, { provider_sid: res?.sid ?? null, status: "ringing" });
    return json({ ok: true, ...publicEvent({ ...slot.event, status: "ringing", provider_sid: res?.sid }) }, 201);
  } catch (e) {
    const m = mapTwilioError(String(e));
    await patch(c, eventId, { status: "failed", error_code: m.code, error_message: m.message });
    console.error(JSON.stringify({ event: "browser_extension_call_failed", code: m.code }));
    return fail(m.status, m.code, m.message);
  }
}

const publicEvent = (e: Row) => ({
  id: e.id, kind: e.kind, status: e.status, to_masked: maskPhone(e.to_number), agent_hint: e.agent_hint,
  lead_id: e.lead_id, duration_seconds: e.duration_seconds ?? null, error_code: e.error_code ?? null,
  created_at: e.created_at,
});

async function refresh(c: Ctx, e: Row): Promise<Row> {
  if (e.kind !== "click_to_call" || !e.provider_sid || isTerminalStatus(e.status)) return e;
  if (Date.now() - Date.parse(e.created_at) > 6 * 3600_000 || !twilioConfigured()) return e;
  try {
    const r = await twilioApi(`Calls/${e.provider_sid}.json`);
    const status = mapProviderStatus(String(r?.status ?? ""));
    const duration = r?.duration != null ? Math.max(0, Number(r.duration) || 0) : null;
    if (status !== e.status || duration !== e.duration_seconds) {
      await patch(c, e.id, { status, duration_seconds: isTerminalStatus(status) ? duration : null });
      return { ...e, status, duration_seconds: isTerminalStatus(status) ? duration : null };
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "browser_extension_status_failed", error: String(err).slice(0, 200) }));
  }
  return e;
}

async function callStatus(c: Ctx, body: Row): Promise<Response> {
  if (typeof body.id !== "string" || !UUID.test(body.id)) return fail(422, "invalid_input", "Invalid id.");
  const { data: ev } = await c.userClient.from("browser_extension_events").select("*").eq("id", body.id).maybeSingle();
  if (!ev) return fail(404, "not_found", "Call not found.");
  return json({ ok: true, ...publicEvent(await refresh(c, ev)) });
}

async function recent(c: Ctx, body: Row): Promise<Response> {
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 20);
  const { data } = await c.userClient.from("browser_extension_events").select("*")
    .eq("user_id", c.user.id).order("created_at", { ascending: false }).limit(limit);
  const rows = (data ?? []) as Row[];
  let budget = 3;
  const out: Row[] = [];
  for (const r of rows) {
    if (budget > 0 && r.kind === "click_to_call" && !isTerminalStatus(r.status) && r.provider_sid) { budget--; out.push(await refresh(c, r)); }
    else out.push(r);
  }
  return json({ ok: true, items: out.map(publicEvent) });
}
