// Pure, dependency-free logic for supabase/functions/manage-subscription-cancellation.
// Kept separate from the Deno handler so it is unit-tested by vitest (same
// pattern as dunningLogic.ts).

export const CANCEL_REASONS = [
  "too_expensive",
  "missing_features",
  "not_using",
  "switching",
  "closing_business",
  "technical_issues",
  "other",
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export const PAUSE_MONTH_OPTIONS = [1, 2, 3] as const;
export type PauseMonths = (typeof PAUSE_MONTH_OPTIONS)[number];

export const MAX_DETAIL_LENGTH = 1000;

export type CancellationRequest =
  | { action: "context" }
  | { action: "cancel"; reason: CancelReason; detail: string }
  | { action: "pause"; months: PauseMonths; reason: CancelReason | null; detail: string }
  | { action: "accept_offer"; reason: CancelReason | null; detail: string }
  | { action: "resume" };

export type ParseResult = { ok: true; request: CancellationRequest } | { ok: false; error: string };

function parseReason(value: unknown): CancelReason | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  return (CANCEL_REASONS as readonly unknown[]).includes(value) ? (value as CancelReason) : undefined;
}

function parseDetail(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > MAX_DETAIL_LENGTH ? null : trimmed;
}

/** Strictly validates the untrusted request body. Never throws. */
export function parseRequest(body: unknown): ParseResult {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request." };
  const b = body as Record<string, unknown>;

  if (b.action === "context") return { ok: true, request: { action: "context" } };
  if (b.action === "resume") return { ok: true, request: { action: "resume" } };

  if (b.action === "cancel" || b.action === "pause" || b.action === "accept_offer") {
    const reason = parseReason(b.reason);
    if (reason === undefined) return { ok: false, error: "Unknown cancellation reason." };
    const detail = parseDetail(b.detail);
    if (detail === null) return { ok: false, error: `Feedback must be ${MAX_DETAIL_LENGTH} characters or fewer.` };

    if (b.action === "cancel") {
      if (reason === null) return { ok: false, error: "Please tell us why you're cancelling." };
      return { ok: true, request: { action: "cancel", reason, detail } };
    }
    if (b.action === "pause") {
      const months = b.months;
      if (!(PAUSE_MONTH_OPTIONS as readonly unknown[]).includes(months)) {
        return { ok: false, error: "Pause length must be 1, 2 or 3 months." };
      }
      return { ok: true, request: { action: "pause", months: months as PauseMonths, reason, detail } };
    }
    return { ok: true, request: { action: "accept_offer", reason, detail } };
  }
  return { ok: false, error: "Unknown action." };
}

/** Adds calendar months in UTC, clamping to the last day (Jan 31 + 1 month = Feb 28/29). */
export function addMonthsClamped(from: Date, months: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(y, m, Math.min(from.getUTCDate(), lastDay), from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds()),
  );
}

/** Stripe's cancellation_details.feedback enum. */
export type StripeFeedback =
  | "too_expensive"
  | "missing_features"
  | "unused"
  | "switched_service"
  | "low_quality"
  | "other";

export const STRIPE_FEEDBACK: Record<CancelReason, StripeFeedback> = {
  too_expensive: "too_expensive",
  missing_features: "missing_features",
  not_using: "unused",
  switching: "switched_service",
  technical_issues: "low_quality",
  closing_business: "other",
  other: "other",
};

export interface OfferTerms {
  percentOff: number;
  months: number;
}

/**
 * The win-back coupon must be a percent-off coupon with a bounded duration.
 * A "forever" discount is never offered automatically.
 */
export function offerTermsFromCoupon(coupon: {
  valid?: boolean;
  percent_off?: number | null;
  duration?: string;
  duration_in_months?: number | null;
} | null): OfferTerms | null {
  if (!coupon || coupon.valid === false) return null;
  const percent = coupon.percent_off;
  if (typeof percent !== "number" || percent <= 0 || percent > 100) return null;
  if (coupon.duration === "once") return { percentOff: percent, months: 1 };
  if (coupon.duration === "repeating" && typeof coupon.duration_in_months === "number" && coupon.duration_in_months > 0) {
    return { percentOff: percent, months: coupon.duration_in_months };
  }
  return null;
}

export interface SubscriptionState {
  status: string;
  cancelAtPeriodEnd: boolean;
  paused: boolean;
}

/** Only healthy, un-modified subscriptions can be paused or given the offer. */
export function canModifySubscription(s: SubscriptionState): boolean {
  return (s.status === "active" || s.status === "trialing") && !s.cancelAtPeriodEnd && !s.paused;
}

export function isOfferEligible(input: SubscriptionState & { terms: OfferTerms | null; alreadyUsedOffer: boolean }): boolean {
  return input.terms !== null && !input.alreadyUsedOffer && canModifySubscription(input);
}
