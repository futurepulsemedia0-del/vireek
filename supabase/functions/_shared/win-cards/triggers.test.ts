import { describe, expect, it } from "vitest";
import { findSpeedRecords, detectAfterHoursBooking, detectEmergencyHandled, detectFiveStarAiJob, detectMilestone, detectRecoveredLargeJob, detectSpeedRecord, type CallRow } from "./triggers.ts";
import { DEFAULT_CARD_SETTINGS } from "./types.ts";

const S = DEFAULT_CARD_SETTINGS;
const call = (o: Partial<CallRow> = {}): CallRow => ({ id: "c1", call_datetime: "2026-11-03T07:14:00Z", is_emergency: false, status: "completed", booking_outcome: "booked", caller_name: "Sarah Mitchell", caller_phone: "+12125550147", ...o });

describe("after-hours booking", () => {
  it("fires only for a booked, non-emergency, after-hours call", () => {
    expect(detectAfterHoursBooking(call(), S)?.trigger).toBe("after_hours_booking");
    expect(detectAfterHoursBooking(call({ booking_outcome: "not_booked" }), S)).toBeNull();
    expect(detectAfterHoursBooking(call({ call_datetime: "2026-11-03T15:00:00Z" }), S)).toBeNull(); // 10:00 NY
    expect(detectAfterHoursBooking(call({ is_emergency: true }), S)).toBeNull(); // emergency card instead
  });
  it("captures PII terms (name + phone) for the scrubber, never value without an invoice", () => {
    const c = detectAfterHoursBooking(call(), S)!;
    expect(c.facts.pii.includes("Sarah Mitchell")).toBe(true);
    expect(c.facts.valueCents).toBeFalsy();
    expect(detectAfterHoursBooking(call(), S, { invoice_amount: 4200 })!.facts.valueCents).toBe(420000);
  });
});

describe("emergency handled", () => {
  it("requires is_emergency AND a booking", () => {
    expect(detectEmergencyHandled(call({ is_emergency: true }))?.dedupeKey).toBe("call:c1");
    expect(detectEmergencyHandled(call({ is_emergency: true, booking_outcome: "not_booked" }))).toBeNull();
    expect(detectEmergencyHandled(call())).toBeNull();
  });
});

describe("recovered large job", () => {
  const ev = { id: "e1", source_type: "missed_call", status: "recovered", recovered_amount_cents: 450_000, occurred_at: "2026-11-01T12:00:00Z", customer_name: "A B", customer_phone: null };
  it("uses the real collected amount and respects the threshold", () => {
    expect(detectRecoveredLargeJob(ev, S)?.facts.valueCents).toBe(450_000);
    expect(detectRecoveredLargeJob({ ...ev, recovered_amount_cents: 199_999 }, S)).toBeNull();
    expect(detectRecoveredLargeJob({ ...ev, status: "open" }, S)).toBeNull();
    expect(detectRecoveredLargeJob({ ...ev, source_type: "declined_quote" }, S)).toBeNull();
  });
});

describe("milestones", () => {
  it("picks the highest un-carded milestone once", () => {
    expect(detectMilestone(99, new Set(), "x")).toBeNull();
    expect(detectMilestone(130, new Set(), "x")?.dedupeKey).toBe("milestone:100");
    expect(detectMilestone(1200, new Set([100]), "x")?.dedupeKey).toBe("milestone:1000");
    expect(detectMilestone(130, new Set([100]), "x")).toBeNull();
    expect(detectMilestone(1200, new Set([1000]), "x")).toBeNull();
  });
});

describe("speed-to-lead record", () => {
  const r = { id: "s1", time_to_first_dial_ms: 12_000, sla_met: true, received_at: "2026-11-02T10:00:00Z", first_name: "Jo", full_name: "Jo Park", phone_e164: "+12125550147" };
  it("must strictly beat history, with enough history, within SLA", () => {
    expect(detectSpeedRecord(r, 20_000, 25)?.trigger).toBe("speed_to_lead_record");
    expect(detectSpeedRecord(r, 12_000, 25)).toBeNull();
    expect(detectSpeedRecord(r, 20_000, 5)).toBeNull();
    expect(detectSpeedRecord({ ...r, sla_met: false }, 20_000, 25)).toBeNull();
    expect(detectSpeedRecord({ ...r, time_to_first_dial_ms: null }, 20_000, 25)).toBeNull();
  });
});

describe("5-star review from an AI-booked job", () => {
  const rr = { id: "r1", rating: 5, status: "completed", completed_at: "2026-11-02T10:00:00Z", customer_name: "Pat Lee", customer_phone: null };
  it("needs rating 5, completed, and a job traceable to a booked call", () => {
    expect(detectFiveStarAiJob(rr, { call_booking_outcome: "booked" })?.dedupeKey).toBe("review:r1");
    expect(detectFiveStarAiJob({ ...rr, rating: 4 }, { call_booking_outcome: "booked" })).toBeNull();
    expect(detectFiveStarAiJob(rr, null)).toBeNull();
    expect(detectFiveStarAiJob(rr, { call_booking_outcome: "not_booked" })).toBeNull();
    expect(detectFiveStarAiJob({ ...rr, status: "sent" }, { call_booking_outcome: "booked" })).toBeNull();
  });
});

describe("findSpeedRecords", () => {
  const row = (i: number, ms: number | null, at = `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00Z`) => ({
    id: `s${i}`, time_to_first_dial_ms: ms, sla_met: true, received_at: at, first_name: null, full_name: null, phone_e164: null,
  });
  it("emits only for strict new records after enough history, only inside the window", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(i, 30_000 - i * 100)); // each one faster than the last
    const all = findSpeedRecords(rows, "2000-01-01");
    expect(all.length).toBe(5); // indexes 20..24 (history >= 20)
    expect(findSpeedRecords(rows, "2099-01-01")).toHaveLength(0);
    const flat = Array.from({ length: 30 }, (_, i) => row(i, 20_000));
    expect(findSpeedRecords(flat, "2000-01-01")).toHaveLength(0);
  });
});
