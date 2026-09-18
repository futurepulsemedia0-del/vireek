// supabase/functions/financing-webhook/index.ts
//
// Same shape as stripe-payment-webhook: verify signature, look up the
// row by the provider's own id, update status, and — once funded —
// mark the job's invoice paid. Every raw event is also appended to
// financing_offer_events regardless of whether it changes anything,
// for audit/debugging.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { getFinancingProvider } from "../_shared/financing/registry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const payload = await req.text();
  const provider = getFinancingProvider("wisetack");

  const validSignature = await provider.verifyWebhookSignature(payload, req.headers);
  if (!validSignature) return new Response("Invalid signature", { status: 400 });

  const event = provider.parseWebhookEvent(payload);
  if (!event) return new Response("Unrecognized payload", { status: 400 });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    const { data: offer } = await admin
      .from("financing_offers")
      .select("id, user_id, job_id, status")
      .eq("external_transaction_id", event.externalTransactionId)
      .maybeSingle();

    if (!offer) {
      console.warn(JSON.stringify({ event: "financing_webhook_unknown_offer", externalTransactionId: event.externalTransactionId }));
      return new Response("ok", { status: 200 }); // ack anyway — no offer to retry against
    }

    await admin.from("financing_offer_events").insert({
      offer_id: offer.id,
      user_id: offer.user_id,
      event_type: event.eventType,
      raw_payload: JSON.parse(payload),
    });

    const update: Record<string, unknown> = { status: event.status };
    if (event.approvedAmountCents !== undefined) update.approved_amount_cents = event.approvedAmountCents;
    if (event.aprBps !== undefined) update.apr_bps = event.aprBps;
    if (event.termMonths !== undefined) update.term_months = event.termMonths;
    if (event.declineReason !== undefined) update.decline_reason = event.declineReason;
    if (event.status === "funded") update.funded_at = new Date().toISOString();

    await admin.from("financing_offers").update(update).eq("id", offer.id);

    if (event.status === "funded" && offer.job_id) {
      await admin.from("jobs").update({ invoice_status: "paid" }).eq("id", offer.job_id);
    }

    return new Response("ok", { status: 200 });
  } catch (error) {
    console.error(JSON.stringify({ event: "financing_webhook_failed", error: error instanceof Error ? error.message : String(error) }));
    return new Response("error", { status: 500 });
  }
});
