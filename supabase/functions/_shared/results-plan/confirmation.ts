// Results Plan — customer arrival confirmation ("Did <business> arrive?"). Pure: no I/O, no Deno APIs (unit-tested with vitest).
// Used by supabase/functions/results-plan-confirm (sender) and supabase/functions/sms-webhook (reply parser).
//
// Compliance notes (NOT legal advice):
//  - Every send goes through sendCompliantSms(): A2P approval, STOP suppression (dnc_suppressions), quiet hours, fraud guard.
//  - The owner must opt in (results_plan_accounts.customer_confirmation_enabled, default false).
//  - [COUNSEL] confirm whether this message is "transactional/service" or needs prior express consent in each target
//    jurisdiction, and the retention period for the stored customer phone number. This module takes no legal position.

import { classifyKeyword } from "../messaging/optOut.ts";

/** Tunable operating parameters (timing only — never prices). Calibrate from real data. */
export const CONFIRMATION_DEFAULTS = {
  /** Wait after the charge is created before asking, so the visit has plausibly happened. */
  delayMinutes: 30,
  /** Do not ask about a job whose charge is older than this. */
  maxAgeDays: 7,
  /** A reply is attributed to the newest question only inside this window (mirrors the SQL RPC). */
  replyWindowDays: 7,
  /** A sent question with no reply is closed as no_response after this many days. */
  noResponseAfterDays: 7,
  maxAttempts: 3,
} as const;

export type ConfirmationAnswer = "yes" | "no" | "stop";

const YES = new Set(["YES", "Y", "YEP", "YEAH", "YA", "CONFIRM", "CONFIRMED", "ARRIVED"]);
const NO = new Set(["NO", "N", "NOPE", "NOT"]);

/**
 * Strict, whole-message parser. Anything longer or ambiguous ("yes but late", "no thanks call me") returns null so the message
 * still reaches the normal inbox instead of being silently swallowed or mis-recorded. STOP-class words win over everything.
 */
export function parseConfirmationReply(body: string | null | undefined): ConfirmationAnswer | null {
  if (classifyKeyword(body) === "stop") return "stop";
  const word = (body ?? "")
    .normalize("NFKC")
    .replace(/[\s\u200b-\u200d\ufeff]+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .toUpperCase();
  if (!word || word.includes(" ")) return null;
  if (YES.has(word)) return "yes";
  if (NO.has(word)) return "no";
  return null;
}

const E164 = /^\+[1-9][0-9]{6,14}$/;
export const isE164 = (p: string | null | undefined): p is string => !!p && E164.test(p);

/** Strips control characters/links so a business name can never smuggle a URL or break the SMS. */
export function safeBusinessName(name: string | null | undefined): string {
  const cleaned = (name ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, " ")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 40 ? cleaned.slice(0, 39).trimEnd() + "…" : cleaned;
}

export function buildConfirmationSms(input: { businessName: string | null; serviceType?: string | null }): string {
  const who = safeBusinessName(input.businessName) || "your service provider";
  const service = safeBusinessName(input.serviceType ?? "").toLowerCase();
  const visit = service ? `for your ${service} visit` : "for your recent visit";
  return `Did ${who} arrive ${visit}? Reply YES or NO. Reply STOP to opt out.`;
}

export type SkipReason =
  | "feature_disabled" | "no_phone" | "invalid_phone" | "cancelled" | "rework" | "not_sarah_job" | "charge_not_active" | "too_old" | "already_asked";

export interface EligibilityInput {
  featureEnabled: boolean;
  customerPhone: string | null; // already E.164-normalised by the caller
  jobStatus: string | null;
  isRework: boolean;
  jobSource: string | null;
  chargeStatus: string | null;
  chargeCreatedAt: string; // ISO
  alreadyAsked: boolean;
}

export type Eligibility =
  | { send: true; notBefore: string }
  | { send: false; reason: SkipReason; permanent: boolean };

export function evaluateEligibility(i: EligibilityInput, nowIso: string, cfg = CONFIRMATION_DEFAULTS): Eligibility {
  if (i.alreadyAsked) return { send: false, reason: "already_asked", permanent: true };
  if (!i.featureEnabled) return { send: false, reason: "feature_disabled", permanent: false };
  if (!i.customerPhone) return { send: false, reason: "no_phone", permanent: true };
  if (!isE164(i.customerPhone)) return { send: false, reason: "invalid_phone", permanent: true };
  if (i.jobStatus === "cancelled") return { send: false, reason: "cancelled", permanent: true };
  if (i.isRework) return { send: false, reason: "rework", permanent: true };
  if (i.jobSource === "owner" || i.jobSource === "test") return { send: false, reason: "not_sarah_job", permanent: true };
  if (i.chargeStatus !== "pending" && i.chargeStatus !== "posted") return { send: false, reason: "charge_not_active", permanent: true };
  const created = Date.parse(i.chargeCreatedAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(created) || !Number.isFinite(now)) return { send: false, reason: "charge_not_active", permanent: true };
  if (now - created > cfg.maxAgeDays * 86_400_000) return { send: false, reason: "too_old", permanent: true };
  return { send: true, notBefore: new Date(created + cfg.delayMinutes * 60_000).toISOString() };
}

// ---- mapping sendCompliantSms() outcomes to a row transition (structural type: no import of Deno code) ----
export type SendOutcome =
  | { ok: true; sid: string; deferred?: boolean }
  | { ok: false; reason: "QUIET_HOURS"; sendAt: string }
  | { ok: false; reason: "FRAUD_BLOCKED"; block: { retryable: boolean; retryAt: string | null }; detail?: string }
  | { ok: false; reason: "A2P_NOT_APPROVED" | "OPTED_OUT" | "NOT_CONFIGURED" | "TWILIO_ERROR" | "QUEUE_ERROR"; detail?: string };

export type Transition =
  | { status: "sent"; sid: string }
  | { status: "queued"; nextAttemptAt: string; countAttempt: boolean }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export function classifySendOutcome(r: SendOutcome, attemptsSoFar: number, nowIso: string, cfg = CONFIRMATION_DEFAULTS): Transition {
  const now = Date.parse(nowIso);
  const later = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  if (r.ok) return { status: "sent", sid: r.sid };
  switch (r.reason) {
    case "OPTED_OUT": return { status: "skipped", reason: "opted_out" };
    case "QUIET_HOURS": return { status: "queued", nextAttemptAt: r.sendAt, countAttempt: false };
    case "FRAUD_BLOCKED":
      return r.block.retryable && r.block.retryAt
        ? { status: "queued", nextAttemptAt: r.block.retryAt, countAttempt: false }
        : { status: "skipped", reason: "fraud_blocked" };
    case "NOT_CONFIGURED": return { status: "queued", nextAttemptAt: later(60), countAttempt: false };
    default: {
      const attempts = attemptsSoFar + 1;
      if (attempts >= cfg.maxAttempts) return { status: "failed", reason: `${r.reason}${r.detail ? `: ${r.detail}` : ""}`.slice(0, 300) };
      return { status: "queued", nextAttemptAt: later(30 * attempts), countAttempt: true };
    }
  }
}
