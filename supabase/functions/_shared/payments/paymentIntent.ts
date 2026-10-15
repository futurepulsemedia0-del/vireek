// Pure helpers for the embedded Payment Element flow (cards, Apple Pay, Google Pay, ...).
// No imports and no runtime APIs: shared by the Deno edge functions and vitest. Keep it that way.

export const PAYMENT_CURRENCY = "usd";
export const MIN_CHARGE_CENTS = 50; // Stripe's minimum charge for USD

/** PaymentIntent states in which the same intent can safely be re-used / updated for another attempt. */
export const REUSABLE_INTENT_STATUSES = ["requires_payment_method", "requires_confirmation", "requires_action"] as const;

export function isReusableIntentStatus(status: unknown): boolean {
  return typeof status === "string" && (REUSABLE_INTENT_STATUSES as readonly string[]).includes(status);
}

export interface IntentMetadataInput {
  requestId: string;
  userId: string;
  jobId?: string | null;
  baseCents: number;
  tipCents: number;
  technicianId?: string | null;
  membershipId?: string | null;
  /** True only for a first-time public signup (membership still "offered"). */
  membershipSignup?: boolean;
}

/** Same keys the Checkout flow wrote (flow "tip_v1"), so the webhook and finalize RPC treat both identically. */
export function buildIntentMetadata(input: IntentMetadataInput): Record<string, string> {
  const meta: Record<string, string> = {
    flow: "tip_v1",
    payment_request_id: input.requestId,
    user_id: input.userId,
    base_cents: String(input.baseCents),
    tip_cents: String(input.tipCents),
  };
  if (input.jobId) meta.job_id = input.jobId;
  if (input.tipCents > 0 && input.technicianId) meta.technician_id = input.technicianId;
  if (input.membershipId) {
    meta.membership_id = input.membershipId;
    if (input.membershipSignup) meta.membership_signup = "true";
  }
  return meta;
}

export interface IntentParamsInput {
  baseCents: number;
  tipCents: number;
  destinationAccountId: string;
  description: string;
  receiptEmail?: string | null;
  metadata: Record<string, string>;
}

/**
 * Destination-charge PaymentIntent. `automatic_payment_methods` lets the Stripe Dashboard decide
 * which methods (incl. Apple Pay and Google Pay) the Payment Element offers — no code change needed
 * to turn a wallet on or off later.
 */
export function buildPaymentIntentParams(input: IntentParamsInput): Record<string, unknown> {
  const { baseCents, tipCents } = input;
  if (!Number.isInteger(baseCents) || baseCents <= 0) throw new Error("Invalid invoice amount.");
  if (!Number.isInteger(tipCents) || tipCents < 0) throw new Error("Invalid tip amount.");
  const amount = baseCents + tipCents;
  if (amount < MIN_CHARGE_CENTS) throw new Error("This amount is below the minimum that can be charged online.");
  if (!input.destinationAccountId) throw new Error("Missing connected account.");
  return {
    amount,
    currency: PAYMENT_CURRENCY,
    automatic_payment_methods: { enabled: true },
    transfer_data: { destination: input.destinationAccountId },
    description: input.description.slice(0, 500),
    receipt_email: input.receiptEmail || undefined,
    metadata: input.metadata,
  };
}

export type WalletType = "apple_pay" | "google_pay";

/** Which wallet (if any) paid a charge — used for structured logging / analytics only. */
export function walletFromCharge(charge: any): WalletType | null {
  const type = charge?.payment_method_details?.card?.wallet?.type;
  return type === "apple_pay" || type === "google_pay" ? type : null;
}
