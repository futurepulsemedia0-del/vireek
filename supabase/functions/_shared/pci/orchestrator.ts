// supabase/functions/_shared/pci/orchestrator.ts
//
// The pay-by-phone engine. Dependency-injected (database, Twilio, Stripe, clock)
// so the SAME code runs in the edge functions and in the vitest "no card data"
// invariant test with in-memory fakes.
//
// Order of operations is the compliance story, and it is enforced here AND in
// the database:
//   1. verify the job, the open balance and the Stripe account (amount is NEVER taken from the caller/AI)
//   2. create the session + payment request, audit "session_requested"
//   3. PAUSE call recording and VERIFY it           (fail closed: no pause => no capture)
//   4. arm capture (session -> capturing), then move the caller's leg to Twilio <Pay>
//      (the AI/STT pipeline is detached from the leg, so it cannot hear or transcribe DTMF)
//   5. Twilio posts a token + masked metadata; we charge the token on the Stripe Connect destination
//   6. resume recording, audit the outcome, tell the caller the real result
//
// Nothing in this file ever receives, stores or logs card digits. Every write passes
// through assertNoCardData() as a last line of defense.

import { assertNoCardData, deepRedact } from "./cardData.ts";
import {
  type ActorType,
  type AuditEventInput,
  buildAuditEvent,
  type PhonePaymentChannel,
  type PhonePaymentStatus,
  sessionExpiresAt,
  TERMINAL_STATUSES,
} from "./session.ts";
import { buildPayTwiml, buildResultTwiml, parsePayCallback, type PayResult } from "./twilio.ts";

export const MIN_CHARGE_CENTS = 50;
export const MAX_CHARGE_CENTS = 100_000_000;

export interface PhonePaymentRow {
  id: string;
  user_id: string;
  job_id: string;
  payment_request_id: string | null;
  vapi_call_id: string;
  provider_call_sid: string;
  channel: PhonePaymentChannel;
  initiated_by: string | null;
  status: PhonePaymentStatus;
  amount_cents: number;
  currency: string;
  failure_code: string | null;
  card_brand: string | null;
  card_last4: string | null;
  stripe_payment_intent_id: string | null;
  return_to_number: string | null;
  recording_paused_at: string | null;
  recording_resumed_at: string | null;
  capture_started_at: string | null;
  capture_ended_at: string | null;
  expires_at: string;
}

export type SessionPatch = Partial<Omit<PhonePaymentRow, "id" | "user_id">> & { status: PhonePaymentStatus };

export interface ChargeResult {
  id: string;
  status: string;
  amount: number;
  currency: string;
  brand: string | null;
  last4: string | null;
  /** The raw PaymentIntent, handed to finalizeRequestFromIntent (existing, idempotent pipeline). */
  paymentIntent: Record<string, unknown>;
}

export class ChargeError extends Error {
  code: "payment_declined" | "needs_authentication" | "provider_error";
  constructor(code: ChargeError["code"], message: string = code) {
    super(message);
    this.name = "ChargeError";
    this.code = code;
  }
}

export interface PciPorts {
  db: {
    getJob(userId: string, jobId: string): Promise<{ id: string; customer_name: string | null; customer_phone: string | null } | null>;
    getBalanceCents(jobId: string): Promise<number>;
    getConnectDestination(userId: string): Promise<string | null>;
    expireStale(userId: string): Promise<void>;
    findActiveSession(userId: string, vapiCallId: string): Promise<PhonePaymentRow | null>;
    createPaymentRequest(row: { user_id: string; job_id: string; customer_name: string | null; customer_phone: string | null; amount: number }): Promise<{ id: string }>;
    setPaymentRequestStatus(id: string, status: "canceled" | "failed"): Promise<void>;
    insertSession(row: Omit<PhonePaymentRow, "id">): Promise<PhonePaymentRow>;
    getSession(id: string): Promise<PhonePaymentRow | null>;
    /** Compare-and-set: applies `patch` only if the row is currently in one of `from`. Returns the new row or null. */
    transition(id: string, from: PhonePaymentStatus[], patch: SessionPatch): Promise<PhonePaymentRow | null>;
    appendAudit(sessionId: string, userId: string, event: AuditEventInput): Promise<void>;
    /** Stamps recording_resumed_at without touching status (allowed on finished sessions). */
    markRecordingResumed(sessionId: string, atIso: string): Promise<void>;
  };
  twilio: {
    pauseRecordings(callSid: string): Promise<{ paused: number }>;
    resumeRecordings(callSid: string): Promise<{ resumed: number }>;
    redirect(callSid: string, twiml: string): Promise<void>;
  };
  stripe: {
    charge(a: {
      amountCents: number;
      destination: string;
      token: string;
      idempotencyKey: string;
      description: string;
      metadata: Record<string, string>;
      moto: boolean;
    }): Promise<ChargeResult>;
  };
  finalizeRequestFromIntent(paymentIntent: Record<string, unknown>): Promise<{ handled: boolean; status?: string }>;
  /** Vapi call id -> Twilio CallSid of the CUSTOMER leg, or null when the call is not on a Twilio number we control. */
  resolveCallLeg(vapiCallId: string): Promise<string | null>;
  urls: { action(sessionId: string): Promise<string>; status(sessionId: string): Promise<string> };
  config: { payConnector: string; tokenType: "one-time" | "reusable" | "payment-method"; motoEnabled: boolean };
  log(event: string, data?: Record<string, unknown>): void;
  now(): Date;
}

type Writes = PciPorts["db"];

/** Wraps every WRITE with a fail-closed card-data check. A leak blocks the write instead of reaching the database. */
function guarded(db: Writes): Writes {
  return {
    ...db,
    createPaymentRequest: (row) => (assertNoCardData(row, "payment_requests insert"), db.createPaymentRequest(row)),
    insertSession: (row) => (assertNoCardData(row, "phone_payment_sessions insert"), db.insertSession(row)),
    transition: (id, from, patch) => (assertNoCardData(patch, "phone_payment_sessions update"), db.transition(id, from, patch)),
    appendAudit: (sid, uid, e) => (assertNoCardData(e, "phone_payment_audit_events insert"), db.appendAudit(sid, uid, e)),
  };
}

function iso(d: Date): string {
  return d.toISOString();
}

export type StartInput = {
  userId: string;
  jobId: string;
  vapiCallId: string;
  channel: PhonePaymentChannel;
  actorId: string | null;
  /** Staff only: where to reconnect the call after the secure capture (already validated E.164). */
  returnToNumber?: string | null;
};

export type StartResult =
  | { ok: true; sessionId: string; amountCents: number }
  | { ok: false; code: StartFailure; message: string; sessionId?: string };

export type StartFailure =
  | "job_not_found"
  | "already_paid"
  | "below_minimum"
  | "payments_not_configured"
  | "already_in_progress"
  | "unsupported_call_leg"
  | "recording_pause_failed"
  | "redirect_failed"
  | "internal_error";

export async function startPhonePayment(ports: PciPorts, input: StartInput): Promise<StartResult> {
  const db = guarded(ports.db);
  const log = (e: string, d: Record<string, unknown> = {}) => ports.log(e, deepRedact(d));
  const actor: ActorType = input.channel === "ai_agent" ? "ai_agent" : "staff";
  const now = ports.now();

  try {
    await db.expireStale(input.userId);

    const job = await db.getJob(input.userId, input.jobId);
    if (!job) return { ok: false, code: "job_not_found", message: "I couldn't find that job on this account." };

    const balance = await db.getBalanceCents(job.id);
    if (balance <= 0) return { ok: false, code: "already_paid", message: "That job has no open balance." };
    if (balance < MIN_CHARGE_CENTS || balance > MAX_CHARGE_CENTS) {
      return { ok: false, code: "below_minimum", message: "The open balance can't be charged by card on this call." };
    }

    const destination = await db.getConnectDestination(input.userId);
    if (!destination) return { ok: false, code: "payments_not_configured", message: "Card payments aren't set up for this business yet." };

    const existing = await db.findActiveSession(input.userId, input.vapiCallId);
    if (existing) return { ok: false, code: "already_in_progress", message: "A secure payment is already in progress on this call.", sessionId: existing.id };

    const callSid = await ports.resolveCallLeg(input.vapiCallId);
    if (!callSid) {
      // Not a Twilio-backed call we can control. Record it and let the caller fall back to a secure payment link.
      const s = await db.insertSession(newSessionRow(input, now, balance, "unsupported", null));
      await db.appendAudit(s.id, input.userId, buildAuditEvent("session_requested", actor, { channel: input.channel, amount_cents: balance }, input.actorId));
      await db.appendAudit(s.id, input.userId, buildAuditEvent("fallback_payment_link", "system", { reason: "unsupported_call_leg" }));
      await db.transition(s.id, ["requested"], { status: "failed", failure_code: "unsupported_call_leg" });
      return { ok: false, code: "unsupported_call_leg", message: "Card details can't be taken securely on this call.", sessionId: s.id };
    }

    const request = await db.createPaymentRequest({
      user_id: input.userId,
      job_id: job.id,
      customer_name: job.customer_name,
      customer_phone: job.customer_phone,
      amount: balance / 100,
    });

    let session: PhonePaymentRow;
    try {
      session = await db.insertSession(newSessionRow(input, now, balance, callSid, request.id));
    } catch (e) {
      await db.setPaymentRequestStatus(request.id, "canceled").catch(() => undefined);
      // The partial unique index (one active session per call) is the race-proof guard.
      if (isUniqueViolation(e)) return { ok: false, code: "already_in_progress", message: "A secure payment is already in progress on this call." };
      throw e;
    }
    await db.appendAudit(session.id, input.userId, buildAuditEvent("session_requested", actor, { channel: input.channel, amount_cents: balance, currency: "usd" }, input.actorId));

    // ---- 3. pause recording (fail closed) ------------------------------------------------------------
    await db.appendAudit(session.id, input.userId, buildAuditEvent("recording_pause_requested", "system"));
    try {
      const { paused } = await ports.twilio.pauseRecordings(callSid);
      await db.transition(session.id, ["requested"], { status: "recording_paused", recording_paused_at: iso(ports.now()) });
      await db.appendAudit(session.id, input.userId, buildAuditEvent("recording_paused", "system", { provider_recordings: paused }));
    } catch (e) {
      log("recording_pause_failed", { session_id: session.id, error: errMsg(e) });
      await db.appendAudit(session.id, input.userId, buildAuditEvent("recording_pause_failed", "system", { reason: "provider_error" }));
      await failSession(ports, db, session, "recording_pause_failed", false);
      return { ok: false, code: "recording_pause_failed", message: "I can't take card details securely right now.", sessionId: session.id };
    }

    // ---- 4. arm capture, then move the leg to <Pay> ------------------------------------------------------
    const armed = await db.transition(session.id, ["recording_paused"], { status: "capturing", capture_started_at: iso(ports.now()) });
    if (!armed) return { ok: false, code: "internal_error", message: "The secure session could not start.", sessionId: session.id };

    const twiml = buildPayTwiml({
      connector: ports.config.payConnector,
      tokenType: ports.config.tokenType,
      actionUrl: await ports.urls.action(session.id),
      statusCallbackUrl: await ports.urls.status(session.id),
    });
    try {
      await ports.twilio.redirect(callSid, twiml);
    } catch (e) {
      log("capture_redirect_failed", { session_id: session.id, error: errMsg(e) });
      await db.appendAudit(session.id, input.userId, buildAuditEvent("capture_redirect_failed", "system", { reason: "provider_error" }));
      await failSession(ports, db, armed, "redirect_failed", true);
      return { ok: false, code: "redirect_failed", message: "I couldn't move you to the secure line.", sessionId: session.id };
    }
    await db.appendAudit(session.id, input.userId, buildAuditEvent("capture_redirect_sent", "system"));
    await db.appendAudit(session.id, input.userId, buildAuditEvent("capture_started", "provider"));
    return { ok: true, sessionId: session.id, amountCents: balance };
  } catch (e) {
    log("start_phone_payment_failed", { error: errMsg(e) });
    return { ok: false, code: "internal_error", message: "Something went wrong starting the secure payment." };
  }
}

// ---------------------------------------------------------------------------
// Twilio <Pay> progress events (no money moves here, no card data is read)
// ---------------------------------------------------------------------------

export async function handlePayStatus(ports: PciPorts, sessionId: string, params: Record<string, string>): Promise<void> {
  const db = guarded(ports.db);
  const session = await db.getSession(sessionId);
  if (!session || session.status !== "capturing") return;
  const cb = parsePayCallback(params);
  if (cb.callSid && cb.callSid !== session.provider_call_sid) return;
  if (cb.capture) {
    await db.appendAudit(session.id, session.user_id, buildAuditEvent("capture_progress", "provider", { field: cb.capture }));
  }
}

// ---------------------------------------------------------------------------
// Twilio <Pay> result -> charge the token -> TwiML for the caller
// ---------------------------------------------------------------------------

export async function handlePayAction(ports: PciPorts, sessionId: string, params: Record<string, string>): Promise<{ twiml: string }> {
  const db = guarded(ports.db);
  const log = (e: string, d: Record<string, unknown> = {}) => ports.log(e, deepRedact(d));
  const cb = parsePayCallback(params);

  const session = await db.getSession(sessionId);
  if (!session) return { twiml: buildResultTwiml("failed") };
  const back = session.channel === "staff" ? session.return_to_number : null;
  const done = (kind: "approved" | "declined" | "failed" | "cancelled") => ({ twiml: buildResultTwiml(kind, { returnToNumber: back }) });

  // Retries / duplicates: answer from the final state, never charge twice.
  if (TERMINAL_STATUSES.has(session.status)) return done(session.status === "succeeded" ? "approved" : session.status === "cancelled" ? "cancelled" : "failed");
  if (session.status === "tokenized" || session.status === "charging") return done("approved");

  if (cb.callSid && cb.callSid !== session.provider_call_sid) {
    await db.appendAudit(session.id, session.user_id, buildAuditEvent("callback_rejected", "system", { reason: "call_sid_mismatch" }));
    return done("failed");
  }
  if (session.status !== "capturing") return done("failed");

  if (ports.now().getTime() > Date.parse(session.expires_at)) {
    await db.appendAudit(session.id, session.user_id, buildAuditEvent("session_expired", "system"));
    await failSession(ports, db, session, "expired", true, "expired");
    return done("failed");
  }

  // ---- capture did not produce a token ---------------------------------------------------------------
  if (cb.result !== "success" || !cb.token) {
    const code = failureCodeFor(cb.result);
    await db.appendAudit(session.id, session.user_id, buildAuditEvent("capture_failed", "provider", { result: cb.result ?? "none", reason: code }));
    await failSession(ports, db, session, code, true);
    return done("failed");
  }

  await db.appendAudit(session.id, session.user_id, buildAuditEvent("capture_completed", "provider", { card_brand: cb.cardBrand, card_last4: cb.cardLast4 }));
  const tokenized = await db.transition(session.id, ["capturing"], {
    status: "tokenized",
    card_brand: cb.cardBrand,
    card_last4: cb.cardLast4,
    capture_ended_at: iso(ports.now()),
  });
  if (!tokenized) return done("approved"); // a concurrent retry owns this session
  await db.appendAudit(session.id, session.user_id, buildAuditEvent("tokenized", "provider"));

  // ---- the balance may have moved while the caller was typing ------------------------------------------------
  const balance = await db.getBalanceCents((await db.getSession(session.id))?.job_id ?? session.job_id);
  if (balance < session.amount_cents) {
    await failSession(ports, db, tokenized, "balance_changed", true);
    return done("failed");
  }

  const charging = await db.transition(session.id, ["tokenized"], { status: "charging" });
  if (!charging) return done("approved");
  await db.appendAudit(session.id, session.user_id, buildAuditEvent("charge_attempted", "system", { amount_cents: session.amount_cents, currency: session.currency }));

  try {
    const destination = await db.getConnectDestination(session.user_id);
    if (!destination) throw new ChargeError("provider_error", "no destination");

    const charge = await ports.stripe.charge({
      amountCents: session.amount_cents,
      destination,
      token: cb.token,
      idempotencyKey: `phone-pay-${session.id}`,
      description: `Phone payment (job ${session.job_id.slice(0, 8)})`,
      metadata: {
        flow: "phone_dtmf_v1",
        payment_request_id: session.payment_request_id ?? "",
        user_id: session.user_id,
        job_id: session.job_id,
        phone_payment_session_id: session.id,
        base_cents: String(session.amount_cents),
        tip_cents: "0",
      },
      moto: ports.config.motoEnabled,
    });

    if (charge.status !== "succeeded") throw new ChargeError("needs_authentication");

    try {
      await ports.finalizeRequestFromIntent(charge.paymentIntent);
    } catch (e) {
      // Money moved; the Stripe webhook retries finalization idempotently. Never undo the session over this.
      log("finalize_after_phone_charge_failed", { session_id: session.id, error: errMsg(e) });
    }

    await db.transition(session.id, ["charging"], {
      status: "succeeded",
      stripe_payment_intent_id: charge.id,
      card_brand: charge.brand ?? cb.cardBrand,
      card_last4: charge.last4 ?? cb.cardLast4,
    });
    await db.appendAudit(
      session.id,
      session.user_id,
      buildAuditEvent("charge_succeeded", "system", {
        amount_cents: charge.amount,
        currency: charge.currency,
        payment_intent_id: charge.id,
        card_brand: charge.brand ?? cb.cardBrand,
        card_last4: charge.last4 ?? cb.cardLast4,
      }),
    );
    await resumeRecording(ports, db, session);
    return done("approved");
  } catch (e) {
    const code = e instanceof ChargeError ? e.code : "provider_error";
    log("phone_charge_failed", { session_id: session.id, code });
    await db.appendAudit(session.id, session.user_id, buildAuditEvent("charge_failed", "system", { reason: code }));
    await failSession(ports, db, charging, code, true);
    return done(code === "payment_declined" ? "declined" : "failed");
  }
}

// ---------------------------------------------------------------------------
// Cancel (staff, or the AI hanging up on a stuck session)
// ---------------------------------------------------------------------------

export async function cancelPhonePayment(
  ports: PciPorts,
  input: { userId: string; sessionId: string; actorType: ActorType; actorId: string | null },
): Promise<{ ok: boolean; message: string }> {
  const db = guarded(ports.db);
  const session = await db.getSession(input.sessionId);
  if (!session || session.user_id !== input.userId) return { ok: false, message: "Session not found." };
  if (TERMINAL_STATUSES.has(session.status)) return { ok: false, message: "This secure payment has already finished." };
  if (session.status === "tokenized" || session.status === "charging") return { ok: false, message: "The charge is already being processed." };

  const cancelled = await db.transition(session.id, ["requested", "recording_paused", "capturing"], { status: "cancelled", failure_code: "cancelled", capture_ended_at: iso(ports.now()) });
  if (!cancelled) return { ok: false, message: "This secure payment can no longer be cancelled." };
  await db.appendAudit(session.id, session.user_id, buildAuditEvent("session_cancelled", input.actorType, { reason: "cancelled" }, input.actorId));
  if (session.payment_request_id) await db.setPaymentRequestStatus(session.payment_request_id, "canceled").catch(() => undefined);

  if (session.status === "capturing") {
    const back = session.channel === "staff" ? session.return_to_number : null;
    await ports.twilio.redirect(session.provider_call_sid, buildResultTwiml("cancelled", { returnToNumber: back })).catch((e) => ports.log("cancel_redirect_failed", deepRedact({ error: errMsg(e) })));
  }
  await resumeRecording(ports, db, session);
  return { ok: true, message: "Cancelled." };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function newSessionRow(input: StartInput, now: Date, amountCents: number, callSid: string, requestId: string | null): Omit<PhonePaymentRow, "id"> {
  return {
    user_id: input.userId,
    job_id: input.jobId,
    payment_request_id: requestId,
    vapi_call_id: input.vapiCallId,
    provider_call_sid: callSid,
    channel: input.channel,
    initiated_by: input.actorId,
    status: "requested",
    amount_cents: amountCents,
    currency: "usd",
    failure_code: null,
    card_brand: null,
    card_last4: null,
    stripe_payment_intent_id: null,
    return_to_number: input.channel === "staff" ? input.returnToNumber ?? null : null,
    recording_paused_at: null,
    recording_resumed_at: null,
    capture_started_at: null,
    capture_ended_at: null,
    expires_at: iso(sessionExpiresAt(now)),
  };
}

async function failSession(ports: PciPorts, db: Writes, session: PhonePaymentRow, code: string, resume: boolean, terminal: "failed" | "expired" = "failed"): Promise<void> {
  await db.transition(session.id, ["requested", "recording_paused", "capturing", "tokenized", "charging"], {
    status: terminal,
    failure_code: code,
    capture_ended_at: iso(ports.now()),
  });
  if (session.payment_request_id) await db.setPaymentRequestStatus(session.payment_request_id, "canceled").catch(() => undefined);
  if (resume) await resumeRecording(ports, db, session);
}

async function resumeRecording(ports: PciPorts, db: Writes, session: PhonePaymentRow): Promise<void> {
  if (!session.recording_paused_at) return;
  try {
    await ports.twilio.resumeRecordings(session.provider_call_sid);
    await db.markRecordingResumed(session.id, iso(ports.now()));
    await db.appendAudit(session.id, session.user_id, buildAuditEvent("recording_resumed", "system"));
  } catch {
    await db.appendAudit(session.id, session.user_id, buildAuditEvent("recording_resume_failed", "system", { reason: "provider_error" })).catch(() => undefined);
  }
}

function failureCodeFor(result: PayResult | null): string {
  switch (result) {
    case "input-timeout": return "caller_timeout";
    case "caller-interrupted": return "caller_cancelled";
    case "payment-connector-error":
    case "internal-error": return "provider_error";
    default: return "invalid_input";
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === "23505" || /duplicate key|unique/i.test(errMsg(e));
}
