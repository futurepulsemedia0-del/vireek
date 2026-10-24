// The compliance invariant: no matter what the provider sends, what a caller says, or what
// goes wrong, card data never reaches logs, transcripts, the database, or outbound requests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCardData } from "./cardData";
import { cancelPhonePayment, handlePayAction, handlePayStatus, startPhonePayment } from "./orchestrator";
import { CALL_SID, JOB, makeFakePorts, USER, type Recorder } from "./testkit";
import { redactCallTranscript, redactLiveLine, redactTranscriptMessages } from "./transcript";

const PAN = "4111111111111111";
const PAN_SPACED = "4111 1111 1111 1111";
const AMEX = "378282246310005";
const START = { userId: USER, jobId: JOB, vapiCallId: "vapi-call-1", channel: "staff" as const, actorId: "00000000-0000-0000-0000-0000000000a2", returnToNumber: "+15551239999" };

let consoleOutput: string[] = [];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  consoleOutput = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleOutput.push(a.map(String).join(" "))));
  }
});
afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

/** Everything that could persist or leave the system, in one string list. */
function surfaces(rec: Recorder): string[] {
  return [...rec.dbWrites, ...rec.logs, ...rec.outbound, ...consoleOutput, JSON.stringify(rec.audit), JSON.stringify([...rec.sessions.values()]), JSON.stringify([...rec.paymentRequests.values()])];
}
function expectClean(rec: Recorder) {
  for (const s of surfaces(rec)) {
    expect(findCardData(s, { strict: true })).toEqual([]);
    for (const needle of [PAN, PAN_SPACED, AMEX, "4111-1111", "378282"]) expect(s).not.toContain(needle);
  }
}

// What Twilio posts after a successful tokenize — plus hostile extras a misconfigured connector or an attacker could add.
const hostileSuccess = (over: Record<string, string> = {}) => ({
  CallSid: CALL_SID,
  Result: "success",
  PaymentToken: "tok_1Abc23DefGhi456Jkl",
  PaymentCardType: "visa",
  PaymentCardNumber: "************1111",
  ExpirationDate: "1228",
  SecurityCode: "123",
  PostalCode: "94107",
  Digits: PAN,
  RawCard: PAN_SPACED,
  Note: `customer said ${AMEX}`,
  ...over,
});

describe("happy path (staff-assisted)", () => {
  it("pauses recording BEFORE capture, charges only the token, and leaks nothing", async () => {
    const { ports, rec } = makeFakePorts();
    const r = await startPhonePayment(ports, START);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // ordering = the compliance story
    const o = rec.order;
    expect(o.indexOf("twilio.pause")).toBeGreaterThan(-1);
    expect(o.indexOf("twilio.pause")).toBeLessThan(o.indexOf("session:capturing"));
    expect(o.indexOf("session:capturing")).toBeLessThan(o.indexOf("twilio.redirect"));
    expect(o.indexOf("twilio.redirect")).toBeLessThan(o.indexOf("stripe.charge") === -1 ? Infinity : o.indexOf("stripe.charge"));

    await handlePayStatus(ports, r.sessionId, { CallSid: CALL_SID, Capture: "payment-card-number", PaymentCardNumber: PAN, PartialResult: "true" });
    const done = await handlePayAction(ports, r.sessionId, hostileSuccess());

    expect(done.twiml).toContain("approved");
    expect(done.twiml).toContain("<Dial>+15551239999</Dial>"); // staff are reconnected
    expect(rec.charges).toBe(1);
    expect(rec.finalized).toBe(1);
    expect(rec.outbound.find((x) => x.startsWith("stripe"))).toContain("tok_1Abc23DefGhi456Jkl");
    expect(rec.outbound.find((x) => x.startsWith("stripe"))).toContain("phone-pay-"); // idempotency key
    const s = rec.sessions.get(r.sessionId)!;
    expect(s.status).toBe("succeeded");
    expect(s.card_brand).toBe("visa");
    expect(s.card_last4).toBe("1111");
    expect(s.recording_resumed_at).not.toBeNull();
    expect(rec.audit.map((a) => a.event.type)).toEqual([
      "session_requested", "recording_pause_requested", "recording_paused", "capture_redirect_sent", "capture_started",
      "capture_progress", "capture_completed", "tokenized", "charge_attempted", "charge_succeeded", "recording_resumed",
    ]);
    expectClean(rec);
  });

  it("a duplicate provider callback never charges twice", async () => {
    const { ports, rec } = makeFakePorts();
    const r = await startPhonePayment(ports, START);
    if (!r.ok) throw new Error("start failed");
    await handlePayAction(ports, r.sessionId, hostileSuccess());
    const again = await handlePayAction(ports, r.sessionId, hostileSuccess());
    expect(again.twiml).toContain("approved");
    expect(rec.charges).toBe(1);
    expectClean(rec);
  });
});

describe("fail closed", () => {
  it("never captures when the recording pause cannot be confirmed", async () => {
    const { ports, rec } = makeFakePorts({ pauseFails: true });
    const r = await startPhonePayment(ports, START);
    expect(r).toMatchObject({ ok: false, code: "recording_pause_failed" });
    expect(rec.order).not.toContain("twilio.redirect");
    expect(rec.order).not.toContain("session:capturing");
    const s = [...rec.sessions.values()][0];
    expect(s.status).toBe("failed");
    expect(s.failure_code).toBe("recording_pause_failed");
    expect([...rec.paymentRequests.values()][0].status).toBe("canceled");
    expect(rec.audit.map((a) => a.event.type)).toContain("recording_pause_failed");
    expectClean(rec);
  });

  it("a failed redirect fails the session and restores recording", async () => {
    const { ports, rec } = makeFakePorts({ redirectFails: true });
    const r = await startPhonePayment(ports, START);
    expect(r).toMatchObject({ ok: false, code: "redirect_failed" });
    expect([...rec.sessions.values()][0].status).toBe("failed");
    expect(rec.order).toContain("twilio.resume");
    expectClean(rec);
  });

  it("falls back (no capture, no pause) when the call is not on a controllable Twilio leg", async () => {
    const { ports, rec } = makeFakePorts({ callSid: null });
    const r = await startPhonePayment(ports, START);
    expect(r).toMatchObject({ ok: false, code: "unsupported_call_leg" });
    expect(rec.order).not.toContain("twilio.redirect");
    expect(rec.audit.map((a) => a.event.type)).toContain("fallback_payment_link");
  });

  it("refuses an already-paid job, a missing Stripe account, and a second session on the same call", async () => {
    expect(await startPhonePayment(makeFakePorts({ balanceCents: 0 }).ports, START)).toMatchObject({ ok: false, code: "already_paid" });
    expect(await startPhonePayment(makeFakePorts({ connect: null }).ports, START)).toMatchObject({ ok: false, code: "payments_not_configured" });
    const { ports } = makeFakePorts();
    expect((await startPhonePayment(ports, START)).ok).toBe(true);
    expect(await startPhonePayment(ports, START)).toMatchObject({ ok: false, code: "already_in_progress" });
  });

  it("rejects a callback for a different call leg and never charges", async () => {
    const { ports, rec } = makeFakePorts();
    const r = await startPhonePayment(ports, START);
    if (!r.ok) throw new Error("start failed");
    const out = await handlePayAction(ports, r.sessionId, hostileSuccess({ CallSid: "CA" + "b".repeat(32) }));
    expect(out.twiml).not.toContain("approved");
    expect(rec.charges).toBe(0);
    expect(rec.audit.map((a) => a.event.type)).toContain("callback_rejected");
  });

  it("expires a session whose callback arrives too late", async () => {
    let now = new Date("2027-11-02T12:00:00Z");
    const { ports, rec } = makeFakePorts({ now: () => now });
    const r = await startPhonePayment(ports, START);
    if (!r.ok) throw new Error("start failed");
    now = new Date("2027-11-02T12:30:00Z");
    await handlePayAction(ports, r.sessionId, hostileSuccess());
    expect(rec.sessions.get(r.sessionId)!.status).toBe("expired");
    expect(rec.charges).toBe(0);
  });
});

describe("provider payloads", () => {
  it("discards an UNMASKED card number and hostile fields; stores nothing from them", async () => {
    const { ports, rec } = makeFakePorts();
    const r = await startPhonePayment(ports, START);
    if (!r.ok) throw new Error("start failed");
    await handlePayAction(ports, r.sessionId, hostileSuccess({ PaymentCardNumber: PAN, PaymentError: `bad card ${PAN}` }));
    const s = rec.sessions.get(r.sessionId)!;
    expect(s.card_last4).toBe("1111"); // from Stripe's own masked charge details, not from the raw number
    expectClean(rec);
  });

  it.each([
    ["input-timeout", "caller_timeout"],
    ["caller-interrupted", "caller_cancelled"],
    ["invalid-card-number", "invalid_input"],
    ["payment-connector-error", "provider_error"],
  ])("maps Result=%s to %s without charging", async (result, code) => {
    const { ports, rec } = makeFakePorts();
    const r = await startPhonePayment(ports, START);
    if (!r.ok) throw new Error("start failed");
    await handlePayAction(ports, r.sessionId, { CallSid: CALL_SID, Result: result, PaymentCardNumber: PAN });
    expect(rec.sessions.get(r.sessionId)!.failure_code).toBe(code);
    expect(rec.charges).toBe(0);
    expect(rec.order).toContain("twilio.resume");
    expectClean(rec);
  });

  it("declined card -> failed session, canceled request, 'declined' message", async () => {
    const { ports, rec } = makeFakePorts({ chargeError: "payment_declined" });
    const r = await startPhonePayment(ports, START);
    if (!r.ok) throw new Error("start failed");
    const out = await handlePayAction(ports, r.sessionId, hostileSuccess());
    expect(out.twiml).toContain("declined");
    expect(rec.sessions.get(r.sessionId)!.failure_code).toBe("payment_declined");
    expect([...rec.paymentRequests.values()][0].status).toBe("canceled");
    expectClean(rec);
  });

  it("a charge that needs 3-D Secure is not treated as paid", async () => {
    const { ports, rec } = makeFakePorts({ chargeStatus: "requires_action" });
    const r = await startPhonePayment(ports, START);
    if (!r.ok) throw new Error("start failed");
    await handlePayAction(ports, r.sessionId, hostileSuccess());
    expect(rec.sessions.get(r.sessionId)!.failure_code).toBe("needs_authentication");
    expect(rec.finalized).toBe(0);
  });
});

describe("cancel", () => {
  it("cancelling mid-capture interrupts <Pay>, resumes recording and cancels the request", async () => {
    const { ports, rec } = makeFakePorts();
    const r = await startPhonePayment(ports, START);
    if (!r.ok) throw new Error("start failed");
    const out = await cancelPhonePayment(ports, { userId: USER, sessionId: r.sessionId, actorType: "staff", actorId: START.actorId });
    expect(out.ok).toBe(true);
    expect(rec.sessions.get(r.sessionId)!.status).toBe("cancelled");
    expect(rec.outbound.filter((x) => x.startsWith("redirect")).length).toBe(2); // <Pay>, then cancel message
    expect(rec.order).toContain("twilio.resume");
    expect(await cancelPhonePayment(ports, { userId: "someone-else", sessionId: r.sessionId, actorType: "staff", actorId: null })).toMatchObject({ ok: false });
  });
});

describe("transcripts", () => {
  const spoken = `Sure, my card is four one one one, 4111 1111 1111 1111, the cvv is 123 and it expires 08/27. Thanks!`;

  it("redacts spoken and typed card data from the stored call transcript and flags the audio", () => {
    const r = redactCallTranscript(spoken, { hadCapture: true });
    expect(findCardData(r.text ?? "", { strict: true })).toEqual([]);
    expect(r.text).not.toContain("4111");
    expect(r.text).not.toContain("08/27");
    expect(r.spokenCardDetected).toBe(true);
    expect(r.redactions).toBeGreaterThan(0);
    expect(r.text).toContain("Secure payment capture took place");
  });

  it("redacts each live line", () => {
    expect(redactLiveLine(`it's ${PAN}`)).not.toContain("4111");
    expect(redactLiveLine("what time can you come tomorrow")).toBe("what time can you come tomorrow");
  });

  it("replaces everything inside the capture window, even text that does not look like a card", () => {
    const t0 = Date.parse("2027-11-02T12:00:10Z");
    const msgs = [
      { time: t0 - 60_000, message: "hello, I'd like to pay my invoice" },
      { time: t0 + 1_000, message: "one two three" },
      { time: t0 + 5_000, message: "that's it" },
      { time: t0 + 120_000, message: `after: ${PAN}` },
      { message: "no timestamp" },
    ];
    const out = redactTranscriptMessages(msgs, [{ startMs: t0, endMs: t0 + 6_000 }]);
    expect(out[0].message).toBe("hello, I'd like to pay my invoice");
    expect(out[1].message).toContain("REDACTED");
    expect(out[2].message).toContain("REDACTED");
    expect(out[3].message).not.toContain("4111"); // still scrubbed outside the window
    expect(out[4].message).toContain("REDACTED"); // fail closed on missing timestamps
  });

  it("passes untouched transcripts through unchanged", () => {
    const t = "Hi, this is Pat. The AC stopped cooling. Can someone come Tuesday at 3?";
    expect(redactCallTranscript(t).text).toBe(t);
  });
});
