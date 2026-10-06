// Shared types for the Property Intelligence Graph.
// Pure types only — safe to import from Deno edge functions and from Vitest.

export type ProviderId = "census" | "rentcast" | "attom_permits" | "nasa_power" | "eia";
export type ProviderState = "ok" | "no_data" | "skipped" | "error";

export interface ProviderReport {
  state: ProviderState;
  message?: string;
  fetched_at?: string;
  latency_ms?: number;
}
export type ProviderReports = Partial<Record<ProviderId, ProviderReport>>;

export interface SiteAddressInput {
  address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
}

export interface GeoFacts {
  formatted_address: string;
  latitude: number;
  longitude: number;
  state_fips: string | null;
  county_fips: string | null;
  census_tract: string | null;
  street1: string;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/** Physical facts only. Owner, sale price and tax values are intentionally absent. */
export interface ParcelFacts {
  formatted_address: string | null;
  latitude: number | null;
  longitude: number | null;
  state_fips: string | null;
  county_fips: string | null;
  apn: string | null;
  property_type: string | null;
  year_built: number | null;
  living_sqft: number | null;
  lot_sqft: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  stories: number | null;
  heating_type: string | null;
  cooling_type: string | null;
  has_heating: boolean | null;
  has_cooling: boolean | null;
  last_sale_date: string | null;
}

export type WorkCategory =
  | "hvac"
  | "plumbing"
  | "electrical"
  | "roofing"
  | "solar"
  | "water_heater"
  | "gas"
  | "structural"
  | "other";

export interface PermitFact {
  source: string;
  source_record_id: string;
  permit_number: string | null;
  permit_type: string | null;
  work_category: WorkCategory;
  status: string | null;
  description: string | null;
  issued_date: string | null; // YYYY-MM-DD
}

export type ClimateProfile = "cooling_dominated" | "heating_dominated" | "mixed";

export interface ClimateFacts {
  source: "nasa_power";
  monthly_mean_c: number[]; // 12 values, Jan..Dec
  annual_mean_c: number | null;
  hdd65f_est: number; // estimated from monthly means (mean-temperature method)
  cdd65f_est: number;
  profile: ClimateProfile;
}

export interface EnergyFacts {
  source: "eia";
  state: string;
  residential_cents_per_kwh: number;
  residential_cents_per_kwh_12m_avg: number | null;
  period: string | null; // YYYY-MM
}

export interface EquipmentLite {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  status: string;
  expected_lifespan_years: number | null;
  last_service_date: string | null;
}

export interface JobLite {
  id: string;
  service_type: string | null;
  job_status: string;
  scheduled_datetime: string | null;
}

/** What scoring/briefing needs about the stored profile. */
export interface ProfileFacts {
  formatted_address: string | null;
  apn: string | null;
  property_type: string | null;
  year_built: number | null;
  year_built_source: "manual" | "provider" | null;
  living_sqft: number | null;
  lot_sqft: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  stories: number | null;
  heating_type: string | null;
  cooling_type: string | null;
  has_heating: boolean | null;
  has_cooling: boolean | null;
  census_tract: string | null;
  climate: ClimateFacts | null;
  energy: EnergyFacts | null;
}

export type AgeBasis = "equipment_record" | "service_history" | "permit" | "year_built" | "unknown";
export type LikelihoodLevel = "high" | "medium" | "low" | "unknown";

export interface HvacAssessment {
  level: LikelihoodLevel;
  /** Most likely score (0-100), null when nothing is known. */
  score: number | null;
  /** Upper bound if the original system is still in place (year_built basis only). */
  ceiling_score: number | null;
  /** 0-1 confidence in the age estimate. */
  confidence: number;
  basis: AgeBasis;
  estimated_install_year: number | null;
  estimated_age_years: number | null;
  expected_life_years: number;
  hvac_repairs_24m: number;
  reasons: string[];
  ask_caller: string | null;
}

export type SignalSeverity = "info" | "watch" | "alert";

export interface PropertySignal {
  id: string;
  label: string;
  detail: string;
  severity: SignalSeverity;
  trades: string[];
}

export type NodeState = "known" | "estimated" | "missing";

export interface GraphNode {
  id: string;
  kind:
    | "address"
    | "parcel"
    | "characteristics"
    | "building_age"
    | "square_footage"
    | "permits"
    | "equipment"
    | "climate"
    | "utility"
    | "energy"
    | "service_history";
  label: string;
  value: string;
  state: NodeState;
  source: string | null;
  detail: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string | null;
}

export interface PropertyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 0-1: share of the graph that is known (estimated counts half). */
  coverage: number;
}

export interface ServiceStats {
  visits: number;
  completed_visits: number;
  last_visit: string | null;
  hvac_repairs_24m: number;
}

export interface PermitSummary {
  permit_number: string | null;
  permit_type: string | null;
  work_category: WorkCategory;
  status: string | null;
  description: string | null;
  issued_date: string | null;
  source: string;
}

export type BriefingStatus = "not_enriched" | "pending" | "ready" | "partial" | "failed";

export interface PropertyBriefing {
  site_id: string;
  status: BriefingStatus;
  fetched_at: string | null;
  refresh_after: string | null;
  is_stale: boolean;
  providers: ProviderReports;
  profile: ProfileFacts | null;
  hvac: HvacAssessment;
  signals: PropertySignal[];
  permits: PermitSummary[];
  service: ServiceStats;
  graph: PropertyGraph;
  /** Internal, allowlisted context for the voice agent. Never contains address, APN, permit numbers or owner data. */
  voice_context: string;
}
