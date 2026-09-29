// supabase/functions/_shared/permit-rules/types.ts
//
// Shared types for the AI Permit / Code / Compliance Engine.
// Pure TypeScript, zero dependencies - runs unchanged in Deno (Edge
// Functions) and Node (Vitest). Keep src/lib/permitCompliance.ts in sync.

export type WorkType =
  | "electrical_service"
  | "electrical_new"
  | "ev_charger"
  | "generator"
  | "electrical_repair"
  | "water_heater"
  | "plumbing_repipe"
  | "plumbing_drain"
  | "plumbing_fixture"
  | "gas_work"
  | "hvac_replace"
  | "hvac_new"
  | "ductwork"
  | "refrigerant"
  | "appliance_repair"
  | "maintenance";

export type RequirementCategory =
  | "permit"
  | "inspection"
  | "licensing"
  | "safety"
  | "documentation"
  | "regulation";

/** blocker = do not start until resolved or consciously acknowledged. */
export type Severity = "blocker" | "warning" | "info";

/** How sure we are. Federal/national rules = high; "typically required" = medium; inferred = low. */
export type Confidence = "high" | "medium" | "low";

export type PermitLikelihood = "likely_required" | "possibly_required" | "unlikely" | "unknown";

export type RequirementSource = "rule" | "ai";

export interface RequirementItem {
  /** Stable key - progress/acknowledgements are stored against it. */
  key: string;
  category: RequirementCategory;
  severity: Severity;
  title: string;
  detail: string;
  /** Who to verify with (AHJ, state board, EPA...). */
  authority: string | null;
  /** Code / regulation citation, when there is a real one. */
  reference: string | null;
  confidence: Confidence;
  source: RequirementSource;
}

export interface JurisdictionInfo {
  country: string | null; // ISO-3166 alpha-2, upper-case
  state: string | null; // US state / DC code
  stateName: string | null;
  city: string | null;
  zip: string | null;
  label: string; // human-readable, e.g. "Austin, TX 78701, US"
  /** How the jurisdiction was determined. */
  basis: "address" | "country_only" | "unknown";
  /** Curated deterministic coverage level for this jurisdiction. */
  coverage: "us_curated" | "country_curated" | "generic";
}

export interface JobFacts {
  serviceType: string | null;
  dispatchNote: string | null;
  diagnosisNote: string | null;
  address: string | null;
  countryHint: string | null;
  customerType: "residential" | "commercial" | null;
  isEmergency: boolean;
  isRework: boolean;
  tags: string[];
  equipmentType: string | null;
}

export interface EngineResult {
  jurisdiction: JurisdictionInfo;
  workTypes: WorkType[];
  permitLikelihood: PermitLikelihood;
  items: RequirementItem[];
}
