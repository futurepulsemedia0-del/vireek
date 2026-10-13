// supabase/functions/manage-subscription-cancellation/index.ts
//
// Backend for /dashboard/billing/cancel (src/pages/CancelSubscriptionPage.tsx).
// One authenticated endpoint, five strictly-validated actions:
//
//   context       read live subscription state + win-back offer terms
//   cancel        schedule cancellation at the END of the paid period
//   pause         pause billing for 1-3 months (Stripe pause_collection)
//   accept_offer  apply the win-back coupon (once per account)
//   resume        undo a scheduled cancellation or end a pause early
//
// Design rules:
//   * Stripe is the source of truth. Nothing about the live subscription is
//     cached in our DB, so the UI can never disagree with what Stripe will bill.
//   * Cancelling is `cancel_at_period_end` — the customer keeps what they paid
//     for. The existing stripe-webhook `customer.subscription.deleted` handler
//     then suspends the account when the period actually ends.
//   * Only the account OWNER may call this, and only for their own subscription.
//   * Every mutation is recorded twice: `subscription_cancellations` (retention
//     history + exit-survey) and `audit_log` (security trail).
//   * The win-back offer is one-time per account, enforced here, not in the UI.
//
// Required secrets:
//   supabase secrets set STRIPE_SECRET_KEY=sk_live_xxx
// Optional (enables the win-back offer; create a percent-off coupon with
// duration "once" or "repeating" in Stripe first):
//   supabase secrets set STRIPE_WINBACK_COUPON_ID=coupon_xxx
// Deploy: supabase functions deploy manage-subscription-cancellation

import Stripe from "npm:stripe@17.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  addMonthsClamped,
  canModifySubscription,
  isOfferEligible,
  offerTermsFromCoupon,
  parseRequest,
  STRIPE_FEEDBACK,
  type CancelReason,
  type OfferTerms,
} from "../_shared/billing/cancellationLogic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function fail(code: string, error: string, status: number) {
  return json({ error, code }, status);
}

const iso = (unixSeconds: number | null | undefined) => (unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return fail("method_not_allowed", "Method not allowed", 405);

  try {
    // ---- Auth ------------------------------------------------------------
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return fail("unauthenticated", "Missing Authorization header.", 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) return fail("unauthenticated", "Invalid or expired session.", 401);
    const user = userData.user;

    // ---- Validate input ----------------------------------------------------
    const parsed = parseRequest(await req.json().catch(() => null));
    if (!parsed.ok) return fail("invalid_request", parsed.error, 400);
    const request = parsed.request;

    // ---- Authorize: owner of a real subscription ------------------------------
    const { data: profile } = await admin
      .from("profiles")
      .select("id, role, plan, stripe_customer_id, stripe_subscription_id")
      .eq("id", user.id)
      .maybeSingle();

    if (!profile) return fail("no_profile", "Account not found.", 404);
    if (profile.role !== "owner") return fail("forbidden", "Only the account owner can change the subscription.", 403);
    if (!profile.stripe_subscription_id) return fail("no_subscription", "There is no paid subscription on this account.", 404);

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) return fail("not_configured", "Billing is not configured yet (missing STRIPE_SECRET_KEY).", 500);
    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-11-20.acacia" });

    const subscriptionId = profile.stripe_subscription_id as string;
    let sub = await stripe.subscriptions.retrieve(subscriptionId);
    if (sub.status === "canceled" || sub.status === "incomplete_expired") {
      return fail("subscription_ended", "This subscription has already ended.", 409);
    }

    // ---- Win-back offer terms (only if configured) -----------------------------
    let terms: OfferTerms | null = null;
    let couponId: string | null = null;
    const configuredCoupon = Deno.env.get("STRIPE_WINBACK_COUPON_ID");
    if (configuredCoupon) {
      try {
        terms = offerTermsFromCoupon(await stripe.coupons.retrieve(configuredCoupon));
        couponId = terms ? configuredCoupon : null;
      } catch (err) {
        console.error(JSON.stringify({ event: "winback_coupon_lookup_failed", error: err instanceof Error ? err.message : String(err) }));
      }
    }

    const { count: usedOffers } = await admin
      .from("subscription_cancellations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("action", "offer_accepted");
    const alreadyUsedOffer = (usedOffers ?? 0) > 0;

    const stateOf = (s: Stripe.Subscription) => ({
      status: s.status,
      cancelAtPeriodEnd: s.cancel_at_period_end,
      paused: !!s.pause_collection,
    });

    const buildContext = (s: Stripe.Subscription) => {
      const item = s.items.data[0];
      return {
        plan: profile.plan as string,
        status: s.status,
        current_period_end: iso(s.current_period_end),
        cancel_at_period_end: s.cancel_at_period_end,
        paused_until: iso(s.pause_collection?.resumes_at ?? null),
        price_cents: item?.price?.unit_amount ?? null,
        currency: (item?.price?.currency ?? "usd").toUpperCase(),
        offer: isOfferEligible({ ...stateOf(s), terms, alreadyUsedOffer }) && terms
          ? { percent_off: terms.percentOff, months: terms.months }
          : null,
      };
    };

    // ---- Recording helper ------------------------------------------------------
    const record = async (
      action: "cancel_scheduled" | "paused" | "offer_accepted" | "resumed",
      auditAction: string,
      extra: Record<string, unknown> = {},
      survey: { reason: CancelReason | null; detail: string } = { reason: null, detail: "" },
    ) => {
      const { error: histError } = await admin.from("subscription_cancellations").insert({
        user_id: user.id,
        action,
        reason: survey.reason,
        reason_detail: survey.detail || null,
        plan: profile.plan,
        stripe_subscription_id: subscriptionId,
        ...extra,
      });
      const { error: auditError } = await admin.from("audit_log").insert({
        user_id: user.id,
        actor_id: user.id,
        actor_email: user.email ?? null,
        action: auditAction,
        target_table: "profiles",
        target_id: user.id,
      });
      // Stripe has already been changed — never fail the request over bookkeeping,
      // but make it loud so it can be repaired by hand.
      if (histError || auditError) {
        console.error(JSON.stringify({
          event: "cancellation_record_failed",
          action,
          history_error: histError?.message ?? null,
          audit_error: auditError?.message ?? null,
        }));
      }
    };

    // ---- Actions -----------------------------------------------------------------
    switch (request.action) {
      case "context":
        return json(buildContext(sub));

      case "cancel": {
        if (sub.cancel_at_period_end) return fail("already_scheduled", "Cancellation is already scheduled.", 409);
        sub = await stripe.subscriptions.update(subscriptionId, {
          cancel_at_period_end: true,
          cancellation_details: {
            feedback: STRIPE_FEEDBACK[request.reason],
            comment: request.detail ? request.detail.slice(0, 500) : undefined,
          },
          // A pause on a cancelling subscription would be confusing; end it.
          pause_collection: "",
        });
        await record("cancel_scheduled", "subscription_cancel_scheduled", { period_end: iso(sub.current_period_end) }, {
          reason: request.reason,
          detail: request.detail,
        });
        return json(buildContext(sub));
      }

      case "pause": {
        if (!canModifySubscription(stateOf(sub))) {
          return fail("not_pausable", "This subscription can't be paused right now.", 409);
        }
        const resumesAt = addMonthsClamped(new Date(), request.months);
        sub = await stripe.subscriptions.update(subscriptionId, {
          pause_collection: { behavior: "void", resumes_at: Math.floor(resumesAt.getTime() / 1000) },
        });
        await record("paused", "subscription_paused", { resumes_at: resumesAt.toISOString(), pause_months: request.months }, {
          reason: request.reason,
          detail: request.detail,
        });
        return json(buildContext(sub));
      }

      case "accept_offer": {
        if (!couponId || !terms) return fail("offer_unavailable", "No offer is available right now.", 409);
        if (alreadyUsedOffer) return fail("offer_used", "This offer has already been used on your account.", 409);
        if (!canModifySubscription(stateOf(sub))) return fail("offer_unavailable", "No offer is available right now.", 409);
        sub = await stripe.subscriptions.update(subscriptionId, { discounts: [{ coupon: couponId }] });
        await record("offer_accepted", "subscription_winback_accepted", {
          offer_coupon_id: couponId,
          offer_percent_off: terms.percentOff,
        }, { reason: request.reason, detail: request.detail });
        return json(buildContext(sub));
      }

      case "resume": {
        if (!sub.cancel_at_period_end && !sub.pause_collection) {
          return fail("nothing_to_resume", "There is nothing to undo on this subscription.", 409);
        }
        sub = await stripe.subscriptions.update(subscriptionId, {
          cancel_at_period_end: false,
          pause_collection: "",
        });
        await record("resumed", "subscription_resumed");
        return json(buildContext(sub));
      }
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "manage_subscription_cancellation_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return fail("server_error", "Something went wrong. Please try again.", 500);
  }
});
