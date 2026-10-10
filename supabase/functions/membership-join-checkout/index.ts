// supabase/functions/membership-join-checkout/index.ts
//
// Public (no login) endpoint behind /join/:planSlug. Deploy with
// --no-verify-jwt. Billing follows the same model as the rest of the
// project: a real payment_request + a Stripe Connect Checkout session
// (one payment per period, renewals are invoiced by
// membership-lifecycle-agent). The membership is created as 'offered'
// and flipped to 'active' by stripe-payment-webhook once paid.
//
// Abuse protection (public + unauthenticated): honeypot field, strict
// server-side validation, per-plan and per-email hourly caps, and reuse
// of a still-open Checkout session so double-clicks don't create rows.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { stripeRequest } from "../_shared/stripe/client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MIN_PRICE_CENTS = 50; // Stripe's minimum charge
const MAX_PER_PLAN_PER_HOUR = 40;
const MAX_PER_EMAIL_PER_HOUR = 5;
const REUSE_WINDOW_MS = 30 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function fail(status: number, reason: string, error: string) {
  return jsonResponse({ error, reason }, status);
}

// Best-effort: link the signup to an existing customer (so the customer
// portal shows the membership) or create one. Never blocks the signup.
async function resolveCustomerId(admin: any, ownerId: string, name: string, email: string, phone: string): Promise<string | null> {
  try {
    const { data: byEmail } = await admin.from("customers").select("id").eq("user_id", ownerId).eq("email", email).maybeSingle();
    if (byEmail?.id) return byEmail.id;
    if (phone) {
      const { data: byPhone } = await admin.from("customers").select("id").eq("user_id", ownerId).eq("phone", phone).maybeSingle();
      if (byPhone?.id) return byPhone.id;
    }
    const { data: created } = await admin
      .from("customers")
      .insert({ user_id: ownerId, name, email, phone: phone || null, lifecycle_stage: "lead", source: "manual", tags: ["membership-signup"] })
      .select("id")
      .single();
    return created?.id ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));

    // Honeypot: real users never see or fill this field.
    if (typeof body.website === "string" && body.website.trim() !== "") return fail(400, "invalid", "Invalid request.");

    const slug = String(body.plan_slug ?? "").trim().toLowerCase();
    const name = String(body.customer_name ?? "").trim();
    const email = String(body.customer_email ?? "").trim().toLowerCase();
    const phone = String(body.customer_phone ?? "").trim();

    if (!SLUG_RE.test(slug) || slug.length < 3 || slug.length > 60) return fail(404, "unavailable", "This membership isn't available.");
    if (name.length < 2 || name.length > 100) return fail(400, "invalid", "Please enter your full name.");
    if (email.length > 254 || !EMAIL_RE.test(email)) return fail(400, "invalid", "Please enter a valid email address.");
    const phoneDigits = phone.replace(/\D/g, "");
    if (phone && (phone.length > 30 || phoneDigits.length < 7 || phoneDigits.length > 15)) return fail(400, "invalid", "Please enter a valid phone number.");

    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secretKey) return fail(500, "error", "Payments aren't configured on this server yet.");
    const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

    const { data: plan } = await admin
      .from("membership_plans")
      .select("id, user_id, name, price_cents, public_slug")
      .eq("public_slug", slug)
      .eq("public_enabled", true)
      .eq("active", true)
      .maybeSingle();
    if (!plan) return fail(404, "unavailable", "This membership isn't available.");
    if (plan.price_cents < MIN_PRICE_CENTS) return fail(409, "unavailable", "Online signup isn't available for this plan.");

    const { data: connect } = await admin
      .from("stripe_connect_accounts")
      .select("stripe_account_id, charges_enabled")
      .eq("user_id", plan.user_id)
      .maybeSingle();
    if (!connect?.stripe_account_id || !connect.charges_enabled) return fail(409, "unavailable", "Online signup isn't available right now.");

    // Already a member of this plan?
    const { data: existingMember } = await admin
      .from("memberships")
      .select("id")
      .eq("plan_id", plan.id)
      .eq("customer_email", email)
      .in("status", ["active", "past_due"])
      .limit(1);
    if (existingMember && existingMember.length > 0) return fail(409, "already_member", "You already have this membership.");

    // Double-click / retry: reuse a still-open checkout from the last 30 minutes.
    const { data: recent } = await admin
      .from("memberships")
      .select("id, last_payment_request_id")
      .eq("plan_id", plan.id)
      .eq("customer_email", email)
      .eq("status", "offered")
      .eq("signup_source", "public_join")
      .gte("created_at", new Date(Date.now() - REUSE_WINDOW_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent?.last_payment_request_id) {
      const { data: openRequest } = await admin.from("payment_requests").select("status, payment_link_url").eq("id", recent.last_payment_request_id).maybeSingle();
      if (openRequest?.status === "sent" && openRequest.payment_link_url) return jsonResponse({ checkout_url: openRequest.payment_link_url });
    }

    // Hourly caps (counted from the rows this endpoint already writes).
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: planCount } = await admin
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("plan_id", plan.id)
      .eq("signup_source", "public_join")
      .gte("created_at", since);
    if ((planCount ?? 0) >= MAX_PER_PLAN_PER_HOUR) return fail(429, "rate_limited", "Too many requests. Please try again later.");
    const { count: emailCount } = await admin
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("plan_id", plan.id)
      .eq("customer_email", email)
      .eq("signup_source", "public_join")
      .gte("created_at", since);
    if ((emailCount ?? 0) >= MAX_PER_EMAIL_PER_HOUR) return fail(429, "rate_limited", "Too many requests. Please try again later.");

    const customerId = await resolveCustomerId(admin, plan.user_id, name, email, phone);

    const { data: membership, error: membershipError } = await admin
      .from("memberships")
      .insert({
        user_id: plan.user_id,
        plan_id: plan.id,
        customer_id: customerId,
        customer_name: name,
        customer_email: email,
        customer_phone: phone || null,
        status: "offered",
        signup_source: "public_join",
        auto_renew: true,
      })
      .select("id")
      .single();
    if (membershipError || !membership) throw membershipError || new Error("Could not create the membership.");

    const { data: paymentRequest, error: requestError } = await admin
      .from("payment_requests")
      .insert({
        user_id: plan.user_id,
        customer_name: name,
        customer_email: email,
        customer_phone: phone || null,
        amount: plan.price_cents / 100,
        status: "pending",
      })
      .select("id")
      .single();
    if (requestError || !paymentRequest) throw requestError || new Error("Could not create the payment request.");

    let session: { id: string; url: string };
    try {
      session = await stripeRequest(
        "checkout/sessions",
        {
          mode: "payment",
          success_url: `${siteUrl}/join/${plan.public_slug}?checkout=success`,
          cancel_url: `${siteUrl}/join/${plan.public_slug}?checkout=cancel`,
          customer_email: email,
          line_items: [
            {
              quantity: 1,
              price_data: { currency: "usd", unit_amount: plan.price_cents, product_data: { name: `${plan.name} membership` } },
            },
          ],
          payment_intent_data: { transfer_data: { destination: connect.stripe_account_id } },
          metadata: {
            payment_request_id: paymentRequest.id,
            membership_id: membership.id,
            user_id: plan.user_id,
            membership_signup: "true",
          },
        },
        secretKey,
      );
    } catch (stripeError) {
      await admin.from("payment_requests").update({ status: "failed" }).eq("id", paymentRequest.id);
      console.error(JSON.stringify({ event: "membership_join_stripe_failed", error: stripeError instanceof Error ? stripeError.message : String(stripeError) }));
      return fail(502, "error", "We couldn't start checkout. Please try again.");
    }

    await admin
      .from("payment_requests")
      .update({ status: "sent", stripe_checkout_session_id: session.id, payment_link_url: session.url, last_reminder_sent_at: new Date().toISOString() })
      .eq("id", paymentRequest.id);
    await admin.from("memberships").update({ last_payment_request_id: paymentRequest.id }).eq("id", membership.id);

    return jsonResponse({ checkout_url: session.url });
  } catch (error) {
    console.error(JSON.stringify({ event: "membership_join_failed", error: error instanceof Error ? error.message : String(error) }));
    return fail(500, "error", "Something went wrong. Please try again.");
  }
});
