import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { verifyStripeSignature } from "../_shared/stripe/client.ts";
import { applyPaymentIntentResult } from "../_shared/stripe/terminalPayments.ts";

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
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.completed": {
        const session = event.data.object;
        const requestId = session.metadata?.payment_request_id;
        if (!requestId || session.payment_status !== "paid") break;
        const tipCents = Number.parseInt(session.metadata?.tip_cents ?? "0", 10) || 0;
        const { data: result, error: finalizeError } = await admin.rpc("finalize_paid_payment_request", {
          p_request_id: requestId,
          p_session_id: session.id,
          p_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : null,
          p_amount_total_cents: session.amount_total,
          p_tip_cents: tipCents,
        });
        if (finalizeError) throw finalizeError;
        if (result?.status === "amount_mismatch") {
          // Money moved but amounts disagree: never auto-fix silently — surface it for a human.
          console.error(JSON.stringify({ event: "payment_amount_mismatch", requestId, sessionId: session.id, result }));
        }
        break;
      }
      case "checkout.session.expired": {
        const meta = event.data.object.metadata;
        // tip_v1 links are reusable (a fresh session per attempt), so an expired session no longer fails the request.
        if (meta?.payment_request_id && meta?.flow !== "tip_v1") {
          await admin.from("payment_requests").update({ status: "failed" }).eq("id", meta.payment_request_id).eq("status", "sent");
        }
        break;
      }
      case "charge.refunded": {
        const charge = event.data.object;
        if (charge.refunded === true && typeof charge.payment_intent === "string") {
          await admin.rpc("mark_tip_refunded", { p_payment_intent_id: charge.payment_intent });
        }
        break;
      }
      case "payment_intent.succeeded":
      case "payment_intent.payment_failed":
      case "payment_intent.canceled": {
        await applyPaymentIntentResult(admin, event.data.object, Deno.env.get("STRIPE_SECRET_KEY") ?? undefined);
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
