import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripe } from "../_shared/paymentPlans/stripe.ts";
import { buildTerms } from "../_shared/paymentPlans/logic.ts";
import { chargeInstallment, notifyCustomer, payLinkFor } from "../_shared/paymentPlans/charge.ts";

// Authenticated actions: { action: 'send', plan_id } | { action: 'charge_now', installment_id }
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) throw new HttpError(401, "Missing Authorization header.");
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) throw new HttpError(401, "Invalid or expired session.");
    const caller = userData.user;

    const { data: profile } = await admin.from("profiles").select("id").eq("id", caller.id).maybeSingle();
    let ownerId = profile?.id as string | undefined;
    if (!ownerId) {
      const { data: member } = await admin.from("team_members").select("account_owner_id, permissions").eq("member_email", caller.email ?? "").maybeSingle();
      if (!member?.account_owner_id || !member.permissions?.can_view_billing) throw new HttpError(403, "You don't have permission to manage payment plans.");
      ownerId = member.account_owner_id;
    }

    const body = await req.json().catch(() => ({}));
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secretKey) throw new HttpError(500, "Payments aren't configured on this server yet (missing STRIPE_SECRET_KEY).");

    if (body.action === "charge_now") {
      const { data: inst } = await admin.from("payment_plan_installments").select("id").eq("id", body.installment_id ?? "").eq("user_id", ownerId).maybeSingle();
      if (!inst) throw new HttpError(404, "Installment not found.");
      const result = await chargeInstallment(admin, secretKey, inst.id, true);
      if (result.outcome === "skipped") throw new HttpError(409, "This installment can't be charged right now (no saved card, plan not active, or already in progress).");
      return json({ ok: true, outcome: result.outcome, error: result.error ?? null });
    }

    if (body.action !== "send") throw new HttpError(400, "Unknown action.");
    const { data: plan } = await admin.from("payment_plans").select("*, installments:payment_plan_installments(*)").eq("id", body.plan_id ?? "").eq("user_id", ownerId).maybeSingle();
    if (!plan) throw new HttpError(404, "Plan not found.");
    if (!["draft", "pending_authorization"].includes(plan.status)) throw new HttpError(409, "This plan has already been approved or closed.");

    const { data: connect } = await admin.from("stripe_connect_accounts").select("charges_enabled, stripe_account_id").eq("user_id", ownerId).maybeSingle();
    if (!connect?.stripe_account_id || !connect.charges_enabled) throw new HttpError(400, "Connect and finish verifying your Stripe account before sending a plan.");

    let customerId = plan.stripe_customer_id as string | null;
    if (!customerId) {
      const c = await stripe("POST", "customers", secretKey, { name: plan.customer_name, email: plan.customer_email ?? undefined, phone: plan.customer_phone ?? undefined, metadata: { payment_plan_id: plan.id } }, `pplan-customer-${plan.id}`);
      customerId = c.id;
    }

    const regular = (plan.installments ?? []).filter((i: any) => i.kind === "installment").sort((a: any, b: any) => a.seq - b.seq);
    const terms = buildTerms({
      customer_name: plan.customer_name, currency: plan.currency, total_cents: Number(plan.total_cents), deposit_cents: Number(plan.deposit_cents),
      installment_count: plan.installment_count, installment_cents: regular.map((i: any) => Number(i.amount_cents)), first_due_date: plan.first_due_date,
      frequency: plan.frequency, auto_charge: plan.auto_charge, late_fee_type: plan.late_fee_type, late_fee_value: Number(plan.late_fee_value),
      late_fee_cap_cents: Number(plan.late_fee_cap_cents), grace_days: plan.grace_days,
    });
    const link = payLinkFor("p", plan.id);
    const { error } = await admin.rpc("mark_plan_authorization_sent", { p_plan_id: plan.id, p_session_id: null, p_url: link, p_customer: customerId, p_terms: terms });
    if (error) throw error;

    await notifyCustomer(plan, "Review and approve your payment plan", `Hi ${plan.customer_name}, ${terms} Review and approve here: ${link}`);
    return json({ ok: true, authorization_url: link });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error(JSON.stringify({ event: "payment_plan_actions_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
