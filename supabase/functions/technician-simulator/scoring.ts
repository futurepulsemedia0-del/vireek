// supabase/functions/technician-simulator/scoring.ts
//
// Deterministic, explainable scoring. The AI writes the scenario and the
// coaching prose; it NEVER decides the score. Every point below can be traced
// to a concrete action the technician took, so a result is auditable and
// cannot be argued with or prompt-injected.

import type { Decision, Truth } from "./normalize.ts";

export type SimEvent =
  | { type: "question"; fact_ids: string[]; via: "topic" | "free_text"; t: string }
  | { type: "measurement"; id: string; t: string }
  | { type: "safety_ack"; ids: string[]; t: string }
  | { type: "safety_violation"; measurement_id: string; t: string };

export interface Submission {
  cause_id: string;
  part_ids: string[];
  decision: Decision;
  confidence: number; // 1-5, self-rated
}

export const SCORE_MAX = {
  diagnosis: 35,
  evidence: 20,
  information: 10,
  safety: 20,
  parts_decision: 10,
  calibration: 5,
} as const;

export const PASS_MARK = 70;

export type ScoreBreakdown = Record<keyof typeof SCORE_MAX, number>;

export interface ScoreResult {
  score: number;
  passed: boolean;
  diagnosis_correct: boolean;
  breakdown: ScoreBreakdown;
  flags: string[];
  stats: {
    measurements_taken: number;
    decisive_taken: number;
    noise_taken: number;
    minutes_spent: number;
    critical_facts_found: number;
    critical_facts_total: number;
    required_safety_done: number;
    required_safety_total: number;
    safety_violations: number;
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function acknowledgedSafety(events: SimEvent[]): Set<string> {
  const s = new Set<string>();
  for (const e of events) if (e.type === "safety_ack") for (const id of e.ids) s.add(id);
  return s;
}

export function requiredSafetyMet(truth: Truth, events: SimEvent[]): boolean {
  const acked = acknowledgedSafety(events);
  return truth.safety_checks.filter((s) => s.required).every((s) => acked.has(s.id));
}

export function scoreAttempt(truth: Truth, events: SimEvent[], sub: Submission): ScoreResult {
  const flags: string[] = [];

  // --- unique measurements, in the order the technician took them ---
  const measById = new Map(truth.measurements.map((m) => [m.id, m]));
  const takenIds = [...new Set(events.filter((e) => e.type === "measurement").map((e) => (e as { id: string }).id))];
  const taken = takenIds.map((id) => measById.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
  const decisiveTaken = taken.filter((m) => m.decisive).length;
  const isRelevant = (m: (typeof taken)[number]) =>
    m.decisive || m.supports_cause_ids.length > 0 || m.rules_out_cause_ids.length > 0;
  const noiseTaken = taken.filter((m) => !isRelevant(m)).length;
  const minutesSpent = taken.reduce((s, m) => s + m.minutes, 0);

  // --- 1. diagnosis (35) ---
  const chosen = truth.causes.find((c) => c.id === sub.cause_id);
  const diagnosisCorrect = !!chosen?.is_root;
  let diagnosis = 0;
  if (diagnosisCorrect) {
    diagnosis = decisiveTaken > 0 ? SCORE_MAX.diagnosis : 20;
    if (decisiveTaken === 0) flags.push("unverified_diagnosis");
  } else if (chosen?.near_miss) {
    diagnosis = 10;
  }

  // --- 2. evidence quality (20) = 12 decisive test + up to 8 efficiency ---
  let evidence = decisiveTaken > 0 ? 12 : 0;
  let efficiency = 0;
  if (taken.length === 0) {
    flags.push("no_measurements");
  } else {
    efficiency = 8 * (1 - noiseTaken / taken.length);
    if (minutesSpent > truth.par_minutes * 1.5) {
      efficiency -= 3;
      flags.push("over_time");
    }
  }
  evidence += clamp(efficiency, 0, 8);

  // --- 3. information gathering (10) ---
  const criticalIds = new Set(truth.facts.filter((f) => f.critical).map((f) => f.id));
  const askedIds = new Set<string>();
  for (const e of events) if (e.type === "question") for (const id of e.fact_ids) askedIds.add(id);
  const criticalFound = [...criticalIds].filter((id) => askedIds.has(id)).length;
  const information = criticalIds.size === 0 ? SCORE_MAX.information : SCORE_MAX.information * (criticalFound / criticalIds.size);

  // --- 4. safety (20) ---
  const required = truth.safety_checks.filter((s) => s.required);
  const acked = acknowledgedSafety(events);
  const requiredDone = required.filter((s) => acked.has(s.id)).length;
  const violations = events.filter((e) => e.type === "safety_violation").length;
  let safety = required.length === 0 ? SCORE_MAX.safety : SCORE_MAX.safety * (requiredDone / required.length);
  safety -= violations * 8;
  safety = clamp(safety, 0, SCORE_MAX.safety);
  if (violations > 0) flags.push("safety_violation");
  if (requiredDone < required.length) flags.push("missing_safety_checks");
  const safetyClean = violations === 0 && requiredDone === required.length;

  // --- 5. parts (6) + decision (4) ---
  const correctParts = new Set(truth.parts.filter((p) => p.correct).map((p) => p.id));
  const chosenParts = new Set(sub.part_ids.filter((id) => truth.parts.some((p) => p.id === id)));
  let f1: number;
  if (correctParts.size === 0) {
    f1 = chosenParts.size === 0 ? 1 : 0;
  } else {
    const tp = [...chosenParts].filter((id) => correctParts.has(id)).length;
    const precision = chosenParts.size === 0 ? 0 : tp / chosenParts.size;
    const recall = tp / correctParts.size;
    f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  }
  const partsDecision = 6 * f1 + (sub.decision === truth.correct_decision ? 4 : 0);

  // --- 6. calibration (5): does self-rated confidence match reality? ---
  const conf = (clamp(Math.round(sub.confidence), 1, 5) - 1) / 4;
  const calibration = SCORE_MAX.calibration * (1 - Math.abs((diagnosisCorrect ? 1 : 0) - conf));
  if (!diagnosisCorrect && conf >= 0.75) flags.push("overconfident");

  const breakdown: ScoreBreakdown = {
    diagnosis: Math.round(diagnosis),
    evidence: Math.round(evidence),
    information: Math.round(information),
    safety: Math.round(safety),
    parts_decision: Math.round(partsDecision),
    calibration: Math.round(calibration),
  };
  const score = clamp(Object.values(breakdown).reduce((a, b) => a + b, 0), 0, 100);

  // Hard gates: a high score can never buy a pass without the right diagnosis and clean safety.
  const passed = score >= PASS_MARK && diagnosisCorrect && safetyClean;

  return {
    score,
    passed,
    diagnosis_correct: diagnosisCorrect,
    breakdown,
    flags,
    stats: {
      measurements_taken: taken.length,
      decisive_taken: decisiveTaken,
      noise_taken: noiseTaken,
      minutes_spent: minutesSpent,
      critical_facts_found: criticalFound,
      critical_facts_total: criticalIds.size,
      required_safety_done: requiredDone,
      required_safety_total: required.length,
      safety_violations: violations,
    },
  };
}
