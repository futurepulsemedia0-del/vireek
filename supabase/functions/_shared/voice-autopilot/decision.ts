// supabase/functions/_shared/voice-autopilot/decision.ts
//
// Pure decision engine: given pre-registered settings and per-arm outcome rows, decide what Voice Autopilot may do.
// Priority: ROLLBACK (any time) > locks > data sufficiency > sequential look > promotion gate.
// An UNKNOWN guardrail (no data) never counts as "passed": it blocks promotion.

import { isBooked, classifyCallScenario, type ScenarioKey } from "../call-scripts/logic.ts";
import {
  ABSOLUTE_MIN_PER_ARM, K_LOOKS, diffBinary, diffContinuous, evaluateLook, guardrailStats, lookThresholds, nextLookDue,
  type BinaryTally, type ContinuousTally, type DiffStat, type Interval, type LookResult,
} from "./stats.ts";

// ---------- metrics ----------
export type MetricId =
  | "qualified_booking_rate" | "abandon_rate" | "time_to_book_seconds" | "emergency_detection_accuracy" | "customer_sentiment"
  | "complaint_rate" | "escalation_rate" | "compliance_flag_rate" | "latency_ms";

export interface MetricDef { id: MetricId; kind: "binary" | "continuous"; higherIsBetter: boolean; role: "primary" | "guardrail"; defaultMargin: number }

export const METRICS: Record<MetricId, MetricDef> = {
  qualified_booking_rate: { id: "qualified_booking_rate", kind: "binary", higherIsBetter: true, role: "primary", defaultMargin: 0 },
  abandon_rate: { id: "abandon_rate", kind: "binary", higherIsBetter: false, role: "primary", defaultMargin: 0 },
  time_to_book_seconds: { id: "time_to_book_seconds", kind: "continuous", higherIsBetter: false, role: "primary", defaultMargin: 0 },
  emergency_detection_accuracy: { id: "emergency_detection_accuracy", kind: "binary", higherIsBetter: true, role: "primary", defaultMargin: 0 },
  customer_sentiment: { id: "customer_sentiment", kind: "continuous", higherIsBetter: true, role: "primary", defaultMargin: 0 },
  // Guardrail margins = the largest harm we accept (absolute, in the metric's units).
  complaint_rate: { id: "complaint_rate", kind: "binary", higherIsBetter: false, role: "guardrail", defaultMargin: 0.02 },
  escalation_rate: { id: "escalation_rate", kind: "binary", higherIsBetter: false, role: "guardrail", defaultMargin: 0.03 },
  compliance_flag_rate: { id: "compliance_flag_rate", kind: "binary", higherIsBetter: false, role: "guardrail", defaultMargin: 0 },
  latency_ms: { id: "latency_ms", kind: "continuous", higherIsBetter: false, role: "guardrail", defaultMargin: 150 },
};
export const PRIMARY_METRIC_IDS = (Object.values(METRICS).filter((m) => m.role === "primary").map((m) => m.id)) as MetricId[];
export const GUARDRAIL_IDS = (Object.values(METRICS).filter((m) => m.role === "guardrail").map((m) => m.id)) as MetricId[];

// ---------- per-call outcome rows -> tallies ----------
export interface CallOutcome {
  booked: boolean;
  abandoned: boolean;
  /** Seconds to booking (only for booked calls); null if unknown. */
  timeToBookSeconds: number | null;
  /** null = no ground-truth label; the call is then NOT counted for emergency accuracy. */
  emergencyCorrect: boolean | null;
  /** -1..1; null when sentiment is unknown. */
  sentiment: number | null;
  complaint: boolean;
  escalated: boolean;
  complianceFlag: boolean;
  /** Any compliance finding of severity high/critical (hard stop). */
  criticalCompliance: boolean;
  latencyMs: number | null;
}

export interface CallRowForOutcome {
  is_emergency: boolean; intent: string | null; status: string; is_voicemail: boolean; booking_outcome: string | null;
  sentiment: string | null; duration_seconds: number | null; call_score?: number | null;
}
export const ABANDON_MAX_SECONDS = 15;

const SENTIMENT: Record<string, number> = { positive: 1, neutral: 0, negative: -1 };

/** Heuristics are explicit and shown in the UI: abandon = <=15 s, not booked, not voicemail. */
export function outcomeFromCall(
  call: CallRowForOutcome,
  extra: { afterHours: boolean; escalated: boolean; complianceFindings: ("low" | "medium" | "high" | "critical")[]; latencyMs: number | null; emergencyLabel: boolean | null },
): CallOutcome {
  const booked = isBooked(call);
  const dur = call.duration_seconds;
  const complaint = classifyCallScenario(call, extra.afterHours) === "complaint";
  return {
    booked,
    abandoned: !booked && !call.is_voicemail && dur !== null && dur <= ABANDON_MAX_SECONDS,
    timeToBookSeconds: booked && dur !== null ? dur : null,
    emergencyCorrect: extra.emergencyLabel,
    sentiment: call.sentiment && call.sentiment in SENTIMENT ? SENTIMENT[call.sentiment] : null,
    complaint,
    escalated: extra.escalated,
    complianceFlag: extra.complianceFindings.length > 0,
    criticalCompliance: extra.complianceFindings.some((s) => s === "high" || s === "critical"),
    latencyMs: extra.latencyMs,
  };
}

export type MetricTally = { kind: "binary"; t: BinaryTally } | { kind: "continuous"; t: ContinuousTally };

function binary(rows: CallOutcome[], pick: (r: CallOutcome) => boolean | null): BinaryTally {
  let n = 0, k = 0;
  for (const r of rows) { const v = pick(r); if (v === null) continue; n++; if (v) k++; }
  return { n, k };
}
function continuous(rows: CallOutcome[], pick: (r: CallOutcome) => number | null): ContinuousTally {
  const xs: number[] = [];
  for (const r of rows) { const v = pick(r); if (v !== null && Number.isFinite(v)) xs.push(v); }
  const n = xs.length;
  if (n === 0) return { n: 0, mean: 0, variance: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, variance };
}

export function tallyArm(rows: CallOutcome[]): Record<MetricId, MetricTally> {
  return {
    qualified_booking_rate: { kind: "binary", t: binary(rows, (r) => r.booked) },
    abandon_rate: { kind: "binary", t: binary(rows, (r) => r.abandoned) },
    time_to_book_seconds: { kind: "continuous", t: continuous(rows, (r) => r.timeToBookSeconds) },
    emergency_detection_accuracy: { kind: "binary", t: binary(rows, (r) => r.emergencyCorrect) },
    customer_sentiment: { kind: "continuous", t: continuous(rows, (r) => r.sentiment) },
    complaint_rate: { kind: "binary", t: binary(rows, (r) => r.complaint) },
    escalation_rate: { kind: "binary", t: binary(rows, (r) => r.escalated) },
    compliance_flag_rate: { kind: "binary", t: binary(rows, (r) => r.complianceFlag) },
    latency_ms: { kind: "continuous", t: continuous(rows, (r) => r.latencyMs) },
  };
}

export function diffMetric(c: MetricTally, h: MetricTally): DiffStat | null {
  if (c.kind === "binary" && h.kind === "binary") return diffBinary(c.t, h.t);
  if (c.kind === "continuous" && h.kind === "continuous") return diffContinuous(c.t, h.t);
  return null;
}

// ---------- pre-registration ----------
export interface Prereg {
  primaryMetric: MetricId;
  /** Pre-registered max sample per arm; looks are at 25/50/75/100 % of it. */
  nMaxPerArm: number;
  /** Minimum improvement worth shipping (in the primary metric's units). */
  minEffect: number;
  guardrailMargins: Partial<Record<MetricId, number>>;
  /** Guardrails the owner explicitly accepted not measuring (e.g. latency not instrumented). Recorded in the pre-registration.
   * complaint_rate and compliance_flag_rate can NEVER be waived. */
  waivedGuardrails?: MetricId[];
}
export const NON_WAIVABLE: readonly MetricId[] = ["complaint_rate", "compliance_flag_rate"];

export type AutopilotMode = "off" | "suggest" | "auto";
export interface AutopilotLimits {
  mode: AutopilotMode;
  maxTrafficPct: number;
  maxAutoPromotionsPerWeek: number;
  autoPromotionsThisWeek: number;
  /** Scenarios that can never be promoted automatically. */
  humanOnlyScenarios: ScenarioKey[];
}
export const DEFAULT_LIMITS: AutopilotLimits = {
  mode: "suggest", maxTrafficPct: 20, maxAutoPromotionsPerWeek: 1, autoPromotionsThisWeek: 0, humanOnlyScenarios: ["emergency", "complaint"],
};

// ---------- evaluation ----------
export type Decision = "continue" | "insufficient_data" | "promote_ready" | "stop_harm" | "inconclusive" | "rollback" | "blocked_by_lock";

export interface GuardrailReport {
  metric: MetricId;
  status: "pass" | "unknown" | "waived" | "fail_promote" | "breach";
  margin: number;
  harm: number | null;
  harmUpper95: number | null;
  n: { control: number; challenger: number };
}

export interface Evaluation {
  decision: Decision;
  reasons: string[]; // stable reason codes; UI maps them to i18n
  look: LookResult | null;
  lookIndex: number | null;
  primary: { metric: MetricId; control: MetricTally; challenger: MetricTally; diff: DiffStat | null };
  guardrails: GuardrailReport[];
  nMin: number;
  thresholds: number[];
  /** true if a favourable stop happened before the final look (estimate is likely inflated). */
  earlyStop: boolean;
  /** Final interval to report when the experiment is concluded (repeated CI at the deciding look). */
  reportInterval: Interval | null;
}

export interface EvaluateInput {
  prereg: Prereg;
  control: CallOutcome[];
  challenger: CallOutcome[];
  lastLookDone: number;
  lockOk: boolean;
}

const tallyN = (m: MetricTally) => m.t.n;

export function evaluateExperiment(input: EvaluateInput): Evaluation {
  const { prereg } = input;
  const metric = METRICS[prereg.primaryMetric];
  const tc = tallyArm(input.control);
  const th = tallyArm(input.challenger);
  const nMin = Math.min(tallyN(tc[prereg.primaryMetric]), tallyN(th[prereg.primaryMetric]));
  const thresholds = lookThresholds(prereg.nMaxPerArm);
  const pDiff = diffMetric(tc[prereg.primaryMetric], th[prereg.primaryMetric]);
  const reasons: string[] = [];

  // ---- guardrails ----
  const guardrails: GuardrailReport[] = GUARDRAIL_IDS.map((id) => {
    const def = METRICS[id];
    const margin = prereg.guardrailMargins[id] ?? def.defaultMargin;
    const n = { control: tallyN(tc[id]), challenger: tallyN(th[id]) };
    const d = n.control >= ABSOLUTE_MIN_PER_ARM && n.challenger >= ABSOLUTE_MIN_PER_ARM ? diffMetric(tc[id], th[id]) : null;
    const waived = (prereg.waivedGuardrails ?? []).includes(id) && !NON_WAIVABLE.includes(id);
    if (!d) return { metric: id, status: waived ? "waived" : "unknown", margin, harm: null, harmUpper95: null, n };
    const g = guardrailStats(d, def.higherIsBetter);
    const status = g.harmLower3 > margin ? "breach" : g.harmUpper95 > margin ? "fail_promote" : "pass";
    return { metric: id, status, margin, harm: g.harm, harmUpper95: g.harmUpper95, n };
  });
  const base = {
    primary: { metric: prereg.primaryMetric, control: tc[prereg.primaryMetric], challenger: th[prereg.primaryMetric], diff: pDiff },
    guardrails, nMin, thresholds, earlyStop: false, reportInterval: null as Interval | null,
  };

  // ---- 1. rollback: critical compliance or guardrail breach, evaluated at any time ----
  if (input.challenger.some((r) => r.criticalCompliance)) {
    return { ...base, decision: "rollback", reasons: ["critical_compliance_flag"], look: null, lookIndex: null };
  }
  const breached = guardrails.filter((g) => g.status === "breach");
  if (breached.length) {
    return { ...base, decision: "rollback", reasons: breached.map((g) => `guardrail_breach:${g.metric}`), look: null, lookIndex: null };
  }
  // ---- 2. lock ----
  if (!input.lockOk) return { ...base, decision: "blocked_by_lock", reasons: ["lock_violation"], look: null, lookIndex: null };

  // ---- 3. sequential look (the ONLY place a win/loss can be declared) ----
  const lookIndex = nextLookDue(nMin, prereg.nMaxPerArm, input.lastLookDone);
  if (lookIndex === null || !pDiff) {
    return { ...base, decision: nMin < thresholds[0] ? "insufficient_data" : "continue", reasons: [nMin < thresholds[0] ? "below_first_look" : "waiting_for_next_look"], look: null, lookIndex: null };
  }
  const look = evaluateLook(pDiff, lookIndex, metric.higherIsBetter);
  const final = lookIndex === K_LOOKS;
  const withLook = { ...base, look, lookIndex, reportInterval: look.rci };

  if (look.verdict === "control_better") return { ...withLook, decision: "stop_harm", reasons: ["challenger_worse"] };
  if (look.verdict === "no_boundary_crossed") {
    return final ? { ...withLook, decision: "inconclusive", reasons: ["no_significant_difference_at_final_look"] } : { ...withLook, decision: "continue", reasons: ["no_boundary_crossed"] };
  }
  // challenger_better: promotion gate
  const gate: string[] = [];
  const goodDirection = metric.higherIsBetter ? look.estimate : -look.estimate;
  if (goodDirection < prereg.minEffect) gate.push("effect_below_minimum");
  for (const g of guardrails) {
    if (g.status === "unknown") gate.push(`guardrail_unknown:${g.metric}`);
    else if (g.status === "fail_promote") gate.push(`guardrail_not_proven_safe:${g.metric}`);
  }
  if (gate.length) return { ...withLook, decision: "continue", reasons: gate, earlyStop: false };
  return { ...withLook, decision: "promote_ready", reasons: ["significant_and_guardrails_pass"], earlyStop: !final };
}

// ---------- what the system may DO ----------
export type Action = "none" | "rollback" | "stop" | "request_approval" | "auto_promote";

export function resolveAction(ev: Evaluation, limits: AutopilotLimits, scenario: ScenarioKey): { action: Action; why: string } {
  if (ev.decision === "rollback") return { action: "rollback", why: "guardrail_or_compliance" }; // always automatic, in every mode
  if (ev.decision === "stop_harm" || ev.decision === "inconclusive" || ev.decision === "blocked_by_lock") return { action: "stop", why: ev.decision };
  if (ev.decision !== "promote_ready") return { action: "none", why: ev.decision };
  if (limits.mode !== "auto") return { action: "request_approval", why: "mode_suggest" };
  if (limits.humanOnlyScenarios.includes(scenario)) return { action: "request_approval", why: "human_only_scenario" };
  if (limits.autoPromotionsThisWeek >= limits.maxAutoPromotionsPerWeek) return { action: "request_approval", why: "weekly_limit_reached" };
  return { action: "auto_promote", why: "auto_within_limits" };
}
