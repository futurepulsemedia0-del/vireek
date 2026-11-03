import { describe, expect, it } from "vitest";
import {
  applyPronunciations, normalizeSamples, prepareSpeechText, sanitizeTuning, tuningForScenario, toProviderSettings, DEFAULT_TUNING,
} from "./logic.ts";

describe("applyPronunciations", () => {
  const list = [{ match: "Puyallup", say: "pew-AL-up" }, { match: "Joe's HVAC", say: "Joes aitch-vac" }];
  it("replaces whole words case-insensitively", () => {
    expect(applyPronunciations("Welcome to puyallup!", list)).toBe("Welcome to pew-AL-up!");
  });
  it("prefers the longest match and does not touch substrings", () => {
    expect(applyPronunciations("Joe's HVAC in Puyallups", list)).toBe("Joes aitch-vac in Puyallups");
  });
  it("does not re-substitute its own output", () => {
    expect(applyPronunciations("Al", [{ match: "Al", say: "Al Al" }])).toBe("Al Al");
  });
  it("escapes regex metacharacters", () => {
    expect(applyPronunciations("Call A+B now", [{ match: "A+B", say: "ay plus bee" }])).toBe("Call ay plus bee now");
  });
});

describe("sanitizeTuning", () => {
  it("clamps and strips markup characters", () => {
    const t = sanitizeTuning({ speed: 9, warmth: -1, pauseMs: 99999, formality: "x", pronunciations: [{ match: "A", say: "<b>ay</b>" }] });
    expect(t).toMatchObject({ speed: 1.2, warmth: 0, pauseMs: 800, formality: "neutral" });
    expect(t.pronunciations[0].say).toBe("bay/b");
  });
  it("survives garbage", () => {
    expect(sanitizeTuning(null)).toEqual(DEFAULT_TUNING);
    expect(sanitizeTuning({ speed: "fast" }).speed).toBe(1);
  });
});

describe("scenarios + parity", () => {
  it("emergency is slower and calmer than sales", () => {
    const e = tuningForScenario(DEFAULT_TUNING, "emergency");
    const s = tuningForScenario(DEFAULT_TUNING, "sales");
    expect(e.speed).toBeLessThan(s.speed);
    expect(e.warmth).toBeLessThan(s.warmth);
  });
  it("explicit variant wins over preset", () => {
    expect(tuningForScenario(DEFAULT_TUNING, "emergency", { speed: 1.1 }).speed).toBe(1.1);
  });
  it("preview text equals production text for same input", () => {
    const t = sanitizeTuning({ pauseMs: 400, pronunciations: [{ match: "Puyallup", say: "pew-AL-up" }] });
    const a = prepareSpeechText("Hi. Puyallup plumbing here.", t);
    expect(a).toBe(prepareSpeechText("Hi. Puyallup plumbing here.", t));
    expect(a).toBe("Hi. ... pew-AL-up plumbing here.");
  });
  it("provider settings stay in range", () => {
    const p = toProviderSettings(sanitizeTuning({ warmth: 1, speed: 1.2 }));
    expect(p.stability).toBeGreaterThanOrEqual(0);
    expect(p.style).toBeLessThanOrEqual(1);
  });
});

describe("normalizeSamples", () => {
  it("never exceeds the peak ceiling and keeps silence silent", () => {
    const out = normalizeSamples(Float32Array.from([0.001, -0.9, 0.002, 0.5]), 0.5, 0.98);
    expect(Math.max(...out.map(Math.abs)) <= 0.98 + 1e-6).toBe(true);
    expect(normalizeSamples(new Float32Array(4))).toEqual(new Float32Array(4));
  });
});
