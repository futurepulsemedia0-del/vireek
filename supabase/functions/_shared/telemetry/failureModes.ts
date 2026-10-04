// Failure-mode library + explainable probability model.
// Deliberately transparent (weighted evidence → logistic) instead of a
// black box: a technician must be able to see WHY a unit was flagged, and
// every confirmed / false-alarm outcome recalibrates it (see applyCalibration).

import type { AnomalyKind, Direction, MetricKind } from "./anomaly.ts";

export const MODEL_VERSION = "tel-1.0";

export interface Signal {
  metric: MetricKind;
  kind: AnomalyKind;
  direction: Direction;
  zAbs: number;
  persistenceHours: number;
}

interface SignalSpec { metric: MetricKind; direction: Direction | "any"; weight: number }
interface PartHint { label: string; keywords: string[]; qty: number }

export interface FailureMode {
  id: string;
  label: string;
  equipment: RegExp;      // matched against "type make model" (lowercase)
  prior: number;          // base rate of this failure within horizonDays
  horizonDays: number;
  signals: SignalSpec[];
  parts: PartHint[];
  action: string;
}

const HVAC = /(hvac|air.?cond|a\/c|\bac\b|heat.?pump|furnace|split|condens|rooftop|rtu|air.?handler|chiller|\bvrf\b|cooling)/;
// "heat pump" is HVAC, not a hydronic circulator pump.
const HYDRONIC = /(boiler|hydronic|water.?heater|heat.?exchang|chiller|circulat|(?<!heat[ -]?)pump)/;

export const FAILURE_MODES: FailureMode[] = [
  {
    id: "low_refrigerant_charge", label: "Low refrigerant charge / leak", equipment: HVAC, prior: 0.05, horizonDays: 30,
    signals: [
      { metric: "suction_pressure", direction: "low", weight: 2.2 },
      { metric: "superheat", direction: "high", weight: 2.0 },
      { metric: "delta_t", direction: "low", weight: 1.6 },
      { metric: "compressor_current", direction: "low", weight: 1.2 },
    ],
    parts: [
      { label: "Refrigerant (matching type)", keywords: ["refrigerant", "r410", "r-410", "r22", "r-22", "r32"], qty: 1 },
      { label: "Filter drier", keywords: ["drier", "dryer"], qty: 1 },
    ],
    action: "Bring gauges and leak detector; plan for a leak search and recharge.",
  },
  {
    id: "airflow_restriction", label: "Restricted airflow (filter / coil / duct)", equipment: HVAC, prior: 0.08, horizonDays: 21,
    signals: [
      { metric: "filter_dp", direction: "high", weight: 2.4 },
      { metric: "delta_t", direction: "high", weight: 1.4 },
      { metric: "supply_air_temp", direction: "low", weight: 1.0 },
      { metric: "fan_current", direction: "high", weight: 1.2 },
    ],
    parts: [{ label: "Air filter (size on unit)", keywords: ["filter"], qty: 2 }],
    action: "Replace filter, inspect evaporator coil and blower wheel.",
  },
  {
    id: "compressor_wear", label: "Compressor degradation", equipment: HVAC, prior: 0.04, horizonDays: 60,
    signals: [
      { metric: "compressor_current", direction: "high", weight: 2.2 },
      { metric: "vibration", direction: "high", weight: 1.8 },
      { metric: "discharge_pressure", direction: "high", weight: 1.6 },
      { metric: "power_kw", direction: "high", weight: 1.0 },
    ],
    parts: [
      { label: "Compressor contactor", keywords: ["contactor"], qty: 1 },
      { label: "Run / start capacitor", keywords: ["capacitor"], qty: 1 },
    ],
    action: "Check amp draw vs. nameplate RLA; quote compressor or unit replacement early.",
  },
  {
    id: "capacitor_or_electrical", label: "Failing capacitor / electrical fault", equipment: HVAC, prior: 0.07, horizonDays: 30,
    signals: [
      { metric: "compressor_current", direction: "any", weight: 1.8 },
      { metric: "fan_current", direction: "any", weight: 1.8 },
      { metric: "power_kw", direction: "any", weight: 0.8 },
    ],
    parts: [
      { label: "Run capacitor", keywords: ["capacitor"], qty: 1 },
      { label: "Contactor", keywords: ["contactor"], qty: 1 },
    ],
    action: "Test capacitor µF and contactor contacts first.",
  },
  {
    id: "fan_motor_bearing", label: "Fan / blower motor bearing wear", equipment: HVAC, prior: 0.06, horizonDays: 45,
    signals: [
      { metric: "vibration", direction: "high", weight: 2.4 },
      { metric: "fan_current", direction: "high", weight: 1.6 },
      { metric: "flow_rate", direction: "low", weight: 1.0 },
    ],
    parts: [
      { label: "Blower / fan motor", keywords: ["motor", "blower"], qty: 1 },
      { label: "Fan belt / bearing", keywords: ["belt", "bearing"], qty: 1 },
    ],
    action: "Inspect bearings and mounts; lubricate or replace motor.",
  },
  {
    id: "pump_degradation", label: "Pump / hydronic loop degradation", equipment: HYDRONIC, prior: 0.05, horizonDays: 45,
    signals: [
      { metric: "pump_pressure", direction: "low", weight: 2.0 },
      { metric: "flow_rate", direction: "low", weight: 2.0 },
      { metric: "power_kw", direction: "high", weight: 1.2 },
      { metric: "vibration", direction: "high", weight: 1.4 },
    ],
    parts: [
      { label: "Pump seal / impeller kit", keywords: ["pump", "seal", "impeller"], qty: 1 },
      { label: "Strainer", keywords: ["strainer"], qty: 1 },
    ],
    action: "Check for air lock, clogged strainer, worn seal or impeller.",
  },
  {
    id: "heat_transfer_loss", label: "Heat-transfer loss (fouling / scale)", equipment: HYDRONIC, prior: 0.05, horizonDays: 60,
    signals: [
      { metric: "water_temp_supply", direction: "low", weight: 1.8 },
      { metric: "delta_t", direction: "low", weight: 1.6 },
      { metric: "power_kw", direction: "high", weight: 1.2 },
    ],
    parts: [{ label: "Descaling / flush kit", keywords: ["descal", "flush"], qty: 1 }],
    action: "Plan a flush / descale and inspect the heat exchanger.",
  },
  {
    id: "sensor_or_control_fault", label: "Sensor / control fault", equipment: /.*/, prior: 0.06, horizonDays: 14,
    signals: [
      { metric: "zone_temp", direction: "any", weight: 1.4 },
      { metric: "setpoint", direction: "any", weight: 1.0 },
      { metric: "supply_air_temp", direction: "any", weight: 0.8 },
      { metric: "return_air_temp", direction: "any", weight: 0.8 },
    ],
    parts: [{ label: "Replacement temperature sensor / thermostat", keywords: ["sensor", "thermostat"], qty: 1 }],
    action: "Verify sensor against a reference probe; check wiring and controller.",
  },
];

const KIND_WEIGHT: Record<AnomalyKind, number> = {
  spike: 1, drift: 0.9, out_of_range: 1, flatline: 0.6, rate_of_change: 0.5,
};

export interface ModeScore {
  mode: FailureMode;
  probability: number;
  confidence: number;
  drivers: { metric: MetricKind; kind: AnomalyKind; direction: Direction; evidence: number }[];
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));

function evidenceOf(s: Signal): number {
  const strength = s.kind === "out_of_range" ? 1 : Math.min(1, s.zAbs / 8);
  const persistence = 0.6 + 0.4 * Math.min(1, s.persistenceHours / 12);
  return strength * KIND_WEIGHT[s.kind] * persistence;
}

export function scoreFailureModes(equipmentLabel: string, signals: Signal[]): ModeScore[] {
  const label = equipmentLabel.toLowerCase();
  const results: ModeScore[] = [];

  for (const mode of FAILURE_MODES) {
    if (!mode.equipment.test(label)) continue;

    let z = logit(mode.prior);
    let matchedWeight = 0;
    let strongest = 0;
    const totalWeight = mode.signals.reduce((a, s) => a + s.weight, 0);
    const drivers: ModeScore["drivers"] = [];

    for (const spec of mode.signals) {
      let best: { sig: Signal; ev: number } | null = null;
      for (const sig of signals) {
        if (sig.metric !== spec.metric) continue;
        if (spec.direction !== "any" && sig.direction !== spec.direction) continue;
        const ev = evidenceOf(sig);
        if (!best || ev > best.ev) best = { sig, ev };
      }
      if (best && best.ev > 0.05) {
        z += spec.weight * best.ev;
        matchedWeight += spec.weight;
        strongest = Math.max(strongest, best.ev);
        drivers.push({ metric: best.sig.metric, kind: best.sig.kind, direction: best.sig.direction, evidence: Number(best.ev.toFixed(2)) });
      }
    }

    // Guard against single weak signals raising alarms.
    if (drivers.length === 0) continue;
    if (drivers.length < 2 && strongest < 0.8) continue;

    const probability = Math.min(0.97, sigmoid(z));
    const confidence = Math.min(0.95, 0.35 + 0.6 * (matchedWeight / totalWeight));
    results.push({ mode, probability, confidence, drivers });
  }

  return results.sort((a, b) => b.probability - a.probability);
}

/**
 * Per-account recalibration from technician feedback. A Beta(2,2)-style
 * reliability estimate scales the odds: reliable modes get boosted,
 * noisy modes get damped. This is the compounding data moat — every
 * confirmed / false-alarm outcome makes the next prediction sharper.
 */
export function applyCalibration(p: number, confirmed: number, falseAlarm: number): number {
  const reliability = (2 + confirmed) / (4 + confirmed + falseAlarm);
  const multiplier = Math.min(3, Math.max(0.2, reliability / (1 - reliability)));
  const odds = (p / (1 - p)) * multiplier;
  return Math.min(0.97, Math.max(0.01, odds / (1 + odds)));
}

/** Matches catalog part hints against the account's own parts catalogue. */
export function matchParts(
  hints: PartHint[],
  catalogue: { id: string; name: string; part_number: string | null }[],
): { label: string; qty: number; part_id: string | null; part_name: string | null }[] {
  return hints.map((h) => {
    const hit = catalogue.find((p) => {
      const hay = `${p.name} ${p.part_number ?? ""}`.toLowerCase();
      return h.keywords.some((k) => hay.includes(k));
    });
    return { label: h.label, qty: h.qty, part_id: hit?.id ?? null, part_name: hit?.name ?? null };
  });
}
