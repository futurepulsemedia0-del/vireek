// supabase/functions/manage-subscription-plan/index.ts
//
// Backend for /dashboard/billing/plans. One authenticated POST endpoint with
// an `action` field:
//
//   state             -> live subscription snapshot (plan, renewal date, card,
//                        scheduled change, live Stripe prices)
//   preview           -> exact proration preview for switching to `planId`
//   apply             -> upgrade now (prorated, invoiced immediately) or
//                        schedule a downgrade for the end of the billing period
//   cancel_scheduled  -> drop a scheduled downgrade ("keep my current plan")
//   checkout          -> first-time subscribers: Stripe Checkout session URL
//
// Rules enforced HERE (never trust the browser):
//   * caller must be the account owner or a team member whose permissions
//     include can_view_billing (custom-role overrides respected, same as the
//     frontend AuthContext). Team members always act on the OWNER's billing
//     profile, never on their own.
//   * only the account owner can move money (apply / cancel_scheduled /
//     checkout). Team members with can_view_billing get read-only access.
//   * upgrades are blocked while a payment is past due.
//   * the amount the customer confirmed must equal the amount we charge
//     (PRICE_CHANGED) and a preview expires after 10 minutes.
//
// Required secrets (same ones create-checkout-session already uses):
//   STRIPE_SECRET_KEY, STRIPE_PRICE_STARTER, STRIPE_PRICE_PROFESSIONAL,
//   STRIPE_PRICE_BUSINESS, SITE_URL
//
// Deploy:  supabase functions deploy manage-subscription-plan

import Stripe from "npm:stripe@17.4.0";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  classifyPlanChange,
  getPlanDef,
  isPurchasablePlan,
  minutesForPlan,
  planIdFromPriceId,
  PURCHASABLE_PLANS,
  type PlanChangeKind,
  type PurchasablePlanId,
} from "../_shared/billing/planCatalog.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const PREVIEW_MAX_AGE_SECONDS = 10 * 60;
const CHANGEABLE_STATUSES = new Set(["active", "trialing"]);

interface OwnerProfile {
  id: string;
  email: string | null;
  full_name: string | null;
  plan: string | null;
  subscription_status: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

interface BillingContext {
  actorId: string;
  owner: OwnerProfile;
  canManage: boolean;
}

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

const OWNER_COLUMNS =
  "id, email, full_name, plan, subscription_status, stripe_customer_id, stripe_subscription_id";

async function resolveBillingContext(admin: SupabaseClient, userId: string): Promise<BillingContext> {
  const { data: me } = await admin.from("profiles").select("id, email, role").eq("id", userId).maybeSingle();
  if (!me) throw new HttpError(404, "Profile not found.", "NO_PROFILE");

  if (me.role === "owner") {
    const { data: owner } = await admin.from("profiles").select(OWNER_COLUMNS).eq("id", userId).maybeSingle();
    if (!owner) throw new HttpError(404, "Profile not found.", "NO_PROFILE");
    return { actorId: userId, owner: owner as OwnerProfile, canManage: true };
  }

  const { data: member } = await admin
    .from("team_members")
    .select("account_owner_id, permissions, custom_role:custom_roles(permissions)")
    .eq("member_email", me.email)
    .maybeSingle();

  const customRole = (member as { custom_role?: { permissions?: Record<string, boolean> } | null } | null)
    ?.custom_role?.permissions;
  const merged = { ...(member?.permissions as Record<string, boolean> | undefined), ...customRole };
  if (!member || merged.can_view_billing !== true) {
    throw new HttpError(403, "You don't have permission to view billing.", "FORBIDDEN");
  }

  const { data: owner } = await admin
    .from("profiles")
    .select(OWNER_COLUMNS)
    .eq("id", member.account_owner_id)
    .maybeSingle();
  if (!owner) throw new HttpError(404, "Account owner not found.", "NO_PROFILE");
  return { actorId: userId, owner: owner as OwnerProfile, canManage: false };
}

function requireOwner(ctx: BillingContext) {
  if (!ctx.canManage) {
    throw new HttpError(403, "Only the account owner can change the plan.", "OWNER_ONLY");
  }
}

async function loadSubscription(stripe: Stripe, subscriptionId: string | null): Promise<Stripe.Subscription | null> {
  if (!subscriptionId) return null;
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["default_payment_method"] });
    if (sub.status === "canceled" || sub.status === "incomplete_expired") return null;
    return sub;
  } catch (err) {
    if ((err as { code?: string }).code === "resource_missing") return null;
    throw err;
  }
}

function currentPlanOf(sub: Stripe.Subscription, ctx: BillingContext): string | null {
  const fromPrice = planIdFromPriceId(sub.items.data[0]?.price.id, (k) => Deno.env.get(k));
  return fromPrice ?? ctx.owner.plan;
}

function assertChangeable(sub: Stripe.Subscription, ctx: BillingContext) {
  if (!CHANGEABLE_STATUSES.has(sub.status) || (ctx.owner.subscription_status ?? "active") !== "active") {
    throw new HttpError(
      409,
      "Your last payment needs attention before you can change plans. Update your payment method first.",
      "PAYMENT_ISSUE",
    );
  }
  if (sub.cancel_at_period_end) {
    throw new HttpError(
      409,
      "Your subscription is set to end at the close of this billing period, so the plan can't be changed.",
      "CANCELLING",
    );
  }
}

async function cardFor(stripe: Stripe, sub: Stripe.Subscription): Promise<{ brand: string; last4: string } | null> {
  const pm = sub.default_payment_method;
  if (pm && typeof pm !== "string" && pm.card) return { brand: pm.card.brand, last4: pm.card.last4 };
  const customerId = idOf(sub.customer);
  if (!customerId) return null;
  const customer = await stripe.customers.retrieve(customerId, { expand: ["invoice_settings.default_payment_method"] });
  if ("deleted" in customer && customer.deleted) return null;
  const def = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
  if (def && typeof def !== "string" && def.card) return { brand: def.card.brand, last4: def.card.last4 };
  return null;
}

async function scheduledChangeOf(
  stripe: Stripe,
  sub: Stripe.Subscription,
): Promise<{ scheduleId: string; planId: PurchasablePlanId; effectiveAt: string } | null> {
  const scheduleId = idOf(sub.schedule as string | { id: string } | null);
  if (!scheduleId) return null;
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
  if (schedule.status !== "active" && schedule.status !== "not_started") return null;
  const now = Math.floor(Date.now() / 1000);
  const next = schedule.phases.find((p) => p.start_date > now);
  const planId = planIdFromPriceId(idOf(next?.items[0]?.price as string | { id: string } | undefined), (k) =>
    Deno.env.get(k)
  );
  if (!next || !planId) return null;
  return { scheduleId, planId, effectiveAt: iso(next.start_date) };
}

function priceIdFor(plan: PurchasablePlanId): string {
  const def = getPlanDef(plan);
  const priceId = Deno.env.get(def.priceEnv);
  if (!priceId) {
    throw new HttpError(500, `Billing is not configured yet (missing ${def.priceEnv}).`, "NOT_CONFIGURED");
  }
  return priceId;
}

function discountsOf(sub: Stripe.Subscription): number {
  return (sub.discounts?.length ?? 0) + (sub.discount ? 1 : 0);
}

interface PreviewResult {
  kind: Exclude<PlanChangeKind, "same">;
  currentPlanId: string | null;
  targetPlanId: PurchasablePlanId;
  currency: string;
  interval: string;
  effectiveAt: string;
  nextBillingDate: string | null;
  dueNowMinor: number;
  creditMinor: number;
  lines: { description: string; amountMinor: number }[];
  newRecurringMinor: number;
  taxesApply: boolean;
  hasDiscount: boolean;
  prorationDate: number;
}

async function computePreview(
  stripe: Stripe,
  ctx: BillingContext,
  sub: Stripe.Subscription | null,
  targetPlan: PurchasablePlanId,
  prorationDate: number,
): Promise<PreviewResult> {
  const targetPriceId = priceIdFor(targetPlan);
  const targetPrice = await stripe.prices.retrieve(targetPriceId);
  const base = {
    targetPlanId: targetPlan,
    currency: targetPrice.currency,
    interval: targetPrice.recurring?.interval ?? "month",
    newRecurringMinor: targetPrice.unit_amount ?? 0,
    prorationDate,
  };

  if (!sub) {
    return {
      ...base,
      kind: "new",
      currentPlanId: ctx.owner.plan,
      effectiveAt: iso(prorationDate),
      nextBillingDate: null,
      dueNowMinor: targetPrice.unit_amount ?? 0,
      creditMinor: 0,
      lines: [],
      taxesApply: false,
      hasDiscount: false,
    };
  }

  assertChangeable(sub, ctx);
  const item = sub.items.data[0];
  if (!item) throw new HttpError(409, "Your subscription has no plan item to change.", "NO_ITEM");

  const currentPlan = currentPlanOf(sub, ctx);
  if (!currentPlan) {
    throw new HttpError(409, "We couldn't match your current subscription to a plan. Contact support.", "UNKNOWN_PLAN");
  }
  const kind = classifyPlanChange(currentPlan, targetPlan, true);
  if (kind === "same") throw new HttpError(409, "You're already on this plan.", "SAME_PLAN");

  if (
    item.price.recurring?.interval !== targetPrice.recurring?.interval ||
    item.price.recurring?.interval_count !== targetPrice.recurring?.interval_count
  ) {
    throw new HttpError(
      409,
      "Your subscription bills on a different interval than this plan. Contact support to switch.",
      "INTERVAL_MISMATCH",
    );
  }

  const common = {
    ...base,
    currentPlanId: currentPlan,
    nextBillingDate: iso(sub.current_period_end),
    hasDiscount: discountsOf(sub) > 0,
  };

  if (kind === "downgrade") {
    return {
      ...common,
      kind: "downgrade",
      effectiveAt: iso(sub.current_period_end),
      dueNowMinor: 0,
      creditMinor: 0,
      lines: [],
      taxesApply: false,
    };
  }

  const upcoming = await stripe.invoices.retrieveUpcoming({
    customer: idOf(sub.customer) ?? undefined,
    subscription: sub.id,
    subscription_items: [{ id: item.id, price: targetPriceId }],
    subscription_proration_behavior: "create_prorations",
    subscription_proration_date: prorationDate,
  });
  const prorationLines = upcoming.lines.data.filter((line) => line.proration);
  const net = prorationLines.reduce((sum, line) => sum + line.amount, 0);
  return {
    ...common,
    kind: "upgrade",
    effectiveAt: iso(prorationDate),
    dueNowMinor: Math.max(0, net),
    creditMinor: Math.max(0, -net),
    lines: prorationLines.map((line) => ({ description: line.description ?? "Plan change", amountMinor: line.amount })),
    taxesApply: (upcoming.tax ?? 0) > 0,
  };
}

async function logPlanEvent(
  admin: SupabaseClient,
  ctx: BillingContext,
  eventType: string,
  payload: Record<string, unknown>,
) {
  const { error } = await admin.from("billing_events").insert({
    stripe_event_id: `plan_change:${crypto.randomUUID()}`,
    event_type: eventType,
    user_id: ctx.owner.id,
    payload: { actor_id: ctx.actorId, ...payload },
  });
  if (error) console.error(JSON.stringify({ event: "plan_change_audit_failed", error: error.message }));
}

function carryDiscounts(phase: Stripe.SubscriptionSchedule.Phase) {
  const out: { discount?: string; coupon?: string }[] = [];
  for (const d of phase.discounts ?? []) {
    const discountId = idOf(d.discount as string | { id: string } | null);
    const couponId = idOf(d.coupon as string | { id: string } | null);
    if (discountId) out.push({ discount: discountId });
    else if (couponId) out.push({ coupon: couponId });
  }
  return out.length > 0 ? out : undefined;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) throw new HttpError(401, "Missing Authorization header.", "UNAUTHENTICATED");

    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) throw new HttpError(401, "Invalid or expired session.", "UNAUTHENTICATED");

    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      planId?: string;
      prorationDate?: number;
      expectedDueNowMinor?: number;
    };

    const ctx = await resolveBillingContext(admin, userData.user.id);

    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      throw new HttpError(500, "Billing is not configured yet (missing STRIPE_SECRET_KEY).", "NOT_CONFIGURED");
    }
    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2024-11-20.acacia" });
    const sub = await loadSubscription(stripe, ctx.owner.stripe_subscription_id);

    // ---------------------------------------------------------------- state
    if (body.action === "state") {
      const priceEntries = await Promise.all(
        PURCHASABLE_PLANS.map(async (plan) => {
          const priceId = Deno.env.get(plan.priceEnv);
          if (!priceId) return [plan.id, null] as const;
          try {
            const price = await stripe.prices.retrieve(priceId);
            return [
              plan.id,
              { amountMinor: price.unit_amount ?? 0, currency: price.currency, interval: price.recurring?.interval ?? "month" },
            ] as const;
          } catch {
            return [plan.id, null] as const;
          }
        }),
      );
      const prices = Object.fromEntries(priceEntries.filter(([, v]) => v !== null));
      const scheduled = sub ? await scheduledChangeOf(stripe, sub) : null;
      const item = sub?.items.data[0];
      return jsonResponse({
        canManage: ctx.canManage,
        hasSubscription: Boolean(sub),
        status: sub?.status ?? null,
        currentPlanId: sub ? currentPlanOf(sub, ctx) : ctx.owner.plan,
        currentPeriodEnd: sub ? iso(sub.current_period_end) : null,
        cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false,
        currency: item?.price.currency ?? null,
        currentAmountMinor: item?.price.unit_amount ?? null,
        paymentMethod: sub ? await cardFor(stripe, sub) : null,
        scheduledChange: scheduled ? { planId: scheduled.planId, effectiveAt: scheduled.effectiveAt } : null,
        prices,
      });
    }

    // -------------------------------------------------------------- preview
    if (body.action === "preview") {
      if (!isPurchasablePlan(body.planId)) throw new HttpError(400, "Unknown plan.", "BAD_PLAN");
      const preview = await computePreview(stripe, ctx, sub, body.planId, Math.floor(Date.now() / 1000));
      return jsonResponse(preview);
    }

    // ------------------------------------------------------------- checkout
    if (body.action === "checkout") {
      requireOwner(ctx);
      if (!isPurchasablePlan(body.planId)) throw new HttpError(400, "Unknown plan.", "BAD_PLAN");
      if (sub) throw new HttpError(409, "You already have an active subscription.", "HAS_SUBSCRIPTION");
      const priceId = priceIdFor(body.planId);
      const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

      let customerId = ctx.owner.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: ctx.owner.email ?? undefined,
          name: ctx.owner.full_name ?? undefined,
          metadata: { supabase_user_id: ctx.owner.id },
        });
        customerId = customer.id;
        await admin.from("profiles").update({ stripe_customer_id: customerId }).eq("id", ctx.owner.id);
      }
      const metadata = { supabase_user_id: ctx.owner.id, plan_id: body.planId };
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${siteUrl}/dashboard/billing/plans?checkout=success`,
        cancel_url: `${siteUrl}/dashboard/billing/plans?checkout=cancelled`,
        allow_promotion_codes: true,
        metadata,
        subscription_data: { metadata },
      });
      return jsonResponse({ url: session.url });
    }

    // ----------------------------------------------------- cancel_scheduled
    if (body.action === "cancel_scheduled") {
      requireOwner(ctx);
      const scheduled = sub ? await scheduledChangeOf(stripe, sub) : null;
      if (!scheduled) throw new HttpError(404, "There is no scheduled plan change to cancel.", "NO_SCHEDULE");
      await stripe.subscriptionSchedules.release(scheduled.scheduleId);
      await logPlanEvent(admin, ctx, "plan_change.schedule_cancelled", { cancelled_plan: scheduled.planId });
      return jsonResponse({ ok: true });
    }

    // ---------------------------------------------------------------- apply
    if (body.action === "apply") {
      requireOwner(ctx);
      if (!isPurchasablePlan(body.planId)) throw new HttpError(400, "Unknown plan.", "BAD_PLAN");
      if (!sub) throw new HttpError(409, "No active subscription — start checkout instead.", "USE_CHECKOUT");

      const nowSeconds = Math.floor(Date.now() / 1000);
      const prorationDate = Number.isInteger(body.prorationDate) ? (body.prorationDate as number) : nowSeconds;
      if (nowSeconds - prorationDate > PREVIEW_MAX_AGE_SECONDS || prorationDate > nowSeconds + 60) {
        throw new HttpError(409, "This preview has expired. Review the updated amount and confirm again.", "PREVIEW_EXPIRED");
      }

      const preview = await computePreview(stripe, ctx, sub, body.planId, prorationDate);
      if (preview.kind === "upgrade" && body.expectedDueNowMinor !== preview.dueNowMinor) {
        throw new HttpError(
          409,
          "The amount changed since you reviewed it. Review the updated amount and confirm again.",
          "PRICE_CHANGED",
        );
      }

      const item = sub.items.data[0];
      const targetPriceId = priceIdFor(body.planId);
      const currentPlan = preview.currentPlanId as string;
      const existingSchedule = await scheduledChangeOf(stripe, sub);

      if (preview.kind === "upgrade") {
        if (existingSchedule) await stripe.subscriptionSchedules.release(existingSchedule.scheduleId);
        await stripe.subscriptions.update(
          sub.id,
          {
            items: [{ id: item.id, price: targetPriceId }],
            proration_behavior: "always_invoice",
            proration_date: prorationDate,
            payment_behavior: "error_if_incomplete",
            metadata: { ...sub.metadata, plan_id: body.planId },
          },
          { idempotencyKey: `plan-upgrade:${sub.id}:${item.price.id}:${targetPriceId}:${prorationDate}` },
        );
        const { error: profileError } = await admin
          .from("profiles")
          .update({ plan: body.planId, minutes_included: minutesForPlan(body.planId) })
          .eq("id", ctx.owner.id);
        if (profileError) {
          console.error(JSON.stringify({ event: "plan_change_profile_sync_failed", error: profileError.message }));
        }
        await logPlanEvent(admin, ctx, "plan_change.upgraded", {
          from: currentPlan,
          to: body.planId,
          charged_minor: preview.dueNowMinor,
          currency: preview.currency,
        });
        return jsonResponse({ ok: true, kind: "upgrade", planId: body.planId, effectiveAt: preview.effectiveAt });
      }

      // Downgrade: keep the current (paid) plan until the period ends, then switch.
      if (existingSchedule) await stripe.subscriptionSchedules.release(existingSchedule.scheduleId);
      const schedule = await stripe.subscriptionSchedules.create(
        { from_subscription: sub.id },
        { idempotencyKey: `plan-downgrade:${sub.id}:${targetPriceId}:${sub.current_period_end}` },
      );
      const phase0 = schedule.phases[0];
      const quantity = item.quantity ?? 1;
      await stripe.subscriptionSchedules.update(schedule.id, {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            items: [{ price: item.price.id, quantity }],
            start_date: phase0.start_date,
            end_date: phase0.end_date,
            discounts: carryDiscounts(phase0),
            metadata: { plan_id: currentPlan },
          },
          {
            items: [{ price: targetPriceId, quantity }],
            iterations: 1,
            metadata: { plan_id: body.planId },
          },
        ],
      });
      await logPlanEvent(admin, ctx, "plan_change.downgrade_scheduled", {
        from: currentPlan,
        to: body.planId,
        effective_at: preview.effectiveAt,
      });
      return jsonResponse({ ok: true, kind: "downgrade", planId: body.planId, effectiveAt: preview.effectiveAt });
    }

    throw new HttpError(400, "Unknown action.", "BAD_ACTION");
  } catch (error) {
    if (error instanceof HttpError) return jsonResponse({ error: error.message, code: error.code }, error.status);
    const stripeType = (error as { type?: string }).type;
    if (stripeType === "StripeCardError") {
      return jsonResponse(
        { error: `Your card was declined: ${(error as Error).message} Update your payment method and try again.`, code: "CARD_DECLINED" },
        402,
      );
    }
    console.error(
      JSON.stringify({ event: "manage_subscription_plan_failed", type: stripeType, error: error instanceof Error ? error.message : String(error) }),
    );
    return jsonResponse({ error: "We couldn't complete that billing request. Please try again.", code: "BILLING_ERROR" }, 500);
  }
});
