/**
 * Pest Ops — configurable treatment-record requirements per region (pure).
 *
 * ⚠ REQUIRES COUNSEL. Record-keeping rules differ by country, state/province and licence class and
 * change over time. Nothing in this file states what any jurisdiction requires. The presets below
 * are neutral starting points the business adjusts after confirming its own obligations with its
 * regulator or counsel. The database stores the business's chosen set (pest_region_profiles) and
 * records who acknowledged that review.
 */

export const RECORD_FIELDS = [
  'application_date',
  'application_time',
  'site_address',
  'customer_name',
  'applicator_name',
  'applicator_license',
  'product_name',
  'epa_reg_number',
  'quantity_applied',
  'quantity_unit',
  'target_pest',
  'areas_treated',
  'application_method',
  'dilution_rate',
  'weather_conditions',
  'customer_notified',
] as const;

export type RecordFieldKey = (typeof RECORD_FIELDS)[number];

export const RECORD_FIELD_LABELS: Record<RecordFieldKey, string> = {
  application_date: 'Date of application',
  application_time: 'Time of application',
  site_address: 'Site address',
  customer_name: 'Customer name',
  applicator_name: 'Applicator name',
  applicator_license: 'Applicator licence number',
  product_name: 'Product name',
  epa_reg_number: 'Registration number (EPA-style)',
  quantity_applied: 'Quantity applied',
  quantity_unit: 'Unit of quantity',
  target_pest: 'Target pest',
  areas_treated: 'Areas treated',
  application_method: 'Application method',
  dilution_rate: 'Dilution / mix rate',
  weather_conditions: 'Weather (wind / temperature)',
  customer_notified: 'Customer notification recorded',
};

export function isRecordField(v: string): v is RecordFieldKey {
  return (RECORD_FIELDS as readonly string[]).includes(v);
}

export interface RegionPreset {
  key: 'baseline' | 'extended';
  label: string;
  requiredFields: RecordFieldKey[];
  /** Always true: no preset is a statement of what the law requires. */
  requiresCounsel: true;
}

export const REGION_PRESETS: RegionPreset[] = [
  {
    key: 'baseline',
    label: 'Baseline (what the Pest pack always captures)',
    requiredFields: ['application_date', 'applicator_name', 'applicator_license', 'product_name', 'epa_reg_number', 'quantity_applied', 'quantity_unit', 'target_pest', 'areas_treated'],
    requiresCounsel: true,
  },
  {
    key: 'extended',
    label: 'Extended (adds site, customer, method, mix rate, weather, notification)',
    requiredFields: [
      'application_date', 'application_time', 'site_address', 'customer_name', 'applicator_name', 'applicator_license',
      'product_name', 'epa_reg_number', 'quantity_applied', 'quantity_unit', 'target_pest', 'areas_treated',
      'application_method', 'dilution_rate', 'weather_conditions', 'customer_notified',
    ],
    requiresCounsel: true,
  },
];

export const REGION_COUNSEL_NOTICE =
  'REQUIRES COUNSEL: choose the fields your regulator requires. These presets are not legal advice and are not verified for any region.';

/** A free-form label such as "US-TX", "CA-ON", "GB", "AU-NSW", "DE". Letters, digits and "-" only. */
export const REGION_CODE_RE = /^[A-Za-z]{2}(-[A-Za-z0-9]{1,3})?$/;

export interface RegionProfile {
  regionCode: string;
  requiredFields: RecordFieldKey[];
  retentionYears: number;
  /** Set when an owner/admin confirmed the field set was reviewed against local rules. */
  counselAcknowledgedAt: string | null;
}

export function validateRegionProfile(p: { regionCode: string; requiredFields: string[]; retentionYears: number }): string[] {
  const errors: string[] = [];
  if (!REGION_CODE_RE.test(p.regionCode.trim())) errors.push('Region code looks like US, US-TX, CA-ON, GB or AU-NSW');
  if (p.requiredFields.length === 0) errors.push('Choose at least one required field');
  const bad = p.requiredFields.filter((f) => !isRecordField(f));
  if (bad.length) errors.push(`Unknown field: ${bad[0]}`);
  if (new Set(p.requiredFields).size !== p.requiredFields.length) errors.push('Duplicate fields in the list');
  if (!Number.isInteger(p.retentionYears) || p.retentionYears < 1 || p.retentionYears > 15) errors.push('Retention must be 1-15 years');
  return errors;
}

/** The minimal slice of a ledger entry (trade_log_entries row) the check needs. */
export interface RecordSource {
  performed_at: string | null;
  site_address: string | null;
  technician_name: string | null;
  credential_number: string | null;
  product_name: string | null;
  product_epa_reg: string | null;
  /** True when the product is marked exempt from registration (25(b)-style). */
  product_exempt: boolean;
  customer_name: string | null;
  data: Record<string, unknown>;
}

const filled = (v: unknown): boolean => v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '') && !(Array.isArray(v) && v.length === 0);

const CHECKS: Record<RecordFieldKey, (r: RecordSource) => boolean> = {
  application_date: (r) => filled(r.performed_at),
  application_time: (r) => filled(r.performed_at),
  site_address: (r) => filled(r.site_address),
  customer_name: (r) => filled(r.customer_name),
  applicator_name: (r) => filled(r.technician_name),
  applicator_license: (r) => filled(r.credential_number),
  product_name: (r) => filled(r.product_name),
  epa_reg_number: (r) => filled(r.product_epa_reg) || r.product_exempt,
  quantity_applied: (r) => typeof r.data.amount === 'number' && r.data.amount > 0,
  quantity_unit: (r) => filled(r.data.amount_unit),
  target_pest: (r) => filled(r.data.target_pests),
  areas_treated: (r) => filled(r.data.application_site) || (typeof r.data.area_sqft === 'number' && r.data.area_sqft > 0),
  application_method: (r) => filled(r.data.method),
  dilution_rate: (r) => filled(r.data.dilution),
  weather_conditions: (r) => typeof r.data.wind_mph === 'number' || typeof r.data.temp_f === 'number',
  customer_notified: (r) => typeof r.data.customer_notified === 'boolean',
};

export interface RecordCheck {
  complete: boolean;
  missing: RecordFieldKey[];
}

export function checkRecord(record: RecordSource, required: readonly RecordFieldKey[]): RecordCheck {
  const missing = required.filter((f) => !CHECKS[f](record));
  return { complete: missing.length === 0, missing };
}

export interface CompletenessSummary {
  total: number;
  complete: number;
  incomplete: number;
  /** Fields missing most often, descending. */
  topMissing: Array<{ field: RecordFieldKey; count: number }>;
}

export function summarizeCompleteness(records: RecordSource[], required: readonly RecordFieldKey[]): CompletenessSummary {
  const counts = new Map<RecordFieldKey, number>();
  let complete = 0;
  for (const r of records) {
    const c = checkRecord(r, required);
    if (c.complete) complete += 1;
    for (const f of c.missing) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const topMissing = [...counts.entries()].map(([field, count]) => ({ field, count })).sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
  return { total: records.length, complete, incomplete: records.length - complete, topMissing };
}
