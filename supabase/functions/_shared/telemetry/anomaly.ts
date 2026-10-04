// Pure, dependency-free statistics for Building Telemetry Intelligence.
// Runs unchanged in Deno (edge functions) and Node/Vitest (tests).
// Robust statistics (median/MAD) on purpose: building data is full of
// outliers, so mean/stddev baselines would be poisoned by the very faults
// we are trying to detect.

export type MetricKind =
  | "supply_air_temp" | "return_air_temp" | "delta_t" | "zone_temp" | "setpoint"
  | "discharge_pressure" | "suction_pressure" | "superheat" | "subcooling"
  | "compressor_current" | "fan_current" | "vibration" | "filter_dp"
  | "power_kw" | "energy_kwh" | "water_temp_supply" | "water_temp_return"
  | "pump_pressure" | "flow_rate" | "humidity" | "co2" | "runtime_hours" | "other";

export const METRIC_KINDS: readonly MetricKind[] = [
  "supply_air_temp", "return_air_temp", "delta_t", "zone_temp", "setpoint",
  "discharge_pressure", "suction_pressure", "superheat", "subcooling",
  "compressor_current", "fan_current", "vibration", "filter_dp",
  "power_kw", "energy_kwh", "water_temp_supply", "water_temp_return",
  "pump_pressure", "flow_rate", "humidity", "co2", "runtime_hours", "other",
];

export type AnomalyKind = "spike" | "drift" | "flatline" | "out_of_range" | "rate_of_change";
export type Severity = "low" | "medium" | "high";
export type Direction = "high" | "low";

export interface Reading { ts: number; value: number } // ts = epoch ms

export interface Baseline {
  median: number;
  mad: number;   // raw median absolute deviation
  mean: number;
  std: number;
  n: number;
}

export interface PointSpec {
  metric: MetricKind;
  minValid?: number | null; // hard physical limits, if the user set them
  maxValid?: number | null;
}

export interface DetectedAnomaly {
  kind: AnomalyKind;
  severity: Severity;
  direction: Direction;
  zScore: number;      // signed robust z (0 when not applicable)
  observed: number;
  expected: number;
  persistenceHours: number;
  explanation: string;
}

export const MIN_BASELINE_N = 48;
const MAD_TO_SIGMA = 1.4826;

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function computeBaseline(values: number[]): Baseline {
  const clean = values.filter((v) => Number.isFinite(v));
  const n = clean.length;
  if (n === 0) return { median: 0, mad: 0, mean: 0, std: 0, n: 0 };
  const med = median(clean);
  const mad = median(clean.map((v) => Math.abs(v - med)));
  const mean = clean.reduce((a, b) => a + b, 0) / n;
  const variance = clean.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  return { median: med, mad, mean, std: Math.sqrt(variance), n };
}

/** Robust sigma with a floor so near-constant series don't produce infinite z. */
export function robustSigma(b: Baseline): number {
  const fromMad = b.mad * MAD_TO_SIGMA;
  const floor = Math.max(Math.abs(b.median) * 0.01, 1e-6);
  return Math.max(fromMad, b.std * 0.25, floor);
}

export function robustZ(value: number, b: Baseline): number {
  return (value - b.median) / robustSigma(b);
}

function severityFromZ(absZ: number): Severity {
  return absZ >= 8 ? "high" : absZ >= 5 ? "medium" : "low";
}

/** Hours the series has been continuously satisfying `pred`, counting back from the latest reading. */
function trailingRunHours(recent: Reading[], pred: (v: number) => boolean): number {
  let i = recent.length - 1;
  if (i < 0 || !pred(recent[i].value)) return 0;
  while (i > 0 && pred(recent[i - 1].value)) i--;
  return (recent[recent.length - 1].ts - recent[i].ts) / 3_600_000;
}

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1));

/**
 * Detects anomalies on one point. `recent` = last ~24h ascending;
 * `baseline` = learned from the preceding weeks (see MIN_BASELINE_N).
 */
export function detectAnomalies(
  spec: PointSpec,
  recent: Reading[],
  baseline: Baseline,
): DetectedAnomaly[] {
  const out: DetectedAnomaly[] = [];
  if (recent.length === 0) return out;
  const last = recent[recent.length - 1];
  const hoursSpan = (last.ts - recent[0].ts) / 3_600_000;

  // 1. Hard physical limits (configured by the user) — works without a baseline.
  if (spec.maxValid != null && last.value > spec.maxValid) {
    out.push({
      kind: "out_of_range", severity: "high", direction: "high", zScore: 0,
      observed: last.value, expected: spec.maxValid, persistenceHours: 0,
      explanation: `Reading ${fmt(last.value)} is above the configured maximum ${fmt(spec.maxValid)}.`,
    });
  } else if (spec.minValid != null && last.value < spec.minValid) {
    out.push({
      kind: "out_of_range", severity: "high", direction: "low", zScore: 0,
      observed: last.value, expected: spec.minValid, persistenceHours: 0,
      explanation: `Reading ${fmt(last.value)} is below the configured minimum ${fmt(spec.minValid)}.`,
    });
  }

  if (baseline.n < MIN_BASELINE_N) return out; // still learning this machine

  const sigma = robustSigma(baseline);

  // 2. Drift — sustained shift of the recent median (needs >= 12 samples
  //    spanning >= 6h). Evaluated first so a persistent shift is reported
  //    as drift, not as a "spike".
  let drift: DetectedAnomaly | null = null;
  if (recent.length >= 12 && hoursSpan >= 6) {
    const rMed = median(recent.map((r) => r.value));
    const dz = (rMed - baseline.median) / sigma;
    if (Math.abs(dz) >= 2.5) {
      drift = {
        kind: "drift", severity: severityFromZ(Math.abs(dz)),
        direction: dz >= 0 ? "high" : "low", zScore: dz,
        observed: rMed, expected: baseline.median, persistenceHours: hoursSpan,
        explanation: `Typical value has shifted to ${fmt(rMed)} (normal ${fmt(baseline.median)}) over the last ${hoursSpan.toFixed(0)}h.`,
      };
    }
  }

  // 3. Spike — latest value far outside the learned envelope, confirmed by
  //    at least 2 of the last 3 readings to avoid single-sample glitches.
  const tail = recent.slice(-3);
  const zs = tail.map((r) => robustZ(r.value, baseline));
  const strong = zs.filter((z) => Math.abs(z) >= 4);
  const sameSign = strong.length >= 2 && strong.every((z) => Math.sign(z) === Math.sign(strong[0]));
  const spikeLike = sameSign || (tail.length < 3 && strong.length >= 1 && Math.abs(zs[zs.length - 1]) >= 6);
  const zLast = zs[zs.length - 1];
  const explainedByDrift = drift !== null && Math.abs(zLast) < 1.5 * Math.abs(drift.zScore);
  if (spikeLike && !explainedByDrift) {
    const sign = Math.sign(zLast);
    const runHours = trailingRunHours(recent, (v) => Math.sign(robustZ(v, baseline)) === sign && Math.abs(robustZ(v, baseline)) >= 4);
    out.push({
      kind: "spike", severity: severityFromZ(Math.abs(zLast)),
      direction: zLast >= 0 ? "high" : "low", zScore: zLast,
      observed: last.value, expected: baseline.median, persistenceHours: runHours,
      explanation: `Latest value ${fmt(last.value)} is ${Math.abs(zLast).toFixed(1)}σ ${zLast >= 0 ? "above" : "below"} this unit's normal ${fmt(baseline.median)}.`,
    });
  } else if (drift) {
    out.push(drift);
  }

  // 4. Flatline — a sensor that normally varies but is now frozen
  //    (stuck sensor, dead gateway link, or a seized/stopped machine).
  if (recent.length >= 12 && hoursSpan >= 3 && baseline.mad > 0) {
    const vals = recent.map((r) => r.value);
    const range = Math.max(...vals) - Math.min(...vals);
    if (range <= baseline.mad * 0.05) {
      out.push({
        kind: "flatline", severity: "medium", direction: last.value >= baseline.median ? "high" : "low",
        zScore: 0, observed: last.value, expected: baseline.median, persistenceHours: hoursSpan,
        explanation: `Value has not changed for ${hoursSpan.toFixed(0)}h although this point normally varies — sensor or machine may be stuck.`,
      });
    }
  }

  // 5. Rate of change — abrupt step between consecutive samples.
  if (recent.length >= 2) {
    const prev = recent[recent.length - 2];
    const step = last.value - prev.value;
    const dtMin = Math.max((last.ts - prev.ts) / 60_000, 1);
    const stepZ = step / sigma;
    if (Math.abs(stepZ) >= 6 && dtMin <= 30 && !out.some((a) => a.kind === "spike")) {
      out.push({
        kind: "rate_of_change", severity: Math.abs(stepZ) >= 10 ? "medium" : "low",
        direction: step >= 0 ? "high" : "low", zScore: stepZ,
        observed: last.value, expected: prev.value, persistenceHours: 0,
        explanation: `Jumped ${fmt(Math.abs(step))} in ${dtMin.toFixed(0)} min — far faster than this point normally moves.`,
      });
    }
  }

  return out;
}
