// supabase/functions/_shared/property-vision/taxonomy.ts
//
// Single source of truth for Persistent Property Vision: controlled
// vocabularies, shared types, and the transparent scoring formulas.
// Pure module (no I/O, no Deno APIs) so it is unit-testable under vitest.
//
// The remaining-life formula MUST stay in sync with public._pv_remaining_life()
// in 20270215000000_persistent_property_vision.sql.

export const PROMPT_VERSION = "pv-1.0";

export const SEVERITIES = ["info", "low", "medium", "high", "emergency"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONDITIONS = ["good", "fair", "poor", "critical", "unknown"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const INSTALL_QUALITIES = ["good", "acceptable", "deficient", "unsafe", "unknown"] as const;
export type InstallQuality = (typeof INSTALL_QUALITIES)[number];

export const AGE_BASES = ["human", "label_date", "serial_decode", "visual", "unknown"] as const;
export type AgeBasis = (typeof AGE_BASES)[number];

export const SERIAL_LEGIBILITY = ["clear", "partial", "unreadable", "none"] as const;
export type SerialLegibility = (typeof SERIAL_LEGIBILITY)[number];

export const EQUIPMENT_KINDS = [
  "water_heater", "furnace", "boiler", "air_conditioner", "heat_pump", "air_handler",
  "condenser_unit", "mini_split", "thermostat", "electrical_panel", "subpanel", "meter",
  "water_softener", "well_pump", "sump_pump", "expansion_tank", "generator", "other",
] as const;

export const HAZARD_CODES = [
  "active_leak", "water_damage", "structural_corrosion", "gas_connector_issue",
  "flue_or_venting_defect", "combustion_residue", "exposed_wiring", "scorch_marks", "mold_growth",
  "suspect_asbestos_material", "insufficient_clearance", "missing_cover_or_guard",
  "trip_or_fall_hazard", "pest_damage", "refrigerant_oil_staining", "pressure_relief_issue", "other",
] as const;

export const INSTALL_ISSUE_CODES = [
  "missing_drain_pan", "missing_expansion_tank", "missing_ptr_discharge_pipe", "improper_flue_slope",
  "missing_sediment_trap", "unsupported_piping", "missing_seismic_strapping",
  "dissimilar_metals_no_dielectric", "undersized_wiring", "double_tapped_breaker", "missing_disconnect",
  "open_junction_box", "improper_vent_termination", "missing_condensate_safety", "improper_clearance",
  "improper_slope_or_trap", "non_standard_materials", "other",
] as const;

export const CONDITION_CODES = [
  "corrosion", "rust", "scale_buildup", "leak_evidence", "water_staining", "wear", "physical_damage",
  "burn_marks", "dust_or_debris", "loose_fasteners", "insulation_damage", "cracking", "oil_residue", "other",
] as const;

export const COMPONENT_KINDS = [
  "pipe", "valve", "connector", "filter", "capacitor", "burner", "heat_exchanger", "expansion_tank",
  "anode_rod", "breaker", "wiring", "thermostat", "pump", "flue", "drain_pan", "insulation",
  "compressor", "coil", "blower", "other",
] as const;

export const ROOM_TYPES = [
  "mechanical_room", "basement", "attic", "crawlspace", "garage", "kitchen", "bathroom", "laundry",
  "exterior", "roof", "utility", "electrical_area", "other",
] as const;

export type FindingType = "hazard" | "installation_issue" | "condition_indicator" | "component";
export type ComponentOrigin = "original" | "appears_replaced" | "unknown";
export type PriorStatus = "still_visible" | "no_longer_visible" | "not_in_frame";

/** Normalized box in 0-1000 space: [ymin, xmin, ymax, xmax]. */
export type Region = [number, number, number, number];

export interface NormFinding {
  type: FindingType;
  code: string;
  locus: string;
  title: string;
  description: string;
  severity: Severity;
  standard_hint: string | null;
  verify_required: boolean;
  attrs: Record<string, unknown>;
  region: Region | null;
}

export interface NormEquipment {
  local_id: string;
  photo_indexes: number[];
  kind: string;
  make: string | null;
  model: string | null;
  serial_raw: string | null;
  serial_norm: string | null;
  serial_legibility: SerialLegibility;
  specs: string | null;
  location_label: string | null;
  match_ref: string | null;
  match_confidence: number;
  match_basis: string | null;
  condition: Condition;
  installation_quality: InstallQuality;
  age_basis: AgeBasis;
  install_year: number | null;
  age_range: [number, number] | null;
  age_confidence: number;
  region: Region | null;
  confidence: number;
  findings: NormFinding[];
}

export interface NormAnalysis {
  room_type: string;
  scene_summary: string;
  photo_quality: { photo_index: number; usable: boolean; issues: string[] }[];
  equipment: NormEquipment[];
  area_findings: NormFinding[];
  prior_review: Record<string, PriorStatus>;
}

// ------------------------------------------------------------------
// Scoring (transparent, deterministic — never left to the LLM)
// ------------------------------------------------------------------

export const SEVERITY_RANK: Record<Severity, number> = { info: 1, low: 2, medium: 3, high: 4, emergency: 5 };

export function severityRank(s: string | null | undefined): number {
  return SEVERITY_RANK[(s as Severity) ?? "info"] ?? 1;
}

export const CONDITION_SCORE: Record<Condition, number | null> = {
  good: 85, fair: 62, poor: 38, critical: 15, unknown: null,
};

/** Typical industry service-life midpoints (years). Defaults only — not manufacturer data. */
export const TYPICAL_LIFESPAN_YEARS: Record<string, number> = {
  water_heater: 11, furnace: 20, boiler: 25, air_conditioner: 15, heat_pump: 15, air_handler: 18,
  condenser_unit: 15, mini_split: 15, thermostat: 10, electrical_panel: 40, subpanel: 40, meter: 30,
  water_softener: 12, well_pump: 12, sump_pump: 10, expansion_tank: 8, generator: 20, other: 15,
};

export function lifespanFor(kind: string): number {
  return TYPICAL_LIFESPAN_YEARS[kind] ?? TYPICAL_LIFESPAN_YEARS.other;
}

export const AGE_BASIS_RANK: Record<AgeBasis, number> = {
  human: 4, label_date: 3, serial_decode: 2, visual: 1, unknown: 0,
};

/** Age in years from the best available evidence; null when unknown. */
export function ageYears(
  basis: AgeBasis, installYear: number | null, range: [number, number] | null, nowYear: number,
): number | null {
  if ((basis === "human" || basis === "label_date" || basis === "serial_decode") && installYear) {
    return Math.max(0, nowYear - installYear);
  }
  if (basis === "visual" && range) return Math.max(0, (range[0] + range[1]) / 2);
  return null;
}

/** Mirrors public._pv_remaining_life(). Rounded to the nearest 0.5 year. */
export function remainingLifeYears(lifespan: number | null, age: number | null, condition: Condition): number | null {
  if (lifespan == null || age == null) return null;
  const left = Math.max(lifespan - age, 0);
  const adj = condition === "critical" ? Math.min(left, 1) : condition === "poor" ? left * 0.5 : left;
  return Math.round(adj * 2) / 2;
}
