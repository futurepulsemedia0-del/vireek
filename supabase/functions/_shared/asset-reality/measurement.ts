// supabase/functions/_shared/asset-reality/measurement.ts
//
// Canonical physical-measurement contract for the Asset Reality Layer.
// Pure: no I/O, no Deno APIs, no imports -> identical in Edge Functions and Vitest.
// Existing ingestion endpoints keep their request formats; they call normalizeMeasurement()
// through an adapter (see ADAPTERS) and store/forward the canonical result.
//
// Storage units are SI-based. "No data -> no claim": invalid input yields { ok: false }, never a guess.

export const METHODS = ["instrument", "manual", "ocr", "sensor", "derived"] as const;
export type MeasurementMethod = (typeof METHODS)[number];

/** Mirror of METRIC_KINDS in _shared/telemetry/anomaly.ts plus asset-state kinds. Keep in sync (test enforces superset). */
export const CANONICAL_KINDS = [
  "supply_air_temp", "return_air_temp", "delta_t", "zone_temp", "setpoint",
  "discharge_pressure", "suction_pressure", "superheat", "subcooling",
  "compressor_current", "fan_current", "vibration", "filter_dp",
  "power_kw", "energy_kwh", "water_temp_supply", "water_temp_return",
  "pump_pressure", "flow_rate", "humidity", "co2", "runtime_hours",
  "static_pressure", "line_voltage", "suction_line_temp", "liquid_line_temp",
  "ambient_temp", "approach_temp", "amp_ratio", "other",
] as const;
export type CanonicalKind = (typeof CANONICAL_KINDS)[number];

export type Dimension =
  | "temperature" | "temperature_diff" | "pressure" | "pressure_diff" | "current" | "voltage"
  | "power" | "energy" | "flow" | "ratio" | "percent" | "duration" | "concentration" | "vibration";

/** SI storage unit per dimension. Pressure is stored ABSOLUTE in kPa (gauge inputs add atmospheric). */
export const STORAGE_UNIT: Record<Dimension, string> = {
  temperature: "degC", temperature_diff: "K", pressure: "kPa_a", pressure_diff: "Pa", current: "A",
  voltage: "V", power: "kW", energy: "kWh", flow: "L/s", ratio: "ratio", percent: "percent",
  duration: "h", concentration: "ppm", vibration: "mm/s",
};

export const KIND_DIMENSION: Record<CanonicalKind, Dimension> = {
  supply_air_temp: "temperature", return_air_temp: "temperature", delta_t: "temperature_diff",
  zone_temp: "temperature", setpoint: "temperature", discharge_pressure: "pressure",
  suction_pressure: "pressure", superheat: "temperature_diff", subcooling: "temperature_diff",
  compressor_current: "current", fan_current: "current", vibration: "vibration", filter_dp: "pressure_diff",
  power_kw: "power", energy_kwh: "energy", water_temp_supply: "temperature", water_temp_return: "temperature",
  pump_pressure: "pressure", flow_rate: "flow", humidity: "percent", co2: "concentration",
  runtime_hours: "duration", static_pressure: "pressure_diff", line_voltage: "voltage",
  suction_line_temp: "temperature", liquid_line_temp: "temperature", ambient_temp: "temperature",
  approach_temp: "temperature_diff", amp_ratio: "ratio", other: "ratio",
};

/** Hard physical plausibility limits in STORAGE units. Outside => rejected (spoofed/broken sensor), not clamped. */
export const PHYSICAL_RANGE: Record<CanonicalKind, [number, number]> = {
  supply_air_temp: [-60, 150], return_air_temp: [-60, 150], delta_t: [-60, 60], zone_temp: [-60, 100],
  setpoint: [-20, 60], discharge_pressure: [0, 6000], suction_pressure: [0, 3000], superheat: [-20, 80],
  subcooling: [-20, 60], compressor_current: [0, 1000], fan_current: [0, 200], vibration: [0, 200],
  filter_dp: [0, 5000], power_kw: [0, 5000], energy_kwh: [0, 1e9], water_temp_supply: [-20, 150],
  water_temp_return: [-20, 150], pump_pressure: [0, 3000], flow_rate: [0, 5000], humidity: [0, 100],
  co2: [0, 100000], runtime_hours: [0, 1e6], static_pressure: [-2000, 2000], line_voltage: [0, 1000],
  suction_line_temp: [-60, 150], liquid_line_temp: [-40, 150], ambient_temp: [-60, 70],
  approach_temp: [-60, 100], amp_ratio: [0, 10], other: [-1e12, 1e12],
};

export const STD_ATM_KPA = 101.325;

type Conv = (v: number) => number; // input unit -> storage unit
const PSI_KPA = 6.894757293168;
const UNIT_TABLE: Record<string, { dim: Dimension; to: Conv }> = {
  degC: { dim: "temperature", to: (v) => v }, C: { dim: "temperature", to: (v) => v },
  degF: { dim: "temperature", to: (v) => ((v - 32) * 5) / 9 }, F: { dim: "temperature", to: (v) => ((v - 32) * 5) / 9 },
  K: { dim: "temperature", to: (v) => v - 273.15 },
  // temperature DIFFERENCES: scale only, no offset
  dK: { dim: "temperature_diff", to: (v) => v }, dC: { dim: "temperature_diff", to: (v) => v },
  dF: { dim: "temperature_diff", to: (v) => (v * 5) / 9 },
  kPa_a: { dim: "pressure", to: (v) => v }, kPa_g: { dim: "pressure", to: (v) => v + STD_ATM_KPA },
  psia: { dim: "pressure", to: (v) => v * PSI_KPA }, psig: { dim: "pressure", to: (v) => v * PSI_KPA + STD_ATM_KPA },
  bar_a: { dim: "pressure", to: (v) => v * 100 }, bar_g: { dim: "pressure", to: (v) => v * 100 + STD_ATM_KPA },
  Pa: { dim: "pressure_diff", to: (v) => v }, kPa: { dim: "pressure_diff", to: (v) => v * 1000 },
  inWC: { dim: "pressure_diff", to: (v) => v * 249.08891 }, psid: { dim: "pressure_diff", to: (v) => v * PSI_KPA * 1000 },
  A: { dim: "current", to: (v) => v }, mA: { dim: "current", to: (v) => v / 1000 },
  V: { dim: "voltage", to: (v) => v },
  kW: { dim: "power", to: (v) => v }, W: { dim: "power", to: (v) => v / 1000 }, BTUh: { dim: "power", to: (v) => v * 0.00029307107 },
  kWh: { dim: "energy", to: (v) => v }, Wh: { dim: "energy", to: (v) => v / 1000 },
  "L/s": { dim: "flow", to: (v) => v }, cfm: { dim: "flow", to: (v) => v * 0.47194745 }, gpm: { dim: "flow", to: (v) => v * 0.0630901964 },
  "m3/h": { dim: "flow", to: (v) => v / 3.6 },
  percent: { dim: "percent", to: (v) => v }, "%": { dim: "percent", to: (v) => v },
  ratio: { dim: "ratio", to: (v) => v },
  h: { dim: "duration", to: (v) => v }, min: { dim: "duration", to: (v) => v / 60 }, s: { dim: "duration", to: (v) => v / 3600 },
  ppm: { dim: "concentration", to: (v) => v },
  "mm/s": { dim: "vibration", to: (v) => v }, "in/s": { dim: "vibration", to: (v) => v * 25.4 },
};

/** Legacy rr-device-ingest metric names carry the unit in the name (e.g. supply_air_temp_f). */
const SUFFIX_UNIT: Record<string, string> = { _f: "degF", _c: "degC", _psi: "psig", _a: "A", _v: "V", _kw: "kW" };

export interface Instrument {
  id?: string | null;
  model?: string | null;
  calibrated_on?: string | null; // ISO date
  tolerance?: number | null;     // in STORAGE units, absolute
}

export interface RawMeasurementInput {
  kind: string;
  value: number;
  unit?: string | null;
  measured_at: string | number | Date;
  received_at?: string | number | Date;
  method: MeasurementMethod;
  instrument?: Instrument | null;
  passport_id?: string | null;
  equipment_id?: string | null;
  evidence_digest?: string | null; // sha256 hex of source photo/file
  derived_from?: string[];         // measurement ids, for method === "derived"
}

export type QualityFlag = "ok" | "uncalibrated" | "calibration_expired" | "manual_entry" | "ocr_unconfirmed" | "gauge_pressure_assumed_std_atm";

export interface CanonicalMeasurement {
  kind: CanonicalKind;
  dimension: Dimension;
  value: number;          // storage unit
  unit: string;           // storage unit
  input_value: number;
  input_unit: string;
  measured_at: string;
  received_at: string;
  method: MeasurementMethod;
  instrument: Instrument | null;
  uncertainty: number | null; // absolute, storage unit; null = unknown (never invented)
  quality: QualityFlag[];
  passport_id: string | null;
  equipment_id: string | null;
  evidence_digest: string | null;
  derived_from: string[];
}

export type NormalizeResult =
  | { ok: true; measurement: CanonicalMeasurement }
  | { ok: false; reason: string };

const MAX_FUTURE_MS = 60_000;
const MAX_PAST_MS = 400 * 86_400_000; // offline-first technician devices may sync late; telemetry adapters tighten this
const CAL_VALID_MS = 365 * 86_400_000;
const SHA256 = /^[0-9a-f]{64}$/;

function toMs(t: string | number | Date | undefined): number {
  if (t === undefined) return NaN;
  return t instanceof Date ? t.getTime() : typeof t === "number" ? t : Date.parse(t);
}

export function splitLegacyMetric(metric: string): { kind: string; unit: string | null } {
  for (const [suf, unit] of Object.entries(SUFFIX_UNIT)) {
    if (metric.endsWith(suf)) return { kind: metric.slice(0, -suf.length), unit };
  }
  return { kind: metric, unit: null };
}

export function normalizeMeasurement(raw: RawMeasurementInput, now: Date = new Date()): NormalizeResult {
  if (!(CANONICAL_KINDS as readonly string[]).includes(raw.kind)) return { ok: false, reason: "invalid_kind" };
  const kind = raw.kind as CanonicalKind;
  if (!(METHODS as readonly string[]).includes(raw.method)) return { ok: false, reason: "invalid_method" };
  if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) return { ok: false, reason: "invalid_value" };

  const dim = KIND_DIMENSION[kind];
  let inputUnit = (raw.unit ?? "").trim() || STORAGE_UNIT[dim];
  // "K" is an absolute temperature in UNIT_TABLE but a plain interval for difference kinds (delta_t, superheat, ...).
  if (dim === "temperature_diff" && inputUnit === "K") inputUnit = "dK";
  const entry = UNIT_TABLE[inputUnit] ?? (inputUnit === STORAGE_UNIT[dim] ? { dim, to: (v: number) => v } : undefined);
  if (!entry) return { ok: false, reason: "unknown_unit" };
  if (entry.dim !== dim) return { ok: false, reason: "unit_dimension_mismatch" };

  const measuredMs = toMs(raw.measured_at);
  if (!Number.isFinite(measuredMs)) return { ok: false, reason: "invalid_measured_at" };
  const receivedMs = raw.received_at === undefined ? now.getTime() : toMs(raw.received_at);
  if (!Number.isFinite(receivedMs)) return { ok: false, reason: "invalid_received_at" };
  if (measuredMs > now.getTime() + MAX_FUTURE_MS) return { ok: false, reason: "measured_in_future" };
  if (measuredMs < now.getTime() - MAX_PAST_MS) return { ok: false, reason: "measured_too_old" };

  const stored = entry.to(raw.value);
  const [lo, hi] = PHYSICAL_RANGE[kind];
  if (stored < lo || stored > hi) return { ok: false, reason: "out_of_physical_range" };

  if (raw.evidence_digest != null && !SHA256.test(raw.evidence_digest)) return { ok: false, reason: "invalid_evidence_digest" };
  if (raw.method === "derived" && (!raw.derived_from || raw.derived_from.length === 0)) return { ok: false, reason: "derived_requires_inputs" };

  const quality: QualityFlag[] = [];
  let uncertainty: number | null = null;
  const inst = raw.instrument ?? null;
  if (raw.method === "instrument" || raw.method === "sensor") {
    if (!inst?.calibrated_on) quality.push("uncalibrated");
    else {
      const cal = Date.parse(inst.calibrated_on);
      if (!Number.isFinite(cal) || cal > now.getTime() || now.getTime() - cal > CAL_VALID_MS) quality.push("calibration_expired");
    }
    if (typeof inst?.tolerance === "number" && Number.isFinite(inst.tolerance) && inst.tolerance >= 0) uncertainty = inst.tolerance;
  }
  if (raw.method === "manual") quality.push("manual_entry");
  if (raw.method === "ocr") quality.push("ocr_unconfirmed"); // must be human-confirmed before safety/warranty/compliance use
  if (dim === "pressure" && (inputUnit === "psig" || inputUnit === "kPa_g" || inputUnit === "bar_g")) quality.push("gauge_pressure_assumed_std_atm");
  if (quality.length === 0) quality.push("ok");

  return {
    ok: true,
    measurement: {
      kind, dimension: dim, value: Math.round(stored * 1e6) / 1e6, unit: STORAGE_UNIT[dim],
      input_value: raw.value, input_unit: inputUnit,
      measured_at: new Date(measuredMs).toISOString(), received_at: new Date(receivedMs).toISOString(),
      method: raw.method, instrument: inst, uncertainty, quality,
      passport_id: raw.passport_id ?? null, equipment_id: raw.equipment_id ?? null,
      evidence_digest: raw.evidence_digest ?? null, derived_from: raw.derived_from ?? [],
    },
  };
}

/** Adapter: legacy rr-device-ingest reading { metric, value, observed_at } -> canonical input. */
export function adaptRrReading(r: { metric: string; value: number; observed_at: string }, equipmentId: string, deviceId: string): RawMeasurementInput {
  const { kind, unit } = splitLegacyMetric(r.metric);
  return { kind, value: r.value, unit, measured_at: r.observed_at, method: "sensor", instrument: { id: deviceId }, equipment_id: equipmentId };
}

/** Adapter: telemetry-ingest point + reading. Telemetry units are free text, so unknown units are rejected, not guessed. */
export function adaptTelemetryReading(p: { metric: string; unit: string | null; equipment_id: string | null; gateway_id: string }, r: { ts: string | number; value: number }): RawMeasurementInput {
  return { kind: p.metric, value: r.value, unit: p.unit, measured_at: r.ts, method: "sensor", instrument: { id: p.gateway_id }, equipment_id: p.equipment_id };
}

/** Adapter: technician job-form field with answers["<field>__source"] provenance. */
export function adaptJobFormField(f: { kind: string; value: number; unit?: string | null; at: string; source: "bluetooth" | "manual"; instrumentId?: string | null; instrumentModel?: string | null; equipmentId?: string | null }): RawMeasurementInput {
  return {
    kind: f.kind, value: f.value, unit: f.unit, measured_at: f.at,
    method: f.source === "bluetooth" ? "instrument" : "manual",
    instrument: f.source === "bluetooth" ? { id: f.instrumentId ?? null, model: f.instrumentModel ?? null } : null,
    equipment_id: f.equipmentId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Deterministic derivations. Inputs are recorded; any missing/invalid input => null (unknown), never a guess.
// Refrigerant PT conversion is intentionally NOT embedded: saturation temperatures must come from an instrument
// or a primary-source table (NIST/OEM). See report: PT table = BLOCKED pending primary source.
// ---------------------------------------------------------------------------

export interface Derived { kind: CanonicalKind; value: number; unit: string; formula: string; inputs: Record<string, number> }

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function deriveDeltaT(returnAirC: number, supplyAirC: number): Derived | null {
  if (!fin(returnAirC) || !fin(supplyAirC)) return null;
  return { kind: "delta_t", value: r3(returnAirC - supplyAirC), unit: "K", formula: "return_air_temp - supply_air_temp", inputs: { returnAirC, supplyAirC } };
}
export function deriveSuperheat(suctionLineC: number, suctionSatC: number): Derived | null {
  if (!fin(suctionLineC) || !fin(suctionSatC)) return null;
  return { kind: "superheat", value: r3(suctionLineC - suctionSatC), unit: "K", formula: "suction_line_temp - sat_temp(suction_pressure)", inputs: { suctionLineC, suctionSatC } };
}
export function deriveSubcooling(liquidSatC: number, liquidLineC: number): Derived | null {
  if (!fin(liquidSatC) || !fin(liquidLineC)) return null;
  return { kind: "subcooling", value: r3(liquidSatC - liquidLineC), unit: "K", formula: "sat_temp(discharge_pressure) - liquid_line_temp", inputs: { liquidSatC, liquidLineC } };
}
export function deriveApproach(leavingFluidC: number, entering: number): Derived | null {
  if (!fin(leavingFluidC) || !fin(entering)) return null;
  return { kind: "approach_temp", value: r3(leavingFluidC - entering), unit: "K", formula: "leaving_fluid_temp - entering_reference_temp", inputs: { leavingFluidC, entering } };
}
export function deriveAmpRatio(measuredA: number, ratedA: number): Derived | null {
  if (!fin(measuredA) || !fin(ratedA) || ratedA <= 0 || measuredA < 0) return null;
  return { kind: "amp_ratio", value: r3(measuredA / ratedA), unit: "ratio", formula: "measured_amps / rated_amps", inputs: { measuredA, ratedA } };
}
