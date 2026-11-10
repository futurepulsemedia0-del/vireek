import { describe, expect, it } from "vitest";
import { parseAnalyticsRequest, parseFounderRequest } from "./request.ts";

const U = "123e4567-e89b-12d3-a456-426614174000";

describe("parseAnalyticsRequest get/csv", () => {
  it("accepts a valid request and applies defaults", () => {
    const r = parseAnalyticsRequest({ action: "get", from: "2028-03-01", to: "2028-03-31" });
    expect(r).toEqual({ ok: true, value: { action: "get", fromDay: "2028-03-01", toDay: "2028-03-31", granularity: "week", teamIds: [] } });
  });
  it("rejects bad dates, impossible dates, inverted and oversized ranges", () => {
    for (const [from, to] of [["2028-3-1", "2028-03-31"], ["2028-02-30", "2028-03-31"], ["2028-03-31", "2028-03-01"], ["2026-01-01", "2028-03-31"]]) {
      expect(parseAnalyticsRequest({ action: "get", from, to }).ok).toBe(false);
    }
  });
  it("rejects bad granularity and malformed or oversized team filters", () => {
    expect(parseAnalyticsRequest({ action: "csv", from: "2028-03-01", to: "2028-03-02", granularity: "hour" }).ok).toBe(false);
    expect(parseAnalyticsRequest({ action: "get", from: "2028-03-01", to: "2028-03-02", teamIds: ["x' OR 1=1"] }).ok).toBe(false);
    expect(parseAnalyticsRequest({ action: "get", from: "2028-03-01", to: "2028-03-02", teamIds: Array(51).fill(U) }).ok).toBe(false);
  });
  it("de-duplicates team ids", () => {
    const r = parseAnalyticsRequest({ action: "get", from: "2028-03-01", to: "2028-03-02", teamIds: [U, U] });
    expect(r.ok && r.value.action === "get" && r.value.teamIds).toEqual([U]);
  });
  it("accepts exactly 400 days and rejects 401", () => {
    expect(parseAnalyticsRequest({ action: "get", from: "2028-01-01", to: "2029-02-03" }).ok).toBe(true); // 400 days (2028 is a leap year)
    expect(parseAnalyticsRequest({ action: "get", from: "2028-01-01", to: "2029-02-04" }).ok).toBe(false);
  });
});

describe("parseAnalyticsRequest settings / ack / event", () => {
  it("validates settings, dropping unknown keys", () => {
    expect(parseAnalyticsRequest({ action: "settings", hoursPerDay: 7.5, digestEnabled: true, role: "admin" })).toEqual({
      ok: true, value: { action: "settings", hoursPerDay: 7.5, digestEnabled: true },
    });
    expect(parseAnalyticsRequest({ action: "settings", hoursPerDay: 0 }).ok).toBe(false);
    expect(parseAnalyticsRequest({ action: "settings", hoursPerDay: 25 }).ok).toBe(false);
    expect(parseAnalyticsRequest({ action: "settings", digestEnabled: "yes" }).ok).toBe(false);
    expect(parseAnalyticsRequest({ action: "settings", digestCadence: "daily" }).ok).toBe(false);
  });
  it("ack needs a UUID", () => {
    expect(parseAnalyticsRequest({ action: "ack", alertId: U }).ok).toBe(true);
    expect(parseAnalyticsRequest({ action: "ack", alertId: "1" }).ok).toBe(false);
  });
  it("event goes through the PII allow-list", () => {
    expect(parseAnalyticsRequest({ action: "event", name: "csv_exported", props: { granularity: "week", email: "a@b.co" } }))
      .toEqual({ ok: true, value: { action: "event", name: "csv_exported", props: { granularity: "week" } } });
    expect(parseAnalyticsRequest({ action: "event", name: "anything_else", props: {} }).ok).toBe(false);
  });
  it("rejects non-objects and unknown actions", () => {
    for (const b of [null, [], "x", 1, { action: "drop_table" }, {}]) expect(parseAnalyticsRequest(b).ok).toBe(false);
  });
});

describe("parseFounderRequest", () => {
  it("get defaults", () => {
    expect(parseFounderRequest({ action: "get" })).toEqual({ ok: true, value: { action: "get", month: null, activationDays: 14 } });
    expect(parseFounderRequest({ action: "get", month: "2028-13" }).ok).toBe(false);
    expect(parseFounderRequest({ action: "get", activationDays: 0 }).ok).toBe(false);
  });
  it("upsert_input validates every number", () => {
    const ok = { action: "upsert_input", month: "2028-03", spendCents: 100, grossMarginBp: 8000, platformFeeCents: 5 };
    expect(parseFounderRequest(ok).ok).toBe(true);
    expect(parseFounderRequest({ ...ok, spendCents: -1 }).ok).toBe(false);
    expect(parseFounderRequest({ ...ok, spendCents: 1.5 }).ok).toBe(false);
    expect(parseFounderRequest({ ...ok, spendCents: 1e13 }).ok).toBe(false);
    expect(parseFounderRequest({ ...ok, grossMarginBp: 10001 }).ok).toBe(false);
    expect(parseFounderRequest({ ...ok, note: "x".repeat(501) }).ok).toBe(false);
    expect(parseFounderRequest({ ...ok, month: "March" }).ok).toBe(false);
  });
});
