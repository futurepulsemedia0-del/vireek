import { describe, expect, it } from "vitest";
import {
  attritionProbability, bandFor, computeScore, evaluateOutcome, observedWeeks, planActions, ramp,
  replacementCostDollars, SIGNAL_WEIGHTS, type TechSignalInputs,
} from "./scoring.ts";

const calm: TechSignalInputs = {
  tenureDays: 700, scheduledJobs: 80, completedJobs: 75, sameDayChanges: 1, hasTimesheets: true,
  overtimeHours: 4, rejectedHours: 0, onCallDays: 7, teamAvgOnCallDays: 7, earningsRecent: 600_000,
  earningsPrior: 610_000, callbacks: 2, techRequests: 10, unansweredRequests: 0,
};
const burnedOut: TechSignalInputs = {
  ...calm, sameDayChanges: 32, overtimeHours: 64, onCallDays: 21, teamAvgOnCallDays: 9,
  earningsRecent: 380_000, earningsPrior: 610_000, callbacks: 12, rejectedHours: 24, unansweredRequests: 9,
};

describe("ramp", () => {
  it("is 0 at/below good, 100 at/above bad, linear between", () => {
    expect(ramp(0.5, "same_day_changes")).toBe(0);
    expect(ramp(4, "same_day_changes")).toBe(100);
    expect(ramp(99, "same_day_changes")).toBe(100);
    expect(ramp(2.25, "same_day_changes")).toBeCloseTo(50, 5);
    expect(ramp(Number.NaN, "overtime")).toBe(0);
  });
});

describe("weights", () => {
  it("sum to 100", () => {
    expect(Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe("computeScore", () => {
  it("scores a stable technician low with no drivers", () => {
    const r = computeScore(calm);
    expect(r.band).toBe("low");
    expect(r.score).toBeLessThan(25);
    expect(r.topDrivers).toEqual([]);
    expect(r.dataQuality).toBe("ok");
  });

  it("scores a burned-out technician high and lists exactly the top 3 drivers", () => {
    const r = computeScore(burnedOut);
    expect(r.band).toBe("high");
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.topDrivers).toHaveLength(3);
    const pts = r.topDrivers.map((d) => d.points);
    expect([...pts].sort((a, b) => b - a)).toEqual(pts);
    expect(r.topDrivers.every((d) => d.message.length > 10)).toBe(true);
  });

  it("driver points add up to the final score (explainable)", () => {
    const r = computeScore({ ...burnedOut, callbacks: 0, rejectedHours: 0, unansweredRequests: 0 });
    const all = Object.entries(r.signals).filter(([, s]) => s.available);
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(r.topDrivers.reduce((s, d) => s + d.points, 0)).toBeLessThanOrEqual(r.score + 0.5);
  });

  it("no data at all -> insufficient, never an invented score", () => {
    const r = computeScore({
      tenureDays: 400, scheduledJobs: 0, completedJobs: 0, sameDayChanges: 0, hasTimesheets: false,
      overtimeHours: 0, rejectedHours: 0, onCallDays: null, teamAvgOnCallDays: null, earningsRecent: 0,
      earningsPrior: 0, callbacks: 0, techRequests: 0, unansweredRequests: 0,
    });
    expect(r.band).toBe("insufficient");
    expect(r.dataQuality).toBe("insufficient");
    expect(r.score).toBe(0);
    expect(r.topDrivers).toEqual([]);
    expect(r.attritionProbability).toBe(0.18);
    expect(planActions(r, "Sam")).toEqual([]);
  });

  it("a single usable signal is still insufficient", () => {
    const r = computeScore({ ...burnedOut, hasTimesheets: false, onCallDays: null, teamAvgOnCallDays: null,
      earningsPrior: 0, completedJobs: 0, techRequests: 0 });
    expect(r.band).toBe("insufficient");
  });

  it("new hire: provisional (limited) and dampened, never flagged high on thin data", () => {
    const r = computeScore({ ...burnedOut, tenureDays: 10, scheduledJobs: 6, completedJobs: 4, techRequests: 3 });
    expect(r.newHire).toBe(true);
    expect(r.dataQuality).not.toBe("ok");
    expect(r.confidence).toBeLessThan(0.5);
    expect(r.band).not.toBe("high");
    expect(r.weeksObserved).toBe(1.4);
  });

  it("earnings trend needs a 6-week history and a meaningful baseline", () => {
    const young = computeScore({ ...burnedOut, tenureDays: 30 });
    expect(young.signals.earnings_trend.available).toBe(false);
    const tiny = computeScore({ ...burnedOut, earningsPrior: 5_000, earningsRecent: 0 });
    expect(tiny.signals.earnings_trend.available).toBe(false);
  });

  it("earnings growth is never penalised", () => {
    const r = computeScore({ ...calm, earningsRecent: 900_000 });
    expect(r.signals.earnings_trend.severity).toBe(0);
  });

  it("on-call load compares against the team average only when 2+ share a rotation", () => {
    expect(computeScore({ ...calm, onCallDays: 14, teamAvgOnCallDays: null }).signals.on_call_load.available).toBe(false);
    expect(computeScore({ ...calm, onCallDays: null, teamAvgOnCallDays: 7 }).signals.on_call_load.available).toBe(false);
    expect(computeScore({ ...calm, onCallDays: 14, teamAvgOnCallDays: 7 }).signals.on_call_load.severity).toBe(100);
  });

  it("zero overtime with timesheets is a real 'good' signal, not missing data", () => {
    const r = computeScore({ ...calm, overtimeHours: 0 });
    expect(r.signals.overtime.available).toBe(true);
    expect(r.signals.overtime.severity).toBe(0);
  });

  it("score is always an integer within 0..100", () => {
    for (const i of [calm, burnedOut]) {
      const r = computeScore(i);
      expect(Number.isInteger(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });
});

describe("cost model", () => {
  it("tiers replacement cost by tenure inside $15-25k", () => {
    expect(replacementCostDollars(100)).toBe(15_000);
    expect(replacementCostDollars(500)).toBe(20_000);
    expect(replacementCostDollars(2000)).toBe(25_000);
  });
  it("maps score to a bounded probability near the 16-20% industry baseline", () => {
    expect(attritionProbability(20)).toBeCloseTo(0.184, 3);
    expect(attritionProbability(100)).toBe(0.6);
    expect(attritionProbability(0)).toBe(0.08);
  });
  it("expected annual cost = probability x replacement cost", () => {
    const r = computeScore(burnedOut);
    expect(r.expectedAnnualCost).toBe(Math.round(r.attritionProbability * r.replacementCost));
  });
  it("bands", () => {
    expect(bandFor(49)).toBe("elevated");
    expect(bandFor(50)).toBe("high");
    expect(bandFor(24)).toBe("low");
    expect(observedWeeks(1000)).toBe(8);
    expect(observedWeeks(0)).toBe(1);
  });
});

describe("planActions", () => {
  it("creates one concrete action per top driver, deduplicated by type", () => {
    const r = computeScore(burnedOut);
    const actions = planActions(r, "Alex Rivera");
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.length).toBeLessThanOrEqual(3);
    expect(new Set(actions.map((a) => a.action_type)).size).toBe(actions.length);
    expect(actions.every((a) => a.title.includes("Alex Rivera") && a.params.name === "Alex Rivera")).toBe(true);
  });
  it("suggests nothing for a low score", () => {
    expect(planActions(computeScore(calm), "Sam")).toEqual([]);
  });
  it("earnings and callback drivers share one 1:1 action", () => {
    const r = computeScore({ ...calm, earningsRecent: 300_000, callbacks: 14 });
    const types = planActions({ ...r, band: "high" }, "Sam").map((a) => a.action_type);
    expect(types.filter((t) => t === "manager_one_on_one").length).toBeLessThanOrEqual(1);
  });
});

describe("evaluateOutcome", () => {
  it("needs a 5-point move to count", () => {
    expect(evaluateOutcome(60, 55)).toBe("improved");
    expect(evaluateOutcome(60, 56)).toBe("no_change");
    expect(evaluateOutcome(60, 65)).toBe("worsened");
  });
});

describe("fairness guard", () => {
  it("inputs contain only operational fields - no protected attribute can be scored", () => {
    const protectedWords = /age|birth|gender|sex|race|ethnic|religio|health|disab|pregnan|marital|nationality|orientation|union|medical/i;
    const keys = Object.keys(burnedOut).filter((k) => k !== "tenureDays"); // tenure != age
    expect(keys.filter((k) => protectedWords.test(k.replace(/Average|Avg|page|usage|message/gi, "")))).toEqual([]);
    expect(Object.keys(computeScore(burnedOut).signals).sort()).toEqual(Object.keys(SIGNAL_WEIGHTS).sort());
  });
});
