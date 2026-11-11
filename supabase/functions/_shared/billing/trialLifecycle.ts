// supabase/functions/_shared/billing/trialLifecycle.ts
//
// Pure state machine for the card-required 14-day trial (capped at TRIAL_MINUTES).
// No Deno globals, no I/O: the same file is imported by stripe-webhook / manage-subscription-plan
// and unit-tested by Vitest (trialLifecycle.test.ts).
//
// States live in profiles.trial_state:
//   none       never trialed, or restarted as a plain paid subscription
//   trialing   card trial running, or trial over but the first invoice is not paid yet (cap still applies)
//   ended      trial canceled / expired without payment  -> voice off
//   converted  first non-zero invoice paid               -> normal paid plan
//
// profiles.subscription_status is NOT used for "trialing" (its CHECK allows only active|past_due|suspended);
// while trialing it stays 'active' and the dunning flow keeps owning past_due/suspended.

import { minutesForPlan, type PurchasablePlanId } from "./planCatalog.ts";

export const TRIAL_DAYS = 14;
/** Hard cap on voice minutes for the whole trial (lifetime of the trial, not monthly). */
export const TRIAL_MINUTES = 60;

export type TrialState = "none" | "trialing" | "ended" | "converted";

export interface ProfileBillingState {
  plan: string | null;
  minutes_included: number | null;
  minutes_used_this_month: number | null;
  subscription_status: string | null;
  stripe_subscription_id: string | null;
  trial_state: TrialState;
  trial_used_at: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  trial_subscription_id: string | null;
  /** ISO time of the newest Stripe event already applied by this state machine. */
  billing_state_event_at: string | null;
}

export type StripeSubStatus =
  | "trialing" | "active" | "past_due" | "unpaid" | "canceled" | "incomplete" | "incomplete_expired" | "paused";

export type BillingInput =
  | {
      kind: "subscription";
      eventType: "created" | "updated" | "deleted";
      /** Stripe event.created (unix seconds). */
      eventCreated: number;
      subscriptionId: string;
      stripeStatus: StripeSubStatus;
      /** Plan resolved from the subscription's price (null if unknown). */
      planId: PurchasablePlanId | null;
      trialStart: number | null;
      trialEnd: number | null;
      /** Results Plan subscriptions have their own trial semantics and are never capped here. */
      isResultsPlan: boolean;
    }
  | {
      kind: "invoice_paid";
      eventCreated: number;
      subscriptionId: string | null;
      amountPaid: number;
    };

export type ClaimResult = "granted" | "replay" | "denied_used" | "denied_email" | "denied_card" | "no_profile";

export type Decision =
  /** Not trial-related: the caller must run the legacy (unchanged) handler. */
  | { action: "legacy" }
  /** Out-of-order / stale event: do nothing. */
  | { action: "ignore"; reason: string }
  /** A new trial wants to start: call claim_trial(), then re-run decide() with the result. */
  | { action: "needs_claim" }
  /** Trial refused (second trial / duplicate email / duplicate card): cancel the Stripe subscription, no entitlements. */
  | { action: "deny_trial"; reason: ClaimResult; patch: Record<string, unknown> }
  | { action: "apply"; patch: Record<string, unknown>; transition: string };

const DUNNING_CLEAR = {
  subscription_status: "active",
  status: "active",
  dunning_stage: 0,
  payment_failed_at: null,
  payment_grace_period_ends_at: null,
  last_payment_error: null,
} as const;

function iso(unixSeconds: number | null): string | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000).toISOString();
}

function isStale(profile: ProfileBillingState, eventCreated: number): boolean {
  if (!profile.billing_state_event_at) return false;
  return eventCreated < Math.floor(Date.parse(profile.billing_state_event_at) / 1000);
}

/** Entitlement for a plan inside a trial: chosen plan unlocked, minutes forced to the trial cap. */
export function trialEntitlement(planId: string | null | undefined): { plan?: string; minutes_included: number } {
  return planId ? { plan: planId, minutes_included: TRIAL_MINUTES } : { minutes_included: TRIAL_MINUTES };
}

/** What manage-subscription-plan must write to minutes_included after a plan change. */
export function minutesIncludedAfterPlanChange(trialState: TrialState | null | undefined, planId: string): number | null {
  if (trialState === "trialing") return TRIAL_MINUTES;
  return minutesForPlan(planId);
}

function convertPatch(planId: string | null, eventCreated: number, profile: ProfileBillingState): Record<string, unknown> {
  const plan = planId ?? profile.plan;
  const minutes = minutesForPlan(plan);
  return {
    ...(plan ? { plan } : {}),
    ...(minutes !== null ? { minutes_included: minutes } : {}),
    minutes_used_this_month: 0,
    trial_state: "converted",
    ...DUNNING_CLEAR,
    billing_state_event_at: iso(eventCreated),
  };
}

export function decide(
  profile: ProfileBillingState,
  input: BillingInput,
  claim: ClaimResult | null = null,
): Decision {
  // ------------------------------------------------------------------ invoice.paid / invoice.payment_succeeded
  if (input.kind === "invoice_paid") {
    const inTrial = profile.trial_state === "trialing" || profile.trial_state === "ended";
    if (!inTrial || !input.subscriptionId || input.subscriptionId !== profile.trial_subscription_id) return { action: "legacy" };
    if (input.amountPaid <= 0) return { action: "ignore", reason: "zero_amount_invoice" };
    if (profile.trial_state === "ended") return { action: "ignore", reason: "trial_already_ended" };
    if (isStale(profile, input.eventCreated)) return { action: "ignore", reason: "stale_event" };
    return { action: "apply", patch: convertPatch(null, input.eventCreated, profile), transition: "trialing->converted (invoice paid)" };
  }

  // ------------------------------------------------------------------ subscription events
  if (input.isResultsPlan) return { action: "legacy" };
  const isTrialSub = profile.trial_subscription_id === input.subscriptionId && profile.trial_state !== "none";
  const startsTrial = input.stripeStatus === "trialing" && input.eventType !== "deleted";

  if (!startsTrial && !isTrialSub) {
    // Plain paid subscription replacing an ended trial: unblock voice and give the paid allowance.
    if (profile.trial_state === "ended" && input.stripeStatus === "active" && input.eventType !== "deleted") {
      if (isStale(profile, input.eventCreated)) return { action: "ignore", reason: "stale_event" };
      const plan = input.planId ?? profile.plan;
      const minutes = minutesForPlan(plan);
      return {
        action: "apply",
        transition: "ended->none (new paid subscription)",
        patch: {
          ...(plan ? { plan } : {}),
          ...(minutes !== null ? { minutes_included: minutes } : {}),
          minutes_used_this_month: 0,
          stripe_subscription_id: input.subscriptionId,
          trial_state: "none",
          ...DUNNING_CLEAR,
          billing_state_event_at: iso(input.eventCreated),
        },
      };
    }
    return { action: "legacy" };
  }

  if (isStale(profile, input.eventCreated)) return { action: "ignore", reason: "stale_event" };

  // ---- a trialing subscription we have not (yet) recorded for this profile
  if (startsTrial && !isTrialSub) {
    if (claim === null && profile.trial_used_at) {
      return { action: "deny_trial", reason: "denied_used", patch: { billing_state_event_at: iso(input.eventCreated) } };
    }
    if (claim === null) return { action: "needs_claim" };
    if (claim === "no_profile") return { action: "ignore", reason: "no_profile" };
    if (claim !== "granted" && claim !== "replay") {
      return { action: "deny_trial", reason: claim, patch: { billing_state_event_at: iso(input.eventCreated) } };
    }
    return {
      action: "apply",
      transition: "none->trialing",
      patch: {
        ...trialEntitlement(input.planId),
        stripe_subscription_id: input.subscriptionId,
        minutes_used_this_month: 0,
        trial_state: "trialing",
        trial_started_at: iso(input.trialStart) ?? profile.trial_started_at,
        trial_ends_at: iso(input.trialEnd),
        trial_subscription_id: input.subscriptionId,
        ...DUNNING_CLEAR,
        billing_state_event_at: iso(input.eventCreated),
      },
    };
  }

  // ---- from here on the subscription is this profile's trial subscription
  const base = { billing_state_event_at: iso(input.eventCreated) };

  if (input.eventType === "deleted" || input.stripeStatus === "canceled" || input.stripeStatus === "incomplete_expired" || input.stripeStatus === "unpaid") {
    if (profile.trial_state === "converted") return { action: "legacy" }; // paid customer canceling: unchanged behaviour
    if (profile.trial_state === "ended") return { action: "ignore", reason: "already_ended" };
    return {
      action: "apply",
      transition: "trialing->ended (canceled/expired unpaid)",
      patch: { trial_state: "ended", minutes_included: 0, subscription_status: "suspended", status: "suspended", ...base },
    };
  }

  if (input.stripeStatus === "trialing") {
    if (profile.trial_state !== "trialing") return { action: "ignore", reason: `trialing_event_in_state_${profile.trial_state}` };
    return {
      action: "apply",
      transition: "trialing->trialing (plan/date update keeps cap)",
      patch: { ...trialEntitlement(input.planId), trial_ends_at: iso(input.trialEnd) ?? profile.trial_ends_at, ...base },
    };
  }

  if (input.stripeStatus === "active") {
    if (profile.trial_state === "converted") return { action: "legacy" };
    if (profile.trial_state === "ended") return { action: "ignore", reason: "active_event_for_ended_trial" };
    return { action: "apply", transition: "trialing->converted (subscription active)", patch: convertPatch(input.planId, input.eventCreated, profile) };
  }

  if (input.stripeStatus === "past_due") {
    if (profile.trial_state === "converted") return { action: "legacy" };
    // Dunning (invoice.payment_failed + enforce-payment-suspension) owns subscription_status; the trial cap stays.
    return {
      action: "apply",
      transition: "trialing->trialing (past_due: cap kept, dunning owns suspension)",
      patch: { ...trialEntitlement(input.planId), ...base },
    };
  }

  return { action: "ignore", reason: `unhandled_status_${input.stripeStatus}` };
}

/** profiles.email -> dedupe key: lower-case, "+tag" stripped from the local part. */
export function emailDedupeKey(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.trim().toLowerCase().split("@");
  if (!local || !domain) return null;
  return `${local.split("+")[0]}@${domain}`;
}
