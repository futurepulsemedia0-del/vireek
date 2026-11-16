// supabase/functions/_shared/billing/topup.ts
//
// 100-minute top-up packs (one-time Stripe Checkout, mode "payment").
//
// Pure helpers + an orchestration function with injected I/O (`TopupDeps`) so Vitest runs the exact
// production logic. No Deno globals, no Stripe/Supabase imports.
//
// A pack is credited ONLY when ALL of these hold (see evaluateTopupSession):
//   * the session is a paid one-time Checkout we created (metadata.purchase_type = "topup_100")
//   * session.customer belongs to exactly one profile, and that profile is metadata.supabase_user_id
//   * every line item is the configured pack price (STRIPE_PRICE_TOPUP_100), quantity 1..10
// Replays are harmless: credit_topup() is UNIQUE on the Checkout Session id.

export const TOPUP_PRICE_ENV = "STRIPE_PRICE_TOPUP_100";
export const TOPUP_PURCHASE_TYPE = "topup_100";
export const TOPUP_MINUTES_PER_PACK = 100;
export const TOPUP_MAX_QUANTITY = 10;

export interface TopupSessionLike {
  id: string;
  mode?: string | null;
  payment_status?: string | null;
  customer?: string | { id: string } | null;
  currency?: string | null;
  amount_total?: number | null;
  payment_intent?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
}

export interface TopupLineItemLike {
  price?: { id?: string | null } | null;
  quantity?: number | null;
}

export interface TopupProfileLike {
  id: string;
  stripe_customer_id: string | null;
}

export type TopupRejection =
  | "not_topup"
  | "price_not_configured"
  | "not_paid"
  | "no_customer"
  | "no_profile"
  | "ambiguous_profile"
  | "customer_mismatch"
  | "missing_user"
  | "user_mismatch"
  | "unexpected_line_item"
  | "bad_quantity";

export type TopupVerdict =
  | { ok: true; userId: string; quantity: number; minutes: number }
  | { ok: false; reason: TopupRejection };

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id ?? null;
}

/** Quantity the browser asked for: undefined -> 1; anything but an integer in 1..10 -> null (reject). */
export function parseTopupQuantity(input: unknown): number | null {
  if (input === undefined || input === null) return 1;
  if (typeof input !== "number" || !Number.isInteger(input)) return null;
  return input >= 1 && input <= TOPUP_MAX_QUANTITY ? input : null;
}

export function topupMinutes(quantity: number): number {
  return quantity * TOPUP_MINUTES_PER_PACK;
}

export function isTopupSession(session: Pick<TopupSessionLike, "mode" | "metadata">): boolean {
  return session.mode === "payment" && session.metadata?.purchase_type === TOPUP_PURCHASE_TYPE;
}

export function evaluateTopupSession(input: {
  session: TopupSessionLike;
  lineItems: TopupLineItemLike[];
  profiles: TopupProfileLike[];
  expectedPriceId: string | undefined;
}): TopupVerdict {
  const { session, lineItems, profiles, expectedPriceId } = input;
  if (!isTopupSession(session)) return { ok: false, reason: "not_topup" };
  if (!expectedPriceId) return { ok: false, reason: "price_not_configured" };
  if (session.payment_status !== "paid") return { ok: false, reason: "not_paid" };

  const customerId = idOf(session.customer);
  if (!customerId) return { ok: false, reason: "no_customer" };
  if (profiles.length === 0) return { ok: false, reason: "no_profile" };
  if (profiles.length > 1) return { ok: false, reason: "ambiguous_profile" };
  const profile = profiles[0];
  if (profile.stripe_customer_id !== customerId) return { ok: false, reason: "customer_mismatch" };

  const claimedUser = session.metadata?.supabase_user_id;
  if (!claimedUser) return { ok: false, reason: "missing_user" };
  if (claimedUser !== profile.id) return { ok: false, reason: "user_mismatch" };

  let quantity = 0;
  for (const item of lineItems) {
    if (item.price?.id !== expectedPriceId) return { ok: false, reason: "unexpected_line_item" };
    quantity += Number.isInteger(item.quantity) ? (item.quantity as number) : 0;
  }
  if (quantity < 1 || quantity > TOPUP_MAX_QUANTITY) return { ok: false, reason: "bad_quantity" };

  return { ok: true, userId: profile.id, quantity, minutes: topupMinutes(quantity) };
}

export interface CreditArgs {
  p_user: string | null;
  p_session_id: string;
  p_payment_intent: string | null;
  p_quantity: number;
  p_minutes: number;
  p_amount_cents: number | null;
  p_currency: string | null;
  p_status: "credited" | "rejected";
  p_reason: string | null;
}

export interface TopupDeps {
  expectedPriceId: string | undefined;
  listLineItems(sessionId: string): Promise<TopupLineItemLike[]>;
  findProfilesByCustomer(customerId: string): Promise<TopupProfileLike[]>;
  recordCredit(args: CreditArgs): Promise<"credited" | "duplicate" | "rejected">;
  log(event: string, detail: Record<string, unknown>): void;
}

export type TopupOutcome =
  | { outcome: "ignored" }
  | { outcome: "pending_payment" }
  | { outcome: "credited"; minutes: number }
  | { outcome: "duplicate" }
  | { outcome: "rejected"; reason: TopupRejection };

/** Credits a paid top-up exactly once. Throws on transient errors so the webhook retries. */
export async function processTopupSession(session: TopupSessionLike, deps: TopupDeps): Promise<TopupOutcome> {
  if (!isTopupSession(session)) return { outcome: "ignored" };
  // Delayed payment methods complete the session unpaid; Stripe sends async_payment_succeeded later.
  if (session.payment_status !== "paid") return { outcome: "pending_payment" };
  // Misconfiguration must retry (webhook 500), never permanently reject a legitimate paid session.
  if (!deps.expectedPriceId) throw new Error(`${TOPUP_PRICE_ENV} is not configured`);

  const customerId = idOf(session.customer);
  const [profiles, lineItems] = customerId
    ? await Promise.all([deps.findProfilesByCustomer(customerId), deps.listLineItems(session.id)])
    : [[], []];

  const verdict = evaluateTopupSession({ session, lineItems, profiles, expectedPriceId: deps.expectedPriceId });
  const common = {
    p_session_id: session.id,
    p_payment_intent: idOf(session.payment_intent),
    p_amount_cents: Number.isInteger(session.amount_total) ? (session.amount_total as number) : null,
    p_currency: session.currency ?? null,
  };

  if (!verdict.ok) {
    deps.log("topup_rejected", { session: session.id, reason: verdict.reason });
    await deps.recordCredit({
      ...common,
      p_user: profiles.length === 1 ? profiles[0].id : null,
      p_quantity: 0,
      p_minutes: 0,
      p_status: "rejected",
      p_reason: verdict.reason,
    });
    return { outcome: "rejected", reason: verdict.reason };
  }

  const result = await deps.recordCredit({
    ...common,
    p_user: verdict.userId,
    p_quantity: verdict.quantity,
    p_minutes: verdict.minutes,
    p_status: "credited",
    p_reason: null,
  });
  return result === "credited" ? { outcome: "credited", minutes: verdict.minutes } : { outcome: "duplicate" };
}

// ------------------------------------------------------------------------------------------- reversal

export interface ReverseArgs {
  p_payment_intent: string;
  /** CUMULATIVE refunded/disputed amount of the payment, in the smallest currency unit. */
  p_refunded_cents: number;
  p_reason: string;
}

export interface TopupReversalDeps {
  reverse(args: ReverseArgs): Promise<"reversed" | "noop" | "not_topup">;
  log(event: string, detail: Record<string, unknown>): void;
}

export type TopupReversalOutcome =
  | { outcome: "ignored"; reason: "no_payment_intent" | "bad_amount" }
  | { outcome: "reversed" | "noop" | "not_topup" };

/**
 * Claws purchased minutes back after a refund (charge.refunded) or dispute (charge.dispute.created).
 * Idempotent: the database works on the cumulative amount. Charges that are not top-up packs are a no-op.
 */
export async function processTopupReversal(
  input: { paymentIntentId: string | null | undefined; cumulativeAmountCents: number; reason: "refund" | "dispute" },
  deps: TopupReversalDeps,
): Promise<TopupReversalOutcome> {
  if (!input.paymentIntentId) return { outcome: "ignored", reason: "no_payment_intent" };
  if (!Number.isInteger(input.cumulativeAmountCents) || input.cumulativeAmountCents <= 0) {
    return { outcome: "ignored", reason: "bad_amount" };
  }
  const result = await deps.reverse({
    p_payment_intent: input.paymentIntentId,
    p_refunded_cents: input.cumulativeAmountCents,
    p_reason: input.reason,
  });
  if (result === "reversed") deps.log("topup_reversed", { payment_intent: input.paymentIntentId, reason: input.reason });
  return { outcome: result };
}
