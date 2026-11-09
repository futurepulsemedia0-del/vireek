// supabase/functions/_shared/vertical-ai/types.ts
//
// Shared contracts for the Vertical AI layer (trade ontology, grounding, deterministic pricing,
// emergency rules, structured intake). PURE types: no imports, no I/O.

export type Trade = "hvac" | "plumbing" | "electrical";
/** Ontology scope: a trade, or "all" for cross-trade safety rules. */
export type OntologyTrade = Trade | "all";

export type UrgencyClass = "emergency" | "urgent" | "routine";

export type SafetyFlag =
  | "gas_odor"
  | "carbon_monoxide"
  | "fire_or_smoke"
  | "sparking_or_burning"
  | "electric_shock"
  | "downed_line"
  | "water_near_electrical"
  | "active_flooding"
  | "sewage_backup"
  | "no_heat_freezing"
  | "vulnerable_occupant_no_climate"
  | "caller_declared_emergency";

export type OntologyKind = "symptom" | "safety_rule" | "permit_trigger" | "code_note" | "parts_labor";

export interface EvidenceRef {
  /** Stable id, e.g. `onto:hvac:symptom:no_cooling@v1`, `price_book:<uuid>`, `kb:<uuid>@v3`, `rule:emergency:gas_odor`. */
  id: string;
  kind: "ontology" | "price_book" | "knowledge" | "policy" | "rule";
  version?: number;
  /** 0..1. Tenant-authored price rows are 1. */
  confidence: number;
  /** Reviewed by a licensed professional / the tenant owner. Unreviewed evidence can only be asserted as "uncertain". */
  reviewed: boolean;
  effectiveOn?: string | null;
  expiresOn?: string | null;
  jurisdiction?: string | null;
  source: string;
}

export type AssertionType = "price" | "urgency" | "diagnosis_hint" | "safety_advice" | "code_permit";

export interface Assertion {
  type: AssertionType;
  text: string;
  evidence: EvidenceRef[];
}

export type GroundingStatus = "grounded" | "uncertain" | "ungrounded";

export interface UrgencyVerdict {
  urgency: UrgencyClass;
  flags: SafetyFlag[];
  /** Rule ids that fired (audit). Never contains more than the matched rule id. */
  rules: string[];
  /** True when the deterministic layer forces emergency handling regardless of what the model decided. */
  override: boolean;
}
