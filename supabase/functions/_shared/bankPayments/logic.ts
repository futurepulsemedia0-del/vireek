// Pay by Bank — pure logic (rails, fee estimates, routing, failure classification, intent policy).
// No imports and no runtime APIs: shared by the Deno edge functions and vitest. Keep it that way.
// The provider boundary lives here: ProviderCapabilities describes what a provider can do; Stripe is the only adapter today.

export type BankRail = "ach_debit" | "instant_bank" | "rtp" | "fednow";
export type RailChoice = BankRail | "card";
export type Confirmation = "instant" | "delayed";

export interface RailCapability {
  /** The provider can move money on this rail at all. */
  supported: boolean;
  /** Vireek can steer a customer onto it (false = the provider decides, e.g. Stripe Link "Instant Bank Payments"). */
  selectable: boolean;
  confirmation: Confirmation;
  /** Per-payment ceiling in cents, when the provider/rail has one. */
  maxAmountCents?: number;
  note?: string;
}

export interface ProviderCapabilities {
  id: string;
  rails: Record<BankRail, RailCapability>;
}

/**
 * Stripe (verified against docs.stripe.com/payments/ach-direct-debit and /link/instant-bank-payments):
 * - ACH Direct Debit: us_bank_account, instant verification via Financial Connections (+ microdeposit fallback),
 *   confirmation takes up to 4 business days.
 * - Instant Bank Payments: part of Link, shown automatically ONLY when ACH Direct Debit is not offered, so it is not selectable.
 * - RTP / FedNow: not offered to merchants as a payment method by Stripe. They stay "unsupported" until another provider adapter lands.
 */
export const STRIPE_CAPABILITIES: ProviderCapabilities = {
  id: "stripe",
  rails: {
    ach_debit: { supported: true, selectable: true, confirmation: "delayed", note: "Up to 4 business days; returns possible." },
    instant_bank: { supported: true, selectable: false, confirmation: "instant", note: "Automatic through Link when ACH Direct Debit is off." },
    rtp: { supported: false, selectable: false, confirmation: "instant", note: "Not available through Stripe." },
    fednow: { supported: false, selectable: false, confirmation: "instant", note: "Not available through Stripe." },
  },
};

/**
 * ESTIMATES used for savings suggestions only (never for charging). Mirror of public.bank_fee_estimate() in the SQL migration —
 * verify against your Stripe pricing page and change both places together. rtp / fednow are provider specific (0 = unknown).
 */
export const FEE_SCHEDULE = {
  cardPercent: 0.029,
  cardFixedCents: 30,
  achPercent: 0.008,
  achCapCents: 500,
  instantBankPercent: 0.026,
} as const;

export function estimateFeeCents(rail: RailChoice, amountCents: number): number {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;
  switch (rail) {
    case "card": return Math.round(amountCents * FEE_SCHEDULE.cardPercent + FEE_SCHEDULE.cardFixedCents);
    case "ach_debit": return Math.min(Math.round(amountCents * FEE_SCHEDULE.achPercent), FEE_SCHEDULE.achCapCents);
    case "instant_bank": return Math.round(amountCents * FEE_SCHEDULE.instantBankPercent);
    default: return 0;
  }
}

export interface BankSettings {
  enabled: boolean;
  routing_mode: "offer" | "prefer";
  min_amount_cents: number;
  max_amount_cents: number;
  capability_status: "unknown" | "inactive" | "pending" | "active";
  rtp_enabled?: boolean;
  fednow_enabled?: boolean;
}

export const MIN_SAVINGS_TO_PREFER_CENTS = 100;

/** Bank payments are offered only when the owner switched them on, Stripe's capability is active, and the amount is inside the window. */
export function isBankEligible(settings: BankSettings | null | undefined, amountCents: number): boolean {
  if (!settings || !settings.enabled || settings.capability_status !== "active") return false;
  return Number.isInteger(amountCents) && amountCents >= settings.min_amount_cents && amountCents <= settings.max_amount_cents;
}

/** A plan can offer bank autopay only if EVERY scheduled amount (deposit + installments) is inside the window. */
export function planBankEligible(settings: BankSettings | null | undefined, amountsCents: number[]): boolean {
  return amountsCents.length > 0 && amountsCents.every((a) => isBankEligible(settings, a));
}

export interface RankedRail {
  rail: RailChoice;
  feeCents: number;
  confirmation: Confirmation;
}

export interface RoutingSuggestion {
  /** The rail we recommend steering this payment to. */
  rail: RailChoice;
  offerBank: boolean;
  /** Put the bank option first in the Payment Element. */
  preferBank: boolean;
  /** Estimated fee difference vs paying by card, in cents (>= 0). */
  savingsCents: number;
  ranked: RankedRail[];
  reasons: string[];
}

/** Picks the cheapest rail the customer may use; ties go to the faster confirmation. Card is always the fallback. */
export function suggestRail(input: {
  amountCents: number;
  settings: BankSettings | null | undefined;
  provider?: ProviderCapabilities;
}): RoutingSuggestion {
  const provider = input.provider ?? STRIPE_CAPABILITIES;
  const card: RankedRail = { rail: "card", feeCents: estimateFeeCents("card", input.amountCents), confirmation: "instant" };
  const reasons: string[] = [];
  const s = input.settings;

  if (!isBankEligible(s, input.amountCents)) {
    if (!s || !s.enabled) reasons.push("Pay by bank is switched off.");
    else if (s.capability_status !== "active") reasons.push("Stripe has not activated ACH debits for this account yet.");
    else reasons.push("The amount is outside your pay-by-bank window.");
    return { rail: "card", offerBank: false, preferBank: false, savingsCents: 0, ranked: [card], reasons };
  }

  const candidates: RankedRail[] = [];
  (Object.keys(provider.rails) as BankRail[]).forEach((rail) => {
    const cap = provider.rails[rail];
    if (!cap.supported || !cap.selectable) return;
    if (rail === "rtp" && !s!.rtp_enabled) return;
    if (rail === "fednow" && !s!.fednow_enabled) return;
    if (cap.maxAmountCents !== undefined && input.amountCents > cap.maxAmountCents) return;
    candidates.push({ rail, feeCents: estimateFeeCents(rail, input.amountCents), confirmation: cap.confirmation });
  });
  if (candidates.length === 0) {
    reasons.push("The payment provider offers no selectable bank rail.");
    return { rail: "card", offerBank: false, preferBank: false, savingsCents: 0, ranked: [card], reasons };
  }

  candidates.sort((a, b) => a.feeCents - b.feeCents || (a.confirmation === b.confirmation ? 0 : a.confirmation === "instant" ? -1 : 1));
  const best = candidates[0];
  const savings = Math.max(0, card.feeCents - best.feeCents);
  const preferBank = s!.routing_mode === "prefer" && savings >= MIN_SAVINGS_TO_PREFER_CENTS;
  reasons.push(savings > 0 ? `Estimated fee saving vs card: ${savings} cents.` : "No fee saving vs card at this amount.");
  if (best.confirmation === "delayed") reasons.push("Funds confirm in up to 4 business days.");
  return { rail: best.rail, offerBank: true, preferBank, savingsCents: savings, ranked: [...candidates, card], reasons };
}

// ---------------------------------------------------------------- failure / return handling

export type FailureCategory = "insufficient_funds" | "account" | "authorization" | "verification" | "unknown";

export interface FailureInfo {
  category: FailureCategory;
  /** The same account can be debited again later (customer funds it). */
  retryable: boolean;
  /** The saved bank account / mandate must not be used again. */
  invalidatesMethod: boolean;
  customerMessage: string;
}

const ACCOUNT_MSG = "your bank couldn’t process a debit from this account. Please pay with a different bank account or a card.";

/**
 * Stripe failure codes for us_bank_account (PaymentIntent last_payment_error.code / charge failure_code).
 * Conservative on purpose: an UNKNOWN code is never retried automatically (never debit repeatedly on a guess).
 */
export function classifyBankFailure(code: string | null | undefined): FailureInfo {
  switch (code) {
    case "insufficient_funds":
      return { category: "insufficient_funds", retryable: true, invalidatesMethod: false, customerMessage: "the account didn’t have enough funds." };
    case "account_closed":
    case "no_account":
    case "invalid_account_number":
    case "bank_account_restricted":
    case "bank_account_unusable":
    case "bank_account_blocked":
      return { category: "account", retryable: false, invalidatesMethod: true, customerMessage: ACCOUNT_MSG };
    case "debit_not_authorized":
      return { category: "authorization", retryable: false, invalidatesMethod: true, customerMessage: "debits are not authorized on this account. Please pay with a different method." };
    case "payment_method_microdeposit_failed":
    case "payment_method_microdeposit_verification_attempts_exceeded":
    case "payment_method_microdeposit_verification_amounts_mismatch":
    case "payment_method_microdeposit_verification_timeout":
      return { category: "verification", retryable: false, invalidatesMethod: true, customerMessage: "we couldn’t verify the bank account. Please start again and connect it instantly through your bank." };
    default:
      return { category: "unknown", retryable: false, invalidatesMethod: false, customerMessage: "the bank payment didn’t go through." };
  }
}

/** Reasons Stripe reports when the bank returns a debit AFTER it showed as succeeded (bank-initiated). Anything else = customer dispute. */
export const BANK_RETURN_REASONS: readonly string[] = ["insufficient_funds", "incorrect_account_details", "bank_cannot_process"];

export function classifyBankReturn(reason: string | null | undefined): { status: "returned" | "disputed"; invalidatesMethod: boolean } {
  const bank = typeof reason === "string" && BANK_RETURN_REASONS.includes(reason);
  return { status: bank ? "returned" : "disputed", invalidatesMethod: reason !== "insufficient_funds" };
}

// ---------------------------------------------------------------- settlement estimate

/** Adds business days (Mon–Fri; bank holidays are NOT modelled — this is an estimate) to a UTC date. Returns YYYY-MM-DD. */
export function addBusinessDays(from: Date, days: number): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let left = Math.max(0, Math.trunc(days));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

export function estimateSettlementDate(from: Date, rail: BankRail): string {
  switch (rail) {
    case "ach_debit": return addBusinessDays(from, 4); // Stripe standard settlement T+4
    case "instant_bank": return addBusinessDays(from, 2);
    default: return addBusinessDays(from, 0);
  }
}

// ---------------------------------------------------------------- PaymentIntent policy

export interface BankIntentPolicyInput {
  /** STRIPE_ACH_DEBIT_ENABLED === "true": ACH Direct Debit is switched on in the PLATFORM's Stripe payment-method settings. */
  platformEnabled: boolean;
  settings: BankSettings | null | undefined;
  /** Invoice amount WITHOUT tip, so a tip change can never flip eligibility between intent updates. */
  baseCents: number;
}

export interface BankIntentExtras {
  excluded_payment_method_types?: string[];
  payment_method_options?: Record<string, unknown>;
}

/** Keeps ACH under Vireek's control even when Stripe has it enabled account-wide, and requests instant verification when allowed. */
export function buildBankIntentExtras(input: BankIntentPolicyInput): BankIntentExtras {
  const allowed = input.platformEnabled && isBankEligible(input.settings, input.baseCents);
  if (!allowed) return { excluded_payment_method_types: ["us_bank_account"] };
  return {
    payment_method_options: {
      us_bank_account: {
        // "automatic" = instant verification through Financial Connections, microdeposits only if the bank isn't supported.
        verification_method: "automatic",
        financial_connections: { permissions: ["payment_method"] },
      },
    },
  };
}

/** Merges extras into PaymentIntent params without clobbering existing payment_method_options (e.g. acss_debit). */
export function mergeIntentParams(params: Record<string, unknown>, extras: BankIntentExtras): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  if (extras.excluded_payment_method_types?.length) out.excluded_payment_method_types = extras.excluded_payment_method_types;
  if (extras.payment_method_options) {
    out.payment_method_options = { ...((params.payment_method_options as Record<string, unknown> | undefined) ?? {}), ...extras.payment_method_options };
  }
  return out;
}

/** What the public pay page needs to describe the bank option (no secrets). */
export function buildBankOffer(input: BankIntentPolicyInput & { amountCents: number }): { offered: boolean; prefer: boolean; savingsCents: number; confirmationDays: number } | null {
  if (!input.platformEnabled) return null;
  const r = suggestRail({ amountCents: input.baseCents, settings: input.settings });
  if (!r.offerBank) return null;
  return { offered: true, prefer: r.preferBank, savingsCents: r.savingsCents, confirmationDays: r.rail === "ach_debit" ? 4 : 0 };
}
