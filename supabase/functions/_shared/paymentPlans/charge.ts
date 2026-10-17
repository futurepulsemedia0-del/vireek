import { stripe, StripeError } from "./stripe.ts";
import { chargeIdempotencyKey, formatMoney } from "./logic.ts";
import { sendEmail, sendSms } from "../notify/deliver.ts";

export type ChargeOutcome = "paid" | "failed" | "requires_action" | "skipped";

export const payLinkFor = (kind: "p" | "i", id: string) =>
  `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "")}/functions/v1/payment-plan-pay?${kind}=${id}`;

export async function notifyCustomer(plan: any, subject: string, text: string): Promise<void> {
  if (plan.customer_phone) await sendSms(plan.customer_phone, text);
  if (plan.customer_email) {
    const esc = text.replace(/[&<>"]/g, (c: string) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]);
    await sendEmail(plan.customer_email, subject, `<p style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5">${esc}</p>`, text);
  }
}

/**
 * Charges one installment off-session. Claim-based: returns "skipped" if someone else holds it or it is not chargeable.
 * Network/5xx errors deliberately leave the row in 'processing' — the runner re-claims it after 30 min and Stripe replays
 * the same idempotency key, so a crash can never double-charge.
 */
export async function chargeInstallment(admin: any, secretKey: string, installmentId: string, manual = false): Promise<{ outcome: ChargeOutcome; error?: string }> {
  const { data: claim, error: claimError } = await admin.rpc("claim_installment_for_charge", { p_installment_id: installmentId, p_manual: manual });
  if (claimError) throw claimError;
  if (!claim) return { outcome: "skipped" };
  const inst = claim.installment, plan = claim.plan;

  const apply = async (status: string, pi: string | null, error?: string) => {
    const { error: e } = await admin.rpc("apply_plan_payment", { p_installment_id: inst.id, p_payment_intent: pi, p_status: status, p_error: error ?? null });
    if (e) throw e;
  };

  const { data: connect } = await admin.from("stripe_connect_accounts").select("stripe_account_id, charges_enabled").eq("user_id", plan.user_id).maybeSingle();
  if (!connect?.stripe_account_id || !connect.charges_enabled) {
    await apply("failed", null, "Your Stripe account is not ready to accept charges.");
    return { outcome: "failed", error: "Stripe account not ready" };
  }

  const amount = Number(inst.amount_cents) + Number(inst.late_fee_cents);
  const link = payLinkFor("i", inst.id);
  let outcome: ChargeOutcome;
  let error: string | undefined;
  try {
    const pi = await stripe("POST", "payment_intents", secretKey, {
      amount, currency: plan.currency, customer: plan.stripe_customer_id, payment_method: plan.stripe_payment_method_id,
      off_session: true, confirm: true, transfer_data: { destination: connect.stripe_account_id },
      description: `Payment plan installment ${inst.seq} — ${plan.customer_name}`,
      metadata: { payment_plan_id: plan.id, installment_id: inst.id, source: "auto" },
    }, chargeIdempotencyKey(inst.id, inst.attempt_count));
    if (pi.status === "succeeded") { await apply("succeeded", pi.id); outcome = "paid"; }
    else if (pi.status === "requires_action") { await apply("requires_action", pi.id); outcome = "requires_action"; }
    else { error = "The payment could not be completed."; await apply("failed", pi.id, error); outcome = "failed"; }
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    if (e.code === "authentication_required") { await apply("requires_action", e.paymentIntentId); outcome = "requires_action"; }
    else if (e.type === "card_error" || e.type === "invalid_request_error" || e.type === "idempotency_error") { error = e.message; await apply("failed", e.paymentIntentId, error); outcome = "failed"; }
    else throw e; // api_error / rate limit: leave 'processing' for safe replay
  }

  if (outcome === "failed" || outcome === "requires_action") {
    const amt = formatMoney(amount, plan.currency);
    await notifyCustomer(plan, `Action needed: ${amt} payment`,
      outcome === "requires_action"
        ? `Hi ${plan.customer_name}, your bank needs you to confirm your ${amt} payment. Please complete it here: ${link}`
        : `Hi ${plan.customer_name}, we couldn't charge your card for ${amt}. Please pay or update your card here: ${link}`);
  }
  return { outcome: outcome!, error };
}
