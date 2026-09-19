// Starts (or updates) a subscription for the plan the customer picked on
// src/pages/BillingPage.tsx. First-time subscribers get a Checkout URL;
// customers who already have an active subscription get it updated in
// place (Stripe prorates automatically) instead of getting a 2nd sub.
//
// Required secrets:
//   supabase secrets set STRIPE_SECRET_KEY=sk_live_xxxxx
//   supabase secrets set STRIPE_PRICE_STARTER=price_xxxxx
//   supabase secrets set STRIPE_PRICE_PROFESSIONAL=price_xxxxx
//   supabase secrets set STRIPE_PRICE_BUSINESS=price_xxxxx
//   supabase secrets set SITE_URL=https://vireek.com
// Deploy: supabase functions deploy create-checkout-session

import Stripe from "npm:stripe@17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const PRICE_ENV_BY_PLAN: Record<string, string> = {
  starter: "STRIPE_PRICE_STARTER",
  professional: "STRIPE_PRICE_PROFESSIONAL",
  business: "STRIPE_PRICE_BUSINESS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const { planId } = await req.json().catch(() => ({}));
    const priceEnvKey = PRICE_ENV_BY_PLAN[planId];
    if (!priceEnvKey) return jsonResponse({ error: "Unknown plan." }, 400);

    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ error: "Missing Authorization header." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session." }, 401);

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const priceId = Deno.env.get(priceEnvKey);
    if (!stripeSecretKey || !priceId) {
      return jsonResponse({ error: `Billing is not configured yet (missing STRIPE_SECRET_KEY or ${priceEnvKey}).` }, 500);
    }
    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-11-20.acacia" });
    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

    const { data: profile } = await admin
      .from("profiles")
      .select("stripe_customer_id, stripe_subscription_id, email, full_name")
      .eq("id", userData.user.id)
      .maybeSingle();

    let customerId = profile?.stripe_customer_id as string | undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: profile?.email ?? userData.user.email ?? undefined,
        name: profile?.full_name ?? undefined,
        metadata: { supabase_user_id: userData.user.id },
      });
      customerId = customer.id;
      await admin.from("profiles").update({ stripe_customer_id: customerId }).eq("id", userData.user.id);
    }

    const existingSubscriptionId = profile?.stripe_subscription_id as string | undefined;
    if (existingSubscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(existingSubscriptionId);
      const currentItem = subscription.items.data[0];
      await stripe.subscriptions.update(existingSubscriptionId, {
        items: [{ id: currentItem.id, price: priceId }],
        proration_behavior: "create_prorations",
        metadata: { ...subscription.metadata, plan_id: planId },
      });
      await admin.from("profiles").update({ plan: planId }).eq("id", userData.user.id);
      return jsonResponse({ switched: true });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${siteUrl}/dashboard/billing?checkout=success`,
      cancel_url: `${siteUrl}/dashboard/billing?checkout=cancelled`,
      allow_promotion_codes: true,
      metadata: { supabase_user_id: userData.user.id, plan_id: planId },
      subscription_data: { metadata: { supabase_user_id: userData.user.id, plan_id: planId } },
    });

    return jsonResponse({ url: session.url });
  } catch (error) {
    console.error(JSON.stringify({ event: "create_checkout_session_failed", error: error instanceof Error ? error.message : String(error) }));
    return jsonResponse({ error: "Something went wrong starting checkout." }, 500);
  }
});
