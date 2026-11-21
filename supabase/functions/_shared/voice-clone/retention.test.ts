import { describe, expect, it } from "vitest";
import {
  MAX_PURGE_ATTEMPTS, RETENTION_DEFAULT_DAYS, RETENTION_MAX_DAYS, RETENTION_MIN_DAYS, RETENTION_PRESETS,
  canShorten, computeExpiry, daysRemaining, isRetentionDue, noticeStageFor, parseRetentionDays,
} from "./retention.ts";

describe("parseRetentionDays", () => {
  it("accepts integers and digit strings inside the bounds", () => {
    expect(parseRetentionDays(30)).toEqual({ ok: true, days: 30 });
    expect(parseRetentionDays("90")).toEqual({ ok: true, days: 90 });
    expect(parseRetentionDays(RETENTION_MIN_DAYS)).toEqual({ ok: true, days: 7 });
    expect(parseRetentionDays(RETENTION_MAX_DAYS)).toEqual({ ok: true, days: 730 });
  });
  it("rejects out-of-range values with a distinct code", () => {
    expect(parseRetentionDays(6)).toEqual({ ok: false, code: "retention_out_of_range" });
    expect(parseRetentionDays(731)).toEqual({ ok: false, code: "retention_out_of_range" });
    expect(parseRetentionDays(0)).toEqual({ ok: false, code: "retention_out_of_range" });
    expect(parseRetentionDays(-5)).toEqual({ ok: false, code: "retention_out_of_range" });
  });
  it("rejects non-integers and non-numbers", () => {
    for (const bad of [1.5, NaN, Infinity, "abc", "12.5", "1e3", "", " ", null, undefined, true, {}, [], "99999"]) {
      expect(parseRetentionDays(bad).ok).toBe(false);
    }
  });
  it("the default and every preset are valid", () => {
    expect(parseRetentionDays(RETENTION_DEFAULT_DAYS).ok).toBe(true);
    for (const p of RETENTION_PRESETS) expect(parseRetentionDays(p).ok).toBe(true);
  });
});

describe("canShorten", () => {
  it("allows equal or shorter, never longer", () => {
    expect(canShorten(365, 90)).toBe(true);
    expect(canShorten(365, 365)).toBe(true);
    expect(canShorten(90, 365)).toBe(false);
  });
  it("still enforces the bounds", () => {
    expect(canShorten(365, 3)).toBe(false);
    expect(canShorten(365, 1.5)).toBe(false);
  });
});

describe("expiry maths", () => {
  const approved = "2026-01-01T00:00:00.000Z";
  it("adds exact 24h days", () => {
    expect(computeExpiry(approved, 30).toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });
  it("throws on an invalid approval time instead of inventing one", () => {
    expect(() => computeExpiry("not a date", 30)).toThrow();
  });
  it("isRetentionDue: boundary is inclusive, bad data is never due", () => {
    const exp = "2026-02-01T00:00:00.000Z";
    expect(isRetentionDue(exp, new Date("2026-01-31T23:59:59.999Z"))).toBe(false);
    expect(isRetentionDue(exp, new Date("2026-02-01T00:00:00.000Z"))).toBe(true);
    expect(isRetentionDue(null, new Date())).toBe(false);
    expect(isRetentionDue(undefined, new Date())).toBe(false);
    expect(isRetentionDue("garbage", new Date())).toBe(false);
  });
  it("daysRemaining rounds up and floors at 0", () => {
    const exp = "2026-02-01T00:00:00.000Z";
    expect(daysRemaining(exp, new Date("2026-01-31T12:00:00.000Z"))).toBe(1);
    expect(daysRemaining(exp, new Date("2026-01-25T00:00:00.000Z"))).toBe(7);
    expect(daysRemaining(exp, new Date("2026-03-01T00:00:00.000Z"))).toBe(0);
    expect(daysRemaining(null, new Date())).toBeNull();
  });
});

describe("noticeStageFor", () => {
  it("maps days left to warning stages", () => {
    expect(noticeStageFor(null)).toBe(0);
    expect(noticeStageFor(31)).toBe(0);
    expect(noticeStageFor(30)).toBe(1);
    expect(noticeStageFor(8)).toBe(1);
    expect(noticeStageFor(7)).toBe(2);
    expect(noticeStageFor(2)).toBe(2);
    expect(noticeStageFor(1)).toBe(3);
    expect(noticeStageFor(0)).toBe(3);
  });
  it("retry cap matches the SQL claim function (30)", () => {
    expect(MAX_PURGE_ATTEMPTS).toBe(30);
  });
});
