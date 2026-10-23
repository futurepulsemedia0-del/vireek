// supabase/functions/_shared/speed-to-lead/runtime.ts
//
// I/O side of the speed-to-lead voice callback. All decisions live in core.ts (pure, unit-tested);
// this file loads facts, applies the decision, talks to Vapi, and writes the audit trail.
//
// Invariants (read before changing anything):
//   1. NEVER dial unless decideDial() said "dial" in this same run (consent, DNC, quiet hours, window).
//   2. NEVER re-dial when we cannot prove the previous attempt did not connect (timeouts => needs_review).
//   3. Any lookup failure on a compliance input DEFERS the call (fail closed); it never skips the check.
//   4. Every dial / deferral / skip is logged to speed_to_lead_attempts with the reason.
//   5. Consent rows are append-only; opt-outs are written as NEW rows + dnc_suppressions.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { isDncSuppressed, normalizePhone } from "../compliance/dncCheck.ts";
import { getPreferences } from "../compliance/preferenceCheck.ts";
import { buildRecordingConsentNotice } from "../compliance/recordingConsent.ts";
import { gateOutbound } from "../messaging/quietHours.ts";
import {
  CONSENT_SCOPE,
  buildAssistantBrief,
  buildFirstMessage,
  canonicalJson,
  decideDial,
  nextRetryAt,
  normalizeStlSettings,
  resolveCallOutcome,
  slaResult,
  type GateView,
  type IntakeAssessment,
  type RequestStatus,
  type StlSettings,
} from "./core.ts";

const VAPI_CALL_URL = "https://api.vapi.ai/call";
const VAPI_TIMEOUT_MS = 10_000;
const RECHECK_DELAY_MS = 2 * 60_000;
const SWEEP_BATCH = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceRecord {
  id: string;
  account_owner_id: string;
  name: string;
  kind: string;
  disclosure_text: string;
  disclosure_version: number;
}

export interface RequestRow {
  id: string;
  account_owner_id: string;
  lead_id: string | null;
  source_id: string | null;
  consent_id: string;
  phone_e164: string;
  first_name: string | null;
  full_name: string | null;
  service: string | null;
  message: string | null;
  received_at: string;
  sla_deadline_at: string;
  attempt_count: number;
  status: RequestStatus;
  first_dial_at: string | null;
  last_vapi_call_id: string | null;
}

export interface Deps {
  admin: SupabaseClient;
  vapiKey: string | null;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;

function log(event: string, data: Json = {}): void {
  console.log(JSON.stringify({ event: `stl_${event}`, ...data }));
}

// ---------------------------------------------------------------------------
// Hashing + auth
// ---------------------------------------------------------------------------

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function findSourceByToken(admin: SupabaseClient, token: string): Promise<SourceRecord | null> {
  const { data, error } = await admin
    .from("speed_to_lead_sources")
    .select("id, account_owner_id, name, kind, disclosure_text, disclosure_version")
    .eq("token_hash", await sha256Hex(token))
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw new Error(`source_lookup_failed: ${error.message}`);
  return (data as SourceRecord | null) ?? null;
}

export async function loadSettings(admin: SupabaseClient, ownerId: string): Promise<StlSettings> {
  const { data, error } = await admin.from("speed_to_lead_settings").select("*").eq("account_owner_id", ownerId).maybeSingle();
  if (error) throw new Error(`settings_lookup_failed: ${error.message}`);
  return normalizeStlSettings(data as Json | null);
}

// ---------------------------------------------------------------------------
// Intake: lead + consent proof + request (+ immediate dial is triggered by the caller)
// ---------------------------------------------------------------------------

export interface IntakeResult {
  duplicate: boolean;
  leadId: string | null;
  requestId: string | null;
  willCall: boolean;
  holdReason: string | null;
}

export async function recordIntake(
  admin: SupabaseClient,
  source: SourceRecord,
  a: Extract<IntakeAssessment, { ok: true }>,
  ctx: { ip: string | null; userAgent: string | null },
  settings: StlSettings,
  nowMs = Date.now(),
): Promise<IntakeResult> {
  const owner = source.account_owner_id;
  const dedupeKey = await sha256Hex(`${source.id}|${a.dedupeSeed}`);

  // Idempotency: webhook retries and double-submits must never create a second lead or a second call.
  const { data: existingLead } = await admin
    .from("leads")
    .select("id")
    .eq("user_id", owner)
    .eq("source_external_id", dedupeKey)
    .limit(1)
    .maybeSingle();
  if (existingLead) {
    const { data: existingReq } = await admin
      .from("speed_to_lead_requests")
      .select("id, status")
      .eq("account_owner_id", owner)
      .eq("dedupe_key", dedupeKey)
      .maybeSingle();
    return {
      duplicate: true,
      leadId: existingLead.id as string,
      requestId: (existingReq?.id as string | undefined) ?? null,
      willCall: existingReq?.status === "queued" || existingReq?.status === "dialing",
      holdReason: null,
    };
  }

  const lead = a.lead;
  const { data: leadRow, error: leadErr } = await admin
    .from("leads")
    .insert({
      user_id: owner,
      name: lead.fullName ?? lead.phone ?? lead.email ?? "Web lead",
      phone: lead.phone,
      email: lead.email,
      service_interested: lead.service,
      notes: lead.message,
      stage: "new",
      source: source.kind,
      source_external_id: dedupeKey,
    })
    .select("id")
    .single();
  if (leadErr || !leadRow) throw new Error(`insert_lead_failed: ${leadErr?.message ?? "unknown"}`);
  const leadId = leadRow.id as string;
  await admin.from("speed_to_lead_sources").update({ last_lead_at: new Date(nowMs).toISOString() }).eq("id", source.id);

  // No dialable number => the lead is saved for humans; there is nothing to attach consent to.
  if (!lead.phone) return { duplicate: false, leadId, requestId: null, willCall: false, holdReason: a.holdReason };

  // Consent proof. A form that showed an outdated disclosure version is NOT usable proof (we cannot
  // show what text the person saw), so it is recorded as not granted.
  const granted = a.consentGiven && a.holdReason !== "stale_disclosure";
  const disclosureSha = await sha256Hex(source.disclosure_text);
  const consentFields = {
    account_owner_id: owner,
    source_id: source.id,
    lead_id: leadId,
    phone_e164: lead.phone,
    email: lead.email,
    granted,
    scope: granted ? [CONSENT_SCOPE] : [],
    method: source.kind === "web_form" || source.kind === "landing_page" ? "web_form" : "api",
    disclosure_text: source.disclosure_text,
    disclosure_sha256: disclosureSha,
    disclosure_version: source.disclosure_version,
    captured_at: a.consent.capturedAt.toISOString(),
    ip_address: ctx.ip,
    user_agent: ctx.userAgent?.slice(0, 400) ?? null,
    page_url: a.consent.pageUrl,
    form_id: a.consent.formId,
    submission_id: a.consent.submissionId,
    third_party_proof_url: a.consent.proofUrl,
    evidence: {
      hold_reason: a.holdReason,
      clock_skew: a.consent.clockSkew,
      echoed_disclosure_version: a.consent.echoedDisclosureVersion,
      source_name: source.name,
      source_kind: source.kind,
      consent_checkbox_value: a.consentGiven,
    },
  };
  const recordHash = await sha256Hex(
    canonicalJson({ ...consentFields, evidence: undefined, email: undefined, user_agent: undefined }),
  );
  const { data: consentRow, error: consentErr } = await admin
    .from("speed_to_lead_consents")
    .insert({ ...consentFields, record_sha256: recordHash })
    .select("id")
    .single();
  if (consentErr || !consentRow) throw new Error(`insert_consent_failed: ${consentErr?.message ?? "unknown"}`);

  const callable = a.autoCall && settings.enabled;
  const held = a.holdReason !== null;
  const status: RequestStatus = callable
    ? "queued"
    : a.holdReason === "no_consent"
      ? "suppressed"
      : held
        ? "needs_review"
        : "cancelled";
  const humanReason = callable
    ? null
    : a.holdReason === "no_consent"
      ? "ai_call_not_permitted"
      : (a.holdReason ?? "feature_disabled");

  const { data: reqRow, error: reqErr } = await admin
    .from("speed_to_lead_requests")
    .insert({
      account_owner_id: owner,
      lead_id: leadId,
      source_id: source.id,
      consent_id: consentRow.id,
      phone_e164: lead.phone,
      first_name: lead.firstName,
      full_name: lead.fullName,
      service: lead.service,
      message: lead.message,
      received_at: new Date(nowMs).toISOString(),
      sla_deadline_at: new Date(nowMs + settings.slaSeconds * 1000).toISOString(),
      // 1 s in the past so the immediate claim (next_attempt_at <= now()) can never lose a clock-skew race.
      next_attempt_at: callable ? new Date(nowMs - 1000).toISOString() : null,
      status,
      final_reason: callable ? null : humanReason,
      // A lead we may not auto-call must still reach a human, never silently disappear.
      needs_human: !callable && settings.enabled !== false ? true : !callable && a.holdReason !== null,
      human_reason: humanReason,
      dedupe_key: dedupeKey,
    })
    .select("id")
    .single();
  if (reqErr || !reqRow) {
    if ((reqErr as { code?: string } | null)?.code === "23505") {
      return { duplicate: true, leadId, requestId: null, willCall: false, holdReason: null };
    }
    throw new Error(`insert_request_failed: ${reqErr?.message ?? "unknown"}`);
  }

  if (!callable && held) await notifyHuman(admin, owner, settings, lead.fullName ?? lead.phone, lead.phone, humanReason ?? "review");
  return { duplicate: false, leadId, requestId: reqRow.id as string, willCall: callable, holdReason: a.holdReason };
}

// ---------------------------------------------------------------------------
// Compliance inputs (each throws on lookup failure => the caller defers; never skips a check)
// ---------------------------------------------------------------------------

async function latestConsent(admin: SupabaseClient, owner: string, phone: string) {
  const { data, error } = await admin
    .from("speed_to_lead_consents")
    .select("granted, scope")
    .eq("account_owner_id", owner)
    .eq("phone_e164", phone)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`consent_lookup_failed: ${error.message}`);
  return data ? { granted: data.granted === true, scope: (data.scope as string[] | null) ?? [] } : null;
}

async function dncStrict(admin: SupabaseClient, owner: string, phone: string): Promise<boolean> {
  const { data, error } = await admin
    .from("dnc_suppressions")
    .select("id")
    .eq("user_id", owner)
    .eq("phone_number", normalizePhone(phone))
    .maybeSingle();
  if (error) throw new Error(`dnc_lookup_failed: ${error.message}`);
  if (data) return true;
  return await isDncSuppressed(admin, owner, phone); // optional external registry layer
}

async function voiceOptedOut(admin: SupabaseClient, owner: string, phone: string): Promise<boolean> {
  const digits = phone.replace(/\D/g, "");
  const ten = digits.slice(-10);
  const { data, error } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", owner)
    .in("phone", Array.from(new Set([phone, digits, ten, `+1${ten}`, `1${ten}`])))
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`customer_lookup_failed: ${error.message}`);
  if (!data) return false;
  const prefs = await getPreferences(admin, data.id as string);
  if (prefs === "error") throw new Error("preferences_lookup_failed");
  return prefs.unsubscribedAll || !prefs.voice;
}

async function recentAttempts(admin: SupabaseClient, owner: string, phone: string, now: Date) {
  const { data: reqs, error } = await admin
    .from("speed_to_lead_requests")
    .select("id")
    .eq("account_owner_id", owner)
    .eq("phone_e164", phone)
    .gte("received_at", new Date(now.getTime() - 72 * 3_600_000).toISOString())
    .limit(50);
  if (error) throw new Error(`attempts_lookup_failed: ${error.message}`);
  const ids = (reqs ?? []).map((r: { id: string }) => r.id);
  if (ids.length === 0) return { count: 0, oldest: null as Date | null };
  const { data: att, error: e2 } = await admin
    .from("speed_to_lead_attempts")
    .select("created_at")
    .in("request_id", ids)
    .eq("decision", "dialed")
    .gte("created_at", new Date(now.getTime() - 24 * 3_600_000).toISOString())
    .order("created_at", { ascending: true });
  if (e2) throw new Error(`attempts_lookup_failed: ${e2.message}`);
  const rows = (att ?? []) as { created_at: string }[];
  return { count: rows.length, oldest: rows.length ? new Date(rows[0].created_at) : null };
}

// ---------------------------------------------------------------------------
// Small write helpers
// ---------------------------------------------------------------------------

async function patchRequest(admin: SupabaseClient, id: string, patch: Json, expected: RequestStatus = "dialing") {
  const { error } = await admin
    .from("speed_to_lead_requests")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", expected);
  if (error) log("request_update_failed", { id, error: error.message });
}

async function logAttempt(admin: SupabaseClient, req: RequestRow, row: Json): Promise<string | null> {
  const { data, error } = await admin
    .from("speed_to_lead_attempts")
    .insert({ account_owner_id: req.account_owner_id, request_id: req.id, seq: req.attempt_count + 1, ...row })
    .select("id")
    .single();
  if (error) {
    log("attempt_log_failed", { id: req.id, error: error.message });
    return null;
  }
  return data.id as string;
}

const HUMAN_LABELS: Record<string, string> = {
  caller_requested_human: "asked to speak with a person",
  qualified_lead: "is qualified and ready for a human",
  no_clear_outcome: "spoke with the AI; review and follow up",
  no_contact_after_attempts: "could not be reached after all attempts",
  lead_ttl_exceeded: "went stale before we could call",
  ai_call_not_permitted: "has no AI-call consent; call manually",
  stale_disclosure: "submitted an outdated consent form; review before calling",
  stale_submission: "was an old submission; review before calling",
  voice_not_configured: "could not be called: voice assistant is not configured",
  dial_failed: "could not be called: the call was rejected",
  dial_state_unknown: "may or may not have been called; check before dialing again",
  no_call_report: "was called but no result came back; check the call log",
  feature_disabled: "arrived while speed-to-lead was off",
};

export async function notifyHuman(
  admin: SupabaseClient,
  owner: string,
  settings: StlSettings,
  who: string,
  phone: string,
  reason: string,
): Promise<void> {
  if (!settings.notifyOnHandoff) return;
  const { error } = await admin.from("notifications").insert({
    user_id: owner,
    type: "speed_to_lead_handoff",
    title: "Lead needs a human",
    message: `${who} (${phone}) ${HUMAN_LABELS[reason] ?? "needs follow-up"}.`,
    action_url: "/dashboard/speed-to-lead",
  });
  if (error) log("notify_failed", { error: error.message });
}

// ---------------------------------------------------------------------------
// Process one CLAIMED request (status = dialing)
// ---------------------------------------------------------------------------

export type ProcessResult = "dialed" | "deferred" | "stopped" | "failed" | "needs_review";

export async function processClaimed(deps: Deps, req: RequestRow, nowFn: () => Date = () => new Date()): Promise<ProcessResult> {
  const { admin } = deps;
  const owner = req.account_owner_id;
  const now = nowFn();

  let settings: StlSettings;
  let decision: ReturnType<typeof decideDial>;
  let gate: GateView;
  let tzInfo: { timezone: string; localTime: string };
  try {
    settings = await loadSettings(admin, owner);
    const [consent, dnc, optOut, attempts] = await Promise.all([
      latestConsent(admin, owner, req.phone_e164),
      dncStrict(admin, owner, req.phone_e164),
      voiceOptedOut(admin, owner, req.phone_e164),
      recentAttempts(admin, owner, req.phone_e164, now),
    ]);
    // "marketing" purpose: the quiet-hours gate can never be overridden for a sales-adjacent AI call.
    const g = await gateOutbound(admin, owner, { channel: "call", to: req.phone_e164, purpose: "marketing", source: "speed-to-lead", now });
    gate = g.proceed
      ? { proceed: true, timezone: g.decision.timezone }
      : { proceed: false, sendAt: new Date(g.sendAt), timezone: g.decision.timezone, reason: g.decision.reason };
    tzInfo = { timezone: g.decision.timezone, localTime: g.decision.localTime };

    decision = decideDial({
      now,
      settings,
      request: { receivedAt: new Date(req.received_at), attemptCount: req.attempt_count },
      consent,
      dncSuppressed: dnc,
      voiceOptOut: optOut,
      attemptsLast24h: attempts.count,
      oldestAttemptLast24h: attempts.oldest,
      gate,
    });
  } catch (e) {
    // Fail closed: a compliance input could not be verified => do not dial, try again shortly.
    const msg = e instanceof Error ? e.message : String(e);
    log("check_failed_deferring", { id: req.id, error: msg });
    await logAttempt(admin, req, { decision: "deferred", reason: "compliance_check_failed", detail: { error: msg.slice(0, 300) } });
    await patchRequest(admin, req.id, { status: "queued", next_attempt_at: new Date(now.getTime() + RECHECK_DELAY_MS).toISOString() });
    return "deferred";
  }

  if (decision.action === "defer") {
    await logAttempt(admin, req, { decision: "deferred", reason: decision.reason, timezone: tzInfo.timezone, local_time: tzInfo.localTime, detail: { until: decision.until.toISOString() } });
    await patchRequest(admin, req.id, { status: "queued", next_attempt_at: decision.until.toISOString() });
    return "deferred";
  }

  if (decision.action === "stop") {
    await logAttempt(admin, req, { decision: "skipped", reason: decision.reason, timezone: tzInfo.timezone, local_time: tzInfo.localTime });
    await patchRequest(admin, req.id, {
      status: decision.status,
      final_reason: decision.reason,
      needs_human: decision.needsHuman,
      human_reason: decision.needsHuman ? decision.reason : null,
      next_attempt_at: null,
    });
    if (decision.needsHuman) await notifyHuman(admin, owner, settings, req.full_name ?? req.phone_e164, req.phone_e164, decision.reason);
    return "stopped";
  }

  return await dial(deps, req, settings, tzInfo, now);
}

async function dial(deps: Deps, req: RequestRow, settings: StlSettings, tz: { timezone: string; localTime: string }, now: Date): Promise<ProcessResult> {
  const { admin } = deps;
  const owner = req.account_owner_id;
  const park = async (reason: string, status: RequestStatus = "needs_review") => {
    await logAttempt(admin, req, { decision: "failed", reason, timezone: tz.timezone, local_time: tz.localTime });
    await patchRequest(admin, req.id, { status, final_reason: reason, needs_human: true, human_reason: reason, next_attempt_at: null });
    await notifyHuman(admin, owner, settings, req.full_name ?? req.phone_e164, req.phone_e164, reason);
  };

  const [{ data: biz }, { data: profile }] = await Promise.all([
    admin.from("business_profile").select("vapi_assistant_id, vapi_phone_number_id").eq("user_id", owner).maybeSingle(),
    admin.from("profiles").select("company_name").eq("id", owner).maybeSingle(),
  ]);
  if (!deps.vapiKey || !biz?.vapi_assistant_id || !biz?.vapi_phone_number_id) {
    await park("voice_not_configured");
    return "needs_review";
  }

  const businessName = (profile?.company_name as string | null) ?? "our team";
  const seq = req.attempt_count + 1;
  const sla = slaResult(new Date(req.received_at), now, settings.slaSeconds);

  // Log BEFORE the call so an attempt can never exist without a record.
  const attemptId = await logAttempt(admin, req, { decision: "dialed", reason: "OK", timezone: tz.timezone, local_time: tz.localTime, detail: { sla_ms: sla.ms, sla_met: sla.met } });

  let callId: string | null = null;
  try {
    const res = await (deps.fetchImpl ?? fetch)(VAPI_CALL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.vapiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(VAPI_TIMEOUT_MS),
      body: JSON.stringify({
        assistantId: biz.vapi_assistant_id,
        phoneNumberId: biz.vapi_phone_number_id,
        customer: { number: req.phone_e164, name: req.full_name ?? undefined },
        assistantOverrides: {
          firstMessage: buildFirstMessage({ businessName, firstName: req.first_name, service: req.service }),
          variableValues: {
            call_purpose: "speed_to_lead",
            customer_name: req.full_name ?? "",
            first_name: req.first_name ?? "",
            business_name: businessName,
            service_requested: req.service ?? "",
            recording_consent_context: buildRecordingConsentNotice(req.phone_e164),
            speed_to_lead_context: buildAssistantBrief({
              businessName,
              firstName: req.first_name,
              service: req.service,
              message: req.message,
              qualificationNotes: settings.qualificationNotes,
            }),
          },
        },
      }),
    });

    if (!res.ok) {
      // Definitive rejection: the call was NOT placed, so a retry is safe.
      const body = (await res.text().catch(() => "")).slice(0, 300);
      if (attemptId) await admin.from("speed_to_lead_attempts").update({ decision: "failed", reason: `vapi_http_${res.status}`, detail: { body } }).eq("id", attemptId);
      const retryAt = nextRetryAt(now, settings, seq);
      if (retryAt) {
        await patchRequest(admin, req.id, { status: "queued", attempt_count: seq, next_attempt_at: retryAt.toISOString() });
        return "failed";
      }
      await patchRequest(admin, req.id, { status: "unreachable", attempt_count: seq, final_reason: "dial_failed", needs_human: true, human_reason: "dial_failed", next_attempt_at: null });
      await notifyHuman(admin, owner, settings, req.full_name ?? req.phone_e164, req.phone_e164, "dial_failed");
      return "failed";
    }
    callId = ((await res.json()) as { id?: string }).id ?? null;
  } catch (e) {
    // Timeout / network error: the call MAY have been placed. Never retry blindly.
    log("dial_state_unknown", { id: req.id, error: e instanceof Error ? e.message : String(e) });
    if (attemptId) await admin.from("speed_to_lead_attempts").update({ decision: "failed", reason: "dial_state_unknown" }).eq("id", attemptId);
    await patchRequest(admin, req.id, { status: "needs_review", attempt_count: seq, final_reason: "dial_state_unknown", needs_human: true, human_reason: "dial_state_unknown", next_attempt_at: null });
    await notifyHuman(admin, owner, settings, req.full_name ?? req.phone_e164, req.phone_e164, "dial_state_unknown");
    return "needs_review";
  }

  // Call placed. Persist the correlation id (one retry); if that fails, stl_release_stuck() parks it for a human.
  const patch: Json = { attempt_count: seq, last_vapi_call_id: callId, next_attempt_at: null };
  if (req.first_dial_at === null) Object.assign(patch, { first_dial_at: now.toISOString(), time_to_first_dial_ms: sla.ms, sla_met: sla.met });
  for (let i = 0; i < 2; i++) {
    const { error } = await admin.from("speed_to_lead_requests").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", req.id).eq("status", "dialing");
    if (!error) break;
    log("call_id_save_failed", { id: req.id, try: i, error: error.message });
  }
  if (attemptId && callId) await admin.from("speed_to_lead_attempts").update({ vapi_call_id: callId }).eq("id", attemptId);
  if (req.lead_id) await admin.from("leads").update({ first_response_at: now.toISOString() }).eq("id", req.lead_id).is("first_response_at", null);
  log("dialed", { id: req.id, sla_ms: sla.ms, sla_met: sla.met, attempt: seq });
  return "dialed";
}

// ---------------------------------------------------------------------------
// Entry points used by the edge function
// ---------------------------------------------------------------------------

/** Immediate dial for a freshly created request (runs in waitUntil after the HTTP response). */
export async function dialNow(deps: Deps, requestId: string): Promise<ProcessResult | "not_claimed"> {
  const { data, error } = await deps.admin.rpc("stl_claim_due", { p_limit: 1, p_request_id: requestId });
  if (error) {
    log("claim_failed", { error: error.message });
    return "not_claimed";
  }
  const row = (data as RequestRow[] | null)?.[0];
  return row ? await processClaimed(deps, row) : "not_claimed";
}

/** Cron sweep: park stuck rows, then work through due retries / deferred leads. */
export async function sweep(deps: Deps): Promise<{ released: number; claimed: number; results: Record<string, number> }> {
  const { data: released } = await deps.admin.rpc("stl_release_stuck");
  const { data, error } = await deps.admin.rpc("stl_claim_due", { p_limit: SWEEP_BATCH });
  if (error) throw new Error(`claim_failed: ${error.message}`);
  const rows = (data as RequestRow[] | null) ?? [];
  const results: Record<string, number> = {};
  for (const row of rows) {
    const r = await processClaimed(deps, row);
    results[r] = (results[r] ?? 0) + 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { released: Number(released ?? 0), claimed: rows.length, results };
}

// ---------------------------------------------------------------------------
// End-of-call result (called from vapi-webhook for every end-of-call-report)
// ---------------------------------------------------------------------------

export interface EndOfCallInput {
  vapiCallId: string;
  endedReason: string | null;
  durationSeconds: number | null;
  transcript: string | null;
  summary: string | null;
  structured: Record<string, unknown> | null;
}

export async function applyCallResult(admin: SupabaseClient, input: EndOfCallInput, now = new Date()): Promise<{ handled: boolean; outcome?: string }> {
  const { data: req } = await admin
    .from("speed_to_lead_requests")
    .select("id, account_owner_id, lead_id, phone_e164, full_name, attempt_count, status")
    .eq("last_vapi_call_id", input.vapiCallId)
    .maybeSingle();
  // Not ours, or already finalized (end-of-call-report can be delivered twice).
  if (!req || req.status !== "dialing") return { handled: false };

  const owner = req.account_owner_id as string;
  const settings = await loadSettings(admin, owner);
  const { data: call } = await admin.from("calls").select("booking_outcome, human_transfer_requested").eq("vapi_call_id", input.vapiCallId).maybeSingle();

  const retryAt = nextRetryAt(now, settings, req.attempt_count as number);
  const res = resolveCallOutcome(
    {
      endedReason: input.endedReason,
      durationSeconds: input.durationSeconds,
      transcript: input.transcript,
      structured: input.structured,
      bookedByTool: call?.booking_outcome === "booked",
      humanTransferRequested: call?.human_transfer_requested === true,
    },
    retryAt !== null,
  );

  await admin
    .from("speed_to_lead_attempts")
    .update({ outcome: res.outcome, duration_seconds: input.durationSeconds, ended_reason: input.endedReason, summary: input.summary?.slice(0, 1000) ?? null, completed_at: now.toISOString() })
    .eq("vapi_call_id", input.vapiCallId);

  if (res.suppress) await suppressNumber(admin, owner, req.phone_e164 as string, res.suppress, req.lead_id as string | null);

  if (res.next === "retry") {
    await patchRequest(admin, req.id as string, { status: "queued", next_attempt_at: (retryAt as Date).toISOString() });
  } else {
    await patchRequest(admin, req.id as string, {
      status: res.next,
      final_reason: res.outcome,
      needs_human: res.needsHuman,
      human_reason: res.humanReason,
      next_attempt_at: null,
    });
    if (res.needsHuman && res.humanReason) {
      await notifyHuman(admin, owner, settings, (req.full_name as string | null) ?? (req.phone_e164 as string), req.phone_e164 as string, res.humanReason);
    }
  }
  log("call_result", { id: req.id, outcome: res.outcome, next: res.next });
  return { handled: true, outcome: res.outcome };
}

/** Permanent suppression: DNC list + append-only revocation row + cancel anything still queued for this number. */
async function suppressNumber(admin: SupabaseClient, owner: string, phone: string, why: "dnc" | "wrong_number", leadId: string | null): Promise<void> {
  const text = why === "dnc" ? "Consent revoked during AI call (customer asked to stop)" : "Consent void: wrong number reported on AI call";
  const sha = await sha256Hex(text);
  const capturedAt = new Date().toISOString();
  const fields = {
    account_owner_id: owner, phone_e164: phone, granted: false, scope: [CONSENT_SCOPE],
    method: why === "dnc" ? "revocation_call" : "revocation_wrong_number",
    disclosure_text: text, disclosure_sha256: sha, disclosure_version: 0, lead_id: leadId, captured_at: capturedAt,
  };
  await admin.from("speed_to_lead_consents").insert({ ...fields, record_sha256: await sha256Hex(canonicalJson(fields)) });
  await admin.from("dnc_suppressions").upsert({ user_id: owner, phone_number: normalizePhone(phone), reason: "customer_opt_out" }, { onConflict: "user_id,phone_number", ignoreDuplicates: true });
  await admin
    .from("speed_to_lead_requests")
    .update({ status: "cancelled", final_reason: "consent_revoked", next_attempt_at: null, updated_at: capturedAt })
    .eq("account_owner_id", owner)
    .eq("phone_e164", phone)
    .eq("status", "queued");
}
