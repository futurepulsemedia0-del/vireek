import { describe, expect, it } from "vitest";
import { addDays, dayBoundsUtc, daysBetween, formatClock, formatDay, isIsoDate, isValidTimeZone, localDate, localTime, resolveDateSpec, shiftToDate, zonedToUtcMs } from "./dates.ts";

const CHI = "America/Chicago";
const TODAY = "2026-10-21"; // a Wednesday

describe("resolveDateSpec", () => {
  it("resolves a weekday to the nearest day on/after today", () => {
    expect(resolveDateSpec({ weekday: "tuesday" }, TODAY)).toEqual({ ok: true, date: "2026-10-27" });
    expect(resolveDateSpec({ weekday: "wednesday" }, TODAY)).toEqual({ ok: true, date: "2026-10-21" });
  });
  it('"next" adds a week to "this"', () => {
    expect(resolveDateSpec({ weekday: "wednesday", when: "next" }, TODAY)).toEqual({ ok: true, date: "2026-10-28" });
  });
  it("resolves a destination weekday strictly after the anchor", () => {
    expect(resolveDateSpec({ weekday: "wednesday" }, TODAY, "2026-10-27")).toEqual({ ok: true, date: "2026-10-28" });
    expect(resolveDateSpec({ weekday: "tuesday" }, TODAY, "2026-10-27")).toEqual({ ok: true, date: "2026-11-03" });
  });
  it("handles today / tomorrow / ISO and rejects impossible dates", () => {
    expect(resolveDateSpec("today", TODAY)).toEqual({ ok: true, date: TODAY });
    expect(resolveDateSpec("tomorrow", TODAY)).toEqual({ ok: true, date: "2026-10-22" });
    expect(resolveDateSpec("2026-12-31", TODAY)).toEqual({ ok: true, date: "2026-12-31" });
    expect(resolveDateSpec("2026-02-30", TODAY).ok).toBe(false);
    expect(resolveDateSpec("someday", TODAY).ok).toBe(false);
  });
});

describe("calendar helpers", () => {
  it("validates ISO dates and time zones", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isValidTimeZone(CHI)).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
  it("adds days across month ends and counts differences", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(daysBetween("2026-10-21", "2026-11-04")).toBe(14);
  });
});

describe("time zones", () => {
  it("uses the business-local day, not UTC", () => {
    expect(localDate(Date.parse("2026-10-28T03:30:00Z"), CHI)).toBe("2026-10-27");
    expect(localTime(Date.parse("2026-10-28T03:30:00Z"), CHI)).toBe("22:30");
  });
  it("keeps the local time of day when moving to another day", () => {
    expect(shiftToDate("2026-10-27T14:00:00.000Z", "2026-10-28", CHI)).toBe("2026-10-28T14:00:00.000Z");
  });
  it("stays at 9:00 local across the autumn DST change", () => {
    // Fri Oct 30 09:00 CDT (14:00Z) -> Mon Nov 2 09:00 CST (15:00Z)
    expect(shiftToDate("2026-10-30T14:00:00.000Z", "2026-11-02", CHI)).toBe("2026-11-02T15:00:00.000Z");
  });
  it("applies an explicit new time", () => {
    expect(shiftToDate("2026-10-27T14:00:00.000Z", "2026-10-28", CHI, "13:30")).toBe("2026-10-28T18:30:00.000Z");
  });
  it("computes day bounds, including a 25-hour DST day and half-hour zones", () => {
    const normal = dayBoundsUtc("2026-10-27", CHI);
    expect(new Date(normal.startMs).toISOString()).toBe("2026-10-27T05:00:00.000Z");
    expect(new Date(normal.endMs).toISOString()).toBe("2026-10-28T05:00:00.000Z");
    const fallBack = dayBoundsUtc("2026-11-01", CHI);
    expect((fallBack.endMs - fallBack.startMs) / 3_600_000).toBe(25);
    expect(new Date(zonedToUtcMs("2026-10-28", "09:00", "Asia/Kolkata")).toISOString()).toBe("2026-10-28T03:30:00.000Z");
  });
  it("formats for customers in the business time zone", () => {
    const ms = Date.parse("2026-10-28T14:00:00Z");
    expect(formatDay(ms, CHI)).toBe("Wed, Oct 28");
    expect(formatClock(ms, CHI)).toContain("9:00");
  });
});
