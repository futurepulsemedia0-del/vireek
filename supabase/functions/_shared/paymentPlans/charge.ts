import { stripe, StripeError } from "./stripe.ts";
import { chargeIdempotencyKey, formatMoney } from "./logic.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../notify/deliver.ts";
import { sendGuardedSms } from "../messaging/gatedSend.ts";

export type ChargeOutcome = "paid" | "failed" | "requires_action" | "skipped" | "pending";

export const payLinkFor = (kind: "p" | "i", id: string) =>
  `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "")}/functions/v1/payment-plan-pay?${kind}=${id}`;

/**
 * The account that owns a customer contact, needed so the SMS can pass the fraud guard. Callers pass user_id when they
 * have it; the bank-payment handler only has the pay link, so it is resolved from the link here.
 */
async function resolveContactOwner(plan: any): Promise<string | null> {
  if (typeof plan?.user_id === "string" && plan.user_id) return plan.user_id;
  if (!plan?.link_id || !plan?.link_kind) return null;
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  if (plan.link_kind === "pay") {
    const { data } = await admin.from("payment_requests").select("user_id").eq("public_token", plan.link_id).maybeSingle();
    return (data?.user_id as string | undefined) ?? null;
  }
  const { data } = await admin.from("payment_plan_installments").select("payment_plans(user_id)").eq("id", plan.link_id).maybeSingle();
  const p = (data as { payment_plans?: { user_id?: string } | { user_id?: string }[] } | null)?.payment_plans;
  return (Array.isArray(p) ? p[0]?.user_id : p?.user_id) ?? null;
}

export async function notifyCustomer(plan: any, subject: string, text: string): Promise<void> {
  if (plan.customer_phone) {
    // Customer SMS goes through the fraud guard (purpose "service": payment links / reminders are transactional).
    const owner = await resolveContactOwner(plan);
    if (!owner) console.error(JSON.stringify({ event: "customer_sms_skipped_owner_unresolved" }));
    else {
      const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
      const r = await sendGuardedSms(admin, owner, plan.customer_phone, text, { purpose: "service", source: "payment-plan-notify" });
      if (!r.ok && r.blocked) console.error(JSON.stringify({ event: "customer_sms_blocked_by_guard", code: r.blocked.code, retryable: r.blocked.retryable }));
    }
  }
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
      ...(plan.payment_rail === "bank" ? { payment_method_types: ["us_bank_account"] } : {}),
      off_session: true, confirm: true, transfer_data: { destination: connect.stripe_account_id },
      description: `Payment plan installment ${inst.seq} — ${plan.customer_name}`,
      metadata: { payment_plan_id: plan.id, installment_id: inst.id, source: "auto" },
    }, chargeIdempotencyKey(inst.id, inst.attempt_count));
    if (pi.status === "succeeded") { await apply("succeeded", pi.id); outcome = "paid"; }
    else if (pi.status === "requires_action") { await apply("requires_action", pi.id); outcome = "requires_action"; }
    else if (pi.status === "processing" && plan.payment_rail === "bank") {
      const { error: be } = await admin.rpc("bank_attempt_apply", { p: {
        provider_payment_id: pi.id, status: "processing", installment_id: inst.id, amount_cents: amount, rail: "ach_debit",
        event_created: Math.floor(Date.now() / 1000), provider_event_id: `charge_${pi.id}_processing`, event_type: "payment_intent.processing",
      } });
      if (be) throw be;
      outcome = "pending";
    }
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
