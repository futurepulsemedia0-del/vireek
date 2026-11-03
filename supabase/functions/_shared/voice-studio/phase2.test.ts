import { describe, expect, it } from "vitest";
import { canStartClone, generateLivenessPhrase, phraseMatches, sha256Hex, CONSENT_TEXT_V1 } from "./consent.ts";
import { assignArm, evaluateExperiment, twoProportion, validateArms } from "./ab.ts";
import { buildVapiPatch } from "./vapi.ts";
import { DEFAULT_TUNING } from "./logic.ts";

const now = new Date("2028-04-03T12:00:00Z");
const good = { user_id: "o1", status: "pending", attested: true, liveness_phrase: "amber river cedar delta", created_at: "2028-04-03T11:50:00Z" };

describe("consent gating", () => {
  it("allows a fresh pending attested consent for the same owner", () => expect(canStartClone(good, "o1", now)).toBe(true));
  it("blocks other tenants, missing rows, wrong status, no attestation", () => {
    expect(canStartClone(good, "o2", now)).toBe(false);
    expect(canStartClone(null, "o1", now)).toBe(false);
    expect(canStartClone({ ...good, status: "revoked" }, "o1", now)).toBe(false);
    expect(canStartClone({ ...good, status: "approved" }, "o1", now)).toBe(false);
    expect(canStartClone({ ...good, attested: false }, "o1", now)).toBe(false);
  });
  it("blocks expired and future-dated consents", () => {
    expect(canStartClone({ ...good, created_at: "2028-04-03T11:00:00Z" }, "o1", now)).toBe(false);
    expect(canStartClone({ ...good, created_at: "2028-04-03T13:00:00Z" }, "o1", now)).toBe(false);
  });
});

describe("liveness phrase", () => {
  it("generates distinct words", () => {
    let i = 0;
    const p = generateLivenessPhrase((n) => (i++ * 7) % n, 4).split(" ");
    expect(new Set(p).size).toBe(4);
  });
  it("matches in order, tolerant to case/punctuation, rejects missing or reordered", () => {
    const ph = "amber river cedar delta";
    expect(phraseMatches("Okay, Amber... river, cedar and Delta.", ph)).toBe(true);
    expect(phraseMatches("amber cedar river delta", ph)).toBe(false);
    expect(phraseMatches("amber river cedar", ph)).toBe(false);
    expect(phraseMatches("anything", "")).toBe(false);
  });
  it("hashes consent text deterministically", async () => {
    const h = await sha256Hex(CONSENT_TEXT_V1);
    expect(h).toBe(await sha256Hex(CONSENT_TEXT_V1));
    expect(h.length).toBe(64);
  });
});

describe("A/B assignment", () => {
  const arms = [{ key: "a", weight: 1 }, { key: "b", weight: 1 }];
  it("is deterministic", () => expect(assignArm("e1", "call-9", arms)).toBe(assignArm("e1", "call-9", arms)));
  it("splits ~50/50 over many calls", () => {
    let a = 0;
    for (let i = 0; i < 20000; i++) if (assignArm("exp", `c${i}`, arms) === "a") a++;
    expect(Math.abs(a / 20000 - 0.5) < 0.02).toBe(true);
  });
  it("respects weights", () => {
    let a = 0;
    for (let i = 0; i < 20000; i++) if (assignArm("exp", `c${i}`, [{ key: "a", weight: 9 }, { key: "b", weight: 1 }]) === "a") a++;
    expect(Math.abs(a / 20000 - 0.9) < 0.02).toBe(true);
  });
  it("rejects invalid arms", () => {
    expect(validateArms([{ key: "a", weight: 1 }])).toBe(false);
    expect(validateArms([{ key: "a", weight: 1 }, { key: "a", weight: 1 }])).toBe(false);
    expect(validateArms([{ key: "a", weight: 0 }, { key: "b", weight: 1 }])).toBe(false);
  });
});

describe("A/B statistics + guardrails", () => {
  it("z-test matches hand calculation", () => {
    const r = twoProportion(30, 100, 50, 100);
    expect(Math.abs(r.z - 2.887) < 0.01).toBe(true);
    expect(Math.abs(r.p - 0.0039) < 0.0005).toBe(true);
  });
  const c = { key: "ctl", calls: 1000, bookings: 300, hangups: 100 };
  it("insufficient data below minimum", () => {
    expect(evaluateExperiment([c, { key: "v", calls: 50, bookings: 40, hangups: 1 }]).status).toBe("insufficient_data");
  });
  it("declares a winner on significant booking lift without hang-up harm", () => {
    expect(evaluateExperiment([c, { key: "v", calls: 1000, bookings: 360, hangups: 100 }])).toEqual({ status: "winner", arm: "v" });
  });
  it("stops on hang-up regression even with more bookings", () => {
    expect(evaluateExperiment([c, { key: "v", calls: 1000, bookings: 360, hangups: 160 }])).toEqual({ status: "stop_guardrail", arm: "v" });
  });
  it("no difference when within noise", () => {
    expect(evaluateExperiment([c, { key: "v", calls: 1000, bookings: 305, hangups: 101 }]).status).toBe("no_difference");
  });
});

describe("vapi patch", () => {
  it("only ever patches `voice`", () => {
    const p = buildVapiPatch("vid", DEFAULT_TUNING);
    expect(Object.keys(p)).toEqual(["voice"]);
    expect(p.voice.voiceId).toBe("vid");
  });
});
