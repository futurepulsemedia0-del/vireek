import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripe } from "../_shared/paymentPlans/stripe.ts";
import { formatMoney } from "../_shared/paymentPlans/logic.ts";

// PUBLIC link target (deploy with --no-verify-jwt). The UUID in the URL is the capability (same model as
// /service and /approve tokens). It mints a FRESH Stripe Checkout session on every click — sessions expire after
// 24h, this link never does — then 303-redirects to it.
//   ?p=<plan_id>        approve the plan (pays the deposit, or just saves a card when there is no deposit)
//   ?i=<installment_id> pay one open installment now (also refreshes the saved card on auto-charge plans)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const page = (title: string, body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:420px;margin:15vh auto;padding:0 24px;color:#111827"><h1 style="font-size:20px">${title}</h1><p style="color:#4b5563;line-height:1.5">${body}</p></body>`, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  const planParam = url.searchParams.get("p");
  const instParam = url.searchParams.get("i");
  const id = planParam ?? instParam;
  if (!id || !UUID.test(id)) return page("Link not valid", "This payment link is not valid. Please contact the business that sent it.", 404);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secretKey) return page("Payments unavailable", "Payments aren't configured right now. Please try again later.", 503);
    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

    let plan: any; let inst: any = null;
    if (instParam) {
      const { data } = await admin.from("payment_plan_installments").select("*, plan:payment_plans(*)").eq("id", instParam).maybeSingle();
      if (!data) return page("Link not valid", "This payment link is not valid.", 404);
      inst = data; plan = data.plan;
      if (plan.status !== "active" || !["scheduled", "failed", "requires_action"].includes(inst.status)) return page("Nothing to pay", "This installment is already settled or no longer active. Thank you!");
    } else {
      const { data } = await admin.from("payment_plans").select("*, installments:payment_plan_installments(*)").eq("id", planParam).maybeSingle();
      if (!data) return page("Link not valid", "This payment link is not valid.", 404);
      plan = data;
      if (!["draft", "pending_authorization"].includes(plan.status) || !plan.terms_text || !plan.stripe_customer_id) {
        return page(plan.status === "active" ? "Already approved" : "Plan unavailable", plan.status === "active" ? "This plan is already approved. Thank you!" : "This plan is no longer available. Please contact the business.");
      }
      inst = (plan.installments ?? []).find((i: any) => i.kind === "deposit") ?? null;
    }

    const { data: connect } = await admin.from("stripe_connect_accounts").select("stripe_account_id, charges_enabled").eq("user_id", plan.user_id).maybeSingle();
    if (!connect?.stripe_account_id || !connect.charges_enabled) return page("Payments unavailable", "The business can't accept payments right now. Please contact them.", 503);

    const metadata = { payment_plan_id: plan.id, ...(inst ? { installment_id: inst.id } : {}) };
    const base: Record<string, unknown> = {
      customer: plan.stripe_customer_id, payment_method_types: ["card"], metadata,
      success_url: `${siteUrl}/pay-result?status=success`, cancel_url: `${siteUrl}/pay-result?status=cancel`,
      custom_text: { submit: { message: String(plan.terms_text ?? "").slice(0, 1000) } },
    };

    let session: any;
    if (inst) {
      const amount = Number(inst.amount_cents) + Number(inst.late_fee_cents);
      session = await stripe("POST", "checkout/sessions", secretKey, {
        ...base, mode: "payment",
        line_items: [{ quantity: 1, price_data: { currency: plan.currency, unit_amount: amount, product_data: { name: inst.kind === "deposit" ? `Deposit — ${plan.customer_name}` : `Installment ${inst.seq} — ${plan.customer_name}`, description: formatMoney(amount, plan.currency) } } }],
        payment_intent_data: { ...(plan.auto_charge ? { setup_future_usage: "off_session" } : {}), transfer_data: { destination: connect.stripe_account_id }, metadata },
      });
    } else {
      session = await stripe("POST", "checkout/sessions", secretKey, { ...base, mode: "setup", setup_intent_data: { metadata } });
    }
    return new Response(null, { status: 303, headers: { Location: session.url } });
  } catch (error) {
    console.error(JSON.stringify({ event: "payment_plan_pay_failed", error: error instanceof Error ? error.message : String(error) }));
    return page("Something went wrong", "We couldn't open the payment page. Please try again in a moment.", 500);
  }
});
