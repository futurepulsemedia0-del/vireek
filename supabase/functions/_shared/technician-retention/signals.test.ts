import { describe, expect, it } from "vitest";
import {
  hourlyPayCents, isSameDayChange, isUnanswered, onCallDaysByTech, splitEarnings, summarizeRequests,
  weekStartUtc, zonedToUtcMs, type OnCallSchedule, type ThreadMessage,
} from "./signals.ts";

const H = 3_600_000;
const D = 24 * H;

describe("isSameDayChange", () => {
  const start = "2026-03-10T15:00:00Z";
  it("flags changes made within 24h before the original start", () => {
    expect(isSameDayChange(start, "2026-03-10T09:00:00Z")).toBe(true);
    expect(isSameDayChange(start, "2026-03-09T15:00:00Z")).toBe(true);
  });
  it("ignores early changes and late edits", () => {
    expect(isSameDayChange(start, "2026-03-08T09:00:00Z")).toBe(false);
    expect(isSameDayChange(start, "2026-03-10T20:00:00Z")).toBe(false);
  });
  it("handles bad input", () => {
    expect(isSameDayChange("nope", start)).toBe(false);
  });
});

describe("zonedToUtcMs", () => {
  it("applies the zone offset (New York EST = UTC-5)", () => {
    expect(new Date(zonedToUtcMs("2026-01-05", 8, "America/New_York")).toISOString()).toBe("2026-01-05T13:00:00.000Z");
  });
  it("respects daylight saving (EDT = UTC-4)", () => {
    expect(new Date(zonedToUtcMs("2026-07-06", 8, "America/New_York")).toISOString()).toBe("2026-07-06T12:00:00.000Z");
  });
  it("falls back to UTC for an unknown zone", () => {
    expect(new Date(zonedToUtcMs("2026-01-05", 8, "Not/AZone")).toISOString()).toBe("2026-01-05T08:00:00.000Z");
  });
});

describe("onCallDaysByTech", () => {
  const sched = (over: Partial<OnCallSchedule> = {}): OnCallSchedule => ({
    rotation_type: "weekly", timezone: "UTC", rotation_start_date: "2026-01-05", handoff_hour: 0,
    members: [{ position: 0, team_member_id: "a" }, { position: 1, team_member_id: "b" }], ...over,
  });
  const start = Date.UTC(2026, 0, 5);
  it("alternates weekly and totals the window", () => {
    const m = onCallDaysByTech([sched()], start, start + 28 * D);
    expect(m.get("a")).toBeCloseTo(14, 6);
    expect(m.get("b")).toBeCloseTo(14, 6);
  });
  it("daily rotation", () => {
    const m = onCallDaysByTech([sched({ rotation_type: "daily" })], start, start + 3 * D);
    expect(m.get("a")).toBeCloseTo(2, 6);
    expect(m.get("b")).toBeCloseTo(1, 6);
  });
  it("time before the rotation start belongs to position 0, like the SQL function", () => {
    const m = onCallDaysByTech([sched()], start - 3 * D, start);
    expect(m.get("a")).toBeCloseTo(3, 6);
  });
  it("a technician in two rotations accumulates both", () => {
    const m = onCallDaysByTech([sched(), sched({ members: [{ position: 0, team_member_id: "a" }] })], start, start + 14 * D);
    expect(m.get("a")).toBeCloseTo(7 + 14, 6);
  });
  it("empty schedules and gaps in positions are safe", () => {
    expect(onCallDaysByTech([sched({ members: [] })], start, start + D).size).toBe(0);
    const gap = sched({ members: [{ position: 0, team_member_id: "a" }, { position: 5, team_member_id: "b" }] });
    expect(onCallDaysByTech([gap], start + 7 * D, start + 14 * D).size).toBe(0);
  });
});

describe("office requests", () => {
  const msg = (job: string, role: "technician" | "office", at: number): ThreadMessage =>
    ({ job_id: job, sender_role: role, tech_id: role === "technician" ? "t1" : null, at });
  const now = 100 * H;
  it("collapses a burst of technician messages into one request", () => {
    const r = summarizeRequests([msg("j", "technician", 0), msg("j", "technician", 10 * 60_000), msg("j", "technician", 20 * 60_000)]);
    expect(r).toHaveLength(1);
  });
  it("pairs each request with the next office reply", () => {
    const r = summarizeRequests([msg("j", "technician", 0), msg("j", "office", 1 * H), msg("j", "technician", 10 * H)]);
    expect(r).toHaveLength(2);
    expect(r[0].replied_at).toBe(1 * H);
    expect(r[1].replied_at).toBeNull();
  });
  it("counts missing and late replies as unanswered, but not fast ones or very recent asks", () => {
    expect(isUnanswered({ tech_id: "t", asked_at: 0, replied_at: 1 * H }, now)).toBe(false);
    expect(isUnanswered({ tech_id: "t", asked_at: 0, replied_at: 6 * H }, now)).toBe(true);
    expect(isUnanswered({ tech_id: "t", asked_at: 0, replied_at: null }, now)).toBe(true);
    expect(isUnanswered({ tech_id: "t", asked_at: now - 1 * H, replied_at: null }, now)).toBe(false);
  });
  it("keeps threads separate", () => {
    const r = summarizeRequests([msg("a", "technician", 0), msg("b", "office", 1 * H), msg("b", "technician", 2 * H)]);
    expect(r.filter((x) => x.replied_at === null)).toHaveLength(2);
  });
});

describe("earnings", () => {
  const now = 100 * D;
  it("splits the last 28 days from the 28 before", () => {
    const s = splitEarnings([
      { at: now - 1 * D, cents: 100 }, { at: now - 27 * D, cents: 50 },
      { at: now - 30 * D, cents: 400 }, { at: now - 55 * D, cents: 100 },
      { at: now - 60 * D, cents: 999 }, { at: now + D, cents: 999 },
    ], now);
    expect(s).toEqual({ recent: 150, prior: 500 });
  });
  it("hourly pay with overtime multiplier", () => {
    expect(hourlyPayCents(3000, 1.5, 40, 10)).toBe(120000 + 45000);
  });
});

describe("weekStartUtc", () => {
  it("returns the Monday of the week", () => {
    expect(weekStartUtc(new Date("2026-10-25T10:00:00Z"))).toBe("2026-10-19"); // Sunday
    expect(weekStartUtc(new Date("2026-10-19T00:00:00Z"))).toBe("2026-10-19");
    expect(weekStartUtc(new Date("2026-10-21T23:59:00Z"))).toBe("2026-10-19");
  });
});
