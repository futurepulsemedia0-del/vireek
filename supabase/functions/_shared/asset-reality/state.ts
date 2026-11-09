// supabase/functions/_shared/asset-reality/state.ts
// Pure per-asset STATE resolution. One winner per attribute, explicit tested conflict rules.
// "No data -> no claim": missing facts stay unknown. Disagreement beyond tolerance is a conflict,
// never a silent overwrite. Claims are persisted through truth_write_claim (Operational Truth);
// this module only decides what the read model shows.
import { ASSET_SOURCES, HALF_LIFE_DAYS } from "./sources.ts";

export type AttrClass = keyof typeof HALF_LIFE_DAYS;
export type ClaimMethod = "instrument" | "sensor" | "manual" | "ocr" | "database" | "attestation" | "regulatory";
export type Value = number | string | boolean;

export interface AssetClaim {
  id: string;
  attribute: string;
  value: Value;
  source_key: string;
  method: ClaimMethod;
  measured_at: string;
  verified: boolean;       // human-confirmed / verification_level >= verified
  confirmed?: boolean;     // OCR fields: human confirmation
  independent_key?: string; // company/tenant of origin, for independence
}

export interface AttrSpec { cls: AttrClass; abs?: number; rel?: number }
/** Tolerances in STORAGE units (see measurement.ts). */
export const ATTRIBUTES: Record<string, AttrSpec> = {
  manufacture_date: { cls: "identity" }, serial_number: { cls: "identity" }, model: { cls: "identity" }, make: { cls: "identity" },
  rated_amps: { cls: "spec", rel: 0.03 }, rated_charge_kg: { cls: "spec", rel: 0.03 }, capacity_kw: { cls: "spec", rel: 0.03 },
  refrigerant_type: { cls: "spec" },
  refrigerant_charge_kg: { cls: "charge", rel: 0.05, abs: 0.02 },
  superheat: { cls: "vital", abs: 1.5 }, subcooling: { cls: "vital", abs: 1.5 }, delta_t: { cls: "vital", abs: 1.5 },
  compressor_current: { cls: "vital", rel: 0.08, abs: 0.3 }, static_pressure: { cls: "vital", abs: 20 },
  suction_pressure: { cls: "vital", rel: 0.05 }, discharge_pressure: { cls: "vital", rel: 0.05 },
};

export const predicateFor = (attribute: string): string | null => {
  const s = ATTRIBUTES[attribute];
  return s ? `asset.${s.cls}.${attribute}` : null;
};

const METHOD_RANK: Record<ClaimMethod, number> = { regulatory: 6, instrument: 5, sensor: 4, database: 3, ocr: 2, attestation: 2, manual: 1 };
const DAY = 86_400_000;
const CONFLICT_MIN_CONF = 0.35;
const MIN_USABLE_CONF = 0.1;
/** Vitals change over time: only measurements this close together can contradict each other. */
const VITAL_CONFLICT_WINDOW_DAYS = 1;

export interface ScoredClaim extends AssetClaim { age_days: number; confidence: number; safety_eligible: boolean }

export interface AttributeState {
  attribute: string;
  cls: AttrClass | null;
  status: "ok" | "conflict" | "unknown";
  value: Value | null;
  winning_claim_id: string | null;
  confidence: number;
  age_days: number | null;
  verified: boolean;
  safety_eligible: boolean;       // false while OCR is unconfirmed or confidence < 0.7
  conflict_claim_ids: string[];
  considered_claim_ids: string[];
}

const UNKNOWN = (attribute: string, cls: AttrClass | null): AttributeState => ({
  attribute, cls, status: "unknown", value: null, winning_claim_id: null, confidence: 0, age_days: null,
  verified: false, safety_eligible: false, conflict_claim_ids: [], considered_claim_ids: [],
});

export function scoreClaim(c: AssetClaim, cls: AttrClass, now: Date): ScoredClaim | null {
  const t = Date.parse(c.measured_at);
  if (!Number.isFinite(t) || t > now.getTime() + 60_000) return null;
  const age = Math.max(0, (now.getTime() - t) / DAY);
  const rel = ASSET_SOURCES[c.source_key]?.reliability ?? 0.3; // unknown sources get the engine's 0.3 floor
  const confidence = Math.round(rel * Math.pow(0.5, age / HALF_LIFE_DAYS[cls]) * 10_000) / 10_000;
  const ocrPending = c.method === "ocr" && !c.confirmed && !c.verified;
  return { ...c, age_days: Math.round(age * 1000) / 1000, confidence, safety_eligible: !ocrPending && confidence >= 0.7 };
}

export function sameValue(a: Value, b: Value, spec: AttrSpec): boolean {
  if (typeof a === "number" && typeof b === "number") {
    const tol = Math.max(spec.abs ?? 0, (spec.rel ?? 0) * Math.max(Math.abs(a), Math.abs(b)));
    return Math.abs(a - b) <= tol;
  }
  return String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
}

/** Ordering: verified > unverified; instrument-grade > manual; newer first; id as a deterministic final tiebreak. */
function compare(a: ScoredClaim, b: ScoredClaim): number {
  return Number(b.verified) - Number(a.verified)
    || METHOD_RANK[b.method] - METHOD_RANK[a.method]
    || Date.parse(b.measured_at) - Date.parse(a.measured_at)
    || (a.id < b.id ? -1 : 1);
}

export function resolveAttribute(attribute: string, claims: AssetClaim[], now: Date = new Date()): AttributeState {
  const spec = ATTRIBUTES[attribute];
  if (!spec) return UNKNOWN(attribute, null); // unregistered attribute: never invent a state
  const scored = claims
    .filter((c) => c.attribute === attribute)
    .map((c) => scoreClaim(c, spec.cls, now))
    .filter((c): c is ScoredClaim => c !== null && c.confidence >= MIN_USABLE_CONF);
  if (scored.length === 0) return UNKNOWN(attribute, spec.cls);

  scored.sort(compare);
  const lead = scored[0];
  const windowMs = spec.cls === "vital" ? VITAL_CONFLICT_WINDOW_DAYS * DAY : Infinity;
  const contradicting = scored.slice(1).filter((c) =>
    c.confidence >= CONFLICT_MIN_CONF &&
    Math.abs(Date.parse(c.measured_at) - Date.parse(lead.measured_at)) <= windowMs &&
    !sameValue(lead.value, c.value, spec) &&
    // same origin disagreeing with itself is a correction (newer wins), not a dispute
    !(c.independent_key && c.independent_key === lead.independent_key && c.source_key === lead.source_key),
  );
  const base = {
    attribute, cls: spec.cls, value: lead.value, winning_claim_id: lead.id, confidence: lead.confidence,
    age_days: lead.age_days, verified: lead.verified, safety_eligible: lead.safety_eligible,
    considered_claim_ids: scored.map((c) => c.id),
  };
  if (contradicting.length > 0) {
    // Conflict: surface the leader, but it is NOT safe to act on until a human resolves it.
    return { ...base, status: "conflict", safety_eligible: false, conflict_claim_ids: [lead.id, ...contradicting.map((c) => c.id)] };
  }
  return { ...base, status: "ok", conflict_claim_ids: [] };
}

export function resolveAssetState(claims: AssetClaim[], now: Date = new Date()): AttributeState[] {
  const attrs = [...new Set(claims.map((c) => c.attribute))].sort();
  return attrs.map((a) => resolveAttribute(a, claims, now));
}
