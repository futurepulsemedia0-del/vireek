import { describe, it, expect } from "vitest";
import { computeAiRoi, parseAiRoiRaw, summarizeAiRoi, type AiRoiRaw } from "./aiRoi";

const base = (): AiRoiRaw => ({
  calls: { total: 10, answered: 8, missed: 2, after_hours_known: 8, after_hours_answered: 3, handled_seconds: 3600 },
  ai_jobs: [], history: { n: 0, sum_cents: 0 }, recovery: { events: 0, recovered: 0, recovered_cents: 0 },
});
const job = (id: string, status: string, paid: boolean, amt: number | null) =>
  ({ id, created_at: "2026-10-01T00:00:00Z", job_status: status, completed_at: status === "completed" ? "2026-10-05T00:00:00Z" : null, amount_cents: amt, paid });

describe("computeAiRoi", () => {
  it("never invents numbers when data is missing", () => {
    const r = computeAiRoi({ ...base(), calls: { ...base().calls, after_hours_known: 0, handled_seconds: 0 } });
    expect(r.metrics.avg_job_value.value).toBeNull();
    expect(r.metrics.avg_job_value.status).toBe("not_enough_data");
    expect(r.metrics.estimated_revenue_influenced.value).toBeNull();
    expect(r.metrics.after_hours_answered.status).toBe("not_enough_data");
    expect(r.metrics.hours_saved.value).toBeNull();
    expect(r.metrics.missed_recovered.status).toBe("not_enough_data");
  });
  it("strict attribution: only booked AND completed AND paid counts as revenue", () => {
    const raw = base();
    raw.ai_jobs = [job("a", "completed", true, 40000), job("b", "completed", false, 90000), job("c", "scheduled", false, null), job("d", "scheduled", true, 70000)];
    const r = computeAiRoi(raw);
    expect(r.attributedRevenueCents).toBe(40000);
    expect(r.funnel.map((f) => f.count)).toEqual([4, 2, 1]);
    expect(r.metrics.ai_bookings.kind).toBe("booked");
  });
  it("keeps estimated separate from measured, with a visible formula", () => {
    const raw = base();
    raw.history = { n: 10, sum_cents: 500000 };
    raw.ai_jobs = [job("a", "completed", true, 40000), job("b", "scheduled", false, null), job("c", "scheduled", false, null)];
    const r = computeAiRoi(raw);
    expect(r.metrics.avg_job_value.value).toBe(50000);
    expect(r.metrics.estimated_revenue_influenced.value).toBe(100000);
    expect(r.metrics.estimated_revenue_influenced.kind).toBe("estimated");
    expect(r.metrics.ai_attributed_revenue.kind).toBe("measured");
    for (const m of Object.values(r.metrics)) { expect(m.formula.length).toBeGreaterThan(10); expect(m.source.length).toBeGreaterThan(3); }
  });
  it("requires a minimum history before using an average", () => {
    const raw = base(); raw.history = { n: 4, sum_cents: 400000 };
    expect(computeAiRoi(raw).metrics.avg_job_value.status).toBe("not_enough_data");
  });
  it("counts a paid job with no amount as paid but adds no revenue", () => {
    const raw = base(); raw.ai_jobs = [job("a", "completed", true, null)];
    const r = computeAiRoi(raw);
    expect(r.attributedRevenueCents).toBe(0);
    expect(r.paidWithoutAmount).toBe(1);
  });
  it("hours saved = handled minutes / 60", () => {
    expect(computeAiRoi(base()).metrics.hours_saved.value).toBe(1);
  });
});

describe("parseAiRoiRaw", () => {
  it("rejects garbage and clamps negatives", () => {
    expect(parseAiRoiRaw(null)).toBeNull();
    expect(parseAiRoiRaw({})).toBeNull();
    const p = parseAiRoiRaw({ calls: { total: -5 }, history: {}, recovery: {}, ai_jobs: [{ id: 1 }, { id: "x", paid: true }] });
    expect(p?.calls.total).toBe(0);
    expect(p?.ai_jobs.length).toBe(1);
  });
});

describe("summarizeAiRoi", () => {
  it("formats money and keeps the same wording as the dashboard", () => {
    const raw = base(); raw.history = { n: 10, sum_cents: 500000 };
    raw.ai_jobs = [job("a", "completed", true, 40000)];
    const sec = summarizeAiRoi(computeAiRoi(raw));
    expect(sec.lines.find((l) => l.label.startsWith("AI-attributed"))?.display).toBe("$400");
    expect(sec.funnel.map((f) => f.count)).toEqual([1, 1, 1]);
    const empty = summarizeAiRoi(computeAiRoi(base()));
    expect(empty.lines.find((l) => l.label.startsWith("Average job"))?.display).toBe("Not enough data yet");
  });
});
