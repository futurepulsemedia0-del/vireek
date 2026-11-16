import { describe, expect, it } from "vitest";
import { isEligibleForPriceNotice, type NoticeProfile } from "./eligibility";

const scope = { planId: "starter", noticeCreatedAt: "2026-06-01T00:00:00Z" };
const p = (o: Partial<NoticeProfile> = {}): NoticeProfile => ({
  id: "u1", email: "a@b.co", plan: "starter", status: "active", subscription_status: "active", created_at: "2025-01-01T00:00:00Z", ...o,
});

describe("price-change eligibility", () => {
  it("affected account is eligible", () => expect(isEligibleForPriceNotice(p(), scope, new Set(), false)).toBe(true));
  it("grandfathered accounts get none", () => expect(isEligibleForPriceNotice(p(), scope, new Set(["u1"]), false)).toBe(false));
  it("other plans get none", () => expect(isEligibleForPriceNotice(p({ plan: "business" }), scope, new Set(), false)).toBe(false));
  it("canceled / suspended / canceling accounts get none", () => {
    expect(isEligibleForPriceNotice(p({ subscription_status: "canceled" }), scope, new Set(), false)).toBe(false);
    expect(isEligibleForPriceNotice(p({ status: "suspended" }), scope, new Set(), false)).toBe(false);
    expect(isEligibleForPriceNotice(p(), scope, new Set(), true)).toBe(false);
  });
  it("accounts created after the announcement and accounts without email get none", () => {
    expect(isEligibleForPriceNotice(p({ created_at: "2026-07-01T00:00:00Z" }), scope, new Set(), false)).toBe(false);
    expect(isEligibleForPriceNotice(p({ email: null }), scope, new Set(), false)).toBe(false);
  });
});
