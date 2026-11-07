// supabase/functions/_shared/fraud/guard.ts
//
// guardOutbound(): the ONE async gate every outbound call, SMS, transfer/forward and voice-clone path
// must pass BEFORE touching Twilio / Vapi / ElevenLabs. It composes the pure policy modules with the
// atomic DB ledger (fraud_reserve) and the global kill switches.
//
// Failure policy (deliberate):
//   * Fraud store unreachable  -> discretionary traffic is DENIED (fail closed): losing money silently is worse.
//   * purpose "emergency" hand-offs / dispatch alerts (a call or SMS) to a DOMESTIC number are never blocked by kill
//     switches, throttling, suspension, verification, spend caps, or a fraud-store outage. They are only
//     bounded by a separate runaway ceiling (EMERGENCY_HANDOFF_DAILY_CEILING) in their own ledger bucket.
//   * The destination policy (premium / international / unknown) ALWAYS applies, even to emergency.

import { evaluateDestination, type DenyReason } from "./destinationPolicy.ts";
import {
  CALL_CENTS_PER_MIN,
  PLAN_LIMITS,
  VOICE_CLONE_CENTS,
  callReservationCents,
  effectiveCaps,
  normalizePlan,
  smsReservationCents,
  type Purpose,
} from "./planLimits.ts";

export const EMERGENCY_HANDOFF_DAILY_CEILING = 200;
export const THROTTLE_FACTOR = 0.2;

export interface FraudDb {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(table: string): { insert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }> };
}

export type GuardKind = "call" | "sms" | "clone";

export interface GuardRequest {
  /** Account owner id (profiles.id) the spend is charged to. */
  userId: string;
  kind: GuardKind;
  /** Destination as stored server-side. Not required for "clone". */
  to?: string;
  purpose: Purpose;
  /** Campaign key for per-campaign approval of NEW accounts (defaults to `source`). */
  campaign?: string;
  /** Calling function name, for the audit trail (e.g. "outbound-dialer"). */
  source: string;
  now?: Date;
}

export type GuardCode =
  | DenyReason
  | "GUARD_UNAVAILABLE"
  | "KILL_SWITCH"
  | "ORG_SUSPENDED"
  | "VERIFICATION_REQUIRED"
  | "CONSENT_REQUIRED"
  | "CAMPAIGN_APPROVAL_REQUIRED"
  | "PLAN_NOT_ALLOWED"
  | "DAILY_CALLS"
  | "DAILY_SMS"
  | "DAILY_COST"
  | "LIFETIME_COST";

export type GuardResult =
  | { ok: true; e164: string | null; country: string | null; reservedCents: number; maxCallSeconds: number; emergency: boolean; shadowDenied?: GuardCode; /** Pass to attachCallRef() once the provider returns its call id. */ eventRef?: string | null }
  | { ok: false; code: GuardCode; httpStatus: 403 | 429 | 503; message: string };

interface GuardContext {
  enforce: boolean;
  kill_outbound_calls: boolean;
  kill_sms: boolean;
  kill_international: boolean;
  status: "active" | "throttled" | "suspended";
  status_reason: string | null;
  outbound_unlocked: boolean;
  international_unlocked: boolean;
  voice_clone_unlocked: boolean;
  allowed_countries: string[];
  plan: string;
  account_age_days: number;
}

const HTTP: Record<GuardCode, 403 | 429 | 503> = {
  INVALID_NUMBER: 403, NEVER_ROUTABLE: 403, PREMIUM_RATE: 403, UNKNOWN_DESTINATION: 403, COUNTRY_NOT_ALLOWED: 403,
  INTERNATIONAL_LOCKED: 403, GUARD_UNAVAILABLE: 503, KILL_SWITCH: 503, ORG_SUSPENDED: 403, VERIFICATION_REQUIRED: 403,
  PLAN_NOT_ALLOWED: 403, CONSENT_REQUIRED: 403, CAMPAIGN_APPROVAL_REQUIRED: 403, DAILY_CALLS: 429, DAILY_SMS: 429, DAILY_COST: 429, LIFETIME_COST: 429,
};

const MESSAGE: Record<GuardCode, string> = {
  INVALID_NUMBER: "The destination is not a valid phone number.",
  NEVER_ROUTABLE: "This destination cannot be reached from Vireek.",
  PREMIUM_RATE: "Premium-rate and special-service numbers are blocked.",
  UNKNOWN_DESTINATION: "This destination country is not supported.",
  COUNTRY_NOT_ALLOWED: "Calling this country is not enabled for your account.",
  INTERNATIONAL_LOCKED: "International calling is off until your business is verified.",
  GUARD_UNAVAILABLE: "Safety checks are temporarily unavailable. Try again shortly.",
  KILL_SWITCH: "This feature is temporarily paused platform-wide.",
  ORG_SUSPENDED: "Outbound activity is paused on this account. Contact support to appeal.",
  VERIFICATION_REQUIRED: "Verify your business to unlock outbound calling and texting.",
  PLAN_NOT_ALLOWED: "Your plan does not include this feature.",
  CONSENT_REQUIRED: "No recorded consent for marketing contact with this number.",
  CAMPAIGN_APPROVAL_REQUIRED: "New accounts need this campaign approved before it can run. We have queued it for review.",
  DAILY_CALLS: "Daily outbound call limit reached.",
  DAILY_SMS: "Daily text message limit reached.",
  DAILY_COST: "Daily spend limit reached.",
  LIFETIME_COST: "The free-plan usage limit has been reached. Upgrade to continue.",
};

const deny = (code: GuardCode): GuardResult => ({ ok: false, code, httpStatus: HTTP[code], message: MESSAGE[code] });

async function logEvent(db: FraudDb, userId: string, req: GuardRequest, code: string, country: string | null, shadow: boolean): Promise<void> {
  try {
    await db.from("fraud_events").insert({
      user_id: userId, kind: "denied", code, source: req.source, country,
      detail: { kind: req.kind, purpose: req.purpose, shadow },
    });
  } catch {
    /* logging must never change the decision */
  }
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function guardOutbound(db: FraudDb, req: GuardRequest): Promise<GuardResult> {
  const now = req.now ?? new Date();

  // ---- 1. load context (fail closed, except domestic emergency hand-offs which are decided locally) ----
  let ctx: GuardContext | null = null;
  try {
    const { data, error } = await db.rpc("fraud_guard_context", { p_user: req.userId });
    if (!error && data && typeof data === "object") ctx = data as GuardContext;
  } catch {
    ctx = null;
  }

  const isHandoff = req.purpose === "emergency" && req.kind !== "clone";
  if (!ctx) {
    if (isHandoff && req.to) {
      const local = evaluateDestination(req.to, { internationalUnlocked: false });
      if (local.allowed && (local.emergency || ["US", "CA"].includes(local.country))) {
        return { ok: true, e164: local.e164, country: local.country, reservedCents: 0, maxCallSeconds: PLAN_LIMITS.free.maxCallSeconds, emergency: true };
      }
    }
    return deny("GUARD_UNAVAILABLE");
  }

  const plan = normalizePlan(ctx.plan);
  const shadow = ctx.enforce === false;
  const finish = async (code: GuardCode, country: string | null): Promise<GuardResult> => {
    await logEvent(db, req.userId, req, code, country, shadow);
    if (shadow) return { ok: true, e164: null, country, reservedCents: 0, maxCallSeconds: PLAN_LIMITS[plan].maxCallSeconds, emergency: false, shadowDenied: code };
    return deny(code);
  };

  // ---- 2. voice clone (no destination) ----
  if (req.kind === "clone") {
    if (ctx.kill_outbound_calls) return finish("KILL_SWITCH", null);
    if (ctx.status === "suspended") return finish("ORG_SUSPENDED", null);
    if (!PLAN_LIMITS[plan].allowVoiceClone) return finish("PLAN_NOT_ALLOWED", null);
    if (!ctx.voice_clone_unlocked) return finish("VERIFICATION_REQUIRED", null);
    const denied = await reserve(db, req, ctx, now, { calls: 0, sms: 0, costCents: VOICE_CLONE_CENTS }, plan, 1);
    if (denied) return finish(denied, null);
    return { ok: true, e164: null, country: null, reservedCents: VOICE_CLONE_CENTS, maxCallSeconds: 0, emergency: false };
  }

  // ---- 3. destination policy (always) ----
  if (!req.to) return finish("INVALID_NUMBER", null);
  const dest = evaluateDestination(req.to, {
    internationalUnlocked: ctx.international_unlocked && !ctx.kill_international,
    allowedCountries: ctx.allowed_countries,
  });
  if (!dest.allowed) return finish(dest.reason, dest.country ?? null);

  // ---- 4. emergency / hand-off lane: domestic only, its own bucket, bypasses every other control ----
  const domestic = dest.emergency || dest.country === "US" || dest.country === "CA";
  if (isHandoff && domestic) {
    if (dest.emergency) {
      return { ok: true, e164: dest.e164, country: dest.country, reservedCents: 0, maxCallSeconds: PLAN_LIMITS[plan].maxCallSeconds, emergency: true };
    }
    let denied: string | null = null;
    try {
      const { data, error } = await db.rpc("fraud_reserve", {
        p_user: req.userId, p_day: `handoff:${utcDay(now)}`, p_calls: req.kind === "call" ? 1 : 0, p_sms: req.kind === "sms" ? 1 : 0, p_cost: 0,
        p_cap_calls: EMERGENCY_HANDOFF_DAILY_CEILING, p_cap_sms: EMERGENCY_HANDOFF_DAILY_CEILING, p_cap_day_cost: 0, p_cap_life_cost: null,
      });
      if (error) throw new Error(error.message);
      denied = typeof data === "string" ? data : null;
    } catch {
      denied = null; // ledger problems must not block a live hand-off
    }
    if (denied) return finish(denied as GuardCode, dest.country);
    return { ok: true, e164: dest.e164, country: dest.country, reservedCents: 0, maxCallSeconds: PLAN_LIMITS[plan].maxCallSeconds, emergency: true };
  }

  // ---- 5. discretionary traffic ----
  if (req.kind === "call" && ctx.kill_outbound_calls) return finish("KILL_SWITCH", dest.country);
  if (req.kind === "sms" && ctx.kill_sms) return finish("KILL_SWITCH", dest.country);
  if (dest.country !== "US" && dest.country !== "CA" && ctx.kill_international) return finish("KILL_SWITCH", dest.country);
  if (ctx.status === "suspended") return finish("ORG_SUSPENDED", dest.country);
  if (!ctx.outbound_unlocked && (req.purpose === "marketing" || req.purpose === "service")) {
    return finish("VERIFICATION_REQUIRED", dest.country);
  }

  // Marketing gates: consent ledger + per-campaign approval for new accounts (both have a log-only rollout mode).
  if (req.purpose === "marketing" && (req.kind === "call" || req.kind === "sms")) {
    const gate = await marketingGate(db, req, dest.e164, dest.country);
    if (gate) return finish(gate, dest.country);
  }

  const factor = ctx.status === "throttled" ? THROTTLE_FACTOR : 1;
  const caps = effectiveCaps(plan, ctx.account_age_days);
  const cost = req.kind === "call" ? callReservationCents(dest.tier, caps.maxCallSeconds) : smsReservationCents(dest.tier);
  const denied = await reserve(
    db, req, ctx, now,
    { calls: req.kind === "call" ? 1 : 0, sms: req.kind === "sms" ? 1 : 0, costCents: cost },
    plan, factor,
  );
  if (denied) return finish(denied, dest.country);

  let eventRef: string | null = null;
  if (req.kind === "call") {
    eventRef = crypto.randomUUID();
    try {
      await db.from("fraud_call_events").insert({
        user_id: req.userId, country: dest.country, international: dest.country !== "US" && dest.country !== "CA",
        prefix: dest.e164.slice(1, 8), cost_cents: cost, reserved_cents: cost, rate_cents_per_min: CALL_CENTS_PER_MIN[dest.tier],
        source: req.source, event_ref: eventRef,
      });
    } catch {
      eventRef = null; /* analytics/settlement only: never fail a permitted call because the event row could not be written */
    }
  }
  return { ok: true, e164: dest.e164, country: dest.country, reservedCents: cost, maxCallSeconds: caps.maxCallSeconds, emergency: false, eventRef };
}

async function reserve(
  db: FraudDb,
  req: GuardRequest,
  ctx: GuardContext,
  now: Date,
  want: { calls: number; sms: number; costCents: number },
  plan: ReturnType<typeof normalizePlan>,
  factor: number,
): Promise<GuardCode | null> {
  const caps = effectiveCaps(plan, ctx.account_age_days);
  try {
    const { data, error } = await db.rpc("fraud_reserve", {
      p_user: req.userId,
      p_day: utcDay(now),
      p_calls: want.calls,
      p_sms: want.sms,
      p_cost: want.costCents,
      p_cap_calls: Math.floor(caps.dailyOutboundCalls * factor),
      p_cap_sms: Math.floor(caps.dailySms * factor),
      p_cap_day_cost: Math.floor(caps.dailyCostCents * factor),
      p_cap_life_cost: caps.lifetimeCostCents,
    });
    if (error) return "GUARD_UNAVAILABLE";
    return typeof data === "string" && data.length > 0 ? (data as GuardCode) : null;
  } catch {
    return "GUARD_UNAVAILABLE";
  }
}

interface MarketingChecks {
  consent_mode: "off" | "log" | "enforce";
  has_consent: boolean;
  approval_required: boolean;
  campaign_status: "none" | "pending" | "approved" | "rejected";
}

async function marketingGate(db: FraudDb, req: GuardRequest, e164: string, country: string): Promise<GuardCode | null> {
  const campaign = (req.campaign ?? req.source).slice(0, 80);
  let m: MarketingChecks | null = null;
  try {
    const { data, error } = await db.rpc("fraud_marketing_checks", {
      p_user: req.userId, p_phone: e164, p_channel: req.kind === "sms" ? "sms" : "voice", p_campaign: campaign,
    });
    if (!error && data && typeof data === "object") m = data as MarketingChecks;
  } catch {
    m = null;
  }
  if (!m) return "GUARD_UNAVAILABLE"; // marketing contact fails closed

  if (m.approval_required && m.campaign_status !== "approved") {
    if (m.campaign_status === "none") {
      try { await db.rpc("fraud_request_campaign_approval", { p_user: req.userId, p_campaign: campaign }); } catch { /* best effort */ }
    }
    return "CAMPAIGN_APPROVAL_REQUIRED";
  }
  if (m.consent_mode !== "off" && !m.has_consent) {
    if (m.consent_mode === "enforce") return "CONSENT_REQUIRED";
    await logEvent(db, req.userId, req, "CONSENT_MISSING", country, true); // log-only rollout: visible in the dashboard, traffic allowed
  }
  return null;
}

/** Links the provider's call id to the reservation made by guardOutbound (so the real duration can settle it). */
export async function attachCallRef(db: FraudDb, eventRef: string | null | undefined, externalId: string | null | undefined): Promise<void> {
  if (!eventRef || !externalId) return;
  try { await db.rpc("fraud_call_attach", { p_ref: eventRef, p_external_id: externalId }); } catch { /* settlement is best effort */ }
}

/** Records the call's real duration and refunds the unused worst-case reservation. Idempotent. */
export async function settleCall(db: FraudDb, externalId: string | null | undefined, durationSeconds: number | null | undefined): Promise<void> {
  if (!externalId || durationSeconds == null || !Number.isFinite(durationSeconds)) return;
  try { await db.rpc("fraud_call_finish", { p_external_id: externalId, p_duration: Math.max(0, Math.round(durationSeconds)) }); } catch { /* best effort */ }
}

/**
 * Destination-only check (no budget, no verification gate, no kill switch): for hops where the reservation was
 * already made earlier in the same flow (e.g. the contact leg of a power-dialer bridge). Applies the same
 * destination policy as guardOutbound with the account's own unlock state. Emergency numbers always pass.
 */
export async function guardDestination(db: FraudDb, userId: string, to: string): Promise<GuardResult> {
  let ctx: GuardContext | null = null;
  try {
    const { data, error } = await db.rpc("fraud_guard_context", { p_user: userId });
    if (!error && data && typeof data === "object") ctx = data as GuardContext;
  } catch {
    ctx = null;
  }
  const dest = evaluateDestination(to, {
    internationalUnlocked: ctx ? ctx.international_unlocked && !ctx.kill_international : false,
    allowedCountries: ctx?.allowed_countries ?? [],
  });
  if (!dest.allowed) return deny(dest.reason);
  return { ok: true, e164: dest.e164, country: dest.country, reservedCents: 0, maxCallSeconds: PLAN_LIMITS[normalizePlan(ctx?.plan)].maxCallSeconds, emergency: dest.emergency };
}
