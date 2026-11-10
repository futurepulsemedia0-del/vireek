import { describe, expect, it } from "vitest";
import {
  addMonths, buildLedger, computeActivation, computeAttachRates, computeCacPayback, computeCohortTable,
  computeRetention, computeTakeRate, monthBounds, type MrrPoint,
} from "./founderKpis.ts";

const P = (accountId: string, at: string, mrrCents: number): MrrPoint => ({ accountId, at, mrrCents });
const MAR = monthBounds("2028-03");

// Fixture: period = March 2028.
//  a  starts Jan @7900, upgrades Mar 10 -> 19900                 (expansion +12000)
//  b  starts Jan @39900, downgrades Mar 20 -> 19900               (contraction -20000)
//  c  starts Feb @7900, churns Mar 5                               (churn -7900)
//  d  starts Jan @19900, no change                                 (flat)
//  e  NEW Mar 3 @7900                                              (new)
//  f  NEW Mar 4 @7900 and churns Mar 20                            (intra-period churn: invisible)
//  g  churned Jan, reactivates Mar 8 @19900                        (reactivation = new MRR)
//  h  upgrade then downgrade back inside March (net zero)          (flat)
const FIX: MrrPoint[] = [
  P("a", "2028-01-05T00:00:00Z", 7900), P("a", "2028-03-10T00:00:00Z", 19900),
  P("b", "2028-01-06T00:00:00Z", 39900), P("b", "2028-03-20T00:00:00Z", 19900),
  P("c", "2028-02-02T00:00:00Z", 7900), P("c", "2028-03-05T00:00:00Z", 0),
  P("d", "2028-01-09T00:00:00Z", 19900),
  P("e", "2028-03-03T00:00:00Z", 7900),
  P("f", "2028-03-04T00:00:00Z", 7900), P("f", "2028-03-20T00:00:00Z", 0),
  P("g", "2028-01-01T00:00:00Z", 7900), P("g", "2028-01-20T00:00:00Z", 0), P("g", "2028-03-08T00:00:00Z", 19900),
  P("h", "2028-01-10T00:00:00Z", 19900), P("h", "2028-03-11T00:00:00Z", 39900), P("h", "2028-03-25T00:00:00Z", 19900),
];

describe("buildLedger", () => {
  it("drops invalid rows and counts them", () => {
    const { stats } = buildLedger([
      P("a", "2028-01-01T00:00:00Z", 100), P("", "2028-01-01T00:00:00Z", 100), P("b", "nope", 100),
      P("c", "2028-01-01T00:00:00Z", -5), P("d", "2028-01-01T00:00:00Z", 1.5),
    ]);
    expect(stats).toEqual({ accepted: 1, rejected: 4 });
  });
  it("sorts out-of-order input", () => {
    const { ledger } = buildLedger([P("a", "2028-03-01T00:00:00Z", 0), P("a", "2028-01-01T00:00:00Z", 500)]);
    const r = computeRetention(ledger, "2028-02-01T00:00:00Z", "2028-04-01T00:00:00Z");
    expect(r.churnedCents).toBe(500);
  });
});

describe("computeRetention (March 2028)", () => {
  const { ledger } = buildLedger(FIX);
  const r = computeRetention(ledger, MAR.start, MAR.end);
  it("cohort = accounts with MRR at start (a,b,c,d,h; g was churned, e/f new)", () => {
    expect(r.cohortAccounts).toBe(5);
    expect(r.startMrrCents).toBe(19900 - 12000 + 39900 + 7900 + 19900 + 19900 - 0); // a7900 + b39900 + c7900 + d19900 + h19900
    expect(r.startMrrCents).toBe(95500);
  });
  it("splits churn / contraction / expansion", () => {
    expect(r.churnedCents).toBe(7900);
    expect(r.churnedAccounts).toBe(1);
    expect(r.contractionCents).toBe(20000);
    expect(r.expansionCents).toBe(12000);
  });
  it("GRR and NRR in basis points", () => {
    // retained gross = 7900(a) + 19900(b) + 0(c) + 19900(d) + 19900(h) = 67600
    expect(r.retainedGrossCents).toBe(67600);
    expect(r.grrBp).toBe(Math.round((67600 * 10000) / 95500));
    // end of cohort = 19900 + 19900 + 0 + 19900 + 19900 = 79600
    expect(r.endMrrFromCohortCents).toBe(79600);
    expect(r.nrrBp).toBe(Math.round((79600 * 10000) / 95500));
  });
  it("new MRR counts new logos and reactivations, never intra-period churn", () => {
    expect(r.newAccounts).toBe(2); // e + g
    expect(r.newMrrCents).toBe(7900 + 19900);
    expect(r.reactivationAccounts).toBe(1);
    expect(r.intraPeriodChurnAccounts).toBe(1); // f
  });
  it("bridge: start + new + expansion - contraction - churn = closing", () => {
    expect(r.startMrrCents + r.newMrrCents + r.expansionCents - r.contractionCents - r.churnedCents).toBe(r.closingMrrCents);
  });
  it("GRR never exceeds 100% even with heavy expansion", () => {
    const l = buildLedger([P("x", "2028-01-01T00:00:00Z", 100), P("x", "2028-03-02T00:00:00Z", 100000)]).ledger;
    expect(computeRetention(l, MAR.start, MAR.end).grrBp).toBe(10000);
    expect(computeRetention(l, MAR.start, MAR.end).nrrBp).toBe(10_000_000); // 100 -> 100000 cents = 1000x = 100000%
  });
  it("event exactly at period start belongs to the period (boundary rule)", () => {
    const l = buildLedger([P("x", "2028-01-01T00:00:00Z", 100), P("x", MAR.start, 0)]).ledger;
    expect(computeRetention(l, MAR.start, MAR.end).churnedCents).toBe(100);
    // ... and is NOT double counted in February
    const feb = monthBounds("2028-02");
    expect(computeRetention(l, feb.start, feb.end).churnedCents).toBe(0);
  });
  it("empty cohort -> null rates, not zero", () => {
    const e = computeRetention(buildLedger([]).ledger, MAR.start, MAR.end);
    expect(e.grrBp).toBeNull();
    expect(e.nrrBp).toBeNull();
  });
  it("rejects an inverted period", () => {
    expect(() => computeRetention(new Map(), MAR.end, MAR.start)).toThrow();
  });
});

describe("computeCohortTable", () => {
  const { ledger } = buildLedger([
    P("a", "2028-01-05T00:00:00Z", 10000), P("a", "2028-02-10T00:00:00Z", 15000),
    P("b", "2028-01-06T00:00:00Z", 10000), P("b", "2028-03-02T00:00:00Z", 0),
    P("z", "2028-01-07T00:00:00Z", 5000), P("z", "2028-01-20T00:00:00Z", 0), // churn within cohort month
  ]);
  const rows = computeCohortTable(ledger, "2028-01", "2028-01", 3, "2028-04-15T00:00:00Z");
  it("drops accounts that churned inside the cohort month", () => {
    expect(rows[0].accounts).toBe(2);
    expect(rows[0].initialMrrCents).toBe(20000);
  });
  it("computes net and logo retention per offset; future months are null", () => {
    const c = rows[0].cells;
    expect(c[0].nrrBp).toBe(10000);
    expect(c[1]).toMatchObject({ netMrrCents: 25000, nrrBp: 12500, activeAccounts: 2, logoRetentionBp: 10000 });
    expect(c[2]).toMatchObject({ netMrrCents: 15000, nrrBp: 7500, activeAccounts: 1, logoRetentionBp: 5000 });
    expect(c[3].nrrBp).toBeNull(); // end of April (Apr 30) is after asOf (Apr 15): month not complete yet
  });
});

describe("computeActivation", () => {
  const rows = [
    { accountId: "1", createdAt: "2028-03-01T00:00:00Z", activatedAt: "2028-03-05T00:00:00Z" },
    { accountId: "2", createdAt: "2028-03-02T00:00:00Z", activatedAt: "2028-03-30T00:00:00Z" }, // too late
    { accountId: "3", createdAt: "2028-03-03T00:00:00Z", activatedAt: null },
    { accountId: "4", createdAt: "2028-03-28T00:00:00Z", activatedAt: null }, // immature at asOf
  ];
  it("uses only mature signups in the denominator", () => {
    const r = computeActivation(rows, 14, "2028-04-05T00:00:00Z", "2028-03-01T00:00:00Z", "2028-04-01T00:00:00Z");
    expect(r).toEqual({ signups: 4, matured: 3, immature: 1, activated: 1, rateBp: 3333 });
  });
  it("null rate when nobody is mature", () => {
    const r = computeActivation(rows, 14, "2028-03-04T00:00:00Z", "2028-03-01T00:00:00Z", "2028-04-01T00:00:00Z");
    expect(r.rateBp).toBeNull();
  });
  it("validates the window", () => {
    expect(() => computeActivation([], 0, "2028-04-05T00:00:00Z", "2028-03-01T00:00:00Z", "2028-04-01T00:00:00Z")).toThrow();
  });
});

describe("computeAttachRates", () => {
  it("counts only paying accounts, once each", () => {
    const r = computeAttachRates(["a", "b", "c", "d"], [
      { accountId: "a", moduleKey: "quotes" }, { accountId: "a", moduleKey: "quotes" },
      { accountId: "b", moduleKey: "quotes" }, { accountId: "free1", moduleKey: "quotes" },
      { accountId: "c", moduleKey: "timesheets" },
    ], ["quotes", "timesheets", "unused"]);
    expect(r).toEqual([
      { moduleKey: "quotes", attachedAccounts: 2, payingAccounts: 4, rateBp: 5000 },
      { moduleKey: "timesheets", attachedAccounts: 1, payingAccounts: 4, rateBp: 2500 },
      { moduleKey: "unused", attachedAccounts: 0, payingAccounts: 4, rateBp: 0 },
    ]);
  });
  it("null when there are no paying accounts", () => {
    expect(computeAttachRates([], [], ["quotes"])[0].rateBp).toBeNull();
  });
});

describe("computeTakeRate", () => {
  it("fee / volume in bp", () => expect(computeTakeRate(1_000_000, 29_000).takeRateBp).toBe(290));
  it("null with no volume", () => expect(computeTakeRate(0, 0).takeRateBp).toBeNull());
  it("rejects negative fees", () => expect(() => computeTakeRate(100, -1)).toThrow());
});

describe("computeCacPayback", () => {
  it("CAC and payback months", () => {
    // spend 10,000.00 over 10 customers => CAC 1,000.00; avg MRR 200.00 at 80% margin => 160/mo => 6.25 months
    expect(computeCacPayback({ spendCents: 1_000_000, newCustomers: 10, newMrrCents: 200_000, grossMarginBp: 8000 }))
      .toEqual({ cacCents: 100_000, avgNewMrrCents: 20_000, paybackMonths: 6.25 });
  });
  it("null when no new customers or no margin", () => {
    expect(computeCacPayback({ spendCents: 1, newCustomers: 0, newMrrCents: 0, grossMarginBp: 8000 }).paybackMonths).toBeNull();
    expect(computeCacPayback({ spendCents: 1, newCustomers: 1, newMrrCents: 100, grossMarginBp: 0 }).paybackMonths).toBeNull();
  });
  it("rejects impossible margin", () => {
    expect(() => computeCacPayback({ spendCents: 1, newCustomers: 1, newMrrCents: 1, grossMarginBp: 10001 })).toThrow();
  });
});

describe("month helpers", () => {
  it("addMonths crosses year boundaries", () => {
    expect(addMonths("2028-11", 3)).toBe("2029-02");
    expect(addMonths("2028-01", -1)).toBe("2027-12");
  });
});

describe("activeAccountIds", () => {
  it("lists accounts with MRR > 0 at the instant (strictly-before rule)", async () => {
    const { activeAccountIds } = await import("./founderKpis.ts");
    const { ledger } = buildLedger([P("a", "2028-01-01T00:00:00Z", 100), P("b", "2028-02-01T00:00:00Z", 100), P("b", "2028-03-01T00:00:00Z", 0)]);
    expect(activeAccountIds(ledger, "2028-03-01T00:00:00Z").sort()).toEqual(["a", "b"]); // b's churn is AT the boundary
    expect(activeAccountIds(ledger, "2028-03-01T00:00:01Z")).toEqual(["a"]);
    expect(() => activeAccountIds(ledger, "x")).toThrow();
  });
});
