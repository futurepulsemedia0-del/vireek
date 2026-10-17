import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { verifyStripeSignature } from "../_shared/stripe/client.ts";
import { stripe } from "../_shared/paymentPlans/stripe.ts";

// Dedicated endpoint (secret: STRIPE_PLAN_WEBHOOK_SECRET). Events: checkout.session.completed, payment_intent.succeeded.
// Only objects carrying metadata.payment_plan_id are touched — every other payment event is ignored.
// Failures are NOT handled here on purpose: the charge routine records them synchronously and is the single source of truth.
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = Deno.env.get("STRIPE_PLAN_WEBHOOK_SECRET") ?? "";
  const payload = await req.text();
  if (!secret || !(await verifyStripeSignature(payload, req.headers.get("Stripe-Signature") ?? "", secret))) return new Response("Invalid signature", { status: 400 });

  let event: any;
  try { event = JSON.parse(payload); } catch { return new Response("Invalid payload", { status: 400 }); }
  const obj = event?.data?.object;
  const planId = obj?.metadata?.payment_plan_id as string | undefined;
  if (!planId || !["checkout.session.completed", "payment_intent.succeeded"].includes(event.type)) return json({ received: true, ignored: true });

  const secretKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    const installmentId = obj.metadata?.installment_id as string | undefined;
    if (event.type === "checkout.session.completed") {
      let paymentMethod: string | null = null;
      let piId: string | null = null;
      if (obj.mode === "setup" && obj.setup_intent) {
        paymentMethod = (await stripe("GET", `setup_intents/${obj.setup_intent}`, secretKey)).payment_method ?? null;
      } else if (obj.mode === "payment" && obj.payment_intent) {
        if (obj.payment_status !== "paid") return json({ received: true, ignored: true });
        piId = obj.payment_intent;
        const pi = await stripe("GET", `payment_intents/${piId}`, secretKey);
        paymentMethod = typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id ?? null;
      }
      // Only keep a card when the customer consented to future charges (auto-charge plans set setup_future_usage).
      const { data: plan } = await admin.from("payment_plans").select("auto_charge").eq("id", planId).maybeSingle();
      if (!plan) return json({ received: true, ignored: true });
      const { error } = await admin.rpc("activate_payment_plan", { p_plan_id: planId, p_payment_method: plan.auto_charge ? paymentMethod : null, p_customer: obj.customer ?? null });
      if (error) throw error;
      if (installmentId && piId) {
        const { error: e2 } = await admin.rpc("apply_plan_payment", { p_installment_id: installmentId, p_payment_intent: piId, p_status: "succeeded", p_error: null });
        if (e2) throw e2;
      }
    } else if (installmentId) {
      const { error } = await admin.rpc("apply_plan_payment", { p_installment_id: installmentId, p_payment_intent: obj.id, p_status: "succeeded", p_error: null });
      if (error) throw error;
    }
    return json({ received: true });
  } catch (error) {
    console.error(JSON.stringify({ event: "payment_plan_webhook_failed", type: event?.type, error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Webhook handling failed." }, 500); // Stripe retries; RPCs are idempotent
  }
});
