// Pure instant-payout rules shared by the instant-payouts edge function and its tests.
// No Deno/Supabase imports here on purpose so Vitest can run this file as-is.

export const INSTANT_PAYOUT_CURRENCY = "usd";
/** Smallest payout we allow (Stripe's own minimum fee is $0.50, so anything lower is all fee). */
export const MIN_PAYOUT_CENTS = 100;
/** Stripe's default per-payout instant limit for US accounts is $9,999. */
export const MAX_PAYOUT_CENTS = 999_900;
/** After this long Stripe forgets an Idempotency-Key, so resuming a payout is no longer safe. */
export const RESUME_WINDOW_MS = 23 * 60 * 60 * 1000;
/** Require typing a phrase in the UI at/above this amount. */
export const TYPE_TO_CONFIRM_CENTS = 500_000;

export interface Pricing {
  /** Basis points of the payout amount (100 = 1%). */
  feeBps: number;
  feeMinCents: number;
  /** null = no maximum. */
  feeMaxCents: number | null;
}

export const DEFAULT_PRICING: Pricing = { feeBps: 100, feeMinCents: 50, feeMaxCents: null };

function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * Reads the fee schedule from env. It MUST mirror the pricing set in the Stripe Dashboard
 * (Connect > Settings > Platform pricing tool > Instant Payouts); Stripe is what really collects the fee.
 * Invalid values fall back to the defaults instead of throwing, so a typo can never take payouts down.
 */
export function loadPricing(get: (key: string) => string | undefined): Pricing {
  const maxRaw = envInt(get("INSTANT_PAYOUT_FEE_MAX_CENTS"), -1, 0, 10_000_000); // -1 = unset/invalid = no maximum
  return {
    feeBps: envInt(get("INSTANT_PAYOUT_FEE_BPS"), DEFAULT_PRICING.feeBps, 0, 10_000),
    feeMinCents: envInt(get("INSTANT_PAYOUT_FEE_MIN_CENTS"), DEFAULT_PRICING.feeMinCents, 0, 100_000),
    feeMaxCents: maxRaw < 0 ? null : maxRaw,
  };
}

/** Fee in cents for a payout of `amountCents`. Rounds half up; clamps to [min, max]. 0% pricing means no fee at all. */
export function quoteFee(amountCents: number, pricing: Pricing): number {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;
  if (pricing.feeBps <= 0 && pricing.feeMinCents <= 0) return 0;
  let fee = Math.round((amountCents * pricing.feeBps) / 10_000);
  fee = Math.max(fee, pricing.feeMinCents);
  if (pricing.feeMaxCents !== null) fee = Math.min(fee, pricing.feeMaxCents);
  return fee;
}

/**
 * Stripe reports gross (balance) and net (max payout after the platform fee) for the destination.
 * If our configured pricing explains the gap (±1¢ rounding), the Dashboard and env agree.
 */
export function isPricingInSync(grossCents: number, netCents: number, pricing: Pricing): boolean {
  const gap = grossCents - netCents;
  if (gap < 0) return false;
  if (gap === 0) return quoteFee(netCents, pricing) === 0;
  return Math.abs(gap - quoteFee(netCents, pricing)) <= 1;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type PayoutRequestInput =
  | { action: "eligibility" }
  | { action: "dashboard_link" }
  | { action: "resume"; payoutId: string }
  | { action: "request"; amountCents: number; expectedFeeCents: number; idempotencyKey: string };

export function parseRequestInput(body: unknown): ParseResult<PayoutRequestInput> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const action = b.action ?? "eligibility";

  if (action === "eligibility") return { ok: true, value: { action: "eligibility" } };
  if (action === "dashboard_link") return { ok: true, value: { action: "dashboard_link" } };

  if (action === "resume") {
    if (typeof b.payout_id !== "string" || !UUID_RE.test(b.payout_id)) return { ok: false, error: "A valid payout_id is required." };
    return { ok: true, value: { action: "resume", payoutId: b.payout_id.toLowerCase() } };
  }

  if (action === "request") {
    const amount = b.amount_cents;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      return { ok: false, error: "Payout amount must be a whole number of cents greater than zero." };
    }
    if (amount < MIN_PAYOUT_CENTS) return { ok: false, error: `The minimum instant payout is ${formatMoney(MIN_PAYOUT_CENTS)}.` };
    if (amount > MAX_PAYOUT_CENTS) return { ok: false, error: `The maximum instant payout is ${formatMoney(MAX_PAYOUT_CENTS)}.` };
    const fee = b.expected_fee_cents;
    if (typeof fee !== "number" || !Number.isInteger(fee) || fee < 0) {
      return { ok: false, error: "expected_fee_cents is required so you always see the fee before confirming." };
    }
    if (typeof b.idempotency_key !== "string" || !KEY_RE.test(b.idempotency_key)) {
      return { ok: false, error: "A valid idempotency_key is required." };
    }
    return { ok: true, value: { action: "request", amountCents: amount, expectedFeeCents: fee, idempotencyKey: b.idempotency_key } };
  }

  return { ok: false, error: "Unknown action." };
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface ExternalAccountSummary {
  id: string;
  type: "card" | "bank_account";
  label: string;
  last4: string | null;
  currency: string;
  defaultForCurrency: boolean;
  instantCapable: boolean;
  usable: boolean;
}

export interface InstantBalance {
  currency: string;
  grossCents: number;
  /** Max payout per destination id, already net of the platform fee (Stripe's instant_available.net_available). */
  netByDestination: Record<string, number>;
}

export type IneligibleReason =
  | "forbidden"
  | "not_connected"
  | "onboarding_incomplete"
  | "payouts_disabled"
  | "open_dispute"
  | "account_too_new"
  | "no_instant_destination"
  | "no_instant_balance";

export interface EligibilityInput {
  canManage: boolean;
  stripeAccountId: string | null;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  hasOpenDispute: boolean;
  accountAgeDays: number;
  minAccountAgeDays: number;
  destinations: ExternalAccountSummary[];
  balance: InstantBalance | null;
}

export interface Eligibility {
  eligible: boolean;
  reason: IneligibleReason | null;
  message: string | null;
  destination: ExternalAccountSummary | null;
  /** Total instant balance (gross, before fee). */
  availableCents: number;
  /** Largest payout allowed right now (net of fee, capped at MAX_PAYOUT_CENTS). */
  maxPayoutCents: number;
}

export const REASON_MESSAGES: Record<IneligibleReason, string> = {
  forbidden: "Only the account owner or an admin can request instant payouts.",
  not_connected: "Connect your Stripe account first.",
  onboarding_incomplete: "Finish verifying your Stripe account to enable payouts.",
  payouts_disabled: "Stripe has paused payouts on your account. Open your Stripe dashboard to see what is needed.",
  open_dispute: "Instant payouts are paused while you have an open dispute. Standard payouts continue as normal.",
  account_too_new: "Instant payouts unlock a few days after your Stripe account is connected. Standard payouts continue as normal.",
  no_instant_destination: "Add a debit card (or an instant-capable bank account) in your Stripe dashboard to receive instant payouts. Prepaid cards are not supported.",
  no_instant_balance: "No funds are available for an instant payout yet. Card payments become available right after they are collected.",
};

const none = (reason: IneligibleReason, extra: Partial<Eligibility> = {}): Eligibility => ({
  eligible: false,
  reason,
  message: REASON_MESSAGES[reason],
  destination: null,
  availableCents: 0,
  maxPayoutCents: 0,
  ...extra,
});

/** Picks the instant destination the payout should go to: default first, then the one with the most room. */
export function pickDestination(destinations: ExternalAccountSummary[], balance: InstantBalance | null): ExternalAccountSummary | null {
  const usable = destinations.filter((d) => d.usable && d.instantCapable && d.currency === INSTANT_PAYOUT_CURRENCY);
  if (usable.length === 0) return null;
  const room = (d: ExternalAccountSummary) => balance?.netByDestination[d.id] ?? 0;
  return [...usable].sort((a, b) => Number(b.defaultForCurrency) - Number(a.defaultForCurrency) || room(b) - room(a))[0];
}

export function evaluateEligibility(i: EligibilityInput): Eligibility {
  if (!i.canManage) return none("forbidden");
  if (!i.stripeAccountId) return none("not_connected");
  if (!i.detailsSubmitted) return none("onboarding_incomplete");
  if (!i.payoutsEnabled) return none("payouts_disabled");
  if (i.hasOpenDispute) return none("open_dispute");
  if (i.accountAgeDays < i.minAccountAgeDays) return none("account_too_new");

  const destination = pickDestination(i.destinations, i.balance);
  if (!destination) return none("no_instant_destination");

  const available = i.balance?.currency === INSTANT_PAYOUT_CURRENCY ? i.balance.grossCents : 0;
  const net = i.balance?.netByDestination[destination.id] ?? 0;
  const maxPayout = Math.min(net, MAX_PAYOUT_CENTS);
  if (maxPayout < MIN_PAYOUT_CENTS) return none("no_instant_balance", { destination, availableCents: available });

  return { eligible: true, reason: null, message: null, destination, availableCents: available, maxPayoutCents: maxPayout };
}

// ---------------------------------------------------------------------------
// Stripe payload mapping
// ---------------------------------------------------------------------------

export type PayoutStatus = "pending" | "in_transit" | "paid" | "failed" | "canceled";

/** Stripe payout.status -> the status we store ('pending' is ours: reserved but unconfirmed). */
export function mapStripePayoutStatus(status: unknown): Exclude<PayoutStatus, "pending"> {
  if (status === "paid") return "paid";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  return "in_transit"; // pending, in_transit, or anything new Stripe adds
}

const FAILURE_MESSAGES: Record<string, string> = {
  account_closed: "Your bank says the destination account is closed. Add a new debit card in Stripe and try again.",
  account_frozen: "Your bank says the destination account is frozen.",
  bank_account_restricted: "Your bank account has restrictions that block this payout.",
  debit_not_authorized: "Your bank did not authorize this payout.",
  insufficient_funds: "There wasn't enough available balance for this payout.",
  invalid_account_number: "The destination account number was rejected.",
  invalid_card: "Your debit card can't receive instant payouts. Add a different card in Stripe.",
  could_not_process: "Your bank could not process this payout. Try again or use another card.",
  declined: "Your card issuer declined this payout. Try another card.",
  no_account: "The destination account could not be found.",
};

export function friendlyFailureMessage(code: string | null | undefined, fallback?: string | null): string {
  if (code && FAILURE_MESSAGES[code]) return FAILURE_MESSAGES[code];
  const text = (fallback ?? "").trim();
  return text ? text.slice(0, 300) : "Stripe could not complete this payout.";
}

/**
 * A 4xx from Stripe means the payout was definitely NOT created. Anything else (network drop,
 * 5xx, unparseable body, 409 "key in use") is ambiguous: the payout may exist, so we keep the
 * reservation instead of releasing it.
 */
export function isAmbiguousStripeFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return true;
  return status >= 500 || status === 409;
}

export function formatMoney(cents: number, currency = "usd"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}
