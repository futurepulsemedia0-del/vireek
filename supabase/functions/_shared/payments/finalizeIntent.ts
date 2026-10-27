// Marks a payment_request paid from a succeeded PaymentIntent (Payment Element flow).
// Idempotent and safe to call from webhook retries. Takes the Supabase admin client as a parameter
// so it can be unit-tested with a fake. Ignores PaymentIntents that don't belong to a payment_request
// (e.g. Terminal / Tap to Pay intents, which carry job_payment_id instead).
import { walletFromCharge } from "./paymentIntent.ts";
import { cardFromCharge } from "../membershipRenewal/logic.ts";
import { decideFeeOutcome } from "./pricing.ts";

export interface FinalizeOutcome {
  handled: boolean;
  status?: string;
}

export interface FinalizeOptions {
  /** Optional: loads the charge so the log can say which wallet paid. Failures are ignored (analytics only). */
  fetchCharge?: (chargeId: string) => Promise<any>;
  /** Refunds the card fee to the customer (destination charge, transfer reversed). Injected so tests need no Stripe. */
  refundFee?: (args: { paymentIntentId: string; amountCents: number; requestId: string }) => Promise<void>;
}

/** First-time public membership signup: offered -> active once the first payment lands. Idempotent. */
export async function activateSignupMembership(admin: any, membershipId: string): Promise<void> {
  const { data: membership } = await admin
    .from("memberships")
    .select("id, status, membership_plans:plan_id(billing_interval, visits_included_per_period)")
    .eq("id", membershipId)
    .maybeSingle();
  if (!membership || membership.status !== "offered") return;

  const plan = membership.membership_plans as { billing_interval: "monthly" | "yearly"; visits_included_per_period: number } | null;
  const start = new Date();
  const end = new Date(start);
  if (plan?.billing_interval === "monthly") end.setMonth(end.getMonth() + 1);
  else end.setFullYear(end.getFullYear() + 1);

  await admin
    .from("memberships")
    .update({
      status: "active",
      started_at: start.toISOString(),
      current_period_start: start.toISOString(),
      current_period_end: end.toISOString(),
      visits_included_current_period: plan?.visits_included_per_period ?? 0,
      visits_used_current_period: 0,
    })
    .eq("id", membershipId)
    .eq("status", "offered");
}
/**
 * Saves the card used for a membership payment when the customer opted in to automatic renewal.
 * Scoped to the owning user (from the server-set intent metadata) and safe to repeat.
 */
export async function saveMembershipCard(admin: any, membershipId: string, pi: any, charge: any, now: Date = new Date()): Promise<void> {
  const customerId = typeof pi?.customer === "string" ? pi.customer : pi?.customer?.id;
  const methodId = typeof pi?.payment_method === "string" ? pi.payment_method : pi?.payment_method?.id;
  if (!customerId || !methodId) return;
  const card = cardFromCharge(charge);
  await admin
    .from("memberships")
    .update({
      stripe_customer_id: customerId,
      stripe_payment_method_id: methodId,
      card_brand: card?.brand ?? null,
      card_last4: card?.last4 ?? null,
      card_exp_month: card?.exp_month || null,
      card_exp_year: card?.exp_year || null,
      auto_renew: true,
      auto_renew_consent_at: now.toISOString(),
    })
    .eq("id", membershipId)
    .eq("user_id", pi?.metadata?.user_id ?? "");
}

/**
 * Decides whether the card fee stays or goes back to the customer (surcharge: credit cards only), refunds it when
 * needed, then records the outcome. Safe to repeat: fixed idempotency key, never refunds an already-refunded charge,
 * and the record RPC is idempotent. Throws on failure so Stripe retries the webhook.
 */
async function settleCardFee(admin: any, pi: any, charge: any, requestId: string, feeCents: number, opts: FinalizeOptions): Promise<void> {
  if (!charge) throw new Error("charge_unavailable_for_fee_settlement");
  const details = charge.payment_method_details ?? {};
  const methodType = typeof details.type === "string" ? details.type : null;
  const funding = typeof details.card?.funding === "string" ? details.card.funding : null;
  const outcome = decideFeeOutcome({
    feeCents,
    mode: pi.metadata?.fee_mode,
    excludeDebit: pi.metadata?.fee_excl_debit !== "0",
    methodType,
    funding,
  });
  if (outcome.refundCents > 0 && (Number(charge.amount_refunded) || 0) < outcome.refundCents) {
    if (!opts.refundFee) throw new Error("fee_refund_not_configured");
    await opts.refundFee({ paymentIntentId: pi.id, amountCents: outcome.refundCents, requestId });
  }
  const bps = Number.parseInt(pi.metadata?.fee_bps ?? "", 10);
  const { error } = await admin.rpc("record_payment_request_fee", {
    p_request_id: requestId,
    p_fee_cents: feeCents,
    p_refunded_cents: outcome.refundCents,
    p_mode: pi.metadata?.fee_mode ?? "",
    p_label: pi.metadata?.fee_label ?? "",
    p_bps: Number.isFinite(bps) ? bps : null,
    p_refund_reason: outcome.refundCents > 0 ? outcome.reason : "",
    p_method_type: methodType ?? "",
    p_funding: funding ?? "",
  });
  if (error) throw error;
  console.log(JSON.stringify({ event: "payment_fee_settled", requestId, kept: outcome.keepCents, refunded: outcome.refundCents, reason: outcome.reason }));
}
export async function finalizePaymentRequestFromIntent(admin: any, pi: any, opts: FinalizeOptions = {}): Promise<FinalizeOutcome> {
  const requestId = pi?.metadata?.payment_request_id as string | undefined;
  if (!requestId) return { handled: false };
  if (pi.status !== "succeeded") return { handled: true, status: pi.status };

  if (String(pi.currency).toLowerCase() !== "usd") {
    console.error(JSON.stringify({ event: "payment_currency_mismatch", requestId, paymentIntent: pi.id, currency: pi.currency }));
    return { handled: true, status: "currency_mismatch" };
  }

  const tipCents = Number.parseInt(pi.metadata?.tip_cents ?? "0", 10) || 0;
  const received = typeof pi.amount_received === "number" && pi.amount_received > 0 ? pi.amount_received : pi.amount;
  // The card fee rides on the same charge but is not part of the invoice: strip it for the amount check, settle it below.
  const feeCents = Number.parseInt(pi.metadata?.fee_cents ?? "0", 10) || 0;
  const invoiceAndTip = feeCents > 0 && feeCents < received ? received - feeCents : received;

  // Keep any Checkout session id already stored on the row (legacy links) instead of overwriting it with null.
  const { data: row } = await admin.from("payment_requests").select("stripe_checkout_session_id").eq("id", requestId).maybeSingle();

  const { data: result, error } = await admin.rpc("finalize_paid_payment_request", {
    p_request_id: requestId,
    p_session_id: row?.stripe_checkout_session_id ?? null,
    p_payment_intent_id: pi.id,
    p_amount_total_cents: invoiceAndTip,
    p_tip_cents: tipCents,
  });
  if (error) throw error;

  if (result?.status === "amount_mismatch") {
    // Money moved but amounts disagree: never auto-fix silently — surface it for a human.
    console.error(JSON.stringify({ event: "payment_amount_mismatch", requestId, paymentIntent: pi.id, result }));
    return { handled: true, status: "amount_mismatch" };
  }

  if (result?.status === "paid" || result?.status === "already_paid") {
    if (pi.metadata?.membership_signup === "true" && pi.metadata?.membership_id) {
      await activateSignupMembership(admin, pi.metadata.membership_id);
    }
    let charge = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
    if (!charge && typeof pi.latest_charge === "string" && opts.fetchCharge) {
      try { charge = await opts.fetchCharge(pi.latest_charge); } catch { /* the wallet label is optional */ }
    }
    const wallet = walletFromCharge(charge);
    if (feeCents > 0) await settleCardFee(admin, pi, charge, requestId, feeCents, opts);
      if (pi.metadata?.save_card === "true" && pi.metadata?.membership_id && charge?.payment_method_details?.type !== "us_bank_account") {
      try {
        await saveMembershipCard(admin, pi.metadata.membership_id, pi, charge);
      } catch (e) {
        // The payment is already recorded; a card-save hiccup must not fail the webhook.
        console.error(JSON.stringify({ event: "membership_card_save_failed", requestId, error: e instanceof Error ? e.message : String(e) }));
      }
    }
    console.log(JSON.stringify({ event: "payment_request_paid", requestId, paymentIntent: pi.id, wallet }));
  }
  return { handled: true, status: result?.status ?? "unknown" };
}
