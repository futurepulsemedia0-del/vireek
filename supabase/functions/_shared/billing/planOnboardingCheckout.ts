// supabase/functions/_shared/billing/planOnboardingCheckout.ts
//
// Checkout for the plan step (/onboarding/plan), called from create-checkout-session when body.source === "onboarding".
// No Deno globals and no npm imports: every dependency is injected, so Vitest drives it with fakes
// (planOnboardingCheckout.test.ts) and the edge function wires the real Stripe / Supabase clients.
//
// Guarantees, each covered by a test:
//   * planId / billing are whitelisted server-side; the price id comes from secrets, never from the client.
//   * ENTITLEMENTS ARE NEVER WRITTEN HERE. The only profiles write is stripe_customer_id (linking, not entitlement).
//     plan / minutes / subscription_status / trial_* change only in stripe-webhook after Stripe confirms.
//   * Idempotent: an existing subscription short-circuits, an open session for the same plan/cycle is reused, and the
//     Stripe call itself carries an idempotency key, so double-clicks / two tabs never create two subscriptions.
//   * Rate limited per user. Logs carry no email, name or card data.

import { checkoutTaxParams, isAutomaticTaxEnabled, priceTaxVerdict } from "./stripeTax.ts";
import { isPurchasablePlan, PURCHASABLE_PLANS, type PurchasablePlanId } from "./planCatalog.ts";
import { TRIAL_DAYS } from "./trialLifecycle.ts";

export type Billing = "monthly" | "annual";
export type TrialMode = "card_required" | "no_card" | "none";
export type OnboardingOutcome = { status: number; body: Record<string, unknown> };

// deno-lint-ignore no-explicit-any
type Any = any;

export interface OnboardingDeps {
  stripe: Any;
  admin: Any;
  limiter: { hit(bucket: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfter: number }> };
  readEnv: (key: string) => string | undefined;
  siteUrl: string;
  now: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

const LIVE_SUB_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);
const PROMO_RE = /^[A-Za-z0-9_-]{3,40}$/;
const IDEMPOTENCY_BUCKET_MS = 10 * 60 * 1000;
const err = (status: number, code: string, message: string): OnboardingOutcome => ({ status, body: { error: message, code } });

export function isBilling(v: unknown): v is Billing {
  return v === "monthly" || v === "annual";
}

/** Secret name holding the Stripe price id: STRIPE_PRICE_STARTER (monthly) / STRIPE_PRICE_STARTER_ANNUAL (annual). */
export function priceEnvName(plan: PurchasablePlanId, billing: Billing): string {
  const base = PURCHASABLE_PLANS.find((p) => p.id === plan)!.priceEnv;
  return billing === "annual" ? `${base}_ANNUAL` : base;
}

export function emailKey(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.trim().toLowerCase().split("@");
  return local && domain ? `${local.split("+")[0]}@${domain}` : null;
}

/** Text shown next to the pay button on Stripe's page. Plain facts only. [COUNSEL] wording needs legal review before launch. */
export function renewalDisclosure(billing: Billing, trial: TrialMode | "off"): string {
  const period = billing === "annual" ? "year" : "month";
  const renew = `Your subscription renews automatically every ${period} until you cancel. You can cancel any time from Billing in your Vireek account.`;
  if (trial === "card_required") return `Free for ${TRIAL_DAYS} days, then billed every ${period}. Your card is charged when the trial ends unless you cancel before then. ${renew}`;
  if (trial === "no_card") return `Free for ${TRIAL_DAYS} days with no card needed. Add a payment method before the trial ends to continue; otherwise the trial ends. ${renew}`;
  return renew;
}

export function idempotencyKey(userId: string, plan: string, billing: Billing, trial: boolean, promo: string | null, now: number): string {
  return `onb:${userId}:${plan}:${billing}:${trial ? 1 : 0}:${promo ?? "-"}:${Math.floor(now / IDEMPOTENCY_BUCKET_MS)}`;
}

export async function runOnboardingCheckout(
  d: OnboardingDeps,
  input: { userId: string; planId: unknown; billing: unknown; promoCode?: unknown },
): Promise<OnboardingOutcome> {
  const log = d.log ?? (() => {});
  const { userId } = input;

  if (!isPurchasablePlan(input.planId)) return err(400, "not_eligible", "Unknown plan.");
  const plan: PurchasablePlanId = input.planId;
  const billing: Billing = input.billing === undefined || input.billing === null ? "monthly" : (input.billing as Billing);
  if (!isBilling(billing)) return err(400, "not_eligible", "Unknown billing period.");

  const rl = await d.limiter.hit(`onb_checkout:${userId}`, 8, 60).catch(() => ({ allowed: true, retryAfter: 0 }));
  if (!rl.allowed) return { status: 429, body: { error: "Too many attempts. Please wait a moment.", code: "rate_limited", retryAfter: rl.retryAfter } };

  const priceId = d.readEnv(priceEnvName(plan, billing));
  if (!priceId) {
    log("onboarding_price_missing", { plan, billing });
    return err(billing === "annual" ? 409 : 500, billing === "annual" ? "annual_unavailable" : "not_configured", "This billing option isn't available yet.");
  }

  const { data: profile } = await d.admin
    .from("profiles")
    .select("stripe_customer_id, stripe_subscription_id, email, full_name, role, trial_used_at, trial_state")
    .eq("id", userId)
    .maybeSingle();
  if (!profile || profile.role !== "owner") return err(403, "not_eligible", "Only the account owner can choose a plan.");

  // 1) Already subscribed (profile, or Stripe knows one the webhook has not delivered yet) -> no second subscription.
  if (profile.stripe_subscription_id || ["trialing", "converted"].includes(profile.trial_state)) {
    return { status: 200, body: { alreadySubscribed: true } };
  }
  if (profile.stripe_customer_id) {
    const subs = await d.stripe.subscriptions.list({ customer: profile.stripe_customer_id, status: "all", limit: 10 });
    if ((subs.data ?? []).some((s: Any) => LIVE_SUB_STATUSES.has(s.status))) return { status: 200, body: { alreadySubscribed: true } };
  }

  // 2) Reuse the open session for the same plan + cycle (refresh, second tab, back button).
  const { data: intent } = await d.admin.from("plan_onboarding").select("plan, billing, checkout_session_id").eq("user_id", userId).maybeSingle();
  if (intent?.checkout_session_id && intent.plan === plan && intent.billing === billing) {
    try {
      const existing = await d.stripe.checkout.sessions.retrieve(intent.checkout_session_id);
      if (existing.status === "open" && existing.url) return { status: 200, body: { url: existing.url, reused: true } };
      if (existing.status === "complete") return { status: 200, body: { processing: true } }; // paid; the webhook is on its way
    } catch (e) {
      log("onboarding_session_lookup_failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 3) Trial policy (config) + one-trial-per-person guard (same rules the webhook enforces via claim_trial()).
  const { data: cfg } = await d.admin.from("plan_onboarding_config").select("trial_mode").eq("id", true).maybeSingle();
  const mode: TrialMode = cfg?.trial_mode === "no_card" || cfg?.trial_mode === "none" ? cfg.trial_mode : "card_required";
  let trialEligible = mode !== "none" && !profile.trial_used_at && (profile.trial_state ?? "none") === "none";
  const key = emailKey(profile.email);
  if (trialEligible && key) {
    const { data: claims } = await d.admin.from("trial_claims").select("user_id").eq("email_key", key).neq("user_id", userId).limit(1);
    if (claims && claims.length > 0) trialEligible = false;
  }

  // 4) Promo code: validated server-side; a valid code replaces Stripe's own promo field (they cannot be combined).
  let promoId: string | null = null;
  const rawPromo = typeof input.promoCode === "string" ? input.promoCode.trim() : "";
  if (rawPromo) {
    if (!PROMO_RE.test(rawPromo)) return err(400, "promo_invalid", "That promo code isn't valid.");
    const found = await d.stripe.promotionCodes.list({ code: rawPromo, active: true, limit: 1 });
    promoId = found.data?.[0]?.id ?? null;
    if (!promoId) return err(400, "promo_invalid", "That promo code isn't valid.");
  }

  // 5) Tax: same opt-in and tax-inclusive guard as the existing checkout.
  const taxEnabled = isAutomaticTaxEnabled(d.readEnv("STRIPE_AUTOMATIC_TAX"));
  if (taxEnabled) {
    const price = await d.stripe.prices.retrieve(priceId);
    if (priceTaxVerdict(price.tax_behavior) === "inclusive") {
      log("price_tax_inclusive_blocked", { plan, billing });
      return err(500, "not_configured", "This plan's price is not configured correctly yet. Please contact support.");
    }
  }

  // 6) Customer (idempotent: two tabs never create two customers). Linking only, not an entitlement.
  let customerId: string | undefined = profile.stripe_customer_id ?? undefined;
  if (!customerId) {
    const customer = await d.stripe.customers.create(
      { email: profile.email ?? undefined, name: profile.full_name ?? undefined, metadata: { supabase_user_id: userId } },
      { idempotencyKey: `cust:${userId}` },
    );
    customerId = customer.id as string;
    await d.admin.from("profiles").update({ stripe_customer_id: customerId }).eq("id", userId).is("stripe_customer_id", null);
  }

  const meta = { supabase_user_id: userId, plan_id: plan, billing, source: "onboarding" };
  const trialDays = trialEligible ? TRIAL_DAYS : 0;
  const session = await d.stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer: customerId,
      client_reference_id: userId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${d.siteUrl}/onboarding/plan?checkout=success`,
      cancel_url: `${d.siteUrl}/onboarding/plan?checkout=cancelled`,
      ...(promoId ? { discounts: [{ promotion_code: promoId }] } : { allow_promotion_codes: true }),
      ...(trialEligible && mode === "no_card" ? { payment_method_collection: "if_required" } : {}),
      custom_text: { submit: { message: renewalDisclosure(billing, trialEligible ? mode : "off") } },
      ...checkoutTaxParams(taxEnabled, { hasCustomer: true }),
      metadata: meta,
      subscription_data: {
        metadata: meta,
        ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
        ...(trialEligible && mode === "no_card" ? { trial_settings: { end_behavior: { missing_payment_method: "cancel" } } } : {}),
      },
    },
    { idempotencyKey: idempotencyKey(userId, plan, billing, trialEligible, promoId, d.now()) },
  );

  // Intent bookkeeping only (not an entitlement): lets the page resume at "checkout" on any device.
  await d.admin.from("plan_onboarding").upsert(
    { user_id: userId, plan, billing, step: "checkout", checkout_session_id: session.id, checkout_started_at: new Date(d.now()).toISOString(), updated_at: new Date(d.now()).toISOString() },
    { onConflict: "user_id" },
  );

  log("onboarding_checkout_created", { plan, billing, trial: trialEligible, promo: !!promoId });
  return { status: 200, body: { url: session.url } };
}

/** Is the open session still usable? Expired sessions send the person back to step "plan". Never grants anything. */
export async function reconcileOnboardingCheckout(d: OnboardingDeps, userId: string): Promise<OnboardingOutcome> {
  const { data: intent } = await d.admin.from("plan_onboarding").select("checkout_session_id, step").eq("user_id", userId).maybeSingle();
  if (!intent?.checkout_session_id) return { status: 200, body: { outcome: "none" } };
  try {
    const s = await d.stripe.checkout.sessions.retrieve(intent.checkout_session_id);
    if (s.status === "expired") {
      await d.admin.from("plan_onboarding").update({ step: "plan", checkout_session_id: null, updated_at: new Date(d.now()).toISOString() }).eq("user_id", userId).eq("checkout_session_id", intent.checkout_session_id);
      return { status: 200, body: { outcome: "expired" } };
    }
    return { status: 200, body: { outcome: s.status === "complete" ? "complete" : "open" } };
  } catch {
    return { status: 200, body: { outcome: "none" } };
  }
}
