import { describe, expect, it } from "vitest";
import { ALL_HEALTHY, DEFAULT_LADDER, degradeFrom, healthFromScore, initialLadder, stepLadder, targetLevel, type ComponentHealth, type Level } from "./ladder.ts";
import { detectEmergencyGather, detectEmergencyText } from "./emergencyFastPath.ts";
import { emergencyTwiml, forwardTwiml, staticTwiml, twimlForLevel, voicemailTwiml, type FallbackCtx } from "./twimlFallback.ts";

const h = (p: Partial<ComponentHealth>): ComponentHealth => ({ ...ALL_HEALTHY, ...p });
const ctx = (targets: string[] = ["+15551230001", "+15551230002"]): FallbackCtx => ({
  businessName: "Acme HVAC & Sons", forwardTargets: targets, language: "en", hook: (a, p) => `https://x.test/fd?action=${a}&${new URLSearchParams(p ?? {})}`,
});

describe("targetLevel: failure injection per ladder level", () => {
  it("L0 when everything is healthy", () => expect(targetLevel(ALL_HEALTHY)).toBe(0));
  it("L1 when tools fail but the engine works", () => expect(targetLevel(h({ tools: "down" }))).toBe(1));
  it("L1 when the engine is merely degraded", () => expect(targetLevel(h({ engine: "degraded" }))).toBe(1));
  it("L2 when the engine is down and voicemail+alerts work", () => expect(targetLevel(h({ engine: "down" }))).toBe(2));
  it("L3 when engine is down and owner alerts are down but forwarding works", () => expect(targetLevel(h({ engine: "down", notify: "down" }))).toBe(3));
  it("L3 when engine and voicemail are down but forwarding works", () => expect(targetLevel(h({ engine: "down", voicemail: "down" }))).toBe(3));
  it("L4 when engine, voicemail and forwarding are all down", () => expect(targetLevel(h({ engine: "down", voicemail: "down", forward: "down" }))).toBe(4));
  it("still L2 (capture the message) when nobody can be alerted or forwarded to", () => expect(targetLevel(h({ engine: "down", notify: "down", forward: "down" }))).toBe(2));
  it("maps scores to health; no data is not a failure", () => {
    expect(healthFromScore(null)).toBe("healthy");
    expect(healthFromScore(79)).toBe("degraded");
    expect(healthFromScore(39)).toBe("down");
  });
});

describe("hysteresis", () => {
  const t0 = 1_000_000;
  it("escalates only after the worse target persists, then jumps straight to it", () => {
    let s = initialLadder(t0);
    let r = stepLadder(s, 3, t0 + 1000); expect(r.changed).toBe(false); s = r.state;
    r = stepLadder(s, 3, t0 + 1000 + DEFAULT_LADDER.escalateAfterMs); expect(r.to).toBe(3); expect(r.changed).toBe(true);
  });
  it("a blip that clears resets the pending escalation", () => {
    let s = stepLadder(initialLadder(t0), 2, t0 + 1000).state;
    s = stepLadder(s, 0, t0 + 30_000).state;
    expect(s.pending).toBeNull();
    const r = stepLadder(s, 2, t0 + 100_000); expect(r.changed).toBe(false);
  });
  const atL3 = (): ReturnType<typeof initialLadder> => ({ ...initialLadder(t0), level: 3, since: t0 });
  it("never recovers inside the minimum dwell", () => {
    const r = stepLadder(atL3(), 0, t0 + 1000); expect(r.changed).toBe(false); expect(r.reason).toBe("min dwell");
  });
  it("recovers ONE level at a time after sustained health", () => {
    let s = stepLadder(atL3(), 0, t0 + DEFAULT_LADDER.minDwellMs + 1).state;
    const r = stepLadder(s, 0, t0 + DEFAULT_LADDER.minDwellMs + 1 + DEFAULT_LADDER.recoverAfterMs);
    expect(r.to).toBe(2);
    s = r.state;
    const r2 = stepLadder(s, 0, r.state.since + 1); expect(r2.changed).toBe(false);
  });
  it("flap guard freezes recovery but never escalation", () => {
    const now = t0 + 10 * 60_000;
    const flapping = { ...initialLadder(now), level: 2 as Level, since: now - 10 * 60_000, recent: Array.from({ length: 6 }, (_, i) => now - i * 60_000) };
    expect(stepLadder(flapping, 0, now).reason).toMatch(/flap/);
    let s = stepLadder(flapping, 4, now).state;
    expect(stepLadder(s, 4, now + DEFAULT_LADDER.escalateAfterMs).to).toBe(4);
  });
  it("an operator pin overrides automation until it expires", () => {
    const pinned = { ...initialLadder(t0), pin: { level: 3 as Level, until: t0 + 60_000, by: "ops" } };
    expect(stepLadder(pinned, 0, t0 + 1000).to).toBe(3);
    expect(stepLadder(pinned, 0, t0 + 120_000).state.pin).toBeNull();
  });
});

describe("degradeFrom: a failing call always moves strictly down the ladder", () => {
  it("never returns the same or a better level", () => {
    for (const lv of [0, 1, 2, 3] as Level[]) for (const hh of [undefined, ALL_HEALTHY, h({ voicemail: "down" }), h({ forward: "down" }), h({ voicemail: "down", forward: "down" })]) {
      expect(degradeFrom(lv, hh)).toBeGreaterThan(lv);
    }
    expect(degradeFrom(4)).toBe(4);
  });
  it("skips levels whose dependency is down", () => {
    expect(degradeFrom(1, h({ voicemail: "down" }))).toBe(3);
    expect(degradeFrom(2, h({ forward: "down" }))).toBe(4);
  });
});

describe("TwiML at every degraded level offers the emergency path", () => {
  it("L2 voicemail: emergency gather precedes the recorder, transcription on", () => {
    const x = twimlForLevel(2, ctx());
    expect(x.indexOf("<Gather")).toBeLessThan(x.indexOf("<Record"));
    expect(x).toContain("press 1");
    expect(x).toContain('transcribe="true"');
    expect(x).toContain("Acme HVAC &amp; Sons"); // escaped
  });
  it("L3 forwards to the first target with an action that advances to the next", () => {
    const x = twimlForLevel(3, ctx());
    expect(x).toContain("<Number>+15551230001</Number>");
    expect(x).toContain("forward-done");
    expect(forwardTwiml(ctx(), 1, false)).toContain("+15551230002");
  });
  it("L3 without any target degrades to voicemail, not silence", () => {
    expect(twimlForLevel(3, ctx([]))).toContain("<Record");
  });
  it("running out of targets ends in voicemail with a 'no one available' prompt", () => {
    const x = forwardTwiml(ctx(), 2, true);
    expect(x).toContain("<Record"); expect(x).not.toContain("<Dial");
  });
  it("L4 static: safety message, 911, and still an emergency key when a number exists", () => {
    const x = staticTwiml(ctx());
    expect(x).toContain("9 1 1"); expect(x).toContain("<Gather"); expect(x).toContain("<Hangup/>");
  });
  it("L4 with no number at all still says something and hangs up cleanly", () => {
    const x = staticTwiml(ctx([]));
    expect(x).not.toContain("<Gather"); expect(x).toContain("9 1 1");
  });
  it("emergency path dials immediately at any level and escapes XML in numbers", () => {
    const x = emergencyTwiml(ctx());
    expect(x).toContain('timeout="30"'); expect(x).toContain("emergency");
    expect(voicemailTwiml({ ...ctx(), businessName: '"><Dial>' }).includes("<Dial>")).toBe(false);
  });
  it("Spanish prompts are used when configured", () => {
    expect(voicemailTwiml({ ...ctx(), language: "es" })).toContain("emergencia");
  });
});

describe("emergency fast-path (works with no engine, no LLM)", () => {
  it.each(["I smell gas in the kitchen", "there's smoke coming from the panel", "pipe burst and water everywhere", "huele a gas", "carbon monoxide alarm is going off", "this is an emergency"])(
    "detects %s", (t) => expect(detectEmergencyText(t).emergency).toBe(true),
  );
  it.each(["I need a quote for a new thermostat", "can someone come Tuesday", ""])("ignores %s", (t) => expect(detectEmergencyText(t).emergency).toBe(false));
  it("respects an explicit negation of the generic word only", () => {
    expect(detectEmergencyText("this is not an emergency").emergency).toBe(false);
    expect(detectEmergencyText("not an emergency but I smell gas").emergency).toBe(true);
  });
  it("keypad 1 always wins", () => expect(detectEmergencyGather({ Digits: "1" }).emergency).toBe(true));
  it("other digits do not", () => expect(detectEmergencyGather({ Digits: "2" }).emergency).toBe(false));
});
