// Property Intelligence OS — deterministic failure-prediction model.
//
// Pure functions, no I/O: every number is explainable, testable and identical
// wherever it runs. Telemetry features are computed in SQL (pio_equipment_features)
// so we never pull raw readings into the edge runtime.
//
//   features (per equipment x metric) --> signal strength 0..1
//   signals x failure-mode weights + lifecycle prior --> logit --> probability
//   probability x per-account calibration (learned from outcomes) --> final
//
// Bump MODEL_VERSION whenever weights/thresholds change so predictions stay auditable.

export const MODEL_VERSION = "pio-1.0.0";

/** A prediction at/above this probability + confidence opens a mission. */
export const MISSION_MIN_PROBABILITY = 0.65;
export const MISSION_MIN_CONFIDENCE = 0.5;
/** Below this we don't even record a prediction. */
export const WATCH_MIN_PROBABILITY = 0.4;

export type Severity = "watch" | "high" | "critical";
export type Direction = "up" | "down" | "either";

export interface MetricFeature {
  equipment_id: string;
  metric: string;
  n_baseline: number;
  base_mean: number | null;
  base_std: number | null;
  n_recent: number;
  recent_mean: number | null;
  recent_p95: number | null;
  slope_per_day: number | null;
  last_value: number | null;
  last_at: string | null;
}

export interface EquipmentContext {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  last_service_date: string | null;
  expected_lifespan_years: number;
  service_interval_months: number;
}

export interface Evidence {
  metric: string;
  label: string;
  recent_mean: number;
  baseline_mean: number;
  change_pct: number | null;
  z: number;
  slope_per_day: number | null;
  strength: number; // 0..1
}

export interface Prediction {
  equipment_id: string;
  failure_mode: string;
  label: string;
  probability: number; // 0..1, calibrated
  raw_probability: number;
  confidence: number; // 0..1
  horizon_days_min: number;
  horizon_days_max: number;
  predicted_failure_at: string;
  severity: Severity;
  probable_cause: string;
  evidence: Evidence[];
  lifecycle_prior: number;
  part_keywords: string[];
  service_keywords: string[];
  model_version: string;
}

interface SignalDef {
  metric: string;
  label: string;
  direction: Direction;
  weight: number;
  /** Absolute value at which the signal is considered fully tripped. */
  hardLimit?: number;
}

interface FailureModeDef {
  key: string;
  label: string;
  appliesTo: RegExp;
  bias: number; // logistic intercept: negative = needs evidence to fire
  signals: SignalDef[];
  cause: string;
  partKeywords: string[];
  serviceKeywords: string[];
  /** Safety-critical modes escalate to "critical" at a lower probability. */
  criticalAt?: number;
}

const HVAC = /hvac|air.?cond|a\/c|\bac\b|heat pump|furnace|condens|compressor|split|package unit|mini.?split/i;
const WATER = /water heater|boiler|tankless|plumb|sump|well pump/i;
const MOTOR = /pump|motor|fan|blower|generator|compressor|handler/i;

export const FAILURE_MODES: FailureModeDef[] = [
  {
    key: "compressor_failure",
    label: "Compressor failure",
    appliesTo: HVAC,
    bias: -3.4,
    signals: [
      { metric: "vibration_mm_s", label: "Vibration", direction: "up", weight: 1.8 },
      { metric: "current_a", label: "Motor current draw", direction: "up", weight: 1.6 },
      { metric: "discharge_pressure_psi", label: "Discharge pressure", direction: "up", weight: 1.2 },
      { metric: "temp_delta_f", label: "Cooling temperature drop", direction: "down", weight: 1.4 },
      { metric: "runtime_ratio", label: "Runtime duty cycle", direction: "up", weight: 1.0 },
    ],
    cause: "The compressor is working harder for less cooling — typical of worn windings, bearings or a failing start component.",
    partKeywords: ["compressor"],
    serviceKeywords: ["compressor", "hvac", "ac repair", "diagnostic"],
  },
  {
    key: "capacitor_degradation",
    label: "Run/start capacitor degradation",
    appliesTo: HVAC,
    bias: -3.1,
    signals: [
      { metric: "current_a", label: "Motor current draw", direction: "up", weight: 1.5 },
      { metric: "cycles_per_hour", label: "Short cycling", direction: "up", weight: 1.7 },
      { metric: "power_w", label: "Power draw", direction: "up", weight: 1.0 },
    ],
    cause: "Rising current with short cycling points to a weakening capacitor, which also accelerates compressor wear.",
    partKeywords: ["capacitor"],
    serviceKeywords: ["capacitor", "hvac", "ac repair"],
  },
  {
    key: "refrigerant_loss",
    label: "Refrigerant leak / low charge",
    appliesTo: HVAC,
    bias: -3.3,
    signals: [
      { metric: "suction_pressure_psi", label: "Suction pressure", direction: "down", weight: 2.0 },
      { metric: "temp_delta_f", label: "Cooling temperature drop", direction: "down", weight: 1.6 },
      { metric: "runtime_ratio", label: "Runtime duty cycle", direction: "up", weight: 1.0 },
    ],
    cause: "Falling suction pressure and a shrinking temperature drop indicate refrigerant loss.",
    partKeywords: ["refrigerant", "r410", "r-410", "r22", "leak"],
    serviceKeywords: ["refrigerant", "leak", "recharge", "hvac"],
  },
  {
    key: "motor_bearing_wear",
    label: "Motor / bearing wear",
    appliesTo: MOTOR,
    bias: -3.2,
    signals: [
      { metric: "vibration_mm_s", label: "Vibration", direction: "up", weight: 2.2 },
      { metric: "temperature_f", label: "Housing temperature", direction: "up", weight: 1.4 },
      { metric: "current_a", label: "Motor current draw", direction: "up", weight: 0.9 },
    ],
    cause: "Increasing vibration and heat are the classic signature of bearing wear or shaft misalignment.",
    partKeywords: ["bearing", "motor", "blower"],
    serviceKeywords: ["motor", "bearing", "blower", "repair"],
  },
  {
    key: "water_leak",
    label: "Water leak / tank breach",
    appliesTo: WATER,
    bias: -2.4,
    signals: [
      { metric: "water_leak", label: "Leak sensor", direction: "up", weight: 3.4, hardLimit: 1 },
      { metric: "humidity_pct", label: "Ambient humidity", direction: "up", weight: 1.2 },
      { metric: "flow_gpm", label: "Unexpected flow", direction: "up", weight: 1.4 },
    ],
    cause: "Moisture or unexpected flow near the unit suggests an active leak or a failing tank/valve.",
    partKeywords: ["water heater", "valve", "anode", "tank", "supply line"],
    serviceKeywords: ["leak", "water heater", "plumb"],
    criticalAt: 0.6,
  },
  {
    key: "thermal_overload",
    label: "Overheating / thermal stress",
    appliesTo: /./,
    bias: -3.6,
    signals: [
      { metric: "temperature_f", label: "Operating temperature", direction: "up", weight: 2.4 },
      { metric: "current_a", label: "Motor current draw", direction: "up", weight: 1.2 },
    ],
    cause: "Sustained rise in operating temperature with higher load indicates thermal stress.",
    partKeywords: ["thermostat", "fan", "sensor"],
    serviceKeywords: ["diagnostic", "inspect", "repair"],
  },
];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

// Minimum samples before a metric is trusted. Below this we ignore the signal
// (and lower confidence) rather than guess from noise.
const MIN_RECENT = 12;
const MIN_BASELINE = 48;

function directional(v: number, dir: Direction): number {
  return dir === "up" ? v : dir === "down" ? -v : Math.abs(v);
}

function signalFor(def: SignalDef, f: MetricFeature | undefined): { strength: number; evidence: Evidence | null; usable: boolean } {
  if (
    !f || f.base_mean === null || f.recent_mean === null ||
    f.n_recent < MIN_RECENT || f.n_baseline < MIN_BASELINE
  ) {
    return { strength: 0, evidence: null, usable: false };
  }
  const mean = f.base_mean;
  // Floor on noise so a perfectly flat baseline can't make a tiny wobble look infinite.
  const std = Math.max(f.base_std ?? 0, Math.abs(mean) * 0.03, 1e-6);
  const z = (f.recent_mean - mean) / std;
  const zComp = clamp((directional(z, def.direction) - 1) / 3, 0, 1); // z=1 -> 0, z=4 -> 1

  let trendComp = 0;
  if (f.slope_per_day !== null && Math.abs(mean) > 1e-6) {
    const weeklyRel = (f.slope_per_day * 7) / Math.abs(mean);
    trendComp = clamp(directional(weeklyRel, def.direction) / 0.25, 0, 1);
  }

  let limitComp = 0;
  if (def.hardLimit !== undefined && f.recent_p95 !== null && def.direction === "up") {
    const span = def.hardLimit - mean;
    limitComp = span <= 0 ? (f.recent_p95 >= def.hardLimit ? 1 : 0) : clamp((f.recent_p95 - mean) / span, 0, 1);
  }

  const strength = Math.max(zComp, 0.8 * trendComp, limitComp);
  const changePct = Math.abs(mean) > 1e-6 ? ((f.recent_mean - mean) / Math.abs(mean)) * 100 : null;
  return {
    strength,
    usable: true,
    evidence: {
      metric: def.metric,
      label: def.label,
      recent_mean: round(f.recent_mean, 2),
      baseline_mean: round(mean, 2),
      change_pct: changePct === null ? null : round(changePct, 1),
      z: round(z, 2),
      slope_per_day: f.slope_per_day === null ? null : round(f.slope_per_day, 4),
      strength: round(strength, 2),
    },
  };
}

/** Static prior from age + overdue service, so old/neglected units fire sooner on the same telemetry. */
export function lifecyclePrior(eq: EquipmentContext, now: Date): number {
  let prior = 0;
  if (eq.install_date) {
    const ageYears = (now.getTime() - new Date(eq.install_date).getTime()) / (365.25 * 86_400_000);
    const lifespan = Math.max(eq.expected_lifespan_years || 15, 1);
    prior += 0.8 * clamp(ageYears / lifespan - 0.6, 0, 0.6) / 0.6;
  }
  const interval = Math.max(eq.service_interval_months || 12, 1);
  const last = eq.last_service_date ?? eq.install_date;
  if (last) {
    const monthsSince = (now.getTime() - new Date(last).getTime()) / (30.44 * 86_400_000);
    prior += 0.5 * clamp(monthsSince / interval - 1, 0, 1);
  }
  return round(prior, 3);
}

/** Odds-scale calibration: factor>1 trusts the model more, <1 less. Learned per account + failure mode. */
export function applyCalibration(p: number, factor: number): number {
  const f = clamp(factor, 0.6, 1.4);
  const odds = (p / (1 - p + 1e-9)) * f;
  return clamp(odds / (1 + odds), 0, 0.99);
}

/** Bayesian-shrunk calibration factor from confirmed/total outcomes (neutral at no data). */
export function calibrationFactor(confirmed: number, total: number): number {
  return clamp(((confirmed + 3) / (total + 4)) / 0.75, 0.6, 1.4);
}

export function severityFor(p: number, criticalAt?: number): Severity | null {
  if (p < WATCH_MIN_PROBABILITY) return null;
  if (p >= 0.85 || (criticalAt !== undefined && p >= criticalAt)) return "critical";
  if (p >= MISSION_MIN_PROBABILITY) return "high";
  return "watch";
}

function horizonDays(p: number, primary: { f: MetricFeature | undefined; def: SignalDef } | null): [number, number] {
  let max = clamp(Math.round(4 + 56 * Math.pow(1 - p, 1.5)), 3, 90);
  // If a hard limit exists and the metric is trending toward it, the trend sets the clock.
  const f = primary?.f;
  const lim = primary?.def.hardLimit;
  if (f && lim !== undefined && f.recent_mean !== null && f.slope_per_day !== null && f.slope_per_day > 1e-9) {
    const days = (lim - f.recent_mean) / f.slope_per_day;
    if (Number.isFinite(days) && days > 0) max = Math.min(max, Math.max(2, Math.ceil(days * 1.2)));
  }
  return [Math.max(1, Math.round(max * 0.4)), max];
}

export function describeEvidence(e: Evidence): string {
  const dir = e.change_pct === null ? "shifted" : e.change_pct >= 0 ? "up" : "down";
  const pct = e.change_pct === null ? "" : ` ${Math.abs(e.change_pct)}% ${dir} vs. 30-day baseline`;
  return `${e.label}${pct}`;
}

export function computePredictions(
  eq: EquipmentContext,
  features: MetricFeature[],
  calibration: Map<string, number> = new Map(),
  now: Date = new Date(),
): Prediction[] {
  const byMetric = new Map(features.filter((f) => f.equipment_id === eq.id).map((f) => [f.metric, f]));
  if (byMetric.size === 0) return [];
  const prior = lifecyclePrior(eq, now);
  const out: Prediction[] = [];

  for (const mode of FAILURE_MODES) {
    if (!mode.appliesTo.test(eq.equipment_type)) continue;
    // The catch-all mode only applies when no specific mode matches this unit type.
    if (mode.key === "thermal_overload" && FAILURE_MODES.some((m) => m.key !== "thermal_overload" && m.appliesTo.test(eq.equipment_type))) continue;

    let logit = mode.bias + prior;
    let usable = 0;
    const evidence: Evidence[] = [];
    let primary: { f: MetricFeature | undefined; def: SignalDef; s: number } | null = null;

    for (const def of mode.signals) {
      const f = byMetric.get(def.metric);
      const sig = signalFor(def, f);
      if (!sig.usable) continue;
      usable++;
      logit += def.weight * sig.strength;
      if (sig.evidence && sig.strength >= 0.25) evidence.push(sig.evidence);
      if (sig.strength > (primary?.s ?? 0)) primary = { f, def, s: sig.strength };
    }
    if (usable === 0 || evidence.length === 0) continue;

    const raw = sigmoid(logit);
    const p = round(applyCalibration(raw, calibration.get(mode.key) ?? 1));
    const severity = severityFor(p, mode.criticalAt);
    if (!severity) continue;

    const coverage = usable / mode.signals.length;
    const volume = clamp(Math.min(...evidence.map((e) => byMetric.get(e.metric)?.n_baseline ?? 0)) / 200, 0.3, 1);
    const confidence = round(clamp(0.3 + 0.45 * coverage + 0.25 * volume + (evidence.length >= 2 ? 0.05 : -0.1), 0.2, 0.95), 2);

    const [hMin, hMax] = horizonDays(p, primary);
    evidence.sort((a, b) => b.strength - a.strength);
    out.push({
      equipment_id: eq.id,
      failure_mode: mode.key,
      label: mode.label,
      probability: p,
      raw_probability: round(raw),
      confidence,
      horizon_days_min: hMin,
      horizon_days_max: hMax,
      predicted_failure_at: new Date(now.getTime() + ((hMin + hMax) / 2) * 86_400_000).toISOString(),
      severity,
      probable_cause: `${mode.cause} Signals: ${evidence.slice(0, 3).map(describeEvidence).join("; ")}.`,
      evidence,
      lifecycle_prior: prior,
      part_keywords: mode.partKeywords,
      service_keywords: mode.serviceKeywords,
      model_version: MODEL_VERSION,
    });
  }
  // Keep only the most likely failure mode per unit so one sick unit opens one mission.
  out.sort((a, b) => b.probability - a.probability);
  return out;
}

export function friendlyEquipment(eq: Pick<EquipmentContext, "equipment_type" | "make" | "model">): string {
  return [eq.make, eq.equipment_type].filter(Boolean).join(" ").trim() || "equipment";
}

export function explainPrediction(p: Prediction, eq: Pick<EquipmentContext, "equipment_type" | "make" | "model">): string {
  const pct = Math.round(p.probability * 100);
  const days = p.horizon_days_min === p.horizon_days_max ? `${p.horizon_days_max} days` : `${p.horizon_days_min}–${p.horizon_days_max} days`;
  return `Live sensor data shows a ${pct}% chance of ${p.label.toLowerCase()} on the ${friendlyEquipment(eq)} within ${days}. ${p.probable_cause}`;
}
