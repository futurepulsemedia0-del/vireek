import { describe, expect, it } from "vitest";
import {
  emailKey, idempotencyKey, priceEnvName, reconcileOnboardingCheckout, renewalDisclosure, runOnboardingCheckout,
  type OnboardingDeps,
} from "./planOnboardingCheckout.ts";
import { TRIAL_DAYS } from "./trialLifecycle.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const ENV: Record<string, string> = {
  STRIPE_PRICE_STARTER: "price_s", STRIPE_PRICE_PROFESSIONAL: "price_p", STRIPE_PRICE_BUSINESS: "price_b", STRIPE_PRICE_PROFESSIONAL_ANNUAL: "price_pa",
};

interface World {
  profile: Record<string, unknown> | null;
  intent: Record<string, unknown> | null;
  cfg: Record<string, unknown> | null;
  claims: Array<{ user_id: string }>;
  sessions: Record<string, { id: string; status: string; url: string | null }>;
  subs: Array<{ status: string }>;
  promo: string | null;
  allowed: boolean;
}
const world = (o: Partial<World> = {}): World => ({
  profile: { stripe_customer_id: null, stripe_subscription_id: null, email: "owner@example.com", full_name: "Owner", role: "owner", trial_used_at: null, trial_state: "none" },
  intent: null, cfg: { trial_mode: "card_required" }, claims: [], sessions: {}, subs: [], promo: null, allowed: true, ...o,
});

function harness(w: World, env: Record<string, string> = ENV) {
  const writes: Array<{ table: string; op: string; payload: unknown }> = [];
  const created: Array<{ params: Record<string, any>; opts: Record<string, any> }> = [];
  const customers: Array<Record<string, any>> = [];
  const table = (name: string) => {
    const result = () => {
      if (name === "profiles") return { data: w.profile };
      if (name === "plan_onboarding") return { data: w.intent };
      if (name === "plan_onboarding_config") return { data: w.cfg };
      if (name === "trial_claims") return { data: w.claims };
      return { data: null };
    };
    const chain: any = {
      select: () => chain, eq: () => chain, neq: () => chain, is: () => chain, limit: () => chain,
      maybeSingle: async () => result(),
      then: (res: any) => Promise.resolve(result()).then(res),
      update: (payload: unknown) => { writes.push({ table: name, op: "update", payload }); return chain; },
      upsert: (payload: unknown) => { writes.push({ table: name, op: "upsert", payload }); if (name === "plan_onboarding") w.intent = { ...(w.intent ?? {}), ...(payload as object) }; return chain; },
    };
    return chain;
  };
  const deps: OnboardingDeps = {
    admin: { from: table },
    stripe: {
      subscriptions: { list: async () => ({ data: w.subs }) },
      customers: { create: async (p: any, o: any) => { customers.push({ p, o }); return { id: "cus_1" }; } },
      prices: { retrieve: async () => ({ tax_behavior: "exclusive" }) },
      promotionCodes: { list: async () => ({ data: w.promo ? [{ id: w.promo }] : [] }) },
      checkout: {
        sessions: {
          retrieve: async (id: string) => { if (!w.sessions[id]) throw new Error("nope"); return w.sessions[id]; },
          create: async (params: any, opts: any) => { created.push({ params, opts }); const s = { id: `cs_${created.length}aaaaaaaa`, status: "open", url: `https://checkout.stripe.com/c/pay/cs_${created.length}` }; w.sessions[s.id] = s; return s; },
        },
      },
    },
    limiter: { hit: async () => ({ allowed: w.allowed, retryAfter: 30 }) },
    readEnv: (k) => env[k],
    siteUrl: "https://vireek.test",
    now: () => 1_800_000_000_000,
  };
  return { deps, writes, created, customers };
}
const run = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) =>
  runOnboardingCheckout(h.deps, { userId: USER, planId: "professional", billing: "monthly", ...extra });

describe("validation and rate limit", () => {
  it("whitelists the plan server-side", async () => {
    for (const planId of ["free", "enterprise", "../x", undefined, 5]) {
      const r = await runOnboardingCheckout(harness(world()).deps, { userId: USER, planId, billing: "monthly" });
      expect(r.status).toBe(400);
    }
  });
  it("rejects unknown billing periods", async () => {
    expect((await run(harness(world()), { billing: "weekly" })).status).toBe(400);
  });
  it("rate limits per user", async () => {
    const r = await run(harness(world({ allowed: false })));
    expect(r.status).toBe(429);
    expect(r.body.code).toBe("rate_limited");
  });
  it("annual without its price secret is reported, never silently charged as monthly", async () => {
    const r = await run(harness(world()), { planId: "starter", billing: "annual" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("annual_unavailable");
    expect(priceEnvName("starter", "annual")).toBe("STRIPE_PRICE_STARTER_ANNUAL");
  });
  it("only the account owner may buy", async () => {
    const r = await run(harness(world({ profile: { role: "technician", email: "t@x.com" } })));
    expect(r.status).toBe(403);
  });
});

describe("entitlements change ONLY from the verified webhook", () => {
  it("never writes plan / minutes / subscription_status / trial_* anywhere", async () => {
    const h = harness(world());
    const r = await run(h);
    expect(r.status).toBe(200);
    const FORBIDDEN = ["plan", "minutes_included", "subscription_status", "status", "trial_state", "trial_used_at", "stripe_subscription_id"];
    for (const w of h.writes.filter((x) => x.table === "profiles")) {
      for (const k of Object.keys(w.payload as object)) expect(FORBIDDEN).not.toContain(k);
    }
    // the only profile write is linking the new Stripe customer
    expect(h.writes.filter((x) => x.table === "profiles").map((x) => x.payload)).toEqual([{ stripe_customer_id: "cus_1" }]);
  });
  it("records intent bookkeeping (step=checkout) but nothing else about access", async () => {
    const h = harness(world());
    await run(h);
    const up = h.writes.find((x) => x.table === "plan_onboarding" && x.op === "upsert")!.payload as Record<string, unknown>;
    expect(up).toMatchObject({ user_id: USER, plan: "professional", billing: "monthly", step: "checkout" });
  });
});

describe("idempotency: no double subscription", () => {
  it("existing subscription on the profile short-circuits", async () => {
    const h = harness(world({ profile: { ...world().profile!, stripe_subscription_id: "sub_1" } }));
    const r = await run(h);
    expect(r.body).toEqual({ alreadySubscribed: true });
    expect(h.created).toHaveLength(0);
  });
  it("a trialing account short-circuits", async () => {
    const h = harness(world({ profile: { ...world().profile!, trial_state: "trialing" } }));
    expect((await run(h)).body).toEqual({ alreadySubscribed: true });
  });
  it("a subscription Stripe knows but the webhook has not delivered yet short-circuits", async () => {
    const h = harness(world({ profile: { ...world().profile!, stripe_customer_id: "cus_9" }, subs: [{ status: "trialing" }] }));
    expect((await run(h)).body).toEqual({ alreadySubscribed: true });
    expect(h.created).toHaveLength(0);
  });
  it("canceled old subscriptions do not block a new one", async () => {
    const h = harness(world({ profile: { ...world().profile!, stripe_customer_id: "cus_9" }, subs: [{ status: "canceled" }] }));
    expect((await run(h)).body.url).toBeTruthy();
  });
  it("reuses the open session for the same plan and cycle", async () => {
    const w = world({ intent: { plan: "professional", billing: "monthly", checkout_session_id: "cs_open" }, sessions: { cs_open: { id: "cs_open", status: "open", url: "https://checkout.stripe.com/c/pay/cs_open" } } });
    const h = harness(w);
    const r = await run(h);
    expect(r.body).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_open", reused: true });
    expect(h.created).toHaveLength(0);
  });
  it("a completed session means 'processing', not a second checkout", async () => {
    const w = world({ intent: { plan: "professional", billing: "monthly", checkout_session_id: "cs_done" }, sessions: { cs_done: { id: "cs_done", status: "complete", url: null } } });
    const h = harness(w);
    expect((await run(h)).body).toEqual({ processing: true });
    expect(h.created).toHaveLength(0);
  });
  it("an expired session is replaced; a different plan never reuses the old session", async () => {
    const w = world({ intent: { plan: "professional", billing: "monthly", checkout_session_id: "cs_old" }, sessions: { cs_old: { id: "cs_old", status: "expired", url: null } } });
    const h = harness(w);
    expect((await run(h)).body.url).toContain("checkout.stripe.com");
    const h2 = harness(world({ intent: { plan: "starter", billing: "monthly", checkout_session_id: "cs_open" }, sessions: { cs_open: { id: "cs_open", status: "open", url: "https://checkout.stripe.com/x" } } }));
    expect(((await run(h2)).body as any).reused).toBeUndefined();
  });
  it("sends Stripe idempotency keys (customer and session)", async () => {
    const h = harness(world());
    await run(h);
    expect(h.customers[0].o).toEqual({ idempotencyKey: `cust:${USER}` });
    expect(h.created[0].opts.idempotencyKey).toBe(idempotencyKey(USER, "professional", "monthly", true, null, 1_800_000_000_000));
    expect(idempotencyKey(USER, "professional", "monthly", true, null, 0)).toBe(idempotencyKey(USER, "professional", "monthly", true, null, 599_999));
    expect(idempotencyKey(USER, "professional", "monthly", true, null, 0)).not.toBe(idempotencyKey(USER, "professional", "monthly", true, null, 600_000));
  });
  it("success/cancel URLs return to onboarding and the user id is attached for the webhook", async () => {
    const h = harness(world());
    await run(h);
    const p = h.created[0].params;
    expect(p.success_url).toBe("https://vireek.test/onboarding/plan?checkout=success");
    expect(p.cancel_url).toBe("https://vireek.test/onboarding/plan?checkout=cancelled");
    expect(p.client_reference_id).toBe(USER);
    expect(p.metadata).toMatchObject({ supabase_user_id: USER, plan_id: "professional", billing: "monthly", source: "onboarding" });
    expect(p.subscription_data.metadata.plan_id).toBe("professional");
    expect(p.line_items[0].price).toBe("price_p");
  });
});

describe("trial policy is config, one trial per person", () => {
  it("card_required: trial days from the shared constant, card always collected", async () => {
    const h = harness(world());
    await run(h);
    const p = h.created[0].params;
    expect(p.subscription_data.trial_period_days).toBe(TRIAL_DAYS);
    expect(p.payment_method_collection).toBeUndefined();
  });
  it("no_card: card not required and the trial ends if none is added", async () => {
    const h = harness(world({ cfg: { trial_mode: "no_card" } }));
    await run(h);
    const p = h.created[0].params;
    expect(p.payment_method_collection).toBe("if_required");
    expect(p.subscription_data.trial_settings).toEqual({ end_behavior: { missing_payment_method: "cancel" } });
  });
  it("none: no trial, billed at checkout", async () => {
    const h = harness(world({ cfg: { trial_mode: "none" } }));
    await run(h);
    expect(h.created[0].params.subscription_data.trial_period_days).toBeUndefined();
  });
  it("trial already used on the account -> no second trial", async () => {
    const h = harness(world({ profile: { ...world().profile!, trial_used_at: "2029-01-01T00:00:00Z" } }));
    await run(h);
    expect(h.created[0].params.subscription_data.trial_period_days).toBeUndefined();
  });
  it("same normalised email already claimed a trial -> no trial", async () => {
    const h = harness(world({ claims: [{ user_id: "someone-else" }] }));
    await run(h);
    expect(h.created[0].params.subscription_data.trial_period_days).toBeUndefined();
    expect(emailKey("A.User+promo@Example.com")).toBe("a.user@example.com");
  });
  it("an unknown trial_mode value falls back to the repo's current behaviour (card_required)", async () => {
    const h = harness(world({ cfg: { trial_mode: "weird" } }));
    await run(h);
    expect(h.created[0].params.subscription_data.trial_period_days).toBe(TRIAL_DAYS);
  });
});

describe("promo codes and terms text", () => {
  it("valid code is applied as a discount (and Stripe's own field is dropped)", async () => {
    const h = harness(world({ promo: "promo_1" }));
    await run(h, { promoCode: "WELCOME-10" });
    expect(h.created[0].params.discounts).toEqual([{ promotion_code: "promo_1" }]);
    expect(h.created[0].params.allow_promotion_codes).toBeUndefined();
  });
  it("unknown or malformed codes are rejected before any session exists", async () => {
    for (const code of ["NOPE123", "bad code!", "x"]) {
      const h = harness(world());
      const r = await run(h, { promoCode: code });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("promo_invalid");
      expect(h.created).toHaveLength(0);
    }
  });
  it("no code: Stripe's promotion field stays available", async () => {
    const h = harness(world());
    await run(h);
    expect(h.created[0].params.allow_promotion_codes).toBe(true);
  });
  it("puts renewal and cancellation terms on the payment page", async () => {
    const h = harness(world());
    await run(h, { billing: "annual" });
    const msg = h.created[0].params.custom_text.submit.message as string;
    expect(msg).toContain("renews automatically every year");
    expect(msg).toContain("cancel");
    expect(renewalDisclosure("monthly", "off")).not.toContain("Free for");
  });
});

describe("tax guard", () => {
  it("blocks a tax-inclusive price when automatic tax is enabled", async () => {
    const h = harness(world());
    (h.deps.stripe as any).prices.retrieve = async () => ({ tax_behavior: "inclusive" });
    h.deps.readEnv = (k) => (k === "STRIPE_AUTOMATIC_TAX" ? "true" : ENV[k]);
    const r = await run(h);
    expect(r.status).toBe(500);
    expect(h.created).toHaveLength(0);
  });
});

describe("reconcile (expired / closed tab)", () => {
  it("expired session sends the person back to step 'plan'", async () => {
    const w = world({ intent: { checkout_session_id: "cs_x", step: "checkout" }, sessions: { cs_x: { id: "cs_x", status: "expired", url: null } } });
    const h = harness(w);
    const r = await reconcileOnboardingCheckout(h.deps, USER);
    expect(r.body).toEqual({ outcome: "expired" });
    expect(h.writes.find((x) => x.op === "update")!.payload).toMatchObject({ step: "plan", checkout_session_id: null });
  });
  it("open and complete sessions are reported without any write", async () => {
    const open = harness(world({ intent: { checkout_session_id: "cs_o" }, sessions: { cs_o: { id: "cs_o", status: "open", url: "u" } } }));
    expect((await reconcileOnboardingCheckout(open.deps, USER)).body).toEqual({ outcome: "open" });
    const done = harness(world({ intent: { checkout_session_id: "cs_c" }, sessions: { cs_c: { id: "cs_c", status: "complete", url: null } } }));
    expect((await reconcileOnboardingCheckout(done.deps, USER)).body).toEqual({ outcome: "complete" });
    expect(open.writes).toHaveLength(0);
    expect(done.writes).toHaveLength(0);
  });
  it("no session or a Stripe failure -> 'none'", async () => {
    expect((await reconcileOnboardingCheckout(harness(world()).deps, USER)).body).toEqual({ outcome: "none" });
    const bad = harness(world({ intent: { checkout_session_id: "cs_missing" } }));
    expect((await reconcileOnboardingCheckout(bad.deps, USER)).body).toEqual({ outcome: "none" });
  });
});
