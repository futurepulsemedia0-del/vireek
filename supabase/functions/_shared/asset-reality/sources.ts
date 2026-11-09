// supabase/functions/_shared/asset-reality/sources.ts
// Asset-attribute sources and freshness policies, spread into the existing Operational Truth
// SOURCE_CATALOG / BUILTIN_POLICIES (engine.ts) so asset claims use ONE trust engine.
// Pure, no imports. Types are structural copies of SourceDef / TruthPolicy.

interface SrcDef { key: string; label: string; kind: "authority" | "system" | "document" | "human" | "ai"; reliability: number; authoritative: boolean; userAssertable: boolean }
interface Pol { predicate: string; min_confidence: number; max_age_days: number; min_independent_sources: number; expiring_warning_days: number }

export const ASSET_SOURCES: Record<string, SrcDef> = {
  technician_measurement: { key: "technician_measurement", label: "Technician Measurement (manual)", kind: "human", reliability: 0.78, authoritative: false, userAssertable: true },
  instrument_bluetooth: { key: "instrument_bluetooth", label: "Bluetooth Instrument", kind: "system", reliability: 0.92, authoritative: false, userAssertable: false },
  nameplate_ocr: { key: "nameplate_ocr", label: "Nameplate OCR", kind: "document", reliability: 0.75, authoritative: false, userAssertable: false },
  installed_sensor: { key: "installed_sensor", label: "Installed Sensor / Thermostat", kind: "system", reliability: 0.85, authoritative: false, userAssertable: false },
  oem_database: { key: "oem_database", label: "OEM Database", kind: "document", reliability: 0.9, authoritative: false, userAssertable: false },
  owner_attested: { key: "owner_attested", label: "Owner Attested", kind: "human", reliability: 0.6, authoritative: false, userAssertable: true },
  other_company_attestation: { key: "other_company_attestation", label: "Other Company Attestation", kind: "human", reliability: 0.65, authoritative: false, userAssertable: false },
  regulatory_record: { key: "regulatory_record", label: "Regulatory Record", kind: "authority", reliability: 0.97, authoritative: true, userAssertable: false },
};

/** Half-lives (days) per attribute class: identity long, charge medium, vitals short. */
export const HALF_LIFE_DAYS = { identity: 3650, spec: 3650, charge: 365, vital: 7 } as const;

export const ASSET_POLICIES: Pol[] = [
  { predicate: "asset.identity.", min_confidence: 0.7, max_age_days: 3650, min_independent_sources: 1, expiring_warning_days: 0 },
  { predicate: "asset.spec.", min_confidence: 0.7, max_age_days: 3650, min_independent_sources: 1, expiring_warning_days: 0 },
  { predicate: "asset.charge.", min_confidence: 0.7, max_age_days: 365, min_independent_sources: 1, expiring_warning_days: 30 },
  { predicate: "asset.vital.", min_confidence: 0.7, max_age_days: 14, min_independent_sources: 1, expiring_warning_days: 0 },
];
