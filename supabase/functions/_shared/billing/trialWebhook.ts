// supabase/functions/_shared/billing/trialWebhook.ts
//
// I/O glue between Stripe webhook events and the pure state machine in trialLifecycle.ts.
// Every function returns `true` when the event was fully handled here and `false` when the caller must run
// its legacy handler unchanged (so non-trial / paid customers keep today's exact behaviour).
//
// Structural types only (no npm: imports) so this file also type-checks under Node/Vitest.

import { planIdFromPriceId } from "./planCatalog.ts";
import {
  decide,
  emailDedupeKey,
  type BillingInput,
  type ClaimResult,
  type ProfileBillingState,
  type StripeSubStatus,
} from "./trialLifecycle.ts";

export interface StripeSubscriptionLike {
  id: string;
  status: string;
  customer: string | { id: string };
  trial_start: number | null;
  trial_end: number | null;
  metadata?: Record<string, string> | null;
  default_payment_method?: string | { id: string; card?: { fingerprint?: string | null } | null } | null;
  items: { data: Array<{ price: { id: string } }> };
}

export interface StripeClientLike {
  subscriptions: {
    retrieve(id: string, params?: Record<string, unknown>): Promise<StripeSubscriptionLike>;
    cancel(id: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  paymentMethods: { retrieve(id: string): Promise<{ card?: { fingerprint?: string | null } | null }> };
}

// deno-lint-ignore no-explicit-any
export type AdminLike = any;

export const PROFILE_COLUMNS =
  "id, email, plan, minutes_included, minutes_used_this_month, subscription_status, stripe_customer_id, stripe_subscription_id, " +
  "trial_state, trial_used_at, trial_started_at, trial_ends_at, trial_subscription_id, billing_state_event_at";

const idOf = (ref: string | { id: string } | null | undefined): string | null => (!ref ? null : typeof ref === "string" ? ref : ref.id);

async function findProfile(admin: AdminLike, sub: StripeSubscriptionLike) {
  const customerId = idOf(sub.customer);
  const bySub = await admin.from("profiles").select(PROFILE_COLUMNS).eq("stripe_subscription_id", sub.id).maybeSingle();
  if (bySub.data) return bySub.data;
  if (customerId) {
    const byCustomer = await admin.from("profiles").select(PROFILE_COLUMNS).eq("stripe_customer_id", customerId).maybeSingle();
    if (byCustomer.data) return byCustomer.data;
  }
  return null;
}

async function cardFingerprint(stripe: StripeClientLike, sub: StripeSubscriptionLike): Promise<string | null> {
  try {
    const pm = sub.default_payment_method;
    if (pm && typeof pm !== "string" && pm.card?.fingerprint) return pm.card.fingerprint;
    const pmId = idOf(pm as string | { id: string } | null | undefined);
    if (!pmId) return null;
    return (await stripe.paymentMethods.retrieve(pmId)).card?.fingerprint ?? null;
  } catch (err) {
    console.error(JSON.stringify({ event: "trial_fingerprint_lookup_failed", error: String(err) }));
    return null; // dedupe by account + email still applies; documented gap
  }
}

export interface ApplyResult { handled: boolean; transition?: string; reason?: string }

/** Core: apply one subscription snapshot (from a subscription.* event or a retrieved checkout subscription). */
export async function applySubscription(
  admin: AdminLike,
  stripe: StripeClientLike,
  sub: StripeSubscriptionLike,
  meta: { eventType: "created" | "updated" | "deleted"; eventCreated: number },
  readEnv: (key: string) => string | undefined,
  knownProfile?: ProfileBillingState & { id: string; email: string | null } | null,
): Promise<ApplyResult> {
  const profile = knownProfile ?? (await findProfile(admin, sub));
  if (!profile) return { handled: false, reason: "no_profile" };

  const input: BillingInput = {
    kind: "subscription",
    eventType: meta.eventType,
    eventCreated: meta.eventCreated,
    subscriptionId: sub.id,
    stripeStatus: sub.status as StripeSubStatus,
    planId: planIdFromPriceId(sub.items.data[0]?.price.id, readEnv) ?? ((sub.metadata?.plan_id as never) ?? null),
    trialStart: sub.trial_start,
    trialEnd: sub.trial_end,
    isResultsPlan: sub.metadata?.results_plan === "1",
  };

  let decision = decide(profile, input, null);
  if (decision.action === "needs_claim") {
    const { data: claim, error } = await admin.rpc("claim_trial", {
      p_user: profile.id,
      p_subscription_id: sub.id,
      p_email_key: emailDedupeKey(profile.email),
      p_card_fingerprint: await cardFingerprint(stripe, sub),
      p_trial_start: sub.trial_start ? new Date(sub.trial_start * 1000).toISOString() : null,
      p_trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    });
    if (error) throw new Error(`claim_trial failed: ${error.message}`); // 500 => Stripe retries, claim is idempotent
    decision = decide(profile, input, claim as ClaimResult);
  }

  switch (decision.action) {
    case "legacy":
      return { handled: false };
    case "ignore":
      console.log(JSON.stringify({ event: "trial_event_ignored", reason: decision.reason, sub: sub.id }));
      return { handled: true, reason: decision.reason };
    case "apply": {
      await admin.from("profiles").update(decision.patch).eq("id", profile.id).throwOnError();
      console.log(JSON.stringify({ event: "trial_transition", transition: decision.transition, user: profile.id, sub: sub.id }));
      return { handled: true, transition: decision.transition };
    }
    case "deny_trial": {
      await admin.from("profiles").update(decision.patch).eq("id", profile.id).throwOnError();
      try {
        // Never touches live objects in tests; in production this ends the second/duplicate trial subscription.
        await stripe.subscriptions.cancel(sub.id, { prorate: false, invoice_now: false });
      } catch (err) {
        console.error(JSON.stringify({ event: "trial_deny_cancel_failed", sub: sub.id, error: String(err) }));
        throw err; // retry: the subscription must not stay open without entitlements being decided
      }
      console.log(JSON.stringify({ event: "trial_denied", reason: decision.reason, user: profile.id, sub: sub.id }));
      return { handled: true, transition: `denied:${decision.reason}` };
    }
    default:
      return { handled: false };
  }
}

/** invoice.paid / invoice.payment_succeeded: converts a trial on the first non-zero payment. */
export async function applyInvoicePaid(
  admin: AdminLike,
  invoice: { customer: string | { id: string } | null; subscription?: string | { id: string } | null; amount_paid: number },
  eventCreated: number,
): Promise<ApplyResult> {
  const customerId = idOf(invoice.customer);
  if (!customerId) return { handled: false };
  const { data: profile } = await admin.from("profiles").select(PROFILE_COLUMNS).eq("stripe_customer_id", customerId).maybeSingle();
  if (!profile) return { handled: false };
  const decision = decide(profile, {
    kind: "invoice_paid",
    eventCreated,
    subscriptionId: idOf(invoice.subscription ?? null),
    amountPaid: invoice.amount_paid ?? 0,
  });
  if (decision.action === "apply") {
    await admin.from("profiles").update(decision.patch).eq("id", profile.id).throwOnError();
    console.log(JSON.stringify({ event: "trial_transition", transition: decision.transition, user: profile.id }));
    return { handled: true, transition: decision.transition };
  }
  if (decision.action === "ignore") return { handled: true, reason: decision.reason };
  return { handled: false };
}

/**
 * checkout.session.completed for subscription-mode sessions (Payment Links or in-app checkout).
 * Links the Stripe customer to the profile (client_reference_id / metadata.supabase_user_id) only when the profile
 * has no customer yet, then applies the retrieved subscription through the same state machine.
 */
export async function applyCheckoutSession(
  admin: AdminLike,
  stripe: StripeClientLike,
  session: {
    mode: string | null;
    customer: string | { id: string } | null;
    subscription: string | { id: string } | null;
    client_reference_id?: string | null;
    metadata?: Record<string, string> | null;
  },
  eventCreated: number,
  readEnv: (key: string) => string | undefined,
): Promise<ApplyResult> {
  if (session.mode !== "subscription" || !session.subscription) return { handled: false };
  if (session.metadata?.results_plan === "1") return { handled: false };
  const subId = idOf(session.subscription)!;
  const customerId = idOf(session.customer);
  const sub = await stripe.subscriptions.retrieve(subId, { expand: ["default_payment_method"] });

  let profile = customerId
    ? (await admin.from("profiles").select(PROFILE_COLUMNS).eq("stripe_customer_id", customerId).maybeSingle()).data
    : null;

  if (!profile) {
    const userId = session.client_reference_id || session.metadata?.supabase_user_id || null;
    if (userId && /^[0-9a-f-]{36}$/i.test(userId) && customerId) {
      const { data: candidate } = await admin.from("profiles").select(PROFILE_COLUMNS).eq("id", userId).maybeSingle();
      // Link only a profile that has no Stripe customer yet: never hijack an account that already has billing.
      if (candidate && !candidate.stripe_customer_id) {
        await admin.from("profiles").update({ stripe_customer_id: customerId }).eq("id", userId).is("stripe_customer_id", null).throwOnError();
        profile = { ...candidate, stripe_customer_id: customerId };
      } else if (candidate) {
        console.error(JSON.stringify({ event: "checkout_profile_already_billed", user: userId, sub: subId }));
      }
    }
  }
  if (!profile) return { handled: false, reason: "no_profile" };
  return applySubscription(admin, stripe, sub, { eventType: "created", eventCreated }, readEnv, profile);
}
