import { describe, expect, it } from "vitest";
import { daysBetween } from "./dates.ts";
import { capacityWarnings, escalationReasons, findOverlaps, toolsAllowedFor } from "./policy.ts";

const base = { userId: "u1", ownerId: "o1" };

describe("toolsAllowedFor (scoped permissions)", () => {
  it("gives the account owner every tool", () => {
    expect(toolsAllowedFor({ userId: "o1", ownerId: "o1", role: "owner", permissions: {} }).size).toBe(3);
  });
  it("never lets a technician use Operator, even with can_view_all_jobs", () => {
    expect(toolsAllowedFor({ ...base, role: "technician", permissions: { can_view_all_jobs: true } }).size).toBe(0);
  });
  it("requires can_view_all_jobs for admins and members", () => {
    expect(toolsAllowedFor({ ...base, role: "admin", permissions: { can_view_all_jobs: true } }).size).toBe(3);
    expect(toolsAllowedFor({ ...base, role: "member", permissions: { can_view_all_jobs: false } }).size).toBe(0);
    expect(toolsAllowedFor({ ...base, role: "member", permissions: {} }).size).toBe(0);
  });
  it("fails closed on an inconsistent owner row", () => {
    expect(toolsAllowedFor({ ...base, role: "owner", permissions: { can_view_all_jobs: true } }).size).toBe(0);
  });
});

describe("escalationReasons (approval forced regardless of autonomy)", () => {
  const i = { affected: 3, targetDates: ["2026-10-28"], today: "2026-10-21", warnings: [], daysBetween };
  it("is empty for a small, near-term, clean step", () => expect(escalationReasons(i)).toHaveLength(0));
  it("forces approval for bulk, far dates and warnings", () => {
    expect(escalationReasons({ ...i, affected: 11 })).toHaveLength(1);
    expect(escalationReasons({ ...i, targetDates: ["2026-12-01"] })).toHaveLength(1);
    expect(escalationReasons({ ...i, warnings: ["x"] })).toHaveLength(1);
  });
});

describe("dry-run conflict prediction", () => {
  const H = 3_600_000;
  it("flags overlaps for the same technician only", () => {
    const existing = [{ id: "e1", techId: "t1", startMs: 9 * H, durationMin: 60 }, { id: "e2", techId: "t2", startMs: 9 * H, durationMin: 60 }];
    const moving = [{ id: "m1", techId: "t1", startMs: 9.5 * H, durationMin: 60 }, { id: "m2", techId: "t1", startMs: 11 * H, durationMin: 60 }];
    expect(findOverlaps(moving, existing)).toEqual([{ id: "m1", with: "e1" }]);
  });
  it("warns when a technician would exceed their daily limit", () => {
    const roster = [{ id: "t1", member_name: "Mike", max_jobs_per_day: 4 }];
    expect(capacityWarnings(new Map([["t1", 3]]), new Map([["t1", 2]]), roster)).toHaveLength(1);
    expect(capacityWarnings(new Map([["t1", 2]]), new Map([["t1", 2]]), roster)).toHaveLength(0);
  });
});
