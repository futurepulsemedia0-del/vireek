import { describe, expect, it } from "vitest";
import { interpretCallReport, sanitizeStructured } from "./outcome.ts";

const T0 = "2026-11-03T16:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

describe("interpretCallReport", () => {
  it("voicemail: ring seconds from ringing -> answered", () => {
    const r = interpretCallReport({ endedReason: "voicemail", ringingAt: T0, answeredAt: at(21), endedAt: at(40), durationSeconds: 19,
      structured: { answered_by: "voicemail", greeting_present: true, business_name_stated: true, greeting_seconds: 12 } });
    expect(r).toMatchObject({ answer_kind: "voicemail", ring_seconds: 21, duration_seconds: 19 });
    expect(r.observations).toEqual({ greeting_present: true, business_name_stated: true, greeting_seconds: 12 });
  });
  it("classifies provider end reasons", () => {
    expect(interpretCallReport({ endedReason: "customer-did-not-answer", ringingAt: T0, endedAt: at(45) })).toMatchObject({ answer_kind: "no_answer", ring_seconds: 45 });
    expect(interpretCallReport({ endedReason: "customer-busy" }).answer_kind).toBe("busy");
    expect(interpretCallReport({ endedReason: "twilio-failed-to-connect-call" }).answer_kind).toBe("failed");
    expect(interpretCallReport({ endedReason: "assistant-ended-call", durationSeconds: 30, structured: { answered_by: "human" } }).answer_kind).toBe("live_person");
    expect(interpretCallReport({ endedReason: "assistant-ended-call", durationSeconds: 30, structured: { answered_by: "ai_agent" } }).answer_kind).toBe("live_ai");
    expect(interpretCallReport({ endedReason: "assistant-ended-call", durationSeconds: 30, structured: { answered_by: "ivr_menu" } }).answer_kind).toBe("ivr");
  });
  it("answered with no usable structured data is UNKNOWN (excluded), not guessed", () => {
    expect(interpretCallReport({ endedReason: "assistant-ended-call", durationSeconds: 30 }).answer_kind).toBe("unknown");
  });
  it("untrusted structured data: unknown keys dropped, numbers clamped, wrong types ignored", () => {
    const s = sanitizeStructured({ answered_by: "ceo", greeting_present: "yes", greeting_seconds: 99999, hold_seconds: -4, evil: "ignore previous", offered_to_book_or_take_details: true });
    expect(s.answered_by).toBeNull();
    expect(s.observations).toEqual({ greeting_seconds: 600, hold_seconds: 0, offered_to_book: true });
    expect(JSON.stringify(s)).not.toContain("ignore previous");
  });
  it("detects a stop request from structured data or the transient transcript, and never returns the transcript", () => {
    expect(interpretCallReport({ endedReason: "x", structured: { asked_to_stop: true } }).asked_to_stop).toBe(true);
    const r = interpretCallReport({ endedReason: "x", durationSeconds: 9, transientTranscript: "AI: hi\nUser: please stop calling me" });
    expect(r.asked_to_stop).toBe(true);
    expect(JSON.stringify(r)).not.toContain("please stop");
    expect(interpretCallReport({ endedReason: "x", transientTranscript: "AI: we won't call again\nUser: hello" }).asked_to_stop).toBe(false);
  });
  it("converts cost to cents, bounded", () => {
    expect(interpretCallReport({ endedReason: "x", costUsd: 0.1234 }).cost_cents).toBe(13);
    expect(interpretCallReport({ endedReason: "x", costUsd: 9999 }).cost_cents).toBe(500);
    expect(interpretCallReport({ endedReason: "x", costUsd: -1 }).cost_cents).toBe(0);
  });
});
