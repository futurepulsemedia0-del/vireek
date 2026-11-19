import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "../../i18n/languages";
import { CATALOG } from "../../i18n/templates";
import { PURCHASABLE_PLANS } from "../planCatalog";
import { composeCancellationScheduled, composeFraudNotice, composePaymentSuspended, composePriceChange, composeRenewal, composeSubscriptionStarted } from "./compose";

const site = "https://vireek.com";
const starter = PURCHASABLE_PLANS.find((p) => p.id === "starter")!;

describe("billing notice templates", () => {
  const keys = Object.keys(CATALOG).filter((k) => k.startsWith("billing."));
  it("has all 14 keys translated in every language", () => {
    expect(keys).toHaveLength(14);
    for (const k of keys) for (const l of SUPPORTED_LANGUAGES) expect((CATALOG as Record<string, Record<string, string>>)[k][l]).toBeTruthy();
  });
});

describe("renewal notice", () => {
  const d = { name: "Sam", planId: "starter", renewalYmd: "2026-12-01", amountCents: 79000, currency: "usd", siteUrl: site };
  it("shows plan, date, charge and included minutes from constants", () => {
    const n = composeRenewal("en", d);
    expect(n.subject).toBe("Your Vireek Starter plan renews on December 1, 2026");
    expect(n.text).toContain("$790.00");
    expect(n.text).toContain(`${starter.minutesIncluded} minutes per month`);
    expect(n.html).toContain("/dashboard/billing");
  });
  it("renders in the account language with RTL markup", () => {
    expect(composeRenewal("fa", d).html).toContain('dir="rtl"');
    expect(composeRenewal("de", d).subject).toContain("Starter");
  });
  it("refuses plans without an included-minutes constant instead of inventing a number", () => {
    expect(() => composeRenewal("en", { ...d, planId: "enterprise" })).toThrow();
  });
  it("escapes hostile names in HTML", () => {
    expect(composeRenewal("en", { ...d, name: "<script>x</script>" }).html).not.toContain("<script>");
  });
});

describe("price change notice", () => {
  const d = { name: "Sam", planId: "starter", effectiveDate: "2026-09-01", oldPriceCents: 7900, newPriceCents: 8900, oldMinutes: starter.minutesIncluded, newMinutes: 300, currency: "usd", siteUrl: site };
  it("states exact old/new numbers", () => {
    const n = composePriceChange("en", d);
    expect(n.text).toContain("$79.00");
    expect(n.text).toContain("$89.00");
    expect(n.text).toContain(`from ${starter.minutesIncluded} to 300`);
    expect(n.text).toContain("September 1, 2026");
  });
  it("price-only notice omits the minutes sentence", () => {
    expect(composePriceChange("en", { ...d, oldMinutes: null, newMinutes: null }).text).not.toContain("included minutes");
  });
  it("rejects a notice that changes nothing for the customer", () => {
    expect(() => composePriceChange("en", { ...d, newPriceCents: 7900, newMinutes: null })).toThrow();
  });
});

describe("suspension notices", () => {
  it("payment: cure steps, support address, SMS with update link", () => {
    const n = composePaymentSuspended("en", { name: "Sam", supportEmail: "help@x.co", siteUrl: site });
    expect(n.text).toContain("update your payment method");
    expect(n.text).toContain("help@x.co");
    expect(n.sms).toContain("/dashboard/billing/update-payment");
  });
  it("fraud: neutral, no detection details, tells the owner how to reach a person", () => {
    const n = composeFraudNotice("en", { name: "Sam", status: "suspended", supportEmail: "help@x.co", siteUrl: site });
    expect(n.text).toContain("help@x.co");
    expect(n.text).not.toMatch(/fraud|suspicious|signal|score|detected|unusual/i);
    expect(composeFraudNotice("en", { name: "Sam", status: "throttled", supportEmail: "a@b.co", siteUrl: site }).subject).toContain("temporarily limited");
  });
});
