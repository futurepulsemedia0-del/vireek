// supabase/functions/_shared/audit/service.ts
//
// Orchestration for the Missed-Call Audit. No I/O of its own: everything goes through ports.ts, so the whole flow
// (including every abuse path) is exercised in service.test.ts and in the Playwright flow with mock telephony.
//
// Ordering principle for `start`: cheapest checks first, anything that COSTS money (bot check, lookup, OTP) last,
// and every paid step reserves its cost atomically before it runs.

import { CALL_BASIS, consentSnapshot, CONSENT_TEXTS, CONSENT_VERSION, type ConsentScope } from "./consentText.ts";
import { COST } from "./cost.ts";
import {
  deriveReportToken, hashIdentifier, isWellFormedToken, randomToken, sha256Hex, signUnsubscribe, verifyUnsubscribe,
} from "./crypto.ts";
import { followupEmail, reportReadyEmail, type EmailCtx } from "./emails.ts";
import { interpretCallReport, type RawCallReport } from "./outcome.ts";
import type {
  ApiResult, AuditDeps, AuditRow, CallRow, ClaimedCall, ConsentInsert, RequestMeta, VerificationRow,
} from "./ports.ts";
import {
  assessBusinessPhone, assessEmail, channelFor, cleanBusinessName, isTrade, BLOCKED_LINE_TYPES, REJECTION_MESSAGES, TRADES,
} from "./phonePolicy.ts";
import { estimateRevenueAtRisk, sanitizeAssumptions } from "./revenue.ts";
import { scoreAudit } from "./scoring.ts";
import { canDialNow, DEFAULT_HOURS, normalizeHours, planTestSlots, validateSlots } from "./slots.ts";
import { isValidTimezone } from "../messaging/quietHoursCore.ts";
import { cleanText } from "../speed-to-lead/core.ts";
import { CONDITIONS, SLOT_OF, type Assumptions, type Condition, type ScoredCall } from "./types.ts";

export const OTP_TTL_SECONDS = 600;
export const OTP_MAX_ATTEMPTS = 5;
export const MIN_FORM_MS = 2500;

const ok = (body: Record<string, unknown> = {}, status = 200): ApiResult => ({ status, body });
const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): ApiResult => ({ status, body: { error, message, ...extra } });
const NOT_FOUND = () => fail(404, "not_found", "This report doesn't exist or has expired.");
const UNAVAILABLE = (m = "The Missed-Call Audit is temporarily unavailable. Please try again later.") => fail(503, "unavailable", m);
const iso = (d: Date) => d.toISOString();
const maskPhone = (e164: string) => `(***) ***-${e164.slice(-4)}`;
const maskEmail = (e: string) => `${e.slice(0, 1)}***@${e.slice(e.lastIndexOf("@") + 1)}`;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

async function isOpen(d: AuditDeps, need: "otp" | "calls" = "otp"): Promise<{ open: boolean; reason?: string }> {
  if (d.env.killSwitch) return { open: false, reason: "kill_switch_env" };
  const s = await d.store.getSettings();
  if (!s.enabled) return { open: false, reason: "disabled" };
  if (need === "otp" && !s.otp_enabled) return { open: false, reason: "otp_disabled" };
  if (need === "calls" && !s.calls_enabled) return { open: false, reason: "calls_disabled" };
  return { open: true };
}

// ---------------------------------------------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------------------------------------------
export async function getPublicConfig(d: AuditDeps): Promise<ApiResult> {
  const gate = await isOpen(d);
  return ok({
    available: gate.open,
    calls_available: gate.open && (await isOpen(d, "calls")).open,
    turnstile_site_key: d.env.turnstileSiteKey,
    consent_version: CONSENT_VERSION,
    consent: CONSENT_TEXTS,
    trades: TRADES,
    default_hours: DEFAULT_HOURS,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// start: validate, abuse-check, send the one-time code
// ---------------------------------------------------------------------------------------------------------------
export async function startVerification(d: AuditDeps, raw: unknown, meta: RequestMeta): Promise<ApiResult> {
  const gate = await isOpen(d);
  if (!gate.open) return UNAVAILABLE();
  const b = obj(raw);
  const now = d.now();
  const ipHash = await hashIdentifier(d.env.pepper, "ip", meta.ip ?? "unknown");

  // 1. cheapest guards first
  if (await d.store.isBlocked("ip_hash", ipHash)) return fail(403, "blocked", "We can't run an audit from this connection.");
  if (!(await d.store.consumeRate(`start:ip:h:${ipHash}`, 6, 3600)) || !(await d.store.consumeRate(`start:ip:d:${ipHash}`, 20, 86400))) {
    return fail(429, "rate_limited", "Too many attempts. Please try again later.");
  }
  // Honeypot: a real person never fills the hidden field. Pretend success and send nothing.
  if (cleanText(b.hp, 100)) return ok({ verification_id: crypto.randomUUID(), channel: "sms", expires_in: OTP_TTL_SECONDS, masked_phone: "(***) ***-0000" });
  if (typeof b.elapsed_ms !== "number" || b.elapsed_ms < MIN_FORM_MS) return fail(400, "bot_check_failed", "Please take a moment to review the form and try again.");

  // 2. validate (no cost)
  const settings = await d.store.getSettings();
  const phone = assessBusinessPhone(b.phone, { allowedCountries: settings.allowed_countries });
  if (!phone.ok) return fail(400, "invalid_phone", REJECTION_MESSAGES[phone.reason], { reason: phone.reason, field: "phone" });
  const email = assessEmail(b.email);
  if (!email.ok) return fail(400, "invalid_email", email.reason === "disposable_email" ? "Please use your real business email." : "Enter a valid email address.", { reason: email.reason, field: "email" });
  const businessName = cleanBusinessName(b.business_name);
  if (businessName.length < 2) return fail(400, "invalid_business_name", "Enter your business name.", { field: "business_name" });
  if (!isTrade(b.trade)) return fail(400, "invalid_trade", "Choose your trade.", { field: "trade" });
  const timezone = typeof b.timezone === "string" ? b.timezone : "";
  if (!isValidTimezone(timezone)) return fail(400, "invalid_timezone", "Choose your time zone.", { field: "timezone" });
  if (b.consent_otp !== true || b.attest_owner !== true) return fail(400, "consent_required", "Please confirm you own this line and agree to receive the one-time code.", { field: "consent_otp" });
  const requested = b.channel === "voice" ? "voice" : "sms";

  // 3. bot check (a network call, so after cheap validation)
  if (typeof b.bot_token !== "string" || b.bot_token.length < 10 || !(await d.bot.verify(b.bot_token, meta.ip))) {
    return fail(400, "bot_check_failed", "We couldn't confirm you're a person. Please try again.");
  }

  // 4. per-identity limits and blocklists
  const phoneHash = await hashIdentifier(d.env.pepper, "phone", phone.e164);
  const emailHash = await hashIdentifier(d.env.pepper, "email", email.email);
  if (!(await d.store.consumeRate(`start:phone:h:${phoneHash}`, 3, 3600)) || !(await d.store.consumeRate(`start:phone:d:${phoneHash}`, 5, 86400))
    || !(await d.store.consumeRate(`start:email:d:${emailHash}`, 5, 86400))) {
    return fail(429, "rate_limited", "Too many attempts for this number or email. Please try again tomorrow.");
  }
  if ((await d.store.isBlocked("phone_hash", phoneHash)) || (await d.store.isBlocked("email_hash", emailHash)) || (await d.store.isBlocked("email_domain", email.domain))) {
    return fail(403, "blocked", "We can't run an audit for this number or email.");
  }
  if (await d.store.cooldownActive(phoneHash)) {
    return fail(409, "already_audited", `This number was audited in the last ${settings.cooldown_days} days. Open the report link from your email, or try again later.`);
  }
  if (!(await d.store.tryStart())) return UNAVAILABLE("We're at capacity for today. Please try again tomorrow.");

  // 5. paid steps: reserve first
  let lineType: string | null = null;
  if (d.lookup && d.env.lookupEnabled) {
    if (!(await d.store.reserveDaily(COST.lookupCents))) return UNAVAILABLE("We're at capacity for today. Please try again tomorrow.");
    try {
      lineType = (await d.lookup.lookup(phone.e164)).type;
    } catch (e) {
      d.log("audit_lookup_failed", { error: String(e).slice(0, 200) });
      return fail(503, "lookup_failed", "We couldn't check that number right now. Please try again in a few minutes.");
    }
    await d.store.bump("otp_sent", 0);
    if (lineType && BLOCKED_LINE_TYPES.has(lineType)) return fail(400, "invalid_phone", REJECTION_MESSAGES.premium_number, { reason: "premium_number", field: "phone" });
  }
  const channel = channelFor(phone, requested, lineType);
  if (!(await d.store.reserveDaily(channel === "sms" ? COST.otpSmsCents : COST.otpVoiceCents))) return UNAVAILABLE("We're at capacity for today. Please try again tomorrow.");

  const id = crypto.randomUUID();
  let ref: string | null = null;
  try {
    ref = (await d.otp.start(phone.e164, channel)).ref;
  } catch (e) {
    d.log("audit_otp_send_failed", { channel, error: String(e).slice(0, 200) });
    return fail(502, "otp_failed", "We couldn't send the code. Check the number and try again, or choose the other delivery method.");
  }
  await d.store.bump("otp_sent");

  const snap = await consentSnapshot("otp_message");
  const row: VerificationRow = {
    id, phone_e164: phone.e164, phone_hash: phoneHash, email: email.email, email_hash: emailHash, business_name: businessName,
    trade: b.trade, timezone, channel, ip_hash: ipHash, user_agent: meta.userAgent?.slice(0, 300) ?? null, provider_ref: ref,
    otp_consent_text_version: snap.version, otp_consent_text_sha256: snap.sha256, status: "pending", attempts: 0,
    created_at: iso(now), expires_at: iso(new Date(now.getTime() + OTP_TTL_SECONDS * 1000)), verified_at: null,
  };
  await d.store.supersedePending(phoneHash, id);
  await d.store.insertVerification(row);
  d.log("audit_otp_sent", { channel, country: phone.country });
  return ok({ verification_id: id, channel, expires_in: OTP_TTL_SECONDS, masked_phone: maskPhone(phone.e164) });
}

// ---------------------------------------------------------------------------------------------------------------
// verify: prove control of the number, then create the audit
// ---------------------------------------------------------------------------------------------------------------
async function consentRow(d: AuditDeps, meta: RequestMeta, v: { phone: string; phoneHash: string; email: string; auditId: string | null; verificationId: string | null },
  scope: ConsentScope, evidence: Record<string, unknown>): Promise<ConsentInsert> {
  const snap = await consentSnapshot(scope);
  const capturedAt = iso(d.now());
  const base = {
    audit_id: v.auditId, verification_id: v.verificationId, scope, granted: true, phone_e164: v.phone, phone_hash: v.phoneHash, email: v.email,
    text_version: snap.version, text_sha256: snap.sha256, text_snapshot: snap.text, captured_at: capturedAt,
    ip_address: meta.ip, user_agent: meta.userAgent?.slice(0, 300) ?? null, page_url: meta.pageUrl?.slice(0, 300) ?? null,
    basis: scope === "ai_test_calls" ? CALL_BASIS : scope === "otp_message" ? "One-time verification requested by the person entering the number." : "Separate opt-in checkbox, unchecked by default.",
    evidence,
  };
  return { ...base, record_sha256: await sha256Hex(JSON.stringify({ ...base, evidence: undefined, user_agent: undefined, email: undefined })) };
}

export async function verifyOtp(d: AuditDeps, raw: unknown, meta: RequestMeta): Promise<ApiResult> {
  const gate = await isOpen(d);
  if (!gate.open) return UNAVAILABLE();
  const b = obj(raw);
  const ipHash = await hashIdentifier(d.env.pepper, "ip", meta.ip ?? "unknown");
  if (!(await d.store.consumeRate(`verify:ip:h:${ipHash}`, 40, 3600))) return fail(429, "rate_limited", "Too many attempts. Please try again later.");
  const id = typeof b.verification_id === "string" ? b.verification_id : "";
  const code = typeof b.code === "string" ? b.code.replace(/\s/g, "") : "";
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^\d{4,8}$/.test(code)) return fail(400, "invalid_code", "Enter the 6-digit code.");

  const v = await d.store.getVerification(id);
  const now = d.now();
  if (!v || v.status === "superseded" || v.status === "expired") return fail(400, "code_expired", "That code has expired. Request a new one.");
  if (v.status === "locked") return fail(429, "locked", "Too many wrong codes. Please start again.");
  if (v.status === "verified") return fail(409, "already_verified", "This code was already used.");
  if (now.getTime() > Date.parse(v.expires_at)) {
    await d.store.updateVerification(id, { status: "expired" });
    return fail(400, "code_expired", "That code has expired. Request a new one.");
  }
  // Count the attempt BEFORE checking, so parallel guesses cannot exceed the limit.
  const attempts = v.attempts + 1;
  await d.store.updateVerification(id, { attempts, ...(attempts >= OTP_MAX_ATTEMPTS ? { status: "locked" as const } : {}) });
  if (attempts > OTP_MAX_ATTEMPTS) return fail(429, "locked", "Too many wrong codes. Please start again.");

  let good = false;
  try {
    good = await d.otp.check(v.phone_e164, code, v.provider_ref);
  } catch (e) {
    d.log("audit_otp_check_failed", { error: String(e).slice(0, 200) });
    return fail(502, "otp_failed", "We couldn't check the code. Please try again.");
  }
  if (!good) {
    return fail(400, "wrong_code", attempts >= OTP_MAX_ATTEMPTS ? "Too many wrong codes. Please start again." : "That code isn't right.", { attempts_left: Math.max(0, OTP_MAX_ATTEMPTS - attempts) });
  }

  if (!(await d.store.claimNumber(v.phone_hash))) {
    return fail(409, "already_audited", "This number was audited recently. Open the report link from your email, or try again later.");
  }
  const settings = await d.store.getSettings();
  const auditId = crypto.randomUUID();
  const token = await deriveReportToken(d.env.tokenSecret, auditId);
  const audit: AuditRow = {
    id: auditId, token_hash: await sha256Hex(token), share_token_hash: null, verification_id: v.id, phone_e164: v.phone_e164, phone_hash: v.phone_hash,
    email: v.email, email_hash: v.email_hash, business_name: v.business_name, trade: v.trade, timezone: v.timezone, business_hours: null,
    status: "verified", followup_opt_in: false, assumptions: {}, score: null, cost_cents_reserved: 0, cost_cents_actual: 0,
    created_at: iso(now), confirmed_at: null, completed_at: null, expires_at: iso(new Date(now.getTime() + settings.retention_days * 86_400_000)),
  };
  await d.store.createAudit(audit);
  await d.store.updateVerification(id, { status: "verified", verified_at: iso(now) });
  await d.store.insertConsent(await consentRow(d, meta, { phone: v.phone_e164, phoneHash: v.phone_hash, email: v.email, auditId, verificationId: v.id }, "otp_message",
    { verified_by: v.channel, otp_sent_at: v.created_at, verified_at: iso(now), version: v.otp_consent_text_version }));
  await d.store.addEvent(auditId, "verified", { channel: v.channel });

  const plan = planTestSlots({ now, timezone: v.timezone, hours: DEFAULT_HOURS });
  return ok({
    token, timezone: v.timezone, default_hours: DEFAULT_HOURS,
    proposed: plan.slots.map((s) => ({ condition: s.condition, scheduled_for: iso(s.scheduledFor), window_end: iso(s.windowEnd) })),
    untestable: plan.untestable,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// plan (re-plan for edited hours) and schedule (explicit consent to the exact calls)
// ---------------------------------------------------------------------------------------------------------------
async function loadByToken(d: AuditDeps, token: unknown, kind: "owner" | "share" = "owner"): Promise<AuditRow | null> {
  if (!isWellFormedToken(token)) return null;
  const h = await sha256Hex(token);
  const a = kind === "owner" ? await d.store.getAuditByTokenHash(h) : await d.store.getAuditByShareHash(h);
  if (!a || Date.parse(a.expires_at) <= d.now().getTime()) return null;
  return a;
}

export async function planSchedule(d: AuditDeps, raw: unknown): Promise<ApiResult> {
  const b = obj(raw);
  const a = await loadByToken(d, b.token);
  if (!a) return NOT_FOUND();
  const h = normalizeHours(b.business_hours);
  if (!h.ok) return fail(400, "invalid_hours", "Check your opening hours (at least 4 hours on at least one day).", { reason: h.reason });
  const plan = planTestSlots({ now: d.now(), timezone: a.timezone, hours: h.hours });
  return ok({ proposed: plan.slots.map((s) => ({ condition: s.condition, scheduled_for: iso(s.scheduledFor), window_end: iso(s.windowEnd) })), untestable: plan.untestable });
}

export async function scheduleCalls(d: AuditDeps, raw: unknown, meta: RequestMeta): Promise<ApiResult> {
  const gate = await isOpen(d, "calls");
  if (!gate.open) return UNAVAILABLE("Test calls are paused right now. Your verification is saved; please come back later.");
  const b = obj(raw);
  const a = await loadByToken(d, b.token);
  if (!a) return NOT_FOUND();
  if (a.status !== "verified") return fail(409, "already_scheduled", "This audit is already scheduled.");
  if (b.consent_calls !== true) return fail(400, "consent_required", "Please confirm the test calls to continue.", { field: "consent_calls" });
  if (!(await d.store.consumeRate(`schedule:${a.id}`, 10, 3600))) return fail(429, "rate_limited", "Too many attempts. Please try again later.");

  const h = normalizeHours(b.business_hours);
  if (!h.ok) return fail(400, "invalid_hours", "Check your opening hours (at least 4 hours on at least one day).", { reason: h.reason });
  const slotsIn = Array.isArray(b.slots) ? b.slots.map((s) => ({ condition: String(obj(s).condition), scheduledFor: String(obj(s).scheduled_for) })) : [];
  const v = validateSlots({ now: d.now(), timezone: a.timezone, hours: h.hours }, slotsIn);
  if (!v.ok) return fail(400, "invalid_schedule", "One or more call times aren't allowed.", { errors: v.errors });

  // Reserve every call's cost up front (per-audit cap, then the daily budget).
  for (let i = 0; i < v.slots.length; i++) {
    const r = await d.store.reserveAudit(a.id, COST.callReserveCents);
    if (r !== "ok") {
      d.log("audit_reserve_refused", { reason: r });
      return UNAVAILABLE("We're at capacity for today. Your verification is saved; please try again tomorrow.");
    }
  }
  const rows: CallRow[] = v.slots.map((s) => ({
    id: crypto.randomUUID(), audit_id: a.id, slot: s.slot, condition: s.condition, scheduled_for: iso(s.scheduledFor), window_end: iso(s.windowEnd),
    status: "scheduled", skip_reason: null, vapi_call_id: null, claimed_at: null, placed_at: null, ringing_at: null, answered_at: null, ended_at: null,
    ended_reason: null, ring_seconds: null, duration_seconds: null, answer_kind: null, observations: {}, cost_cents: 0,
  }));
  const owner = sanitizeAssumptions(b.optional_inputs);
  const who = { phone: a.phone_e164, phoneHash: a.phone_hash, email: a.email, auditId: a.id, verificationId: a.verification_id };
  await d.store.insertConsent(await consentRow(d, meta, who, "ai_test_calls", {
    schedule: rows.map((r) => ({ condition: r.condition, scheduled_for: r.scheduled_for, window_end: r.window_end })), timezone: a.timezone, hours: h.hours,
    owner_attested_control: true,
  }));
  const followup = b.followup_opt_in === true;
  if (followup) await d.store.insertConsent(await consentRow(d, meta, who, "email_followup", { checkbox_default: "unchecked" }));
  await d.store.insertCalls(rows);
  await d.store.updateAudit(a.id, {
    status: "scheduled", business_hours: h.hours, confirmed_at: iso(d.now()), followup_opt_in: followup,
    assumptions: { ...a.assumptions, ...owner },
  });
  await d.store.addEvent(a.id, "scheduled", { slots: rows.length, followup });
  return ok({ status: "scheduled", slots: rows.map((r) => ({ condition: r.condition, scheduled_for: r.scheduled_for })) });
}

// ---------------------------------------------------------------------------------------------------------------
// report (owner and shared views), assumptions, share, cancel, delete, unsubscribe
// ---------------------------------------------------------------------------------------------------------------
const toScored = (c: CallRow): ScoredCall => ({ slot: c.slot, condition: c.condition, status: c.status, answer_kind: c.answer_kind, ring_seconds: c.ring_seconds, observations: c.observations });

function timelineOf(calls: CallRow[], a: AuditRow) {
  const ev: { at: string; label: string; slot: number | null }[] = [{ at: a.created_at, label: "Phone number verified", slot: null }];
  const name = (c: Condition) => (c === "business_hours" ? "Business-hours" : c === "lunch" ? "Lunch-time" : "After-hours");
  for (const c of calls) {
    ev.push({ at: c.scheduled_for, label: `${name(c.condition)} test call scheduled`, slot: c.slot });
    if (c.placed_at) ev.push({ at: c.placed_at, label: `${name(c.condition)} test call placed`, slot: c.slot });
    if (c.ended_at && c.status === "completed") {
      const outcome: Record<string, string> = { live_person: "answered by a person", live_ai: "answered by an assistant", ivr: "reached a phone menu", voicemail: "went to voicemail", no_answer: "rang out, no voicemail", busy: "was busy" };
      ev.push({ at: c.ended_at, label: `${name(c.condition)} call ${outcome[c.answer_kind ?? ""] ?? "ended"}${c.ring_seconds !== null && c.answer_kind !== "busy" ? ` after about ${c.ring_seconds}s of ringing` : ""}`, slot: c.slot });
    }
    if (c.status === "skipped" || c.status === "cancelled") ev.push({ at: c.window_end, label: `${name(c.condition)} test call ${c.status === "cancelled" ? "cancelled" : "skipped"}`, slot: c.slot });
    if (c.status === "failed") ev.push({ at: c.ended_at ?? c.scheduled_for, label: `${name(c.condition)} test call couldn't be completed (on our side; not scored)`, slot: c.slot });
  }
  return ev.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

async function reportDto(d: AuditDeps, a: AuditRow, view: "owner" | "shared"): Promise<Record<string, unknown>> {
  const calls = await d.store.listCalls(a.id);
  const scored = calls.map(toScored);
  const score = scoreAudit(scored);
  const pending = calls.some((c) => ["scheduled", "claimed", "dialing"].includes(c.status));
  const planned = planTestSlots({ now: new Date(a.created_at), timezone: a.timezone, hours: a.business_hours ?? DEFAULT_HOURS });
  const base: Record<string, unknown> = {
    view, status: a.status, provisional: pending, business_name: a.business_name, trade: a.trade, timezone: a.timezone,
    created_at: a.created_at, expires_at: a.expires_at, score, timeline: timelineOf(calls, a),
    calls: calls.map((c) => ({ slot: c.slot, condition: c.condition, status: c.status, scheduled_for: c.scheduled_for, window_end: c.window_end,
      answer_kind: c.answer_kind, ring_seconds: c.ring_seconds, duration_seconds: c.duration_seconds, skip_reason: c.skip_reason })),
    not_tested: calls.length ? CONDITIONS.filter((c) => !calls.some((x) => x.condition === c)) : [],
    planned_untestable: planned.untestable,
  };
  if (view === "owner") {
    Object.assign(base, {
      revenue: estimateRevenueAtRisk(scored, a.assumptions),
      benchmark: await d.store.benchmark(),
      can_cancel: pending, can_schedule: a.status === "verified",
      share_enabled: a.share_token_hash !== null, masked_phone: maskPhone(a.phone_e164), masked_email: maskEmail(a.email),
      followup_opt_in: a.followup_opt_in, trial_url: `${d.env.baseUrl}/signup?source=audit`,
    });
  }
  return base;
}

export async function getReport(d: AuditDeps, raw: unknown, meta: RequestMeta): Promise<ApiResult> {
  const b = obj(raw);
  const ipHash = await hashIdentifier(d.env.pepper, "ip", meta.ip ?? "unknown");
  if (!(await d.store.consumeRate(`report:ip:h:${ipHash}`, 200, 3600))) return fail(429, "rate_limited", "Too many requests. Please try again later.");
  const shared = typeof b.share_token === "string";
  const a = await loadByToken(d, shared ? b.share_token : b.token, shared ? "share" : "owner");
  if (!a) return NOT_FOUND();
  return ok(await reportDto(d, a, shared ? "shared" : "owner"));
}

export async function saveAssumptions(d: AuditDeps, raw: unknown): Promise<ApiResult> {
  const b = obj(raw);
  const a = await loadByToken(d, b.token);
  if (!a) return NOT_FOUND();
  const merged: Partial<Assumptions> = { ...a.assumptions, ...sanitizeAssumptions(b.assumptions) };
  await d.store.updateAudit(a.id, { assumptions: merged });
  const calls = (await d.store.listCalls(a.id)).map(toScored);
  return ok({ revenue: estimateRevenueAtRisk(calls, merged) });
}

export async function setShare(d: AuditDeps, raw: unknown): Promise<ApiResult> {
  const b = obj(raw);
  const a = await loadByToken(d, b.token);
  if (!a) return NOT_FOUND();
  if (b.enable === true) {
    const t = randomToken();
    await d.store.updateAudit(a.id, { share_token_hash: await sha256Hex(t) });
    await d.store.addEvent(a.id, "share_enabled");
    return ok({ share_token: t });
  }
  await d.store.updateAudit(a.id, { share_token_hash: null });
  await d.store.addEvent(a.id, "share_disabled");
  return ok({ share_token: null });
}

export async function cancelCalls(d: AuditDeps, raw: unknown): Promise<ApiResult> {
  const a = await loadByToken(d, obj(raw).token);
  if (!a) return NOT_FOUND();
  const n = await d.store.cancelPendingCalls(a.id, "owner_cancelled");
  await d.store.addEvent(a.id, "owner_cancelled", { calls: n });
  await finalizeReady(d);
  return ok({ cancelled: n });
}

/** One click, no login: removes the audit and everything under it. Works even when the feature is switched off. */
export async function deleteAudit(d: AuditDeps, raw: unknown): Promise<ApiResult> {
  const a = await loadByToken(d, obj(raw).token);
  if (!a) return NOT_FOUND();
  const deleted = await d.store.deleteAudit(a.id);
  d.log("audit_deleted_by_owner", { deleted });
  return ok({ deleted });
}

export async function unsubscribe(d: AuditDeps, token: unknown): Promise<ApiResult> {
  const t = typeof token === "string" ? await verifyUnsubscribe(d.env.linkSecret, token) : null;
  if (!t) return fail(400, "invalid_link", "This unsubscribe link isn't valid.");
  await d.store.suppressEmail(t.emailHash, "unsubscribe");
  await d.store.skipQueuedFollowups(t.auditId, "unsubscribed");
  return ok({ unsubscribed: true });
}

// ---------------------------------------------------------------------------------------------------------------
// runner: dial due calls (called by cron)
// ---------------------------------------------------------------------------------------------------------------
export async function runDueCalls(d: AuditDeps): Promise<Record<string, number>> {
  const out: Record<string, number> = { claimed: 0, dialed: 0, skipped: 0, failed: 0 };
  out.reconciled = await reconcileCalls(d);
  out.released = await d.store.releaseStuck();
  const open = await isOpen(d, "calls");
  const due = open.open ? await d.store.claimDueCalls(5) : [];
  out.claimed = due.length;
  for (const c of due) {
    const res = await dialOne(d, c);
    out[res] = (out[res] ?? 0) + 1;
  }
  out.completed = (await finalizeReady(d)).length;
  return out;
}

async function dialOne(d: AuditDeps, c: ClaimedCall): Promise<"dialed" | "skipped" | "failed"> {
  const skip = async (reason: string) => {
    await d.store.updateCall(c.call_id, { status: "skipped", skip_reason: reason, ended_at: iso(d.now()) });
    await d.store.addEvent(c.audit_id, "call_skipped", { slot: c.slot, reason });
    return "skipped" as const;
  };
  const settings = await d.store.getSettings();
  if (d.env.killSwitch || !settings.enabled || !settings.calls_enabled) return skip("kill_switch");
  const audit = await d.store.getAudit(c.audit_id);
  if (!audit || audit.status === "cancelled") return skip("audit_gone");
  // Fail closed on every compliance input.
  if (!(await d.store.hasConsent(c.audit_id, "ai_test_calls"))) return skip("no_consent");
  if (await d.store.isBlocked("phone_hash", audit.phone_hash)) return skip("number_blocked");
  const gate = canDialNow(d.now(), { scheduledFor: new Date(c.scheduled_for), windowEnd: new Date(c.window_end) }, c.timezone, c.phone_e164);
  if (!gate.ok) return skip(gate.reason);
  const reAssess = assessBusinessPhone(c.phone_e164, { allowedCountries: settings.allowed_countries });
  if (!reAssess.ok) return skip(reAssess.reason);

  let placed;
  try {
    placed = await d.calls.place({ auditCallId: c.call_id, toE164: c.phone_e164, businessName: c.business_name });
  } catch (e) {
    // Timeout / network error: the call MAY have been placed. Never retry blindly.
    d.log("audit_dial_state_unknown", { error: String(e).slice(0, 200) });
    await d.store.updateCall(c.call_id, { status: "failed", skip_reason: "dial_state_unknown", answer_kind: "unknown", ended_at: iso(d.now()) });
    return "failed";
  }
  if (!placed.ok) {
    await d.store.updateCall(c.call_id, { status: "failed", skip_reason: placed.reason.slice(0, 80), answer_kind: placed.definitive ? "failed" : "unknown", ended_at: iso(d.now()) });
    await d.store.addEvent(c.audit_id, "call_failed", { slot: c.slot, reason: placed.reason.slice(0, 80) });
    return "failed";
  }
  await d.store.updateCall(c.call_id, { status: "dialing", vapi_call_id: placed.providerCallId, placed_at: iso(d.now()) });
  await d.store.bump("calls_placed");
  await d.store.addEvent(c.audit_id, "call_placed", { slot: c.slot });
  return "dialed";
}

// ---------------------------------------------------------------------------------------------------------------
// provider events (from vapi-webhook) and reconciliation
// ---------------------------------------------------------------------------------------------------------------
export interface ProviderEvent {
  type: "status-update" | "end-of-call-report";
  providerCallId: string | null;
  auditCallId: string | null; // from call metadata
  status?: string; // status-update: ringing | in-progress | ended ...
  at?: string | null;
  report?: RawCallReport;
}

export async function applyProviderEvent(d: AuditDeps, e: ProviderEvent): Promise<{ handled: boolean }> {
  let call = e.providerCallId ? await d.store.getCallByProviderId(e.providerCallId) : null;
  if (!call && e.auditCallId && /^[0-9a-f-]{36}$/.test(e.auditCallId)) {
    const byId = await d.store.getCall(e.auditCallId);
    if (byId && (byId.status === "claimed" || byId.status === "dialing") && (!byId.vapi_call_id || byId.vapi_call_id === e.providerCallId)) {
      call = byId;
      if (e.providerCallId && !byId.vapi_call_id) await d.store.updateCall(byId.id, { vapi_call_id: e.providerCallId });
    }
  }
  if (!call) return { handled: false };

  if (e.type === "status-update") {
    const at = e.at ?? iso(d.now());
    if (e.status === "ringing" && !call.ringing_at) await d.store.updateCall(call.id, { ringing_at: at });
    if (e.status === "in-progress" && !call.answered_at) await d.store.updateCall(call.id, { answered_at: at });
    return { handled: true };
  }
  if (call.status === "completed") return { handled: true }; // end-of-call-report delivered twice
  const r = { ...(e.report ?? {}), ringingAt: e.report?.ringingAt ?? call.ringing_at, answeredAt: e.report?.answeredAt ?? call.answered_at };
  const i = interpretCallReport(r);
  await d.store.updateCall(call.id, {
    status: "completed", ended_at: iso(d.now()), ended_reason: i.ended_reason, ring_seconds: i.ring_seconds, duration_seconds: i.duration_seconds,
    answer_kind: i.answer_kind, observations: i.observations, cost_cents: i.cost_cents,
  });
  const audit = await d.store.getAudit(call.audit_id);
  if (audit) await d.store.updateAudit(audit.id, { cost_cents_actual: audit.cost_cents_actual + i.cost_cents });
  await d.store.addEvent(call.audit_id, "call_completed", { slot: call.slot, answer_kind: i.answer_kind });
  if (i.asked_to_stop && audit) {
    // Honour it everywhere: block the number, cancel what's left, suppress follow-ups.
    await d.store.addBlock("phone_hash", audit.phone_hash, "asked_to_stop_on_test_call");
    await d.store.cancelPendingCalls(audit.id, "asked_to_stop");
    await d.store.skipQueuedFollowups(audit.id, "asked_to_stop");
    await d.store.addEvent(audit.id, "stop_requested", { slot: call.slot });
  }
  await finalizeReady(d);
  return { handled: true };
}

/** Polls the provider for calls whose end report never arrived (webhook lost). Bounded and idempotent. */
export async function reconcileCalls(d: AuditDeps, limit = 5): Promise<number> {
  let n = 0;
  const stale = await d.store.listStaleDialing(iso(new Date(d.now().getTime() - 3 * 60_000)), limit);
  for (const c of stale) {
    if (!c.vapi_call_id) continue;
    try {
      const report = await d.calls.fetchReport(c.vapi_call_id);
      if (report && report.endedReason) {
        await applyProviderEvent(d, { type: "end-of-call-report", providerCallId: c.vapi_call_id, auditCallId: c.id, report });
        n++;
      }
    } catch (e) {
      d.log("audit_reconcile_failed", { error: String(e).slice(0, 200) });
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// completion, email, housekeeping
// ---------------------------------------------------------------------------------------------------------------
export async function finalizeReady(d: AuditDeps): Promise<string[]> {
  const ids = await d.store.completeReady();
  for (const id of ids) {
    const a = await d.store.getAudit(id);
    if (!a) continue;
    const calls = await d.store.listCalls(id);
    const score = scoreAudit(calls.map(toScored));
    await d.store.updateAudit(id, { score });
    // Nothing was testable because of OUR failures: hand the number back so they can try again.
    if (score.conclusive_calls === 0 && !(await d.store.isBlocked("phone_hash", a.phone_hash))) await d.store.releaseNumber(a.phone_hash);
    const settings = await d.store.getSettings();
    const now = d.now();
    const jobs: { audit_id: string; step: 0 | 1 | 2; kind: "transactional" | "followup"; send_at: string }[] = [
      { audit_id: id, step: 0, kind: "transactional", send_at: iso(now) },
    ];
    const stopped = await d.store.isBlocked("phone_hash", a.phone_hash); // asked to stop on a test call
    if (!stopped && a.followup_opt_in && settings.followups_enabled && d.env.postalAddress && score.conclusive_calls > 0) {
      jobs.push({ audit_id: id, step: 1, kind: "followup", send_at: iso(new Date(now.getTime() + 3 * 86_400_000)) });
      jobs.push({ audit_id: id, step: 2, kind: "followup", send_at: iso(new Date(now.getTime() + 10 * 86_400_000)) });
    }
    await d.store.queueEmails(jobs);
    await d.store.addEvent(id, "completed", { total: score.total, conclusive: score.conclusive_calls });
  }
  return ids;
}

export async function sendDueEmails(d: AuditDeps): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  const settings = await d.store.getSettings();
  for (const job of await d.store.claimDueEmails(10)) {
    const skip = async (reason: string) => { await d.store.finishEmail(job.id, "skipped", { skip_reason: reason }); out.skipped++; };
    const a = await d.store.getAudit(job.audit_id);
    if (!a || Date.parse(a.expires_at) <= d.now().getTime()) { await skip("audit_gone"); continue; }
    if (d.env.killSwitch || !settings.enabled) { await d.store.finishEmail(job.id, "failed", { skip_reason: "kill_switch" }); out.failed++; continue; }
    if (job.kind === "followup") {
      if (!settings.followups_enabled) { await skip("followups_disabled"); continue; }
      if (!a.followup_opt_in) { await skip("no_opt_in"); continue; }
      if (!d.env.postalAddress) { await skip("no_postal_address"); continue; }
      if ((await d.store.isEmailSuppressed(a.email_hash)) || (await d.store.isBlocked("email_hash", a.email_hash))) { await skip("suppressed"); continue; }
    } else if (await d.store.isEmailSuppressed(a.email_hash)) { await skip("suppressed"); continue; }

    const token = await deriveReportToken(d.env.tokenSecret, a.id);
    const unsub = await signUnsubscribe(d.env.linkSecret, a.email_hash, a.id);
    const ctx: EmailCtx = {
      businessName: a.business_name, reportUrl: `${d.env.baseUrl}/audit/${token}`, unsubscribeUrl: `${d.env.baseUrl}/audit/unsubscribe/${unsub}`,
      postalAddress: d.env.postalAddress, score: a.score, trialUrl: `${d.env.baseUrl}/signup?source=audit_email`,
    };
    const mail = job.step === 0 ? reportReadyEmail(ctx) : followupEmail(job.step as 1 | 2, ctx);
    try {
      const r = await d.mailer.send({
        to: a.email, subject: mail.subject, html: mail.html, text: mail.text,
        headers: { "List-Unsubscribe": `<${d.env.functionsUrl}/audit-api?action=unsubscribe&t=${encodeURIComponent(unsub)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      });
      await d.store.finishEmail(job.id, "sent", { provider_id: r.id ?? undefined });
      await d.store.bump("emails_sent");
      out.sent++;
    } catch (e) {
      d.log("audit_email_failed", { step: job.step, error: String(e).slice(0, 200) });
      await d.store.finishEmail(job.id, "failed", { skip_reason: "send_error" });
      out.failed++;
    }
  }
  return out;
}

export const housekeeping = (d: AuditDeps) => d.store.purgeExpired();

// ---------------------------------------------------------------------------------------------------------------
// single dispatcher used by the Edge Function and by the e2e mock backend
// ---------------------------------------------------------------------------------------------------------------
export async function handleAction(d: AuditDeps, action: string, body: unknown, meta: RequestMeta): Promise<ApiResult> {
  switch (action) {
    case "config": return getPublicConfig(d);
    case "start": return startVerification(d, body, meta);
    case "verify": return verifyOtp(d, body, meta);
    case "plan": return planSchedule(d, body);
    case "schedule": return scheduleCalls(d, body, meta);
    case "report": return getReport(d, body, meta);
    case "assumptions": return saveAssumptions(d, body);
    case "share": return setShare(d, body);
    case "cancel": return cancelCalls(d, body);
    case "delete": return deleteAudit(d, body);
    case "unsubscribe": return unsubscribe(d, obj(body).t);
    default: return fail(400, "unknown_action", "Unknown action.");
  }
}

export { SLOT_OF };
