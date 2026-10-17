import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { verifyStripeSignature } from "../_shared/stripe/client.ts";
import { isHandledDisputeEvent, normalizeDispute } from "../_shared/disputes/normalize.ts";

// Dedicated endpoint for charge.dispute.* so the existing payment webhook is untouched.
// Secret: STRIPE_DISPUTE_WEBHOOK_SECRET (signing secret of THIS endpoint in the Stripe dashboard).

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = Deno.env.get("STRIPE_DISPUTE_WEBHOOK_SECRET") ?? "";
  const payload = await req.text();
  if (!secret || !(await verifyStripeSignature(payload, req.headers.get("Stripe-Signature") ?? "", secret))) {
    return new Response("Invalid signature", { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }
  if (!isHandledDisputeEvent(event?.type)) return json({ received: true, ignored: true });

  try {
    const dispute = normalizeDispute(event.data?.object);
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data, error } = await admin.rpc("apply_stripe_dispute_event", {
      p: { event_id: event.id, event_type: event.type, event_created: event.created, stripe_account_id: event.account ?? null, dispute },
    });
    if (error) throw error;
    if (data && data.matched === false) {
      console.warn(JSON.stringify({ event: "stripe_dispute_unmatched", dispute: dispute.stripe_dispute_id, payment_intent: dispute.stripe_payment_intent_id }));
    }
    return json({ received: true, ...(data ?? {}) });
  } catch (error) {
    console.error(JSON.stringify({ event: "stripe_dispute_webhook_failed", type: event?.type, error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Webhook handling failed." }, 500); // 5xx => Stripe retries; the ingest RPC is idempotent
  }
});
