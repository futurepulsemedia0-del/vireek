import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_EVENTS, CUSTOMER_METRICS, bucketForDaysPastDue, bucketStart, capacityMinutes, computeArAging,
  computeCustomerKpis, computeKpiSeries, csvCell, detectAnomaly, sanitizeAnalyticsEvent, seriesToCsv, toCsv,
  weekdayCounts, type RollupRow, type TechCapacity,
} from "./customerKpis.ts";

const row = (o: Partial<RollupRow> & { day: string }): RollupRow => ({
  technicianId: null, jobsCompleted: 0, jobsReworked: 0, reworkJobs: 0, billedJobs: 0, revenueCents: 0, costedJobs: 0,
  costedRevenueCents: 0, costCents: 0, scheduledMinutes: 0, quotesSent: 0, quotesAccepted: 0, ...o,
});

// Week Mon 2028-03-06 .. Sun 2028-03-12. t1 works Mon-Fri, t2 works Mon-Wed.
const TECHS: TechCapacity[] = [{ technicianId: "t1", workingDays: [1, 2, 3, 4, 5] }, { technicianId: "t2", workingDays: [1, 2, 3] }];
const ROWS: RollupRow[] = [
  row({ day: "2028-03-06", technicianId: "t1", jobsCompleted: 4, jobsReworked: 1, billedJobs: 4, revenueCents: 400000, costedJobs: 2, costedRevenueCents: 200000, costCents: 120000, scheduledMinutes: 480 }),
  row({ day: "2028-03-07", technicianId: "t1", jobsCompleted: 2, reworkJobs: 1, billedJobs: 2, revenueCents: 150000, scheduledMinutes: 240 }),
  row({ day: "2028-03-07", technicianId: "t2", jobsCompleted: 3, jobsReworked: 1, billedJobs: 3, revenueCents: 90000, costedJobs: 1, costedRevenueCents: 30000, costCents: 36000, scheduledMinutes: 360 }),
  row({ day: "2028-03-08", technicianId: null, jobsCompleted: 1, billedJobs: 1, revenueCents: 50000, scheduledMinutes: 120 }),
  row({ day: "2028-03-12", technicianId: null, quotesSent: 10, quotesAccepted: 4 }),
  row({ day: "2028-03-05", technicianId: "t1", jobsCompleted: 100, revenueCents: 9_999_999 }), // outside range
];
const OPT = { fromDay: "2028-03-06", toDay: "2028-03-12" };

describe("capacity", () => {
  it("counts weekdays inclusively", () => {
    expect(weekdayCounts("2028-03-06", "2028-03-12")).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(weekdayCounts("2028-03-06", "2028-03-06")[1]).toBe(1);
  });
  it("sums working days x hours", () => {
    expect(capacityMinutes(TECHS, OPT.fromDay, OPT.toDay, 8)).toBe((5 + 3) * 480);
  });
  it("ignores invalid and duplicate weekdays; validates hours and range", () => {
    expect(capacityMinutes([{ technicianId: "x", workingDays: [1, 1, 9, -1] }], OPT.fromDay, OPT.toDay, 8)).toBe(480);
    expect(() => capacityMinutes(TECHS, OPT.fromDay, OPT.toDay, 0)).toThrow();
    expect(() => weekdayCounts("2028-03-12", "2028-03-06")).toThrow();
    expect(() => weekdayCounts("2028-3-1", "2028-03-06")).toThrow();
  });
});

describe("computeCustomerKpis - whole account", () => {
  const k = computeCustomerKpis(ROWS, TECHS, OPT);
  it("ignores rows outside the range", () => {
    expect(k.jobsCompleted).toBe(10);
    expect(k.revenueCents).toBe(690000);
  });
  it("first-time-fix = 100% - reworked/completed", () => expect(k.firstTimeFixRateBp).toBe(8000));
  it("callback rate", () => expect(k.callbackRateBp).toBe(1000));
  it("revenue per technician excludes unassigned jobs", () => {
    expect(k.activeTechnicians).toBe(2);
    expect(k.revenuePerTechnicianCents).toBe(320000);
  });
  it("profitability only uses costed jobs", () => {
    expect(k.grossProfitCents).toBe(74000);
    expect(k.jobProfitabilityBp).toBe(3217);
  });
  it("utilization = tech minutes / capacity (unassigned minutes excluded)", () => {
    expect(k.scheduledMinutes).toBe(1080);
    expect(k.capacityMinutes).toBe(3840);
    expect(k.utilizationBp).toBe(2813);
  });
  it("quote conversion", () => expect(k.quoteConversionBp).toBe(4000));
});

describe("computeCustomerKpis - team filter and edge cases", () => {
  it("filters to selected technicians; quote conversion becomes null", () => {
    const k = computeCustomerKpis(ROWS, TECHS, { ...OPT, teamIds: ["t2"] });
    expect(k.jobsCompleted).toBe(3);
    expect(k.firstTimeFixRateBp).toBe(6667);
    expect(k.callbackRateBp).toBe(0);
    expect(k.revenuePerTechnicianCents).toBe(90000);
    expect(k.jobProfitabilityBp).toBe(-2000); // loss-making jobs are shown, not hidden
    expect(k.capacityMinutes).toBe(3 * 480);
    expect(k.utilizationBp).toBe(2500);
    expect(k.quoteConversionBp).toBeNull();
  });
  it("unknown technician in filter -> nulls, not zeros, not errors", () => {
    const k = computeCustomerKpis(ROWS, TECHS, { ...OPT, teamIds: ["nobody"] });
    expect(k.firstTimeFixRateBp).toBeNull();
    expect(k.revenuePerTechnicianCents).toBeNull();
    expect(k.utilizationBp).toBeNull();
  });
  it("no data at all -> every rate is null", () => {
    const k = computeCustomerKpis([], [], OPT);
    expect([k.firstTimeFixRateBp, k.callbackRateBp, k.jobProfitabilityBp, k.utilizationBp, k.quoteConversionBp, k.grossProfitCents])
      .toEqual([null, null, null, null, null, null]);
  });
  it("ratios are sum/sum, never an average of daily ratios", () => {
    const rows = [
      row({ day: "2028-03-06", technicianId: "t1", jobsCompleted: 1, jobsReworked: 1 }), // 100% reworked day
      row({ day: "2028-03-07", technicianId: "t1", jobsCompleted: 99, jobsReworked: 0 }),
    ];
    expect(computeCustomerKpis(rows, TECHS, OPT).firstTimeFixRateBp).toBe(9900); // average-of-ratios would be 5000
  });
  it("ignores negative / NaN garbage in rows", () => {
    const k = computeCustomerKpis([row({ day: "2028-03-06", technicianId: "t1", jobsCompleted: -5, revenueCents: Number.NaN })], TECHS, OPT);
    expect(k.jobsCompleted).toBe(0);
    expect(k.revenueCents).toBe(0);
  });
  it("rejects an inverted range", () => {
    expect(() => computeCustomerKpis(ROWS, TECHS, { fromDay: "2028-03-12", toDay: "2028-03-06" })).toThrow();
  });
});

describe("series buckets", () => {
  it("bucketStart: Monday weeks and month starts", () => {
    expect(bucketStart("2028-03-12", "week")).toBe("2028-03-06");
    expect(bucketStart("2028-03-06", "week")).toBe("2028-03-06");
    expect(bucketStart("2028-03-19", "month")).toBe("2028-03-01");
  });
  it("weekly series: first bucket equals the totals, the empty bucket is null-safe", () => {
    const s = computeKpiSeries(ROWS, TECHS, { fromDay: "2028-03-06", toDay: "2028-03-19" }, "week");
    expect(s).toHaveLength(2);
    expect(s[0].values.jobsCompleted).toBe(10);
    expect(s[1].values.firstTimeFixRateBp).toBeNull();
  });
  it("monthly series clips to the requested range", () => {
    const s = computeKpiSeries([], TECHS, { fromDay: "2028-03-20", toDay: "2028-04-05" }, "month");
    expect(s.map((p) => [p.start, p.end])).toEqual([["2028-03-20", "2028-03-31"], ["2028-04-01", "2028-04-05"]]);
  });
  it("series buckets partition the range: summed jobs equal the whole-range total", () => {
    const whole = computeCustomerKpis(ROWS, TECHS, { fromDay: "2028-03-06", toDay: "2028-03-19" }).jobsCompleted;
    const parts = computeKpiSeries(ROWS, TECHS, { fromDay: "2028-03-06", toDay: "2028-03-19" }, "day");
    expect(parts.reduce((s, p) => s + p.values.jobsCompleted, 0)).toBe(whole);
  });
});

describe("AR aging", () => {
  const asOf = "2028-03-31";
  it("bucket boundaries", () => {
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(bucketForDaysPastDue)).toEqual(
      ["current", "d1_30", "d1_30", "d31_60", "d31_60", "d61_90", "d61_90", "d90_plus"]);
  });
  const aging = computeArAging([
    { dueDate: "2028-04-10", balanceCents: 100 }, { dueDate: null, balanceCents: 50 }, { dueDate: "2028-03-31", balanceCents: 25 },
    { dueDate: "2028-03-30", balanceCents: 200 }, { dueDate: "2028-03-01", balanceCents: 300 }, { dueDate: "2028-02-29", balanceCents: 400 },
    { dueDate: "2028-01-31", balanceCents: 500 }, { dueDate: "2028-01-30", balanceCents: 600 }, { dueDate: "2027-12-31", balanceCents: 700 },
    { dueDate: "2028-01-01", balanceCents: 0 }, { dueDate: "2028-01-01", balanceCents: -40 },
  ], asOf);
  it("buckets balances, ignoring zero / negative balances", () => {
    expect(aging.buckets.current).toEqual({ count: 3, cents: 175 });
    expect(aging.buckets.d1_30).toEqual({ count: 2, cents: 500 });
    expect(aging.buckets.d31_60).toEqual({ count: 2, cents: 900 });
    expect(aging.buckets.d61_90).toEqual({ count: 1, cents: 600 });
    expect(aging.buckets.d90_plus).toEqual({ count: 1, cents: 700 });
  });
  it("totals and overdue share", () => {
    expect(aging.totalCents).toBe(2875);
    expect(aging.overdueCents).toBe(2700);
    expect(aging.overdueShareBp).toBe(9391);
  });
  it("empty -> null share", () => expect(computeArAging([], asOf).overdueShareBp).toBeNull());
});

describe("anomaly detection", () => {
  const H = [8000, 8100, 7900, 8050, 8000];
  it("flags a large drop in first-time-fix as a bad critical anomaly", () => {
    const a = detectAnomaly("first_time_fix_rate", H, 6500, 40);
    expect(a).toMatchObject({ metric: "first_time_fix_rate", direction: "down", bad: true, severity: "critical" });
  });
  it("a callback-rate rise is bad (lower is better)", () => {
    expect(detectAnomaly("callback_rate", [1000, 1100, 900, 1050, 1000], 2500, 40)).toMatchObject({ direction: "up", bad: true });
  });
  it("an improvement is reported but not flagged bad", () => {
    expect(detectAnomaly("first_time_fix_rate", H, 9800, 40)).toMatchObject({ direction: "up", bad: false });
  });
  it("no alert on thin volume, short history, null value or small change", () => {
    expect(detectAnomaly("first_time_fix_rate", H, 6500, 3)).toBeNull();
    expect(detectAnomaly("first_time_fix_rate", H.slice(0, 3), 6500, 40)).toBeNull();
    expect(detectAnomaly("first_time_fix_rate", H, null, 40)).toBeNull();
    expect(detectAnomaly("first_time_fix_rate", H, 7800, 40)).toBeNull();
  });
  it("normal noise is not an anomaly (|z| < 3) even if the absolute change is large", () => {
    expect(detectAnomaly("first_time_fix_rate", [5000, 9000, 5000, 9000, 7000], 6000, 40)).toBeNull();
  });
  it("flat history (sd = 0) flags any change above the minimum", () => {
    expect(detectAnomaly("first_time_fix_rate", [8000, 8000, 8000, 8000], 7000, 40)).toMatchObject({ z: null, severity: "critical" });
  });
  it("skips null history points", () => {
    expect(detectAnomaly("first_time_fix_rate", [null, 8000, 8100, 7900, 8050, 8000], 6500, 40)).not.toBeNull();
  });
});

describe("CSV export", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });
  it("neutralises spreadsheet formulas in strings but leaves real numbers alone", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
  });
  it("uses CRLF and a trailing newline", () => {
    expect(toCsv(["a", "b"], [[1, "x"]])).toBe("a,b\r\n1,x\r\n");
  });
  it("seriesToCsv: header carries metric versions, values are %, dollars", () => {
    const csv = seriesToCsv(computeKpiSeries(ROWS, TECHS, OPT, "week"));
    const [head, line] = csv.split("\r\n");
    expect(head).toContain("first_time_fix_rate_pct_v1");
    expect(line).toBe("2028-03-06,2028-03-12,10,6900.00,80.00,10.00,3200.00,32.17,28.13,40.00");
  });
});

describe("PII-free analytics events", () => {
  it("rejects unknown event names (including prototype keys)", () => {
    expect(sanitizeAnalyticsEvent("login", {})).toBeNull();
    expect(sanitizeAnalyticsEvent("constructor", {})).toBeNull();
    expect(sanitizeAnalyticsEvent(42, {})).toBeNull();
  });
  it("drops every property that is not allow-listed or has the wrong type", () => {
    const e = sanitizeAnalyticsEvent("csv_exported", { granularity: "week", range_days: 30, email: "a@b.com", customer_name: "Ann" });
    expect(e).toEqual({ name: "csv_exported", props: { granularity: "week", range_days: 30 } });
  });
  it("drops invalid enum / int values", () => {
    expect(sanitizeAnalyticsEvent("csv_exported", { granularity: "hour", range_days: -1 })).toEqual({ name: "csv_exported", props: {} });
    expect(sanitizeAnalyticsEvent("csv_exported", { range_days: 1.5 })).toEqual({ name: "csv_exported", props: {} });
  });
  it("no allow-listed property can carry free text", () => {
    for (const spec of Object.values(ANALYTICS_EVENTS)) for (const p of Object.values(spec.props)) expect(p.rule === "slug").toBe(false);
  });
});

describe("governance: every metric is documented", () => {
  const doc = readFileSync(new URL("../../../../docs/ANALYTICS_METRICS.md", import.meta.url), "utf8");
  it("docs/ANALYTICS_METRICS.md names every customer metric id", () => {
    for (const id of Object.keys(CUSTOMER_METRICS)) expect(doc).toContain(`\`${id}\``);
  });
  it("docs name every founder KPI", () => {
    for (const id of ["gross_dollar_retention", "net_revenue_retention", "activation", "module_attach", "payment_take_rate", "cac_payback", "cohort"]) {
      expect(doc).toContain(`\`${id}\``);
    }
  });
});
