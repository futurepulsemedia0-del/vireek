import { describe, expect, it } from "vitest";
import { normalizeScenario, extractJson, type Truth } from "./normalize.ts";
import { scoreAttempt, requiredSafetyMet, type SimEvent } from "./scoring.ts";

const raw = {
  title: "AC runs, no cooling",
  customer_complaint: "The AC runs all day but the house stays warm.",
  environment: "Summer, 96F outside.",
  equipment: { type: "Split AC", make: "Acme", model: "X1", age_years: 9 },
  causes: [
    { id: "a", label: "Failed run capacitor", is_root: true },
    { id: "b", label: "Low refrigerant charge", is_root: false, near_miss: true },
    { id: "c", label: "Dirty condenser coil", is_root: false },
    { id: "d", label: "Failed contactor", is_root: false },
  ],
  measurements: Array.from({ length: 9 }, (_, i) => ({
    id: `x${i}`, label: `Test ${i}`, tool: "Meter", location: "Unit", reading: `${i} V`,
    supports_cause_ids: i === 0 ? ["a"] : i === 1 ? ["c"] : [],
    rules_out_cause_ids: i === 2 ? ["d"] : [],
    decisive: i === 0, intrusive: i === 0, minutes: 5,
  })),
  customer_facts: [
    { id: "1", topic: "Onset", answer: "Two days ago", critical: true },
    { id: "2", topic: "Noise", answer: "Humming", critical: false },
    { id: "3", topic: "Filter", answer: "Changed", critical: false },
    { id: "4", topic: "Breaker", answer: "Not tripped", critical: false },
  ],
  safety_checks: [
    { id: "s1", label: "Disconnect power", required: true },
    { id: "s2", label: "Discharge capacitor", required: true },
    { id: "s3", label: "PPE", required: false },
  ],
  parts: [
    { id: "p1", label: "Run capacitor", correct: true },
    { id: "p2", label: "Contactor", correct: false },
    { id: "p3", label: "Compressor", correct: false },
    { id: "p4", label: "Fan motor", correct: false },
  ],
  correct_decision: "repair_now",
  decision_rationale: "Capacitor swap on site.",
  par_minutes: 25,
};

function build(seedRnd = () => 0.3) {
  const r = normalizeScenario(raw, { trade: "hvac", difficulty: "foundation" }, seedRnd);
  if (!r.ok) throw new Error(r.errors.join(","));
  return r;
}

describe("normalizeScenario", () => {
  it("accepts a valid scenario and never leaks truth into the brief", () => {
    const { brief, truth } = build();
    const s = JSON.stringify(brief);
    expect(s).not.toContain("is_root");
    expect(s).not.toContain("reading");
    expect(s).not.toContain("decisive");
    expect(s).not.toContain("critical");
    expect(truth.causes.filter((c) => c.is_root)).toHaveLength(1);
  });

  it("re-issues ids after shuffling (root is not always c1)", () => {
    const roots = new Set<string>();
    for (let seed = 1; seed < 40; seed++) {
      let x = seed;
      const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
      const r = normalizeScenario(raw, { trade: "hvac", difficulty: "foundation" }, rnd);
      if (r.ok) roots.add(r.truth.causes.find((c) => c.is_root)!.id);
    }
    expect(roots.size).toBeGreaterThan(1);
  });

  it("rejects two root causes and missing decisive test", () => {
    const bad = { ...raw, causes: raw.causes.map((c) => ({ ...c, is_root: true })) };
    expect(normalizeScenario(bad, { trade: "hvac", difficulty: "foundation" }).ok).toBe(false);
    const noDecisive = { ...raw, measurements: raw.measurements.map((m) => ({ ...m, decisive: false })) };
    expect(normalizeScenario(noDecisive, { trade: "hvac", difficulty: "foundation" }).ok).toBe(false);
  });

  it("extractJson survives code fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson("nope")).toBeNull();
  });
});

function ids(truth: Truth) {
  const root = truth.causes.find((c) => c.is_root)!;
  const decisive = truth.measurements.find((m) => m.decisive)!;
  const noise = truth.measurements.find((m) => !m.decisive && !m.supports_cause_ids.length && !m.rules_out_cause_ids.length)!;
  const required = truth.safety_checks.filter((s) => s.required).map((s) => s.id);
  const critical = truth.facts.filter((f) => f.critical).map((f) => f.id);
  const parts = truth.parts.filter((p) => p.correct).map((p) => p.id);
  return { root, decisive, noise, required, critical, parts };
}
const t = "2026-01-01T00:00:00Z";

describe("scoreAttempt", () => {
  it("gives a perfect run 100 and a pass", () => {
    const { truth } = build();
    const i = ids(truth);
    const events: SimEvent[] = [
      { type: "safety_ack", ids: i.required, t },
      { type: "question", fact_ids: i.critical, via: "topic", t },
      { type: "measurement", id: i.decisive.id, t },
    ];
    const r = scoreAttempt(truth, events, { cause_id: i.root.id, part_ids: i.parts, decision: "repair_now", confidence: 5 });
    expect(r.score).toBe(100);
    expect(r.passed).toBe(true);
  });

  it("caps an unverified lucky guess and blocks the pass", () => {
    const { truth } = build();
    const i = ids(truth);
    const events: SimEvent[] = [{ type: "safety_ack", ids: i.required, t }];
    const r = scoreAttempt(truth, events, { cause_id: i.root.id, part_ids: i.parts, decision: "repair_now", confidence: 5 });
    expect(r.flags).toContain("unverified_diagnosis");
    expect(r.breakdown.diagnosis).toBe(20);
    expect(r.passed).toBe(false);
  });

  it("a safety violation blocks the pass even with a high score", () => {
    const { truth } = build();
    const i = ids(truth);
    const events: SimEvent[] = [
      { type: "safety_violation", measurement_id: i.decisive.id, t },
      { type: "safety_ack", ids: i.required, t },
      { type: "question", fact_ids: i.critical, via: "topic", t },
      { type: "measurement", id: i.decisive.id, t },
    ];
    const r = scoreAttempt(truth, events, { cause_id: i.root.id, part_ids: i.parts, decision: "repair_now", confidence: 5 });
    expect(r.breakdown.safety).toBe(12);
    expect(r.passed).toBe(false);
  });

  it("penalises noise, wrong cause and overconfidence", () => {
    const { truth } = build();
    const i = ids(truth);
    const wrong = truth.causes.find((c) => !c.is_root && !c.near_miss)!;
    const events: SimEvent[] = [{ type: "measurement", id: i.noise.id, t }];
    const r = scoreAttempt(truth, events, { cause_id: wrong.id, part_ids: [], decision: "quote_and_schedule", confidence: 5 });
    expect(r.diagnosis_correct).toBe(false);
    expect(r.flags).toContain("overconfident");
    expect(r.passed).toBe(false);
    expect(r.breakdown.calibration).toBe(0);
  });

  it("de-duplicates repeated measurements and gates on required safety", () => {
    const { truth } = build();
    const i = ids(truth);
    const events: SimEvent[] = [
      { type: "measurement", id: i.decisive.id, t },
      { type: "measurement", id: i.decisive.id, t },
    ];
    expect(scoreAttempt(truth, events, { cause_id: i.root.id, part_ids: [], decision: "repair_now", confidence: 3 }).stats.measurements_taken).toBe(1);
    expect(requiredSafetyMet(truth, events)).toBe(false);
    expect(requiredSafetyMet(truth, [{ type: "safety_ack", ids: i.required, t }])).toBe(true);
  });
});
