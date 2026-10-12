// supabase/functions/dsar-request/index.ts
//
// Public (unauthenticated) endpoint behind /data-request. One function, three
// actions, all POST JSON:
//
//   { action: "submit", kind, email, fullName, relationship, region, details,
//     confirmed, website }          -> creates the request + emails a 6-digit code
//   { action: "verify", requestId, email, code }
//                                   -> verifies identity, then fulfils/queues it
//   { action: "resend", requestId, email }
//                                   -> sends a fresh code (max 4 sends/request)
//
// Security model
//   * Identity = control of the email inbox (one-time code, HMAC-hashed at rest,
//     15 min TTL, 5 attempts, atomic in SQL via dsar_verify_code).
//   * Rate limits are atomic (dsar_consume_rate_limit) and keyed by HMAC of the
//     IP / email, so no raw IP or address is stored in the limiter.
//   * `submit` never reveals whether an account exists for the address; that is
//     only disclosed after the requester has proven control of the inbox.
//   * A verified DELETE from an account owner becomes a normal `full_account`
//     row in `deletion_requests` — grace period, legal-hold trigger and the
//     data-retention-sweep then do the actual erasure.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";
import {
  DSAR_CODE_TTL_MINUTES,
  DSAR_GRACE_PERIOD_DAYS,
  DSAR_MAX_CODE_SENDS,
  buildCodeEmail,
  buildReceiptEmail,
  computeDueAt,
  hashForRateLimit,
  hashVerificationCode,
  generateVerificationCode,
  isCodeFormat,
  normalizeEmail,
  validateSubmission,
  type DsarKind,
  type DsarOutcome,
} from "../_shared/compliance/dsar.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const CONTACT_EMAIL = "ali@vireek.com";
const MAX_BODY_BYTES = 16 * 1024;
const HOUR = 3600;

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

const fail = (code: string, message: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json({ ok: false, code, message, ...extra }, status, headers);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return fail("method_not_allowed", "Method not allowed.", 405);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return fail("too_large", "Request is too large.", 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail("bad_json", "Invalid request body.", 400);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  const pepper = Deno.env.get("DSAR_SECRET") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!pepper) return fail("not_configured", "This service isn't configured yet.", 503);

  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const ipKey = await hashForRateLimit(pepper, `ip:${ip}`);

  async function allowed(bucket: string, limit: number, windowSeconds = HOUR): Promise<boolean> {
    const { data, error } = await admin.rpc("dsar_consume_rate_limit", {
      p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds,
    });
    // Fail closed: if the limiter itself is broken we must not become an open mail relay.
    return !error && data === true;
  }
  const tooMany = () =>
    fail("rate_limited", "Too many attempts. Please wait a while and try again.", 429, {}, { "Retry-After": String(HOUR) });

  async function sendCode(requestId: string, name: string, email: string, reference: string) {
    const code = generateVerificationCode();
    const hash = await hashVerificationCode(pepper, requestId, code);
    const mail = buildCodeEmail({ name, code, reference });
    const sent = await sendEmail(email, mail.subject, mail.html, mail.text);
    return { hash, sent };
  }

  switch (body.action) {
    // ------------------------------------------------------------------ submit
    case "submit": {
      // Honeypot: bots fill hidden fields. Pretend success, store nothing.
      if (typeof body.website === "string" && body.website.trim() !== "") {
        return json({ ok: true, requestId: crypto.randomUUID(), reference: "DSR-PENDING", resendAfterSeconds: 45 });
      }

      const parsed = validateSubmission(body);
      if (!parsed.ok) return fail("validation", "Please check the highlighted fields.", 422, { fieldErrors: parsed.fieldErrors });
      const v = parsed.value;

      const emailKey = await hashForRateLimit(pepper, `email:${v.email}`);
      if (
        !(await allowed(`submit:ip:${ipKey}`, 5)) ||
        !(await allowed(`submit:email:${emailKey}`, 3, 24 * HOUR)) ||
        !(await allowed("submit:global", 300))
      ) return tooMany();

      await admin.rpc("dsar_expire_stale"); // opportunistic housekeeping

      const { data: row, error: insErr } = await admin
        .from("data_subject_requests")
        .insert({
          request_kind: v.kind, requester_email: v.email, requester_name: v.fullName,
          relationship: v.relationship, region: v.region, details: v.details || null, ip_hash: ipKey,
        })
        .select("id, reference")
        .single();
      if (insErr || !row) return fail("server_error", "We couldn't record your request. Please try again.", 500);

      const { hash, sent } = await sendCode(row.id, v.fullName, v.email, row.reference);
      if (!sent.ok) {
        await admin.from("data_subject_requests").delete().eq("id", row.id);
        return fail("email_unavailable",
          `We couldn't send the verification email. Please try again later or write to ${CONTACT_EMAIL}.`, 503);
      }
      await admin.from("data_subject_requests").update({
        verification_code_hash: hash,
        verification_expires_at: new Date(Date.now() + DSAR_CODE_TTL_MINUTES * 60_000).toISOString(),
      }).eq("id", row.id);

      return json({ ok: true, requestId: row.id, reference: row.reference, resendAfterSeconds: 45 });
    }

    // ------------------------------------------------------------------ resend
    case "resend": {
      const email = normalizeEmail(body.email);
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      if (!email || !requestId) return fail("validation", "Missing request details.", 422);
      const emailKey = await hashForRateLimit(pepper, `email:${email}`);
      if (!(await allowed(`resend:ip:${ipKey}`, 10)) || !(await allowed(`resend:email:${emailKey}`, 6))) return tooMany();

      const { data: row } = await admin
        .from("data_subject_requests")
        .select("id, reference, requester_name, requester_email, status, verification_sent_count, created_at")
        .eq("id", requestId)
        .maybeSingle();
      if (!row || row.requester_email !== email || row.status !== "pending_verification") {
        return fail("not_found", "We couldn't find a pending request for those details.", 404);
      }
      if (row.verification_sent_count >= DSAR_MAX_CODE_SENDS) {
        return fail("resend_limit", `Too many codes requested. Please start a new request or write to ${CONTACT_EMAIL}.`, 429);
      }
      const { hash, sent } = await sendCode(row.id, row.requester_name, row.requester_email, row.reference);
      if (!sent.ok) return fail("email_unavailable", "We couldn't send the email. Please try again shortly.", 503);
      await admin.from("data_subject_requests").update({
        verification_code_hash: hash,
        verification_expires_at: new Date(Date.now() + DSAR_CODE_TTL_MINUTES * 60_000).toISOString(),
        verification_attempts: 0,
        verification_sent_count: row.verification_sent_count + 1,
      }).eq("id", row.id);
      return json({ ok: true, resendAfterSeconds: 45 });
    }

    // ------------------------------------------------------------------ verify
    case "verify": {
      const email = normalizeEmail(body.email);
      const requestId = typeof body.requestId === "string" ? body.requestId : "";
      if (!email || !requestId || !isCodeFormat(body.code)) {
        return fail("invalid_code", "Enter the 6-digit code from your email.", 422);
      }
      if (!(await allowed(`verify:ip:${ipKey}`, 30))) return tooMany();

      const codeHash = await hashVerificationCode(pepper, requestId, body.code);
      const { data, error } = await admin.rpc("dsar_verify_code", { p_request_id: requestId, p_email: email, p_code_hash: codeHash });
      const res = Array.isArray(data) ? data[0] : data;
      if (error || !res) return fail("server_error", "We couldn't verify the code. Please try again.", 500);

      switch (res.o_outcome) {
        case "verified":
        case "already_verified":
          break;
        case "invalid":
          return fail("invalid_code", "That code isn't right.", 400, { attemptsLeft: res.o_attempts_left });
        case "locked":
          return fail("locked", "Too many wrong codes. Please start a new request.", 429);
        case "code_expired":
          return fail("code_expired", "That code has expired. Request a new one.", 410);
        case "expired":
          return fail("expired", "This request has expired. Please start a new one.", 410);
        default:
          return fail("not_found", "We couldn't find that request.", 404);
      }

      const kind = res.o_kind as DsarKind;
      const reference = res.o_reference as string;
      const dueAt = new Date(res.o_due_at ?? computeDueAt(new Date()));

      if (res.o_outcome === "already_verified") {
        return json({ ok: true, reference, kind, dueAt: dueAt.toISOString(), outcome: "queued" satisfies DsarOutcome });
      }

      // ---- Identity proven. Match to an account owner (profiles row = owner;
      // team members have none, so they can never trigger a full-account wipe).
      // `.eq` on purpose, not ilike: "_" and "%" in an address are LIKE wildcards.
      let outcome: DsarOutcome = "queued";
      const { data: owner } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();

      if (owner) {
        await admin.from("data_subject_requests").update({ matched_user_id: owner.id }).eq("id", requestId);
      }

      if (owner && kind === "delete") {
        const grace = DSAR_GRACE_PERIOD_DAYS;
        const { data: del, error: delErr } = await admin
          .from("deletion_requests")
          .insert({
            user_id: owner.id,
            requested_by: null,
            request_type: "full_account",
            reason: `Verified public data request ${reference}`,
            grace_period_days: grace,
            scheduled_for: computeDueAt(new Date(), grace).toISOString(),
            dsar_id: requestId,
          })
          .select("id, status")
          .single();
        if (!delErr && del) {
          outcome = del.status === "blocked_legal_hold" ? "deletion_blocked" : "deletion_scheduled";
          try {
            await admin.rpc("log_audit_event", {
              p_user_id: owner.id, p_action: "requested_deletion:full_account:dsar",
              p_target_table: "deletion_requests", p_target_id: del.id,
            });
          } catch { /* audit is best-effort here; the DSAR row itself is the durable record */ }
        }
      }

      // ---- Notifications (best-effort: the request is already durably recorded).
      const { data: info } = await admin
        .from("data_subject_requests").select("requester_name, relationship, region").eq("id", requestId).maybeSingle();

      const receipt = buildReceiptEmail({ name: info?.requester_name ?? "there", reference, kind, dueAt, outcome });
      await sendEmail(email, receipt.subject, receipt.html, receipt.text).catch(() => undefined);

      const staffTo = Deno.env.get("DSAR_NOTIFY_EMAIL") || CONTACT_EMAIL;
      const line = `${reference} · ${kind} · ${info?.relationship ?? "?"} · ${info?.region ?? "?"} · account match: ${owner ? "yes" : "no"} · outcome: ${outcome} · due ${dueAt.toISOString().slice(0, 10)}`;
      await sendEmail(staffTo, `[DSAR] ${reference} verified (${kind})`, `<p>${line}</p>`, line).catch(() => undefined);

      return json({ ok: true, reference, kind, dueAt: dueAt.toISOString(), outcome });
    }

    default:
      return fail("bad_action", "Unknown action.", 400);
  }
});
