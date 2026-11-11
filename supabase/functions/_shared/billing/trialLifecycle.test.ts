import { describe, expect, it } from "vitest";
import { applyInvoicePaid, applyCheckoutSession, applySubscription } from "./trialWebhook.ts";
import {
  TRIAL_MINUTES,
  decide,
  emailDedupeKey,
  minutesIncludedAfterPlanChange,
  type BillingInput,
  type ClaimResult,
  type ProfileBillingState,
  type TrialState,
} from "./trialLifecycle.ts";

const T0 = 1_800_000_000;
const DAY = 86_400;
const SUB = "sub_trial";

function profile(over: Partial<ProfileBillingState> = {}): ProfileBillingState {
  return {
    plan: "starter",
    minutes_included: 0,
    minutes_used_this_month: 0,
    subscription_status: "active",
    stripe_subscription_id: null,
    trial_state: "none",
    trial_used_at: null,
    trial_started_at: null,
    trial_ends_at: null,
    trial_subscription_id: null,
    billing_state_event_at: null,
    ...over,
  };
}
const inTrial = (state: TrialState, over: Partial<ProfileBillingState> = {}) =>
  profile({
    plan: "professional",
    minutes_included: state === "converted" ? 1500 : state === "ended" ? 0 : TRIAL_MINUTES,
    minutes_used_this_month: 12,
    stripe_subscription_id: SUB,
    trial_state: state,
    trial_used_at: new Date(T0 * 1000).toISOString(),
    trial_started_at: new Date(T0 * 1000).toISOString(),
    trial_ends_at: new Date((T0 + 14 * DAY) * 1000).toISOString(),
    trial_subscription_id: SUB,
    billing_state_event_at: new Date(T0 * 1000).toISOString(),
    ...over,
  });

const sub = (over: Partial<Extract<BillingInput, { kind: "subscription" }>> = {}): BillingInput => ({
  kind: "subscription",
  eventType: "updated",
  eventCreated: T0 + DAY,
  subscriptionId: SUB,
  stripeStatus: "trialing",
  planId: "professional",
  trialStart: T0,
  trialEnd: T0 + 14 * DAY,
  isResultsPlan: false,
  ...over,
});
const paid = (over: Partial<Extract<BillingInput, { kind: "invoice_paid" }>> = {}): BillingInput => ({
  kind: "invoice_paid", eventCreated: T0 + 15 * DAY, subscriptionId: SUB, amountPaid: 19900, ...over,
});

interface Row {
  name: string;
  state: ProfileBillingState;
  input: BillingInput;
  claim?: ClaimResult | null;
  action: string;
  patch?: Record<string, unknown>;
}

const ROWS: Row[] = [
  // ---- trial start
  { name: "new trial starts (claim pending)", state: profile(), input: sub({ eventType: "created", eventCreated: T0 }), action: "needs_claim" },
  { name: "new trial granted -> plan unlocked, 60 min cap, usage zeroed", state: profile(), input: sub({ eventType: "created", eventCreated: T0 }), claim: "granted", action: "apply",
    patch: { plan: "professional", minutes_included: TRIAL_MINUTES, minutes_used_this_month: 0, trial_state: "trialing", trial_subscription_id: SUB, subscription_status: "active" } },
  { name: "claim replay is idempotent", state: profile(), input: sub({ eventType: "created", eventCreated: T0 }), claim: "replay", action: "apply", patch: { trial_state: "trialing", minutes_included: TRIAL_MINUTES } },
  { name: "second trial for same profile (trial_used_at set) is denied without RPC", state: profile({ trial_used_at: "2026-01-01T00:00:00Z", trial_subscription_id: "sub_old", trial_state: "converted", billing_state_event_at: null }), input: sub({ eventType: "created", eventCreated: T0 }), action: "deny_trial" },
  { name: "duplicate email denied", state: profile(), input: sub({ eventType: "created", eventCreated: T0 }), claim: "denied_email", action: "deny_trial" },
  { name: "duplicate card denied", state: profile(), input: sub({ eventType: "created", eventCreated: T0 }), claim: "denied_card", action: "deny_trial" },
  { name: "results-plan trial is never capped", state: profile(), input: sub({ isResultsPlan: true }), action: "legacy" },
  // ---- during trial
  { name: "plan change during trial keeps 60 cap", state: inTrial("trialing"), input: sub({ planId: "business" }), action: "apply", patch: { plan: "business", minutes_included: TRIAL_MINUTES } },
  { name: "past_due keeps cap, does not touch subscription_status", state: inTrial("trialing"), input: sub({ stripeStatus: "past_due" }), action: "apply", patch: { minutes_included: TRIAL_MINUTES } },
  // ---- trial -> paid
  { name: "subscription active converts: plan allowance, usage reset", state: inTrial("trialing"), input: sub({ stripeStatus: "active", eventCreated: T0 + 14 * DAY }), action: "apply", patch: { trial_state: "converted", minutes_included: 1500, minutes_used_this_month: 0, plan: "professional" } },
  { name: "first non-zero invoice converts", state: inTrial("trialing"), input: paid(), action: "apply", patch: { trial_state: "converted", minutes_included: 1500, minutes_used_this_month: 0 } },
  { name: "$0 trial invoice ignored", state: inTrial("trialing"), input: paid({ amountPaid: 0 }), action: "ignore" },
  { name: "invoice for a different subscription is legacy", state: inTrial("trialing"), input: paid({ subscriptionId: "sub_other" }), action: "legacy" },
  { name: "invoice after ended trial ignored", state: inTrial("ended"), input: paid(), action: "ignore" },
  { name: "converted + later events -> legacy (paid behaviour unchanged)", state: inTrial("converted"), input: sub({ stripeStatus: "active", eventCreated: T0 + 40 * DAY }), action: "legacy" },
  { name: "converted + paid invoice -> legacy", state: inTrial("converted"), input: paid(), action: "legacy" },
  { name: "converted + canceled -> legacy", state: inTrial("converted"), input: sub({ eventType: "deleted", stripeStatus: "canceled", eventCreated: T0 + 60 * DAY }), action: "legacy" },
  // ---- trial canceled / expired
  { name: "deleted during trial -> ended, suspended, 0 minutes", state: inTrial("trialing"), input: sub({ eventType: "deleted", stripeStatus: "canceled" }), action: "apply", patch: { trial_state: "ended", minutes_included: 0, subscription_status: "suspended", status: "suspended" } },
  { name: "updated->canceled during trial -> ended", state: inTrial("trialing"), input: sub({ stripeStatus: "canceled" }), action: "apply", patch: { trial_state: "ended", minutes_included: 0 } },
  { name: "unpaid after trial -> ended", state: inTrial("trialing"), input: sub({ stripeStatus: "unpaid" }), action: "apply", patch: { trial_state: "ended" } },
  { name: "deleted replay on ended trial ignored", state: inTrial("ended"), input: sub({ eventType: "deleted", stripeStatus: "canceled", eventCreated: T0 + 20 * DAY }), action: "ignore" },
  { name: "ended -> user buys a plain paid plan: unblocked", state: inTrial("ended", { stripe_subscription_id: SUB }), input: sub({ subscriptionId: "sub_paid", stripeStatus: "active", planId: "starter", eventCreated: T0 + 30 * DAY }), action: "apply", patch: { trial_state: "none", minutes_included: 400, stripe_subscription_id: "sub_paid", minutes_used_this_month: 0 } },
  // ---- out of order / replays
  { name: "stale trialing event after conversion is ignored", state: inTrial("trialing", { billing_state_event_at: new Date((T0 + 14 * DAY) * 1000).toISOString() }), input: sub({ eventCreated: T0 + 2 * DAY }), action: "ignore" },
  { name: "stale active event is ignored", state: inTrial("trialing", { billing_state_event_at: new Date((T0 + 20 * DAY) * 1000).toISOString() }), input: sub({ stripeStatus: "active", eventCreated: T0 + 14 * DAY }), action: "ignore" },
  { name: "trialing event arriving after converted does nothing", state: inTrial("converted"), input: sub({ stripeStatus: "trialing", eventCreated: T0 + 30 * DAY }), action: "ignore" },
  { name: "unrelated plain subscription -> legacy", state: profile(), input: sub({ stripeStatus: "active" }), action: "legacy" },
];

describe("trial state machine (event x state -> decision)", () => {
  it.each(ROWS)("$name", (row: Row) => {
    const d = decide(row.state, row.input, row.claim ?? null);
    expect(d.action).toBe(row.action);
    if (row.patch && (d.action === "apply" || d.action === "deny_trial")) {
      for (const [k, v] of Object.entries(row.patch)) expect((d.patch as Record<string, unknown>)[k]).toEqual(v);
    }
  });

  it("applying the same event twice yields the same patch (replay-safe)", () => {
    const a = decide(inTrial("trialing"), sub({ planId: "business" }));
    const b = decide(inTrial("trialing"), sub({ planId: "business" }));
    expect(a).toEqual(b);
  });

  it("never grants paid minutes while trialing, for any plan", () => {
    for (const planId of ["starter", "professional", "business"] as const) {
      const d = decide(inTrial("trialing"), sub({ planId }));
      expect(d.action === "apply" && d.patch.minutes_included).toBe(TRIAL_MINUTES);
    }
  });
});

describe("helpers", () => {
  it("minutesIncludedAfterPlanChange keeps the cap during a trial only", () => {
    expect(minutesIncludedAfterPlanChange("trialing", "business")).toBe(TRIAL_MINUTES);
    expect(minutesIncludedAfterPlanChange("none", "business")).toBe(4000);
    expect(minutesIncludedAfterPlanChange("converted", "starter")).toBe(400);
  });
  it("emailDedupeKey strips +tags and case", () => {
    expect(emailDedupeKey(" Ali+x@Gmail.com ")).toBe("ali@gmail.com");
    expect(emailDedupeKey("bad")).toBeNull();
    expect(emailDedupeKey(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- I/O glue with an in-memory fake (no network, no live Stripe)
function fakeAdmin(rows: Record<string, Record<string, unknown>>, claimResult: ClaimResult = "granted") {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const q = (filters: Array<[string, unknown]> = []) => ({
    select: () => q(filters),
    eq: (c: string, v: unknown) => q([...filters, [c, v]]),
    is: (c: string, v: unknown) => q([...filters, [c, v]]),
    maybeSingle: async () => ({ data: Object.values(rows).find((r) => filters.every(([c, v]) => r[c] === v)) ?? null }),
    update: (patch: Record<string, unknown>) => ({
      eq: (_c: string, id: string) => {
        updates.push({ id, patch });
        Object.assign(rows[id], patch);
        const r = { throwOnError: async () => ({}), is: () => r };
        return r;
      },
    }),
  });
  return {
    updates,
    from: () => q(),
    rpc: async () => ({ data: claimResult, error: null }),
  };
}
const env = (k: string) => ({ STRIPE_PRICE_STARTER: "price_s", STRIPE_PRICE_PROFESSIONAL: "price_p", STRIPE_PRICE_BUSINESS: "price_b" } as Record<string, string>)[k];
const stripeStub = () => {
  const canceled: string[] = [];
  return {
    canceled,
    subscriptions: { retrieve: async () => stripeSub(), cancel: async (id: string) => { canceled.push(id); } },
    paymentMethods: { retrieve: async () => ({ card: { fingerprint: "fp_1" } }) },
  };
};
const stripeSub = (over: Record<string, unknown> = {}) => ({
  id: SUB, status: "trialing", customer: "cus_1", trial_start: T0, trial_end: T0 + 14 * DAY, metadata: {},
  default_payment_method: "pm_1", items: { data: [{ price: { id: "price_p" } }] }, ...over,
});
const baseRow = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-1111-1111-111111111111", email: "a@b.com", stripe_customer_id: "cus_1", ...profile(), ...over,
});

describe("webhook glue", () => {
  it("full lifecycle: checkout(trial) -> plan change -> invoice paid; replays and out-of-order are harmless", async () => {
    const row = baseRow() as Record<string, unknown>;
    const admin = fakeAdmin({ [row.id as string]: row });
    const stripe = stripeStub();
    const session = { mode: "subscription", customer: "cus_1", subscription: SUB, client_reference_id: null, metadata: {} };

    await applyCheckoutSession(admin, stripe as never, session, T0, env);
    expect(row.trial_state).toBe("trialing");
    expect(row.minutes_included).toBe(TRIAL_MINUTES);

    // replay of the same checkout event
    await applyCheckoutSession(admin, stripe as never, session, T0, env);
    expect(row.minutes_included).toBe(TRIAL_MINUTES);

    // plan change inside the trial (business)
    await applySubscription(admin, stripe as never, stripeSub({ items: { data: [{ price: { id: "price_b" } }] } }) as never, { eventType: "updated", eventCreated: T0 + DAY }, env);
    expect(row.plan).toBe("business");
    expect(row.minutes_included).toBe(TRIAL_MINUTES);

    // paid -> converted
    const r = await applyInvoicePaid(admin, { customer: "cus_1", subscription: SUB, amount_paid: 39900 }, T0 + 14 * DAY);
    expect(r.handled).toBe(true);
    expect(row.trial_state).toBe("converted");
    expect(row.minutes_included).toBe(4000);
    expect(row.minutes_used_this_month).toBe(0);

    // late (older) trialing event must not re-cap a paid customer
    await applySubscription(admin, stripe as never, stripeSub() as never, { eventType: "updated", eventCreated: T0 + 2 * DAY }, env);
    expect(row.minutes_included).toBe(4000);
  });

  it("second trial is denied and the Stripe subscription is canceled", async () => {
    const row = baseRow({ trial_used_at: "2026-01-01T00:00:00Z", trial_subscription_id: "sub_old", trial_state: "converted" }) as Record<string, unknown>;
    const admin = fakeAdmin({ [row.id as string]: row });
    const stripe = stripeStub();
    await applySubscription(admin, stripe as never, stripeSub({ id: "sub_new" }) as never, { eventType: "created", eventCreated: T0 }, env);
    expect(stripe.canceled).toEqual(["sub_new"]);
    expect(row.minutes_included).toBe(0); // untouched: no entitlements from the denied trial
    expect(row.trial_state).toBe("converted");
  });

  it("a checkout with client_reference_id never hijacks a profile that already has a Stripe customer", async () => {
    const row = baseRow({ stripe_customer_id: "cus_existing" }) as Record<string, unknown>;
    const admin = fakeAdmin({ [row.id as string]: row });
    const r = await applyCheckoutSession(
      admin, stripeStub() as never,
      { mode: "subscription", customer: "cus_new", subscription: SUB, client_reference_id: row.id as string, metadata: {} },
      T0, env,
    );
    expect(r.handled).toBe(false);
    expect(row.trial_state).toBe("none");
  });

  it("existing paid customers fall through to legacy handlers", async () => {
    const row = baseRow({ plan: "professional", minutes_included: 1500, stripe_subscription_id: "sub_paid" }) as Record<string, unknown>;
    const admin = fakeAdmin({ [row.id as string]: row });
    const r = await applySubscription(admin, stripeStub() as never, stripeSub({ id: "sub_paid", status: "active" }) as never, { eventType: "updated", eventCreated: T0 }, env);
    expect(r.handled).toBe(false);
    expect(admin.updates).toHaveLength(0);
  });
});
