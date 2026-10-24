// supabase/functions/_shared/pci/session.ts
//
// Pure rules for a pay-by-phone session: the state machine, the audit-event
// allowlist, and the HMAC token that binds provider callbacks to one session.
// The database enforces the same transitions (trigger) and the same "recording
// must be paused before capture" invariant (CHECK) — this file is the app-side twin.

import { assertNoCardData, redactCardData } from "./cardData.ts";

export type PhonePaymentStatus =
  | "requested"
  | "recording_paused"
  | "capturing"
  | "tokenized"
  | "charging"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type PhonePaymentChannel = "ai_agent" | "staff";
export type ActorType = "ai_agent" | "staff" | "system" | "provider";

export const TERMINAL_STATUSES: ReadonlySet<PhonePaymentStatus> = new Set(["succeeded", "failed", "cancelled", "expired"]);

const TRANSITIONS: Record<PhonePaymentStatus, readonly PhonePaymentStatus[]> = {
  requested: ["recording_paused", "failed", "cancelled", "expired"],
  recording_paused: ["capturing", "failed", "cancelled", "expired"],
  capturing: ["tokenized", "failed", "cancelled", "expired"],
  tokenized: ["charging", "failed", "expired"],
  charging: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
};

export function canTransition(from: PhonePaymentStatus, to: PhonePaymentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: PhonePaymentStatus, to: PhonePaymentStatus): void {
  if (!canTransition(from, to)) throw new Error(`Illegal phone-payment transition ${from} -> ${to}`);
}

/** A session that has not finished within this window is expired (caller dropped, provider timeout). */
export const SESSION_TTL_SECONDS = 600;

export function sessionExpiresAt(now: Date): Date {
  return new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
}

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------

export const AUDIT_EVENT_TYPES = [
  "session_requested",
  "recording_pause_requested",
  "recording_paused",
  "recording_pause_failed",
  "capture_redirect_sent",
  "capture_redirect_failed",
  "capture_started",
  "capture_progress",
  "capture_completed",
  "capture_failed",
  "tokenized",
  "charge_attempted",
  "charge_succeeded",
  "charge_failed",
  "recording_resumed",
  "recording_resume_failed",
  "session_cancelled",
  "session_expired",
  "spoken_card_data_detected",
  "fallback_payment_link",
  "callback_rejected",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** The ONLY metadata keys an audit event may carry. Anything else is dropped, never stored. */
export const AUDIT_METADATA_KEYS = [
  "reason",
  "channel",
  "amount_cents",
  "currency",
  "card_brand",
  "card_last4",
  "provider_code",
  "payment_intent_id",
  "field",
  "attempt",
  "count",
  "provider_recordings",
  "result",
  "status",
] as const;
const ALLOWED = new Set<string>(AUDIT_METADATA_KEYS);

export interface AuditEventInput {
  type: AuditEventType;
  actorType: ActorType;
  actorId?: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

/** Builds a sanitized audit event: allowlisted keys, bounded values, and a final fail-closed card-data check. */
export function buildAuditEvent(
  type: AuditEventType,
  actorType: ActorType,
  metadata: Record<string, unknown> = {},
  actorId: string | null = null,
): AuditEventInput {
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (!ALLOWED.has(k)) continue;
    if (v === null || typeof v === "boolean") clean[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) clean[k] = v;
    else if (typeof v === "string") {
      if (k === "card_last4" && !/^\d{4}$/.test(v)) continue;
      clean[k] = redactCardData(v, { strict: true }).text.slice(0, 120);
    }
  }
  assertNoCardData(clean, `audit event ${type}`);
  return { type, actorType, actorId, metadata: clean };
}

// ---------------------------------------------------------------------------
// HMAC token: binds a provider callback URL to exactly one session
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string, hash: "SHA-256" | "SHA-1" = "SHA-256"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signSessionToken(secret: string, sessionId: string): Promise<string> {
  return hmacHex(secret, `phone-pay:v1:${sessionId}`);
}

export async function verifySessionToken(secret: string, sessionId: string, token: string | null | undefined): Promise<boolean> {
  if (!secret || !token || !/^[0-9a-f]{64}$/.test(token)) return false;
  return timingSafeEqual(await signSessionToken(secret, sessionId), token);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TWILIO_CALL_SID_RE = /^CA[0-9a-f]{32}$/;

/** Human wording for a failure code, safe to speak to the caller or show in the dashboard. */
export const FAILURE_MESSAGES: Record<string, string> = {
  recording_pause_failed: "Secure capture was not started because call recording could not be paused.",
  redirect_failed: "The caller could not be moved to the secure keypad line.",
  payment_declined: "The card was declined.",
  needs_authentication: "The card needs extra verification that cannot be done by phone.",
  balance_changed: "The balance changed during the call, so no charge was made.",
  provider_error: "The payment provider reported a problem.",
  caller_timeout: "No card details were entered in time.",
  caller_cancelled: "The caller cancelled.",
  invalid_input: "The card details could not be validated.",
  expired: "The secure session expired.",
  cancelled: "Cancelled by staff.",
};
