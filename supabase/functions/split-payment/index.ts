// Public pay page backend for one payer's share of a split invoice.
//
//   POST { action: "get",    token }  -> what the payer sees (no other payer's data)
//   POST { action: "intent", token }  -> creates / re-uses the PaymentIntent for the payer's remaining share
//
// The token is the payer's private link. All amounts come from the database
// (split_payer_summary), never from the client. Booking the payment into the
// invoice ledger happens only in the Stripe webhook (finalize_split_payment).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripeRequest } from "../_shared/stripe/client.ts";
import { stripeGet } from "../_shared/stripe/terminalPayments.ts";
import { MIN_CHARGE_CENTS, PAYMENT_CURRENCY, buildPaymentIntentParams, isReusableIntentStatus } from "../_shared/payments/paymentIntent.ts";
import { buildSplitIntentMetadata, splitIntentDescription } from "../_shared/payments/splitPayment.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const TOKEN_RE = /^[a-f0-9]{64}$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const token = typeof body.token === "string" ? body.token : "";
    if (!TOKEN_RE.test(token)) return json({ status: "not_found" });
    if (body.action !== "get" && body.action !== "intent") return json({ error: "Unknown action." }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data, error } = await admin.rpc("split_payer_summary", { p_token: token });
    if (error) throw error;
    const s = (data ?? null) as Record<string, unknown> | null;
    if (!s || s.status === "not_found") return json({ status: "not_found" });

    if (body.action === "get") {
      return json({
        status: s.status,
        reason: s.reason ?? null,
        payer_name: s.payer_name,
        role: s.role,
        invoice_number: s.invoice_number,
        business_name: s.business_name ?? null,
        due_date: s.due_date ?? null,
        share_cents: s.share_cents,
        paid_cents: s.paid_cents,
        payable_cents: s.payable_cents,
        publishable_key: Deno.env.get("STRIPE_PUBLISHABLE_KEY") ?? null,
      });
    }

    // ── intent ──
    if (s.status !== "open") {
      return json({ error: s.status === "paid" ? "This share has already been paid." : "This payment link isn't available right now." }, 409);
    }
    const payable = Number(s.payable_cents);
    if (!Number.isInteger(payable) || payable < MIN_CHARGE_CENTS) {
      return json({ error: "This amount is below the minimum that can be paid online. Please contact the business." }, 400);
    }

    const { data: connect } = await admin
      .from("stripe_connect_accounts")
      .select("stripe_account_id, charges_enabled")
      .eq("user_id", s.user_id)
      .maybeSingle();
    if (!connect?.stripe_account_id || !connect.charges_enabled) {
      return json({ error: "This business can't accept online payments right now." }, 400);
    }
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secretKey) return json({ error: "Payments aren't configured on this server yet." }, 500);

    const metadata = buildSplitIntentMetadata({
      payerId: String(s.payer_id),
      invoiceId: String(s.invoice_id),
      userId: String(s.user_id),
      amountCents: payable,
    });
    const params = buildPaymentIntentParams({
      baseCents: payable,
      tipCents: 0,
      destinationAccountId: connect.stripe_account_id,
      description: splitIntentDescription(s.business_name as string | null, String(s.invoice_number), String(s.payer_name)),
      receiptEmail: (s.payer_email as string | null) ?? null,
      metadata,
      currency: PAYMENT_CURRENCY,
    });

    // One live intent per payer: update it for a retry or a changed amount, never double-charge.
    const existingId = (s.stripe_payment_intent_id as string | null) ?? null;
    let intent: any = null;
    if (existingId) {
      try {
        const existing = await stripeGet(`payment_intents/${existingId}`, secretKey);
        if (existing.status === "succeeded") return json({ error: "This share has already been paid." }, 409);
        if (existing.status === "processing") return json({ error: "Your payment is still being processed. Please don't pay again." }, 409);
        if (isReusableIntentStatus(existing.status)) {
          intent = await stripeRequest(
            `payment_intents/${existing.id}`,
            { amount: params.amount, description: params.description, receipt_email: params.receipt_email, metadata },
            secretKey,
          );
        }
      } catch { /* unreadable or no longer updatable: fall through and create a fresh intent */ }
    }
    if (!intent) {
      intent = await stripeRequest("payment_intents", params, secretKey, {
        idempotencyKey: `split:${s.payer_id}:${payable}:${existingId ?? "first"}`,
      });
    }

    await admin.from("invoice_split_payers").update({ stripe_payment_intent_id: intent.id }).eq("id", s.payer_id).eq("user_id", s.user_id);
    return json({ client_secret: intent.client_secret });
  } catch (error) {
    console.error(JSON.stringify({ event: "split_payment_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
