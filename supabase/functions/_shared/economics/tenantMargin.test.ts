import { describe, it, expect } from "vitest";
import { computeTenantMargin, marginAlertKey, type TenantMarginInput } from "./tenantMargin";

const t = (o: Partial<TenantMarginInput> = {}): TenantMarginInput => ({
  accountId: "acc1", plan: "starter", minutesIncluded: 200, minutesUsed: 100, costMicro: 10_000_000, // $10
  hasSubscription: true, subscriptionStatus: "active", trialState: "converted", windowDays: 30, ...o,
});

describe("computeTenantMargin", () => {
  it("positive margin on a healthy starter account", () => {
    const m = computeTenantMargin(t());
    expect(m.status).toBe("ok");
    expect(m.revenueCents).toBe(9900);
    expect(m.costCents).toBe(1000);
  });
  it("negative margin raises status negative", () => {
    const m = computeTenantMargin(t({ costMicro: 150_000_000 })); // $150 cost vs $99 revenue
    expect(m.status).toBe("negative");
    expect(m.marginCents).toBeLessThan(0);
  });
  it("adds overage revenue at the plan rate", () => {
    const m = computeTenantMargin(t({ minutesUsed: 300 }));
    expect(m.overageMinutes).toBe(100);
    expect(m.revenueCents).toBe(9900 + 100 * 25);
  });
  it("recognises a grandfathered legacy account by its stored allowance", () => {
    const m = computeTenantMargin(t({ minutesIncluded: 400 }));
    expect(m.priceBasis).toBe("legacy");
    expect(m.revenueCents).toBe(7900);
  });
  it("never alerts on trials, accounts without a subscription, or unknown plans", () => {
    expect(computeTenantMargin(t({ trialState: "trialing", costMicro: 999_000_000 })).status).toBe("trial");
    expect(computeTenantMargin(t({ hasSubscription: false, costMicro: 999_000_000 })).status).toBe("no_revenue_source");
    expect(computeTenantMargin(t({ minutesIncluded: 777, costMicro: 999_000_000 })).status).toBe("unknown_plan");
    expect(computeTenantMargin(t({ plan: "enterprise", minutesIncluded: 6000 })).status).toBe("unknown_plan");
  });
  it("prorates revenue to the window", () => {
    expect(computeTenantMargin(t({ windowDays: 15, minutesUsed: 50 })).revenueCents).toBe(4950);
  });
  it("alert key is stable within a month", () => {
    expect(marginAlertKey("a", "2026-11-03T00:00:00Z")).toBe(marginAlertKey("a", "2026-11-28T00:00:00Z"));
  });
});
