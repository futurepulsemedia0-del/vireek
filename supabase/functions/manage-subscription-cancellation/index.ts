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
//   offers        (churn-save) list the admin-configured save offers this account may
//                 claim for the chosen reason; records "presented" for outcome tracking
//   accept_save_offer  (churn-save) claim + apply one offer: pause / downgrade / discount.
//                 Caps are enforced atomically in SQL (churn_save_claim) BEFORE Stripe is
//                 touched; a Stripe failure releases the claim.
//
// When churn-save offers are live (churn_save_is_active()), the legacy `pause` and
// `accept_offer` actions are refused (use_save_offers) so no uncapped path remains.
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
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { loadOwner, sendCancellationScheduledNotice } from "../_shared/billing/notices/dispatch.ts";
import { localYmd } from "../_shared/billing/notices/schedule.ts";
import { getPlanDef } from "../_shared/billing/planCatalog.ts";
import { schedulePhaseTax, subscriptionHasAutomaticTax } from "../_shared/billing/stripeTax.ts";
import {
  carryDiscounts,
  couponMatches,
  denialFor,
  ledgerActionFor,
  offerFeasibility,
  riskFromRow,
  saveCouponId,
  termsOf,
  toOfferView,
  type ChurnRisk,
  type LiveSubscription,
  type SaveOfferRow,
  type SaveOfferView,
} from "../_shared/billing/churnSaveLogic.ts";
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

/** Reuses the staff health score (computeHealth) for this one account. Never throws. */
async function loadRisk(admin: SupabaseClient, userId: string): Promise<ChurnRisk | null> {
  try {
    const { data, error } = await admin.rpc("churn_save_account_signals", { p_user: userId });
    if (error) return null;
    return riskFromRow(Array.isArray(data) ? data[0] : data);
  } catch {
    return null;
  }
}

/** One Stripe coupon per distinct (percent, months). Verifies an existing coupon carries the same terms. */
async function ensureSaveCoupon(stripe: Stripe, percentOff: number, months: number): Promise<string> {
  const id = saveCouponId(percentOff, months);
  const verifyExisting = async () => {
    if (!couponMatches(await stripe.coupons.retrieve(id), percentOff, months)) throw new Error("save_coupon_terms_mismatch");
    return id;
  };
  try {
    return await verifyExisting();
  } catch (err) {
    if ((err as { code?: string }).code !== "resource_missing") throw err;
  }
  try {
    await stripe.coupons.create({
      id,
      percent_off: percentOff,
      duration: "repeating",
      duration_in_months: months,
      name: `Vireek save offer ${percentOff}% x ${months}m`,
      metadata: { source: "vireek_churn_save" },
    });
    return id;
  } catch (err) {
    if ((err as { code?: string }).code === "resource_already_exists") return await verifyExisting();
    throw err;
  }
}

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

    // Churn-save offers are live only when the kill switch is on AND >=1 offer is enabled.
    // Before the migration is applied this resolves to false and the legacy flow is unchanged.
    const { data: saveActiveData } = await admin.rpc("churn_save_is_active");
    const saveActive = saveActiveData === true;
    const stateOf = (s: Stripe.Subscription) => ({
      status: s.status,
      cancelAtPeriodEnd: s.cancel_at_period_end,
      paused: !!s.pause_collection,
    });

    const liveOf = (s: Stripe.Subscription): LiveSubscription => ({
      ...stateOf(s),
      discountCount: (s.discounts?.length ?? 0) + (s.discount ? 1 : 0),
      hasSchedule: !!s.schedule,
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
        offer: !saveActive && isOfferEligible({ ...stateOf(s), terms, alreadyUsedOffer }) && terms
          ? { percent_off: terms.percentOff, months: terms.months }
          : null,
        save_offers_enabled: saveActive,
      };
    };

    // ---- Recording helper ------------------------------------------------------
    const record = async (
      action: "cancel_scheduled" | "paused" | "offer_accepted" | "resumed" | "downgrade_scheduled",
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
            feedback: request.reason ? STRIPE_FEEDBACK[request.reason] : undefined,
            comment: request.detail ? request.detail.slice(0, 500) : undefined,
          },
          // A pause on a cancelling subscription would be confusing; end it.
          pause_collection: "",
        });
        await record("cancel_scheduled", "subscription_cancel_scheduled", { period_end: iso(sub.current_period_end) }, {
          reason: request.reason,
          detail: request.detail,
        });
        // Written confirmation (best effort: Stripe is already changed, never fail the request over an email).
        try {
          const owner = await loadOwner(admin, user.id);
          if (owner?.email && profile.plan && sub.current_period_end) {
            await sendCancellationScheduledNotice(
              admin,
              owner,
              { planId: profile.plan as string, accessUntilYmd: localYmd(new Date(sub.current_period_end * 1000), owner.timeZone) },
              `cancel:${subscriptionId}:${sub.current_period_end}`,
            );
          }
        } catch (err) {
          console.error(JSON.stringify({ event: "cancellation_confirmation_failed", error: err instanceof Error ? err.message : String(err) }));
        }
        if (saveActive) {
          // Outcome tracking: offers shown in the last 24h that got no answer = declined. Best effort.
          try {
            const risk = await loadRisk(admin, user.id);
            await admin.rpc("churn_save_mark_declined", { p_user: user.id, p_reason: request.reason, p_band: risk?.band ?? null });
          } catch (err) {
            console.error(JSON.stringify({ event: "churn_save_mark_declined_failed", error: err instanceof Error ? err.message : String(err) }));
          }
        }
        return json(buildContext(sub));
      }

      case "pause": {
        if (saveActive) return fail("use_save_offers", "Please choose one of the available options.", 409);
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
        if (saveActive) return fail("use_save_offers", "Please choose one of the available options.", 409);
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

      case "offers": {
        if (!saveActive) return json({ ...buildContext(sub), save_offers: [] as SaveOfferView[] });
        const risk = await loadRisk(admin, user.id);
        const { data: rows, error: rowsError } = await admin.rpc("churn_save_eligible_offers", {
          p_user: user.id,
          p_reason: request.reason,
          p_band: risk?.band ?? null,
        });
        if (rowsError) {
          // Fail closed: no offers is always safe, the customer can still cancel.
          console.error(JSON.stringify({ event: "churn_save_offers_failed", error: rowsError.message }));
          return json({ ...buildContext(sub), save_offers: [] as SaveOfferView[] });
        }
        const live = liveOf(sub);
        const views: SaveOfferView[] = [];
        for (const row of (rows ?? []) as SaveOfferRow[]) {
          const t = termsOf(row);
          const priceId = t?.kind === "downgrade" ? Deno.env.get(getPlanDef(t.plan).priceEnv) : undefined;
          if (offerFeasibility(t, live, { currentPlan: profile.plan as string | null, targetPriceConfigured: t?.kind !== "downgrade" || !!priceId })) continue;
          let extra: { priceCents?: number | null; currency?: string } = {};
          if (t?.kind === "downgrade" && priceId) {
            try {
              const price = await stripe.prices.retrieve(priceId);
              extra = { priceCents: price.unit_amount, currency: price.currency.toUpperCase() };
            } catch {
              continue; // can't show an honest price -> don't show the offer
            }
          }
          const view = toOfferView(row, extra);
          if (view) views.push(view);
        }
        if (views.length > 0) {
          const { error: logError } = await admin.rpc("churn_save_log_presented", {
            p_user: user.id,
            p_offers: views.map((v) => v.id),
            p_reason: request.reason,
            p_band: risk?.band ?? null,
          });
          if (logError) console.error(JSON.stringify({ event: "churn_save_presented_log_failed", error: logError.message }));
        }
        return json({ ...buildContext(sub), save_offers: views });
      }

      case "accept_save_offer": {
        if (!saveActive) return fail("offer_unavailable", "That offer isn't available right now.", 409);
        const deny = (code: string) => {
          const d = denialFor(code);
          return fail(d.code, d.error, d.status);
        };
        const { data: offerRow } = await admin
          .from("churn_save_offers")
          .select("id, kind, name, pause_months, downgrade_plan, discount_percent, discount_months")
          .eq("id", request.offer_id)
          .maybeSingle();
        if (!offerRow) return deny("not_found");
        const t = termsOf(offerRow as SaveOfferRow);
        const targetPriceId = t?.kind === "downgrade" ? Deno.env.get(getPlanDef(t.plan).priceEnv) : undefined;
        const infeasible = offerFeasibility(t, liveOf(sub), {
          currentPlan: profile.plan as string | null,
          targetPriceConfigured: t?.kind !== "downgrade" || !!targetPriceId,
        });
        if (infeasible || !t) return deny(infeasible ?? "invalid_terms");

        // 1) Claim FIRST: caps/cooldown/targeting are enforced atomically in SQL.
        const risk = await loadRisk(admin, user.id);
        const { data: claim, error: claimError } = await admin.rpc("churn_save_claim", {
          p_user: user.id,
          p_offer: request.offer_id,
          p_reason: request.reason,
          p_band: risk?.band ?? null,
          p_score: risk?.score ?? null,
          p_subscription: subscriptionId,
        });
        if (claimError) throw new Error(`churn_save_claim: ${claimError.message}`);
        if (!claim?.ok) return deny(String(claim?.code ?? "not_found"));
        const redemptionId = claim.redemption_id as string;

        // 2) Change Stripe. Any failure releases the claim so the customer keeps their allowance.
        let ledgerExtra: Record<string, unknown> = {};
        let saveResult: Record<string, unknown> = { kind: t.kind };
        try {
          if (t.kind === "pause") {
            const resumesAt = addMonthsClamped(new Date(), t.months);
            sub = await stripe.subscriptions.update(
              subscriptionId,
              { pause_collection: { behavior: "void", resumes_at: Math.floor(resumesAt.getTime() / 1000) } },
              { idempotencyKey: `save-pause:${redemptionId}` },
            );
            ledgerExtra = { resumes_at: resumesAt.toISOString(), pause_months: t.months };
            saveResult = { kind: "pause", resumes_at: resumesAt.toISOString(), months: t.months };
          } else if (t.kind === "discount") {
            const coupon = await ensureSaveCoupon(stripe, t.percentOff, t.months);
            sub = await stripe.subscriptions.update(
              subscriptionId,
              { discounts: [{ coupon }] },
              { idempotencyKey: `save-discount:${redemptionId}` },
            );
            ledgerExtra = { offer_coupon_id: coupon, offer_percent_off: t.percentOff };
            saveResult = { kind: "discount", percent_off: t.percentOff, months: t.months };
          } else {
            const item = sub.items.data[0];
            const quantity = item.quantity ?? 1;
            const schedule = await stripe.subscriptionSchedules.create(
              { from_subscription: sub.id },
              { idempotencyKey: `save-downgrade:${redemptionId}` },
            );
            try {
              const phase0 = schedule.phases[0];
              await stripe.subscriptionSchedules.update(schedule.id, {
                end_behavior: "release",
                proration_behavior: "none",
                phases: [
                  {
                    items: [{ price: item.price.id, quantity }],
                    start_date: phase0.start_date,
                    end_date: phase0.end_date,
                    discounts: carryDiscounts(phase0.discounts as { discount?: string | { id: string } | null; coupon?: string | { id: string } | null }[]),
                    metadata: { plan_id: String(profile.plan) },
                    ...schedulePhaseTax(subscriptionHasAutomaticTax(sub)),
                  },
                  {
                    items: [{ price: targetPriceId as string, quantity }],
                    iterations: 1,
                    metadata: { plan_id: t.plan },
                    ...schedulePhaseTax(subscriptionHasAutomaticTax(sub)),
                  },
                ],
              });
            } catch (err) {
              await stripe.subscriptionSchedules.release(schedule.id).catch(() => undefined);
              throw err;
            }
            sub = await stripe.subscriptions.retrieve(subscriptionId);
            ledgerExtra = { downgrade_plan: t.plan, period_end: iso(sub.current_period_end) };
            saveResult = { kind: "downgrade", plan: t.plan, effective_at: iso(sub.current_period_end) };
          }
        } catch (err) {
          const { error: releaseError } = await admin.rpc("churn_save_finalize", {
            p_redemption: redemptionId,
            p_ok: false,
            p_error: err instanceof Error ? err.message : String(err),
          });
          if (releaseError) console.error(JSON.stringify({ event: "churn_save_release_failed", redemption_id: redemptionId, error: releaseError.message }));
          throw err;
        }

        // 3) Finalize (retry once) + history + audit. Stripe is already changed: never fail the request.
        let finalizeError = (await admin.rpc("churn_save_finalize", { p_redemption: redemptionId, p_ok: true, p_error: null })).error;
        if (finalizeError) finalizeError = (await admin.rpc("churn_save_finalize", { p_redemption: redemptionId, p_ok: true, p_error: null })).error;
        if (finalizeError) {
          console.error(JSON.stringify({ event: "churn_save_finalize_failed", redemption_id: redemptionId, error: finalizeError.message }));
        }
        const ledger = ledgerActionFor(t.kind);
        await record(ledger.action, ledger.audit, { ...ledgerExtra, save_offer_id: request.offer_id }, {
          reason: request.reason,
          detail: request.detail,
        });
        return json({ ...buildContext(sub), save_result: saveResult });
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
