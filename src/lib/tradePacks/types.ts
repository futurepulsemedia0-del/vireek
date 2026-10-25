/**
 * Trade Pack framework — shared types.
 *
 * A Trade Pack is an OPTIONAL, per-tenant bundle of trade-specific operations:
 * custom fields, forms/checklists, pricing models, recurring-plan templates,
 * a regulated-product register, compliance log types and route defaults.
 * Packs are pure data (a `TradePack` manifest) interpreted by the generic
 * engine in framework.ts; the database enforces the rules that matter
 * (supabase/migrations/20271201000000_trade_packs.sql).
 */

import type { IntervalUnit } from '@/lib/recurringJobs';
import type { FormField } from '@/lib/offline/formSchema';

export type PackKey = 'pest_control' | 'pool_service';

/* ------------------------------------------------------------------ */
/* Units + product kinds (mirrored by CHECK constraints in the DB)      */
/* ------------------------------------------------------------------ */

export const PRODUCT_UNITS = ['oz', 'fl_oz', 'lb', 'gal', 'qt', 'g', 'kg', 'ml', 'l', 'each'] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

export const UNIT_LABELS: Record<ProductUnit, string> = {
  oz: 'oz (weight)',
  fl_oz: 'fl oz',
  lb: 'lb',
  gal: 'gal',
  qt: 'qt',
  g: 'g',
  kg: 'kg',
  ml: 'mL',
  l: 'L',
  each: 'each / tablets',
};

export const PRODUCT_KINDS = [
  'insecticide',
  'rodenticide',
  'herbicide',
  'bait',
  'repellent',
  'sanitizer',
  'ph_adjuster',
  'alkalinity',
  'stabilizer',
  'algaecide',
  'clarifier',
  'salt',
  'other',
] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const KIND_LABELS: Record<ProductKind, string> = {
  insecticide: 'Insecticide',
  rodenticide: 'Rodenticide',
  herbicide: 'Herbicide',
  bait: 'Bait',
  repellent: 'Repellent',
  sanitizer: 'Sanitizer',
  ph_adjuster: 'pH adjuster',
  alkalinity: 'Alkalinity',
  stabilizer: 'Stabilizer (CYA)',
  algaecide: 'Algaecide',
  clarifier: 'Clarifier',
  salt: 'Salt',
  other: 'Other',
};

/** Kinds that are pesticides under FIFRA and therefore need an EPA registration (or a 25(b) exemption). */
export const PESTICIDE_KINDS: ProductKind[] = ['insecticide', 'rodenticide', 'herbicide', 'bait', 'repellent'];

/* ------------------------------------------------------------------ */
/* Compliance log types                                                 */
/* ------------------------------------------------------------------ */

export type LogFieldType = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'multiselect';

export interface LogFieldDef {
  key: string;
  label: string;
  type: LogFieldType;
  required?: boolean;
  options?: string[];
  min?: number;
  max?: number;
  unit?: string;
  help?: string;
}

export interface LogTypeDef {
  key: string;
  label: string;
  description: string;
  fields: LogFieldDef[];
  /** Field work: needs a job. Stock / admin records do not. */
  requiresJob: boolean;
  requiresTechnician: boolean;
  requiresEquipment: boolean;
  /** A product from the tenant's register is required (stored on the row, not in `data`). */
  usesProduct: boolean;
  /** Credential types (technician_credentials.credential_type) of which the technician must hold ONE. */
  requiredCredentials: string[];
  /** Extra credential types demanded when the product is restricted-use. */
  restrictedCredentials: string[];
  /** At least one of these numeric keys must be present. */
  atLeastOneOf?: string[];
  retentionYears: number;
}

/* ------------------------------------------------------------------ */
/* Pricing                                                              */
/* ------------------------------------------------------------------ */

export type Billing = 'one_time' | 'per_visit';

export interface RateTier {
  /** Inclusive upper bound; null = open-ended top tier. */
  upTo: number | null;
  price: number;
}

export type PricingLine =
  | { kind: 'flat'; key: string; label: string; amount: number; billing: Billing }
  | { kind: 'tier'; key: string; label: string; inputKey: string; tiers: RateTier[]; billing: Billing }
  | { kind: 'per_unit'; key: string; label: string; inputKey: string; unitPrice: number; minCharge?: number; billing: Billing }
  | { kind: 'cost_plus'; key: string; label: string; inputKey: string; markupPct: number; billing: Billing };

export interface PricingInputDef {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  defaultValue: number;
}

export interface PricingModelDef {
  key: string;
  label: string;
  description: string;
  inputs: PricingInputDef[];
  lines: PricingLine[];
}

export interface QuoteLine {
  key: string;
  label: string;
  billing: Billing;
  amount: number;
}

export interface Quote {
  lines: QuoteLine[];
  oneTime: number;
  perVisit: number;
  annualRecurring: number;
  monthlyRecurring: number;
  firstYearTotal: number;
}

/** Rate overrides stored in trade_pack_installs.config.rates, keyed by line key. */
export type RateOverrides = Record<string, number | RateTier[]>;

/* ------------------------------------------------------------------ */
/* Plans, routes, seeded fields + forms                                 */
/* ------------------------------------------------------------------ */

export interface PlanTemplate {
  key: string;
  title: string;
  description: string;
  intervalUnit: IntervalUnit;
  intervalCount: number;
  durationMinutes: number;
  /** Suggested pricing model + defaults for the quote. */
  pricingModel: string;
  /** Inclusive month numbers (1-12) when visits are allowed; omitted = year-round. */
  season?: { fromMonth: number; toMonth: number };
}

export interface SeedCustomField {
  entity: 'customer' | 'job';
  key: string;
  label: string;
  field_type: 'text' | 'number' | 'select' | 'date' | 'boolean';
  options?: string[];
  required?: boolean;
  show_in_table?: boolean;
  show_in_filters?: boolean;
}

export interface SeedForm {
  slug: string;
  title: string;
  description: string;
  kind: 'form' | 'checklist';
  fields: FormField[];
}

export interface RouteDefaults {
  /** Minutes of productive work per technician-day used when planning routes. */
  workdayMinutes: number;
  /** Average drive speed (km/h) for ETA estimates. */
  speedKmh: number;
  defaultStopMinutes: number;
  /** Weekdays (0 = Sunday) offered by default. */
  weekdays: number[];
}

export interface TradePack {
  key: PackKey;
  name: string;
  tagline: string;
  /** Slug of the marketing industry in src/lib/industries.ts. */
  industrySlug: string;
  /** Case-insensitive substrings of jobs.service_type / agreement service_type that belong to this pack. */
  serviceKeywords: string[];
  productKinds: ProductKind[];
  logTypes: LogTypeDef[];
  customFields: SeedCustomField[];
  forms: SeedForm[];
  pricingModels: PricingModelDef[];
  plans: PlanTemplate[];
  routes: RouteDefaults;
  /** Plain-language reminder shown in the UI: records support, but never replace, local law. */
  complianceNote: string;
}
