import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { verifyStripeSignature } from "../_shared/stripe/client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const signature = req.headers.get("Stripe-Signature") ?? "";
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
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
