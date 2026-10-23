import { describe, expect, it } from "vitest";
import { buildDryRun, plannedCount, type DryRunData, type JobRow } from "./dryrun.ts";
import type { OperatorPlan } from "./types.ts";

const TZ = "America/Chicago";
const TODAY = "2026-10-21"; // Wednesday
const roster = [
  { id: "mike", member_name: "Mike Ross", max_jobs_per_day: 2 },
  { id: "sam", member_name: "Sam Lee", max_jobs_per_day: 6 },
  { id: "mike2", member_name: "Mike Chen", max_jobs_per_day: 6 },
];
const job = (id: string, over: Partial<JobRow> = {}): JobRow => ({
  id, customer_id: `c-${id}`, customer_name: `Cust ${id}`, customer_phone: "+15550001111", service_type: "AC repair",
  scheduled_datetime: "2026-10-27T14:00:00.000Z", duration_minutes: 60, assigned_technician_id: "mike", job_status: "scheduled", ...over,
});
function data(tuesday: JobRow[], wednesday: JobRow[] = []): DryRunData {
  return {
    roster,
    jobsOn: async (date, tech) => (date === "2026-10-27" ? tuesday : []).filter((j) => !tech || j.assigned_technician_id === tech),
    liveJobsOn: async (date) => (date === "2026-10-28" ? wednesday : []),
  };
}
const plan = (technician: string): OperatorPlan => ({
  summary: "s",
  steps: [
    { id: "s1", tool: "reschedule_jobs", selector: { technician, date: { weekday: "tuesday" } }, to_date: { weekday: "wednesday" }, to_time: null },
    { id: "s2", tool: "message_customers", from_step: "s1", body: "Hi {first_name}, moved from {old_date} to {new_date} at {new_time}." },
  ],
});

describe("buildDryRun", () => {
  it("lists exactly the affected jobs and renders each text", async () => {
    const r = await buildDryRun(plan("Sam"), { tz: TZ, today: TODAY }, data([job("j1", { assigned_technician_id: "sam" }), job("j2"), job("j3", { assigned_technician_id: "sam", scheduled_datetime: "2026-10-27T16:30:00.000Z" })]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [move, sms] = r.steps;
    expect(move.effects.map((e) => e.record_id)).toEqual(["j1", "j3"]);
    expect(move.effects[0].after.scheduled_datetime).toBe("2026-10-28T14:00:00.000Z");
    expect(move.effects[0].after.display).toBe("Wed, Oct 28 · 9:00 AM");
    expect(plannedCount(sms)).toBe(2);
    expect(sms.effects[0].after.display).toBe("Hi Cust, moved from Tue, Oct 27 to Wed, Oct 28 at 9:00 AM.");
    expect(move.dates).toEqual(["2026-10-27", "2026-10-28"]);
  });

  it("leaves started/finished jobs alone and skips texts with no phone", async () => {
    const r = await buildDryRun(plan("Mike Ross"), { tz: TZ, today: TODAY }, data([job("j1"), job("j2", { job_status: "completed" }), job("j3", { customer_phone: null })]));
    if (!r.ok) throw new Error("expected ok");
    expect(r.steps[0].effects).toHaveLength(2);
    expect(r.steps[0].note).toContain("1 job");
    expect(r.steps[1].effects.map((e) => e.status)).toEqual(["planned", "skipped"]);
  });

  it("warns about overlaps and daily-limit overflow on the target day", async () => {
    const wednesday = [job("w1", { scheduled_datetime: "2026-10-28T14:30:00.000Z" }), job("w2", { scheduled_datetime: "2026-10-28T20:00:00.000Z" })];
    const r = await buildDryRun(plan("Mike Ross"), { tz: TZ, today: TODAY }, data([job("j1")], wednesday));
    if (!r.ok) throw new Error("expected ok");
    expect(r.steps[0].warnings.length).toBe(2);
    expect(r.steps[0].warnings[0]).toContain("overlap");
    expect(r.steps[0].warnings[1]).toContain("limit 2");
  });

  it("asks which Mike instead of guessing", async () => {
    const r = await buildDryRun(plan("Mike"), { tz: TZ, today: TODAY }, data([job("j1")]));
    expect(r).toMatchObject({ ok: false, kind: "clarify" });
    if (!r.ok) expect(r.message).toContain("Mike Ross");
  });

  it("blocks past dates, no-op moves and over-broad requests", async () => {
    const past: OperatorPlan = { summary: "s", steps: [{ id: "s1", tool: "reschedule_jobs", selector: { technician: "Sam", date: { weekday: "tuesday" } }, to_date: "2026-10-01", to_time: null }] };
    expect(await buildDryRun(past, { tz: TZ, today: TODAY }, data([job("j1")]))).toMatchObject({ ok: false, kind: "blocked" });
    const same: OperatorPlan = { summary: "s", steps: [{ id: "s1", tool: "reschedule_jobs", selector: { technician: null, date: "2026-10-27" }, to_date: "2026-10-27", to_time: null }] };
    expect(await buildDryRun(same, { tz: TZ, today: TODAY }, data([job("j1")]))).toMatchObject({ ok: false, kind: "blocked" });
    const many = Array.from({ length: 51 }, (_, i) => job(`j${i}`));
    expect(await buildDryRun(plan("Mike Ross"), { tz: TZ, today: TODAY }, data(many))).toMatchObject({ ok: false, kind: "blocked" });
  });

  it("plans a reassignment and skips jobs already on that technician", async () => {
    const p: OperatorPlan = { summary: "s", steps: [{ id: "s1", tool: "reassign_jobs", selector: { technician: null, date: { weekday: "tuesday" } }, to_technician: "Sam" }] };
    const r = await buildDryRun(p, { tz: TZ, today: TODAY }, data([job("j1"), job("j2", { assigned_technician_id: "sam" })]));
    if (!r.ok) throw new Error("expected ok");
    expect(r.steps[0].effects.map((e) => e.record_id)).toEqual(["j1"]);
    expect(r.steps[0].effects[0].after.assigned_technician_id).toBe("sam");
    expect(r.steps[0].effects[0].before.display).toBe("Mike Ross");
  });
});
