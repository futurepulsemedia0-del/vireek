import { describe, expect, it } from "vitest";
import { arrivalMatches, buildForwardCode, evaluateForwardTest, expiryFor, planFor, type ForwardCheck } from "./carrierForwarding.ts";
import { ownerAlert, publicIncident } from "./incidentCopy.ts";

describe("buildForwardCode", () => {
  it("GSM no-answer includes a clamped ring delay and the cancel/status codes", () => {
    const c = buildForwardCode("gsm_standard", "no_answer", "+15551234567", 22)!;
    expect(c.activate).toBe("**61*+15551234567**20#");
    expect(c.cancel).toBe("##61#"); expect(c.status).toBe("*#61#"); expect(c.confidence).toBe("standard");
    expect(buildForwardCode("gsm_standard", "no_answer", "+15551234567", 99)!.activate).toMatch(/\*\*30#$/);
    expect(buildForwardCode("gsm_standard", "no_answer", "+15551234567", 1)!.activate).toMatch(/\*\*5#$/);
  });
  it("GSM unreachable and busy", () => {
    expect(buildForwardCode("gsm_standard", "unreachable", "+15551234567")!.activate).toBe("**62*+15551234567#");
    expect(buildForwardCode("gsm_standard", "busy", "+15551234567")!.activate).toBe("**67*+15551234567#");
  });
  it("Verizon is flagged as needing confirmation and has no unreachable code", () => {
    expect(buildForwardCode("verizon", "no_answer", "+15551234567")).toMatchObject({ activate: "*71" + "5551234567", cancel: "*73", confidence: "commonly_documented" });
    expect(buildForwardCode("verizon", "unreachable", "+15551234567")!.confidence).toBe("ask_carrier");
  });
  it("landline/VoIP/PBX never pretends to have a code", () => {
    expect(buildForwardCode("landline_voip_pbx", "no_answer", "+15551234567")).toMatchObject({ activate: "", confidence: "ask_carrier" });
  });
  it("rejects non-E.164 numbers (no code injection into a dial string)", () => {
    expect(buildForwardCode("gsm_standard", "no_answer", "555#*")).toBeNull();
    expect(planFor("gsm_standard", "bad")).toEqual([]);
    expect(planFor("gsm_standard", "+15551234567")).toHaveLength(3);
  });
});

const T0 = 1_000_000;
const chk = (kind: ForwardCheck["kind"], extra: Partial<ForwardCheck> = {}): ForwardCheck => ({
  id: "c", kind, businessNumber: "+15550001111", vireekNumber: "+15550002222", probeFrom: "+15550003333", startedAt: T0, expiresAt: expiryFor(T0, 20), ...extra,
});
const arrival = (o: Partial<{ to: string; from: string; forwardedFrom: string | null; at: number }> = {}) => ({ to: "+15550002222", from: "+15550003333", forwardedFrom: "+15550001111", at: T0 + 25_000, ...o });

describe("test-call wizard verification", () => {
  it("forward_on passes when the call arrives with ForwardedFrom = business number", () => {
    expect(evaluateForwardTest(chk("forward_on"), [arrival()], T0 + 26_000)).toBe("passed");
  });
  it("matches on probe caller ID when the carrier omits ForwardedFrom", () => {
    expect(evaluateForwardTest(chk("forward_on"), [arrival({ forwardedFrom: null })], T0 + 26_000)).toBe("passed");
  });
  it("does not accept an unrelated call, a wrong destination, or a late arrival", () => {
    const c = chk("forward_on");
    expect(arrivalMatches(c, arrival({ forwardedFrom: "+15559999999" }))).toBe(false);
    expect(arrivalMatches(c, arrival({ to: "+15550009999" }))).toBe(false);
    expect(arrivalMatches(c, arrival({ at: c.expiresAt + 1 }))).toBe(false);
    expect(arrivalMatches(c, arrival({ at: T0 - 1 }))).toBe(false);
  });
  it("is pending until the window closes, then failed", () => {
    const c = chk("forward_on", { outboundStatus: "ringing" });
    expect(evaluateForwardTest(c, [], T0 + 10_000)).toBe("pending");
    expect(evaluateForwardTest(c, [], c.expiresAt)).toBe("failed");
  });
  it("tells the user when a human answered (no forward is possible)", () => {
    expect(evaluateForwardTest(chk("forward_on", { outboundStatus: "in-progress" }), [], T0 + 10_000)).toBe("answered_by_human");
  });
  it("a failed outbound call is an error, not a forwarding verdict", () => {
    expect(evaluateForwardTest(chk("forward_on", { outboundStatus: "failed" }), [], T0)).toBe("error");
  });
  it("forward_off passes only if the call rang out and never reached Vireek", () => {
    const c = chk("forward_off", { outboundStatus: "no-answer" });
    expect(evaluateForwardTest(c, [], T0 + 10_000)).toBe("pending");
    expect(evaluateForwardTest(c, [], c.expiresAt)).toBe("passed");
    expect(evaluateForwardTest(c, [arrival()], T0 + 30_000)).toBe("failed");
    expect(evaluateForwardTest(chk("forward_off", { outboundStatus: "ringing" }), [], expiryFor(T0, 20))).toBe("expired");
  });
});

describe("communication copy", () => {
  it("owner alerts differ for degrade vs recovery and escalate severity", () => {
    expect(ownerAlert(0, 2).severity).toBe("warning");
    expect(ownerAlert(2, 3).severity).toBe("critical");
    const rec = ownerAlert(2, 0); expect(rec.severity).toBe("info"); expect(rec.title).toMatch(/recovered/);
    expect(ownerAlert(0, 3, "es").title).toMatch(/degradado/);
    expect(ownerAlert(0, 4).sms.length).toBeLessThanOrEqual(320);
  });
  it("public incident copy is generic: no vendor, phone or tenant data", () => {
    for (const lv of [0, 1, 2, 3, 4] as const) {
      const p = publicIncident(lv, 1);
      expect(JSON.stringify(p)).not.toMatch(/vapi|twilio|telnyx|\+\d|@/i);
    }
    expect(publicIncident(3, 0).impact).toBe("major"); expect(publicIncident(0, 2).resolved).toBe(true);
  });
});
