import { describe, expect, it } from "vitest";
import { compareFigures, computeFee, csvCell, parsePilotResults, renderPilotBlock, resultsToCsv, type PilotFigures } from "./engine.ts";

const fig = (o: Partial<PilotFigures> = {}): PilotFigures => ({
  unclaimed_warranty_cents: 100000, unclaimed_warranty_jobs: 4, claims_filed_6m: 2, claims_paid_6m: 1, claims_paid_cents_6m: 50000,
  overdue60_cents: 900000, overdue60_count: 6, avg_days_to_pay_commercial: 48.5, avg_days_sample: 9, ...o,
});
const row = (o: Record<string, unknown> = {}) => ({
  kind: "invoice", ref_id: "r1", ref_label: "INV-0001", amount_cents: 20000, recovered_on: "2027-01-10",
  action_kind: "reminder", action_on: "2027-01-05", counted: true, reason: null, ...o,
});
const raw = (o: Record<string, unknown> = {}) => ({
  started: true, started_at: "2027-01-01T00:00:00Z", generated_at: "2027-01-15T00:00:00Z", fee_pct: 10,
  baseline: fig(), now: fig({ overdue60_cents: 400000, overdue60_count: 2, avg_days_to_pay_commercial: 40, claims_paid_6m: 3 }),
  estimate_fields: ["unclaimed_warranty_cents"],
  recovered: { counted_cents: 20000, counted_count: 1, not_counted_cents: 5000, not_counted_count: 1, rows: [row(), row({ ref_id: "r2", amount_cents: 5000, action_kind: null, action_on: null, counted: false, reason: "no_preceding_action" })] },
  hours_minutes: 90, claims_by_status: { submitted: { count: 2, cents: 1000 } }, invoices_by_status: { paid: { count: 3, cents: 5000 } }, ...o,
});

describe("baseline vs now math", () => {
  it("marks improvements and regressions per metric direction", () => {
    const rows = compareFigures(fig(), fig({ overdue60_cents: 400000, claims_paid_6m: 3, claims_filed_6m: 1 }));
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.overdue60_cents.delta).toBe(-500000);
    expect(by.overdue60_cents.trend).toBe("better");
    expect(by.claims_paid_6m.trend).toBe("better");
    expect(by.claims_filed_6m.trend).toBe("worse");
    expect(by.unclaimed_warranty_cents.trend).toBe("same");
  });
  it("never turns missing data into 0", () => {
    const r = compareFigures(fig({ avg_days_to_pay_commercial: null }), fig()).find((x) => x.key === "avg_days_to_pay_commercial")!;
    expect(r.delta).toBeNull();
    expect(r.trend).toBe("no_data");
  });
  it("labels estimate fields", () => {
    const rows = compareFigures(fig(), fig(), ["unclaimed_warranty_cents"]);
    expect(rows[0].estimate).toBe(true);
    expect(rows[1].estimate).toBe(false);
  });
});

describe("attribution rules in the payload parser", () => {
  it("parses a started pilot", () => {
    const p = parsePilotResults(raw())!;
    expect(p.recovered.counted_cents).toBe(20000);
    expect(p.recovered.rows).toHaveLength(2);
  });
  it("returns null when the pilot has not started or payload is junk", () => {
    expect(parsePilotResults({ started: false })).toBeNull();
    expect(parsePilotResults(null)).toBeNull();
  });
  it("a row without a preceding action is never counted, even if the payload says so", () => {
    const p = parsePilotResults(raw({ recovered: { counted_cents: 0, counted_count: 0, not_counted_cents: 0, not_counted_count: 0, rows: [row({ action_kind: null, counted: true })] } }))!;
    expect(p.recovered.rows[0].counted).toBe(false);
    expect(p.recovered.counted_cents).toBe(0);
  });
  it("rejects unknown action kinds and row kinds", () => {
    const p = parsePilotResults(raw({ recovered: { rows: [row({ action_kind: "magic" }), row({ kind: "other" })] } }))!;
    expect(p.recovered.rows).toHaveLength(1);
    expect(p.recovered.rows[0].counted).toBe(false);
  });
  it("ignores an out-of-range fee", () => {
    expect(parsePilotResults(raw({ fee_pct: 150 }))!.fee_pct).toBeNull();
  });
});

describe("fee helper (display only)", () => {
  it("is integer-exact", () => {
    expect(computeFee(123456, 7.25)).toBe(8951);
    expect(computeFee(100000, 10)).toBe(10000);
    expect(computeFee(0, 10)).toBe(0);
  });
  it("is null without a valid percentage", () => {
    expect(computeFee(100000, null)).toBeNull();
    expect(computeFee(100000, -1)).toBeNull();
    expect(computeFee(100000, 101)).toBeNull();
  });
});

describe("CSV export", () => {
  it("neutralizes formula injection and quotes commas", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });
  it("contains counted and not-counted rows plus display-only fee", () => {
    const csv = resultsToCsv(parsePilotResults(raw())!);
    expect(csv).toContain("not counted: no preceding action");
    expect(csv).toContain("not charged automatically");
    expect(csv).toContain("estimate");
  });
});

describe("email block", () => {
  it("escapes HTML from database text and states the fee is never charged", () => {
    const p = parsePilotResults(raw({ recovered: { rows: [row({ ref_label: "<img src=x>" })] } }))!;
    const { html, text } = renderPilotBlock(p, "USD", "https://app.vireek.com/dashboard/pilot-results");
    expect(html).not.toContain("<img");
    expect(text).toContain("never charged automatically");
    expect(text).toContain("(estimate)");
  });
});
