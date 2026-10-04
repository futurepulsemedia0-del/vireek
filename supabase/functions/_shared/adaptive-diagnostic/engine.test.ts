import { describe, it, expect } from "vitest";
import {
  applyAnswer, blendLikelihoods, blendPriors, classifyDomain, computePosterior, detectHazard,
  entropyBits, expectedGainBits, normalize, pickNext, realizedGain,
  type DiagHypothesis, type DiagQuestion, type Likelihoods,
} from "./engine";

const hyps: DiagHypothesis[] = [
  { code: "cap", label: "Capacitor", prior: 0.4, safety: "none" },
  { code: "ref", label: "Refrigerant", prior: 0.35, safety: "none" },
  { code: "fil", label: "Filter", prior: 0.25, safety: "none" },
];
const qs: DiagQuestion[] = [
  { code: "hum", text: "Outdoor unit humming?", effort: 1, status: "active", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
  { code: "ice", text: "Ice on pipes?", effort: 2, status: "active", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
  { code: "age", text: "Age?", effort: 1, status: "active", options: [{ id: "old", label: "Old" }, { id: "new", label: "New" }] },
];
const seed: Likelihoods = {
  cap: { hum: [0.9, 0.1], ice: [0.05, 0.95], age: [0.5, 0.5] },
  ref: { hum: [0.1, 0.9], ice: [0.6, 0.4], age: [0.5, 0.5] },
  fil: { hum: [0.1, 0.9], ice: [0.5, 0.5], age: [0.5, 0.5] },
};
const qmap = new Map(qs.map((q) => [q.code, q]));
const prior = blendPriors(hyps, {});

describe("engine", () => {
  it("normalizes and measures entropy", () => {
    expect(normalize({ a: 2, b: 2 })).toEqual({ a: 0.5, b: 0.5 });
    expect(entropyBits({ a: 0.5, b: 0.5 })).toBeCloseTo(1, 6);
  });
  it("updates the posterior toward the matching hypothesis", () => {
    const post = applyAnswer(prior, seed, qs[0], "yes");
    expect(post.cap).toBeGreaterThan(0.8);
  });
  it("treats 'unsure' as no information", () => {
    expect(applyAnswer(prior, seed, qs[0], "unsure")).toEqual(prior);
  });
  it("gives a useless question zero gain and picks an informative one first", () => {
    expect(expectedGainBits(prior, seed, qs[2])).toBeCloseTo(0, 6);
    const next = pickNext(prior, seed, qs, new Set(), { seed: "s" });
    expect(next.question?.code).toBe("hum");
  });
  it("stops when confident", () => {
    const post = computePosterior(prior, seed, qmap, [{ q: "hum", a: "yes" }, { q: "ice", a: "no" }]);
    expect(pickNext(post, seed, qs, new Set(["hum", "ice"])).stop).toBe("confident");
  });
  it("is deterministic for the same session seed", () => {
    const a = pickNext(prior, seed, qs, new Set(), { seed: "x" });
    const b = pickNext(prior, seed, qs, new Set(), { seed: "x" });
    expect(a.question?.code).toBe(b.question?.code);
  });
  it("learns: observed counts move likelihoods away from the seed", () => {
    const before = blendLikelihoods(seed, {}, qs).ref.hum[0];
    const after = blendLikelihoods(seed, { ref: { hum: [30, 0] } }, qs).ref.hum[0];
    expect(after).toBeGreaterThan(before);
  });
  it("detects hazards deterministically", () => {
    expect(detectHazard("I smell gas near the furnace")).toBe(true);
    expect(detectHazard("burning smell from the unit")).toBe(true);
    expect(detectHazard("AC blows warm air")).toBe(false);
  });
  it("classifies the complaint domain", () => {
    expect(classifyDomain("AC not cooling", [{ code: "cool", keywords: ["cool", "ac "] }, { code: "heat", keywords: ["heat"] }])).toBe("cool");
    expect(classifyDomain("roof", [{ code: "cool", keywords: ["cool"] }])).toBeNull();
  });
  it("measures realized gain as change in probability of the truth", () => {
    expect(realizedGain({ a: 0.4, b: 0.6 }, { a: 0.9, b: 0.1 }, "a")).toBeCloseTo(0.5, 6);
  });
});
