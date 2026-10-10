import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { verifyStripeSignature } from "../_shared/stripe/client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature",
};

// Activates a membership created by the public /join page once its Checkout
// payment lands. Idempotent: only an "offered" row is touched, so Stripe
// retries and renewal payments (which carry no membership_signup flag) are no-ops.
async function activateSignupMembership(admin: any, membershipId: string) {
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
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const signature = req.headers.get("Stripe-Signature") ?? "";
  const webhookSecret = Deno.env.get("STRIPE_PAYMENT_WEBHOOK_SECRET") ?? "";
  const payload = await req.text();

  if (!webhookSecret || !(await verifyStripeSignature(payload, signature, webhookSecret))) {
    return new Response("Invalid signature", { status: 400 });
  }

  const event = JSON.parse(payload);
  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const requestId = session.metadata?.payment_request_id;
        if (requestId) {
          const { data: request } = await admin
            .from("payment_requests")
            .update({ status: "paid", paid_at: new Date().toISOString(), stripe_payment_intent_id: session.payment_intent ?? null })
            .eq("id", requestId)
            .select("job_id")
            .maybeSingle();
          if (request?.job_id) await admin.from("jobs").update({ invoice_status: "paid" }).eq("id", request.job_id);
          if (session.metadata?.membership_signup === "true" && session.metadata?.membership_id) {
            await activateSignupMembership(admin, session.metadata.membership_id);
          }
        }
        break;
      }
      case "checkout.session.expired": {
        const requestId = event.data.object.metadata?.payment_request_id;
        if (requestId) await admin.from("payment_requests").update({ status: "failed" }).eq("id", requestId).eq("status", "sent");
        break;
      }
      case "account.updated": {
        const account = event.data.object;
        await admin
          .from("stripe_connect_accounts")
          .update({
            charges_enabled: !!account.charges_enabled,
            payouts_enabled: !!account.payouts_enabled,
            details_submitted: !!account.details_submitted,
          })
          .eq("stripe_account_id", account.id);
        break;
      }
    }
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error(JSON.stringify({ event: "stripe_webhook_failed", type: event?.type, error: error instanceof Error ? error.message : String(error) }));
    return new Response(JSON.stringify({ error: "Webhook handling failed." }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
