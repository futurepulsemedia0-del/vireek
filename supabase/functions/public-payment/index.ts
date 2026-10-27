import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripeRequest } from "../_shared/stripe/client.ts";
import { computeTip, firstName, TIP_PRESET_PERCENTS, type TipSelection } from "../_shared/payments/tip.ts";
import { stripeGet } from "../_shared/stripe/terminalPayments.ts";
import { buildRegionalPaymentMethodOptions, normalizeChargeCurrency } from "../_shared/payments/regionalMethods.ts";
import { buildIntentMetadata, buildPaymentIntentParams, CLEARED_FEE_METADATA, isReusableIntentStatus } from "../_shared/payments/paymentIntent.ts";
import { buildPricingDisclosure, buildReceiptLines, checkoutPricing, itemizedDescription, settingsFromRow } from "../_shared/payments/pricing.ts";
import { buildBankIntentExtras, buildBankOffer, mergeIntentParams } from "../_shared/bankPayments/logic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const TOKEN_RE = /^[a-f0-9]{64}$/;
const PAYABLE = ["pending", "sent", "overdue", "failed"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const token = typeof body.token === "string" ? body.token : "";
    if (!TOKEN_RE.test(token)) return json({ status: "not_found" });

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

    const { data: request } = await admin
      .from("payment_requests")
      .select("id, user_id, job_id, customer_name, customer_email, amount, status, technician_id, stripe_checkout_session_id, stripe_payment_intent_id, tip_cents, fee_cents, fee_refunded_cents, fee_label")
      .eq("public_token", token)
      .maybeSingle();
    if (!request) return json({ status: "not_found" });
    if (request.status === "paid") {
      const receipt = buildReceiptLines({
        baseCents: Math.round(Number(request.amount) * 100),
        tipCents: request.tip_cents ?? 0,
        feeCents: request.fee_cents ?? 0,
        feeRefundedCents: request.fee_refunded_cents ?? 0,
        feeLabel: request.fee_label ?? "",
      });
      return json({ status: "paid", receipt });
    }
    if (!PAYABLE.includes(request.status)) return json({ status: "canceled" });

    const [{ data: connect }, { data: job }, { data: tech }] = await Promise.all([
      admin.from("stripe_connect_accounts").select("stripe_account_id, charges_enabled, tip_enabled").eq("user_id", request.user_id).maybeSingle(),
      request.job_id ? admin.from("jobs").select("service_type").eq("id", request.job_id).maybeSingle() : Promise.resolve({ data: null }),
      request.technician_id ? admin.from("team_members").select("*").eq("id", request.technician_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);

    // Membership signup/renewal invoices are paid on this same page: find the membership (if any) to label and flag it.
    const { data: membership } = await admin
      .from("memberships")
      .select("id, status, auto_renew, stripe_customer_id, membership_plans:plan_id(name, billing_interval)")
      .eq("last_payment_request_id", request.id)
      .limit(1)
      .maybeSingle();
    const membershipPlanName = (membership?.membership_plans as { name?: string } | null)?.name ?? null;
    const membershipInterval = (membership?.membership_plans as { billing_interval?: string } | null)?.billing_interval ?? null;
    // Offer "renew automatically" only on a membership payment whose plan actually renews.
    const autoRenewOffer =
      membership && membership.auto_renew !== false && (membershipInterval === "monthly" || membershipInterval === "yearly")
        ? { interval: membershipInterval }
        : null;

    const baseCents = Math.round(Number(request.amount) * 100);
    const { data: pricingRow } = await admin
      .from("payment_pricing_settings")
      .select("mode, surcharge_bps, flat_fee_cents, cash_discount_bps, exclude_debit, business_state, label, disclosure")
      .eq("user_id", request.user_id)
      .maybeSingle();
    const pricingSettings = settingsFromRow(pricingRow);
    // Recurring membership billing is never surcharged: the renewal charge would not carry the same fee.
    const feeEligible = !membership;
    const quote = checkoutPricing(baseCents, 0, pricingSettings, feeEligible);
    const tipEnabled = !!connect?.tip_enabled && !!request.technician_id;
    const techFirstName = tech ? firstName((tech as Record<string, string | null>).full_name ?? (tech as Record<string, string | null>).member_name ?? (tech as Record<string, string | null>).name) : "";

const { data: bankSettings } = await admin.from("bank_payment_settings").select("*").eq("user_id", request.user_id).maybeSingle();
const bankPolicy = { platformEnabled: Deno.env.get("STRIPE_ACH_DEBIT_ENABLED") === "true", settings: bankSettings ?? null, baseCents };

    if (body.action === "get") {
      return json({
        status: "open",
        amount_cents: baseCents,
        description: membershipPlanName ? `${membershipPlanName} membership` : job?.service_type ?? "Invoice",
        customer_first_name: firstName(request.customer_name),
        technician_first_name: techFirstName || null,
        tip_enabled: tipEnabled,
        presets: TIP_PRESET_PERCENTS,
        publishable_key: Deno.env.get("STRIPE_PUBLISHABLE_KEY") ?? null,
        auto_renew_offer: autoRenewOffer,
        pricing: {
          fee_cents: quote.feeCents,
          fee_label: quote.feeLabel,
          cash_price_cents: quote.cashPriceCents,
          cash_discount_cents: quote.cashDiscountCents,
          disclosure: quote.feeCents > 0 || quote.cashDiscountCents > 0 ? buildPricingDisclosure(pricingSettings) : "",
        },
        bank_offer: buildBankOffer({ ...bankPolicy, amountCents: baseCents }),
      });
    }

    if (body.action !== "checkout" && body.action !== "intent") return json({ error: "Unknown action." }, 400);

    if (!connect?.stripe_account_id || !connect.charges_enabled) {
      return json({ error: "This business can't accept payments right now." }, 400);
    }
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secretKey) return json({ error: "Payments aren't configured on this server yet." }, 500);
    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

    const selection = (body.tip ?? { kind: "none" }) as TipSelection;
    if (selection.kind !== "none" && !tipEnabled) return json({ error: "Tipping isn't available for this payment." }, 400);
    const tip = computeTip(baseCents, selection);
    if (!tip.ok) return json({ error: tip.error }, 400);
    if (body.action === "intent") {
      // Card-on-file consent: only honoured on a membership payment, and only when the customer explicitly opted in.
      const saveCard = body.save_card === true && !!autoRenewOffer;
      let stripeCustomerId: string | null = membership?.stripe_customer_id ?? null;
      if (saveCard && !stripeCustomerId) {
        const customer = await stripeRequest(
          "customers",
          { email: request.customer_email ?? undefined, name: request.customer_name, metadata: { membership_id: membership!.id, user_id: request.user_id } },
          secretKey,
        );
        stripeCustomerId = customer.id;
        await admin.from("memberships").update({ stripe_customer_id: customer.id }).eq("id", membership!.id);
      }
      const intentDescription = membershipPlanName
        ? `${membershipPlanName} membership`
        : job?.service_type ?? `Invoice for ${request.customer_name}`;
      const metadata = buildIntentMetadata({
        requestId: request.id,
        userId: request.user_id,
        jobId: request.job_id,
        baseCents,
        tipCents: tip.tipCents,
        technicianId: request.technician_id,
        membershipId: membership?.id ?? null,
        membershipSignup: membership?.status === "offered",
        feeCents: quote.feeCents,
        feeMode: quote.feeMode,
        feeBps: quote.feeMode === "surcharge" ? pricingSettings.surchargeBps : null,
        feeLabel: quote.feeLabel,
        excludeDebit: pricingSettings.excludeDebit,
      });
      const baseParams = buildPaymentIntentParams({
        baseCents,
        tipCents: tip.tipCents,
        feeCents: quote.feeCents,
        destinationAccountId: connect.stripe_account_id,
        description: itemizedDescription(intentDescription, { baseCents, tipCents: tip.tipCents, feeCents: quote.feeCents, feeLabel: quote.feeLabel }),
        receiptEmail: request.customer_email,
        customerId: stripeCustomerId,
        saveCard,
        metadata,
        currency: normalizeChargeCurrency(job?.invoice_currency),
        paymentMethodOptions: buildRegionalPaymentMethodOptions(
          normalizeChargeCurrency(job?.invoice_currency),
          { acssEnabled: Deno.env.get("STRIPE_ACSS_DEBIT_ENABLED") === "true" },
        ),
      });

      const params = mergeIntentParams(baseParams, buildBankIntentExtras(bankPolicy)) as typeof baseParams;
      // One live intent per payment request: update it for a retry or a changed tip, never double-charge.
      let intent: any = null;
      if (request.stripe_payment_intent_id) {
        try {
          const existing = await stripeGet(`payment_intents/${request.stripe_payment_intent_id}`, secretKey);
          if (existing.status === "succeeded") return json({ error: "This invoice has already been paid." }, 409);
          if (existing.status === "processing") return json({ error: "Your payment is still being processed. Please don't pay again." }, 409);
          // A different "save this card" choice needs a fresh intent: setup_future_usage can't be changed safely.
          if (isReusableIntentStatus(existing.status) && (existing.setup_future_usage === "off_session") === saveCard) {
            intent = await stripeRequest(
              `payment_intents/${existing.id}`,
              { amount: params.amount, description: params.description, receipt_email: params.receipt_email, metadata: quote.feeCents > 0 ? metadata : { ...metadata, ...CLEARED_FEE_METADATA } },
              secretKey,
            );
          }
        } catch { /* unreadable or no longer updatable: fall through and create a fresh intent */ }
      }
      if (!intent) intent = await stripeRequest("payment_intents", params, secretKey);

      await admin
        .from("payment_requests")
        .update({ stripe_payment_intent_id: intent.id, status: request.status === "pending" ? "sent" : request.status })
        .eq("id", request.id);
      return json({ client_secret: intent.client_secret });
    }
    // Only one live session per request: expire the previous attempt (best effort).
    if (request.stripe_checkout_session_id) {
      try { await stripeRequest(`checkout/sessions/${request.stripe_checkout_session_id}/expire`, {}, secretKey); } catch { /* already completed/expired */ }
    }

    const description = job?.service_type ? `${job.service_type}` : `Invoice for ${request.customer_name}`;
    const metadata = {
      flow: "tip_v1",
      payment_request_id: request.id,
      job_id: request.job_id,
      user_id: request.user_id,
      base_cents: baseCents,
      tip_cents: tip.tipCents,
      technician_id: tip.tipCents > 0 ? request.technician_id : undefined,
    };

    const lineItems: unknown[] = [
      { quantity: 1, price_data: { currency: "usd", unit_amount: baseCents, product_data: { name: description } } },
    ];
    if (tip.tipCents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: { currency: "usd", unit_amount: tip.tipCents, product_data: { name: techFirstName ? `Tip for ${techFirstName}` : "Tip for your technician" } },
      });
    }

    const session = await stripeRequest(
      "checkout/sessions",
      {
        mode: "payment",
        success_url: `${siteUrl}/pay-result?status=success`,
        cancel_url: `${siteUrl}/pay/${token}?canceled=1`,
        customer_email: request.customer_email ?? undefined,
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
        line_items: lineItems,
        payment_intent_data: { transfer_data: { destination: connect.stripe_account_id }, metadata },
        metadata,
      },
      secretKey,
    );

    await admin
      .from("payment_requests")
      .update({ stripe_checkout_session_id: session.id, status: request.status === "pending" ? "sent" : request.status })
      .eq("id", request.id);

    return json({ url: session.url });
  } catch (error) {
    console.error(JSON.stringify({ event: "public_payment_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
