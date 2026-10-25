import { describe, expect, it } from "vitest";
import { computeFeeCents } from "./money.ts";
import { accruedGrossCents, computeEwaAvailability, ewaInputsFromRpc, quoteInstantPayout, validateAdvanceRequest, type EwaInputs, type EwaPolicy } from "./ewaEngine.ts";
import { evaluateCardAuthorization, validateCardLimits, type CardPolicy } from "./cardPolicy.ts";
import {
  DEFAULT_PRESCREEN_CONFIG, offerIsDisclosable, prescreenCapital, resolvePrescreenConfig, selectEligibleReceivables,
  type OpenReceivable, type RevenueProfile,
} from "./capitalEngine.ts";
import { sandboxLendingPartner, sandboxPayoutProvider } from "./providers/sandbox.ts";
import { getCardIssuer, getLendingPartner, getPayoutProvider } from "./registry.ts";
import { ProviderBoundaryError } from "./types.ts";

const policy: EwaPolicy = { feeBps: 0, minFeeCents: 299, maxFeeCents: 299, maxPctOfAccrued: 50, maxSingleCents: 50_000, maxDailyTenantCents: 250_000 };
const hourly: EwaInputs = {
  active: true, payType: "hourly", hourlyRateCents: 3000, annualSalaryCents: 0, overtimeMultiplier: 1.5, payScheduleDays: 14, elapsedDays: 7,
  withholdingPct: 20, approvedRegularHours: 40, approvedOvertimeHours: 0, approvedCommissionCents: 0, outstandingAdvanceCents: 0, tenantTransferredTodayCents: 0,
};

describe("computeFeeCents", () => {
  it("clamps to min and max", () => {
    expect(computeFeeCents(10_000, { feeBps: 100, minFeeCents: 50, maxFeeCents: 1000 })).toBe(100);
    expect(computeFeeCents(1_000, { feeBps: 100, minFeeCents: 50, maxFeeCents: 1000 })).toBe(50);
    expect(computeFeeCents(10_000_000, { feeBps: 100, minFeeCents: 50, maxFeeCents: 1000 })).toBe(1000);
  });
  it("flat fee and zero/invalid amounts", () => {
    expect(computeFeeCents(20_000, { feeBps: 0, minFeeCents: 299, maxFeeCents: 299 })).toBe(299);
    expect(computeFeeCents(0, { feeBps: 100, minFeeCents: 50, maxFeeCents: 1000 })).toBe(0);
    expect(computeFeeCents(-5, { feeBps: 100, minFeeCents: 50, maxFeeCents: 1000 })).toBe(0);
  });
});

describe("EWA availability", () => {
  it("hourly: 40h × $30 = $1,200 gross → $960 net → 50% = $480 ceiling", () => {
    const a = computeEwaAvailability(hourly, policy);
    expect(a.accruedGrossCents).toBe(120_000);
    expect(a.accruedNetEstimateCents).toBe(96_000);
    expect(a.ceilingCents).toBe(48_000);
    expect(a.availableCents).toBe(48_000);
  });
  it("outstanding advances reduce availability", () => {
    expect(computeEwaAvailability({ ...hourly, outstandingAdvanceCents: 30_000 }, policy).availableCents).toBe(18_000);
  });
  it("caps at the single-request maximum and the tenant daily cap", () => {
    expect(computeEwaAvailability({ ...hourly, approvedRegularHours: 200 }, policy).availableCents).toBe(50_000);
    const a = computeEwaAvailability({ ...hourly, tenantTransferredTodayCents: 249_000 }, policy);
    expect(a.availableCents).toBe(0);
    expect(a.reasons).toContain("below_minimum");
  });
  it("overtime uses the multiplier; commission counts; pending is never passed in", () => {
    expect(accruedGrossCents({ ...hourly, approvedRegularHours: 0, approvedOvertimeHours: 10 })).toBe(45_000);
    expect(accruedGrossCents({ ...hourly, payType: "commission_only", approvedRegularHours: 0, approvedCommissionCents: 77_700 })).toBe(77_700);
  });
  it("salary accrues pro rata and never more than one period", () => {
    const s: EwaInputs = { ...hourly, payType: "salary", annualSalaryCents: 52_000_00, approvedRegularHours: 0, elapsedDays: 7 };
    expect(accruedGrossCents(s)).toBe(100_000);                      // 5,200,000/26 = 200,000 per period × 7/14
    expect(accruedGrossCents({ ...s, elapsedDays: 99 })).toBe(200_000);
  });
  it("fails closed: inactive, invalid, nothing accrued, under minimum", () => {
    expect(computeEwaAvailability({ ...hourly, active: false }, policy).availableCents).toBe(0);
    expect(computeEwaAvailability({ ...hourly, hourlyRateCents: NaN }, policy).reasons).toContain("invalid_input");
    expect(computeEwaAvailability({ ...hourly, approvedRegularHours: 0 }, policy).reasons).toContain("nothing_accrued");
    expect(computeEwaAvailability({ ...hourly, approvedRegularHours: 1 }, policy).availableCents).toBe(0); // $30 gross → $12 ceiling < $20 min
  });
  it("never exceeds the ceiling even with absurd policy values", () => {
    const a = computeEwaAvailability(hourly, { ...policy, maxPctOfAccrued: 500, maxSingleCents: 9e12, maxDailyTenantCents: 9e12 });
    expect(a.availableCents).toBeLessThanOrEqual(a.accruedNetEstimateCents);
  });
});

describe("advance + instant payout validation", () => {
  it("quotes an exact fee and what the technician receives / repays", () => {
    expect(validateAdvanceRequest(10_000, 48_000, policy)).toEqual({ ok: true, amountCents: 10_000, feeCents: 299, receiveCents: 9_701, repayCents: 10_000 });
  });
  it("rejects bad, over-limit, below-minimum and fee-swallowed amounts", () => {
    expect(validateAdvanceRequest(-1, 48_000, policy)).toEqual({ ok: false, code: "invalid_amount" });
    expect(validateAdvanceRequest(1.5, 48_000, policy)).toEqual({ ok: false, code: "invalid_amount" });
    expect(validateAdvanceRequest("100", 48_000, policy)).toEqual({ ok: false, code: "invalid_amount" });
    expect(validateAdvanceRequest(48_001, 48_000, policy)).toEqual({ ok: false, code: "exceeds_available" });
    expect(validateAdvanceRequest(1_999, 48_000, policy)).toEqual({ ok: false, code: "below_minimum" });
    expect(validateAdvanceRequest(2_000, 48_000, { ...policy, minFeeCents: 2_500, maxFeeCents: 2_500 })).toEqual({ ok: false, code: "fee_exceeds_amount" });
  });
  it("instant payout is all-or-nothing with nothing to repay", () => {
    const p = { ...policy, feeBps: 100, minFeeCents: 50, maxFeeCents: 1000, maxSingleCents: 500_000 };
    expect(quoteInstantPayout(120_000, p)).toEqual({ ok: true, amountCents: 120_000, feeCents: 1000, receiveCents: 119_000, repayCents: 0 });
    expect(quoteInstantPayout(600_000, p)).toEqual({ ok: false, code: "exceeds_available" });
  });
  it("maps RPC payloads defensively", () => {
    const i = ewaInputsFromRpc({ active: true, pay_type: "hourly", hourly_rate_cents: "3000", period_days: 14 });
    expect(i.hourlyRateCents).toBe(3000);
    expect(i.overtimeMultiplier).toBe(1.5);
  });
});

const card: CardPolicy = { status: "active", perTxnLimitCents: 50_000, dailyLimitCents: 100_000, monthlyLimitCents: 300_000, allowedMcc: null, blockedMcc: ["7995"], receiptRequiredOverCents: 2_500 };
const spent = { todayCents: 0, monthCents: 0 };
const auth = (over = {}) => ({ amountCents: 10_000, currency: "usd", mcc: "5251", ...over });

describe("card authorization policy", () => {
  it("approves a normal purchase and flags receipts above the threshold", () => {
    expect(evaluateCardAuthorization(card, auth(), spent, 1_000_000)).toEqual({ approved: true, receiptRequired: true });
    expect(evaluateCardAuthorization(card, auth({ amountCents: 2_000 }), spent, 1_000_000)).toEqual({ approved: true, receiptRequired: false });
  });
  it.each([
    ["frozen card", { ...card, status: "frozen" as const }, auth(), spent, "card_not_active"],
    ["zero amount", card, auth({ amountCents: 0 }), spent, "invalid_amount"],
    ["non-USD", card, auth({ currency: "eur" }), spent, "unsupported_currency"],
    ["blocked mcc", card, auth({ mcc: "7995" }), spent, "mcc_blocked"],
    ["per-txn", card, auth({ amountCents: 50_001 }), spent, "per_transaction_limit"],
    ["daily", card, auth({ amountCents: 20_000 }), { todayCents: 90_000, monthCents: 90_000 }, "daily_limit"],
    ["monthly", card, auth({ amountCents: 20_000 }), { todayCents: 0, monthCents: 290_000 }, "monthly_limit"],
    ["platform cap", card, auth({ amountCents: 20_000 }), spent, "platform_cap_exceeded"],
  ])("declines: %s", (_n, c, a, s, code) => {
    const cap = code === "platform_cap_exceeded" ? 10_000 : 1_000_000;
    expect(evaluateCardAuthorization(c, a, s, cap)).toEqual({ approved: false, declineCode: code });
  });
  it("allow-list: unknown or unlisted mcc declines", () => {
    const c = { ...card, allowedMcc: ["5251", "5072"] };
    expect(evaluateCardAuthorization(c, auth({ mcc: "5411" }), spent, 1e6)).toEqual({ approved: false, declineCode: "mcc_not_allowed" });
    expect(evaluateCardAuthorization(c, auth({ mcc: null }), spent, 1e6)).toEqual({ approved: false, declineCode: "mcc_unknown" });
    expect(evaluateCardAuthorization(c, auth({ mcc: "5072" }), spent, 1e6).approved).toBe(true);
  });
  it("validates limits", () => {
    const ok = { perTxnLimitCents: 50_000, dailyLimitCents: 100_000, monthlyLimitCents: 300_000 };
    expect(validateCardLimits(ok, 1_000_000)).toBeNull();
    expect(validateCardLimits({ ...ok, dailyLimitCents: 10 }, 1_000_000)).toBe("limits_not_ascending");
    expect(validateCardLimits({ ...ok, perTxnLimitCents: 2_000_000, dailyLimitCents: 3_000_000, monthlyLimitCents: 4_000_000 }, 1_000_000)).toBe("per_txn_above_platform_cap");
    expect(validateCardLimits({ ...ok, allowedMcc: ["12"] }, 1_000_000)).toBe("invalid_mcc");
    expect(validateCardLimits({ ...ok, perTxnLimitCents: 1.5 }, 1_000_000)).toBe("limits_must_be_positive_integers");
  });
});

const NOW = new Date("2027-03-01T00:00:00Z");
const recv = (id: string, cust: string, cents: number, daysAgo = 10, over: Partial<OpenReceivable> = {}): OpenReceivable => ({
  invoiceId: id, customerRef: cust, amountCents: cents, dueDate: null, issuedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), alreadyPledged: false, ...over,
});
const healthy: RevenueProfile = {
  monthsOfHistory: 14, trailing12mCents: 12_000_000, trailing3mCents: 3_000_000, monthlyCents: [], paidInvoiceCount12m: 80, avgDaysToPay: 12, onTimeRate: 0.9,
  topCustomerSharePct: 10, lostDisputes12m: 0, openDisputes: 0,
  openReceivables: [recv("a", "c1", 300_000), recv("b", "c2", 250_000), recv("c", "c3", 200_000), recv("d", "c4", 100_000)],
};

describe("capital pre-screen", () => {
  it("healthy business is eligible to APPLY (never 'approved')", () => {
    const r = prescreenCapital(healthy, DEFAULT_PRESCREEN_CONFIG, NOW);
    expect(r.outcome).toBe("eligible_to_apply");
    expect(r.reasons).toEqual([]);
    expect(r.eligibleReceivablesCents).toBe(850_000);
    expect(r.notice).toMatch(/not an offer, approval or credit decision/);
    expect(Object.keys(r).join(",")).not.toMatch(/approv|offer|apr|rate/i);
  });
  it("returns specific reason codes", () => {
    const r = prescreenCapital({ ...healthy, monthsOfHistory: 3, trailing12mCents: 100, paidInvoiceCount12m: 2, lostDisputes12m: 5, openDisputes: 9, openReceivables: [] }, DEFAULT_PRESCREEN_CONFIG, NOW);
    expect(r.outcome).toBe("not_yet_eligible");
    expect(r.reasons).toEqual(expect.arrayContaining(["insufficient_history", "insufficient_revenue", "insufficient_paid_invoices", "lost_disputes", "open_disputes", "no_eligible_receivables"]));
  });
  it("flags a recent revenue decline", () => {
    expect(prescreenCapital({ ...healthy, trailing3mCents: 100_000 }, DEFAULT_PRESCREEN_CONFIG, NOW).reasons).toContain("recent_revenue_decline");
  });
  it("small eligible pool is not enough", () => {
    const r = prescreenCapital({ ...healthy, openReceivables: [recv("a", "c1", 100_000), recv("b", "c2", 100_000), recv("c", "c3", 100_000)] }, DEFAULT_PRESCREEN_CONFIG, NOW);
    expect(r.reasons).toEqual(["eligible_receivables_too_small"]);
  });
  it("excludes pledged, tiny, old and invalid receivables", () => {
    const { eligible, excluded } = selectEligibleReceivables([
      recv("p", "c1", 300_000, 5, { alreadyPledged: true }), recv("t", "c2", 1_000), recv("o", "c3", 300_000, 200),
      recv("x", "c4", -5), recv("ok1", "c5", 300_000), recv("ok2", "c6", 300_000), recv("ok3", "c7", 300_000),
    ], DEFAULT_PRESCREEN_CONFIG, NOW);
    expect(eligible.map((r) => r.invoiceId).sort()).toEqual(["ok1", "ok2", "ok3"]);
    expect(excluded.map((e) => e.why).sort()).toEqual(["invalid", "pledged", "too_old", "too_small"]);
  });
  it("caps customer concentration and refuses a single-customer pool", () => {
    const { eligible } = selectEligibleReceivables([recv("a1", "big", 500_000), recv("a2", "big", 500_000), recv("b", "s1", 300_000), recv("c", "s2", 300_000), recv("d", "s3", 300_000), recv("e", "s4", 300_000)], DEFAULT_PRESCREEN_CONFIG, NOW);
    const total = eligible.reduce((s, r) => s + r.amountCents, 0);
    const big = eligible.filter((r) => r.customerRef === "big").reduce((s, r) => s + r.amountCents, 0);
    expect(eligible.length).toBe(5);
    expect((big * 100) / total).toBeLessThanOrEqual(DEFAULT_PRESCREEN_CONFIG.maxCustomerSharePct);
    expect(selectEligibleReceivables([recv("a", "only", 900_000), recv("b", "only", 900_000)], DEFAULT_PRESCREEN_CONFIG, NOW).eligible).toEqual([]);
  });
  it("config overrides ignore junk", () => {
    expect(resolvePrescreenConfig({ minMonthsOfHistory: 12, minPaidInvoices12m: "x", evil: 1 }).minMonthsOfHistory).toBe(12);
    expect(resolvePrescreenConfig({ minPaidInvoices12m: "x" }).minPaidInvoices12m).toBe(DEFAULT_PRESCREEN_CONFIG.minPaidInvoices12m);
    expect(resolvePrescreenConfig(null)).toEqual(DEFAULT_PRESCREEN_CONFIG);
  });
});

describe("offer disclosure gate", () => {
  const good = { externalOfferId: "o1", offeredAmountCents: 100_000, totalRepaymentCents: 112_000, financeChargeCents: 12_000, termDays: 180, estimatedAprBps: 2400, repaymentDescription: "Daily remittance of 0.8% of receipts.", termsUrl: null, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  it("accepts a complete offer", () => expect(offerIsDisclosable(good)).toBe(true));
  it.each([
    ["inconsistent charge", { financeChargeCents: 1 }], ["no term", { termDays: 0 }], ["fractional", { estimatedAprBps: 1.5 }],
    ["no description", { repaymentDescription: " " }], ["expired", { expiresAt: new Date(Date.now() - 1000).toISOString() }], ["no id", { externalOfferId: "" }],
  ])("rejects %s", (_n, over) => expect(offerIsDisclosable({ ...good, ...over })).toBe(false));
});

describe("sandbox adapters + provider boundary", () => {
  it("sandbox payouts are flagged and deterministic", async () => {
    const base = { referenceId: "r1", currency: "usd" as const, destinationAccountId: "a", instant: true, description: "x" };
    expect(await sandboxPayoutProvider.createPayout({ ...base, amountCents: 10_000 })).toMatchObject({ status: "paid", sandbox: true });
    expect(await sandboxPayoutProvider.createPayout({ ...base, amountCents: 10_013 })).toMatchObject({ status: "failed", failureCode: "sandbox_insufficient_funds" });
    expect(await sandboxPayoutProvider.createPayout({ ...base, amountCents: 10_077 })).toMatchObject({ status: "processing" });
  });
  it("sandbox lending is a fixture, labeled, and independent of the applicant's data", async () => {
    const pkg = (r: number, rev: number) => ({ requestedAmountCents: r, business: { trailing12mCents: rev, trailing3mCents: 0, monthsOfHistory: 0, paidInvoiceCount12m: 0 }, receivables: [] });
    const a = await sandboxLendingPartner.submitApplication("x", pkg(1_000_000, 1));
    const b = await sandboxLendingPartner.submitApplication("x", pkg(1_000_000, 999_999_999));
    expect(a.offers[0].totalRepaymentCents).toBe(b.offers[0].totalRepaymentCents);
    expect(a.sandbox).toBe(true);
    expect(a.offers[0].repaymentDescription).toMatch(/SANDBOX FIXTURE/);
    expect(offerIsDisclosable(a.offers[0])).toBe(true);
    expect((await sandboxLendingPartner.submitApplication("x", pkg(131_300, 1))).outcome).toBe("declined");
  });
  it("sandbox webhook is rejected without a configured secret + signature", async () => {
    expect(await sandboxPayoutProvider.verifyWebhookSignature("{}", new Headers())).toBe(false);
  });
  it("LIVE mode with no partner refuses every action and is never silently sandbox", async () => {
    const p = getPayoutProvider("live"), c = getCardIssuer("live"), l = getLendingPartner("live");
    expect([p.isConfigured(), c.isConfigured(), l.isConfigured()]).toEqual([false, false, false]);
    expect(p.mode).toBe("live");
    await expect(p.createPayout({ referenceId: "r", amountCents: 1, currency: "usd", destinationAccountId: "a", instant: true, description: "x" })).rejects.toBeInstanceOf(ProviderBoundaryError);
    await expect(c.issueCard({ referenceId: "r", holderName: "x", cardType: "virtual" })).rejects.toBeInstanceOf(ProviderBoundaryError);
    await expect(l.submitApplication("r", { requestedAmountCents: 1, business: { trailing12mCents: 0, trailing3mCents: 0, monthsOfHistory: 0, paidInvoiceCount12m: 0 }, receivables: [] })).rejects.toBeInstanceOf(ProviderBoundaryError);
    expect(await p.verifyWebhookSignature("{}", new Headers({ "x-sandbox-signature": "aa" }))).toBe(false);
  });
});
