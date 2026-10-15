// Marks a payment_request paid from a succeeded PaymentIntent (Payment Element flow).
// Idempotent and safe to call from webhook retries. Takes the Supabase admin client as a parameter
// so it can be unit-tested with a fake. Ignores PaymentIntents that don't belong to a payment_request
// (e.g. Terminal / Tap to Pay intents, which carry job_payment_id instead).
import { walletFromCharge } from "./paymentIntent.ts";

export interface FinalizeOutcome {
  handled: boolean;
  status?: string;
}

export interface FinalizeOptions {
  /** Optional: loads the charge so the log can say which wallet paid. Failures are ignored (analytics only). */
  fetchCharge?: (chargeId: string) => Promise<any>;
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

  // Keep any Checkout session id already stored on the row (legacy links) instead of overwriting it with null.
  const { data: row } = await admin.from("payment_requests").select("stripe_checkout_session_id").eq("id", requestId).maybeSingle();

  const { data: result, error } = await admin.rpc("finalize_paid_payment_request", {
    p_request_id: requestId,
    p_session_id: row?.stripe_checkout_session_id ?? null,
    p_payment_intent_id: pi.id,
    p_amount_total_cents: received,
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
    console.log(JSON.stringify({ event: "payment_request_paid", requestId, paymentIntent: pi.id, wallet }));
  }
  return { handled: true, status: result?.status ?? "unknown" };
}
