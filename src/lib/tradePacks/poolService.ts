/**
 * Pack 2 — Pool service.
 * Chemistry readings, route scheduling, equipment + dosing history.
 */

import { PRODUCT_UNITS, type LogTypeDef, type TradePack } from './types';

/* ------------------------------------------------------------------ */
/* Water chemistry                                                      */
/* ------------------------------------------------------------------ */

export type ChemKey = 'fc' | 'tc' | 'ph' | 'ta' | 'cya' | 'ch' | 'salt';

export interface ChemRange {
  label: string;
  unit: string;
  /** Target band. */
  min: number;
  max: number;
  /** Beyond these the reading is critical (act now / consider closing a public pool). */
  critMin?: number;
  critMax?: number;
}

/** Typical targets for residential pools; commercial / public pools follow local health codes. */
export const CHEM_RANGES: Record<ChemKey, ChemRange> = {
  fc: { label: 'Free chlorine', unit: 'ppm', min: 1, max: 4, critMin: 0.5, critMax: 10 },
  tc: { label: 'Total chlorine', unit: 'ppm', min: 1, max: 5 },
  ph: { label: 'pH', unit: '', min: 7.2, max: 7.8, critMin: 6.8, critMax: 8.2 },
  ta: { label: 'Total alkalinity', unit: 'ppm', min: 80, max: 120, critMin: 50, critMax: 200 },
  cya: { label: 'Stabilizer (CYA)', unit: 'ppm', min: 30, max: 50, critMax: 100 },
  ch: { label: 'Calcium hardness', unit: 'ppm', min: 200, max: 400, critMin: 100, critMax: 700 },
  salt: { label: 'Salt', unit: 'ppm', min: 2700, max: 3400, critMin: 2000, critMax: 4500 },
};

export type ChemStatus = 'ok' | 'low' | 'high' | 'critical_low' | 'critical_high';

export function chemStatus(key: ChemKey, value: number): ChemStatus {
  const r = CHEM_RANGES[key];
  if (r.critMin !== undefined && value < r.critMin) return 'critical_low';
  if (r.critMax !== undefined && value > r.critMax) return 'critical_high';
  if (value < r.min) return 'low';
  if (value > r.max) return 'high';
  return 'ok';
}

export interface ChemReadings {
  fc?: number;
  tc?: number;
  ph?: number;
  ta?: number;
  cya?: number;
  ch?: number;
  salt?: number;
  temp_f?: number;
}

export interface ChemEvaluation {
  statuses: Partial<Record<ChemKey, ChemStatus>>;
  /** Total − free chlorine; > 0.4 ppm means chloramines (shock / breakpoint). */
  combinedChlorine: number | null;
  overall: 'ok' | 'attention' | 'critical';
  flagged: ChemKey[];
}

export function evaluateChemistry(r: ChemReadings): ChemEvaluation {
  const statuses: Partial<Record<ChemKey, ChemStatus>> = {};
  (Object.keys(CHEM_RANGES) as ChemKey[]).forEach((k) => {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v)) statuses[k] = chemStatus(k, v);
  });
  const flagged = (Object.keys(statuses) as ChemKey[]).filter((k) => statuses[k] !== 'ok');
  const combinedChlorine = typeof r.tc === 'number' && typeof r.fc === 'number' ? Math.max(0, Math.round((r.tc - r.fc) * 100) / 100) : null;
  const critical = flagged.some((k) => statuses[k]!.startsWith('critical'));
  const attention = flagged.length > 0 || (combinedChlorine !== null && combinedChlorine > 0.4);
  return { statuses, combinedChlorine, overall: critical ? 'critical' : attention ? 'attention' : 'ok', flagged };
}

const TEMP_FACTOR: Array<[number, number]> = [[32, 0.0], [37, 0.1], [46, 0.2], [53, 0.3], [60, 0.4], [66, 0.5], [76, 0.6], [84, 0.7], [94, 0.8], [105, 0.9]];

function tempFactor(f: number): number {
  if (f <= TEMP_FACTOR[0][0]) return TEMP_FACTOR[0][1];
  const last = TEMP_FACTOR[TEMP_FACTOR.length - 1];
  if (f >= last[0]) return last[1];
  for (let i = 1; i < TEMP_FACTOR.length; i++) {
    const [t1, v1] = TEMP_FACTOR[i];
    const [t0, v0] = TEMP_FACTOR[i - 1];
    if (f <= t1) return v0 + ((f - t0) / (t1 - t0)) * (v1 - v0);
  }
  return last[1];
}

/**
 * Simplified Langelier Saturation Index (carbonate alkalinity = TA − CYA/3, TDS constant 12.1).
 * Needs pH, TA, calcium hardness and temperature. ≈ 0 balanced; < −0.3 corrosive; > +0.3 scaling.
 */
export function langelierIndex(r: ChemReadings): number | null {
  const { ph, ta, ch, temp_f } = r;
  if ([ph, ta, ch, temp_f].some((v) => typeof v !== 'number' || !Number.isFinite(v)) || (ch as number) <= 0) return null;
  const carbonate = Math.max(1, (ta as number) - ((r.cya ?? 0) / 3));
  const lsi = (ph as number) + tempFactor(temp_f as number) + (Math.log10(ch as number) - 0.4) + Math.log10(carbonate) - 12.1;
  return Math.round(lsi * 100) / 100;
}

export type Saturation = 'corrosive' | 'balanced' | 'scaling';

export function saturation(lsi: number): Saturation {
  return lsi < -0.3 ? 'corrosive' : lsi > 0.3 ? 'scaling' : 'balanced';
}

/* ------------------------------------------------------------------ */
/* Log types                                                            */
/* ------------------------------------------------------------------ */

const COMPONENTS = ['Pump', 'Filter', 'Heater', 'Salt cell', 'Chlorinator / feeder', 'Controller', 'Cleaner', 'Cover', 'Light', 'Plumbing / valves', 'Other'];

export const POOL_LOG_TYPES: LogTypeDef[] = [
  {
    key: 'chemistry_reading',
    label: 'Chemistry reading',
    description: 'Water test results for a visit, with automatic range flags.',
    requiresJob: true,
    requiresTechnician: true,
    requiresEquipment: false,
    usesProduct: false,
    requiredCredentials: [],
    restrictedCredentials: [],
    retentionYears: 2,
    atLeastOneOf: ['fc', 'tc', 'br', 'ph', 'ta', 'cya', 'ch', 'salt'],
    fields: [
      { key: 'fc', label: 'Free chlorine (ppm)', type: 'number', min: 0, max: 100, unit: 'ppm' },
      { key: 'tc', label: 'Total chlorine (ppm)', type: 'number', min: 0, max: 100, unit: 'ppm' },
      { key: 'ph', label: 'pH', type: 'number', min: 5, max: 9.5 },
      { key: 'ta', label: 'Total alkalinity (ppm)', type: 'number', min: 0, max: 600, unit: 'ppm' },
      { key: 'cya', label: 'Stabilizer / CYA (ppm)', type: 'number', min: 0, max: 400, unit: 'ppm' },
      { key: 'ch', label: 'Calcium hardness (ppm)', type: 'number', min: 0, max: 2000, unit: 'ppm' },
      { key: 'salt', label: 'Salt (ppm)', type: 'number', min: 0, max: 10000, unit: 'ppm' },
      { key: 'temp_f', label: 'Water temperature (°F)', type: 'number', min: 32, max: 120, unit: '°F' },
      { key: 'filter_psi', label: 'Filter pressure (psi)', type: 'number', min: 0, max: 100, unit: 'psi' },
      { key: 'clarity', label: 'Water clarity', type: 'select', options: ['Clear', 'Hazy', 'Cloudy', 'Green', 'Black spot / mustard'] },
      { key: 'br', label: 'Bromine (ppm)', type: 'number', min: 0, max: 50, unit: 'ppm' },
      { key: 'water_body', label: 'Water body', type: 'select', options: ['Pool', 'Spa / hot tub'] },
      { key: 'sanitizer', label: 'Sanitizer system', type: 'select', options: ['Liquid chlorine', 'Trichlor tablets', 'Salt (SWG)', 'Bromine', 'Mineral / ozone', 'Other'] },
      { key: 'volume_gal', label: 'Water volume (gal)', type: 'number', min: 20, max: 5000000, unit: 'gal' },
    ],
  },
  {
    key: 'dosing',
    label: 'Chemical dosing',
    description: 'What was added, how much, and why — builds the dosing history.',
    requiresJob: true,
    requiresTechnician: true,
    requiresEquipment: false,
    usesProduct: true,
    requiredCredentials: [],
    restrictedCredentials: [],
    retentionYears: 2,
    fields: [
      { key: 'amount', label: 'Amount added', type: 'number', required: true, min: 0.0001, max: 100000 },
      { key: 'amount_unit', label: 'Unit', type: 'select', required: true, options: [...PRODUCT_UNITS] },
      { key: 'target', label: 'Purpose', type: 'select', required: true, options: ['Raise chlorine', 'Raise bromine', 'Lower pH', 'Raise pH', 'Raise alkalinity', 'Lower alkalinity', 'Raise stabilizer', 'Raise calcium', 'Add salt', 'Shock / oxidize', 'Algae treatment', 'Clarify', 'Other'] },
      { key: 'method', label: 'Method', type: 'select', options: ['Broadcast', 'Pre-dissolved', 'Feeder / floater', 'Through skimmer', 'Automated dosing'] },
      { key: 'from_recommendation', label: 'From dosing recommendation', type: 'boolean' },
    ],
  },
  {
    key: 'equipment_service',
    label: 'Equipment service',
    description: 'Inspection, repair or replacement history per equipment item.',
    requiresJob: true,
    requiresTechnician: true,
    requiresEquipment: true,
    usesProduct: false,
    requiredCredentials: [],
    restrictedCredentials: [],
    retentionYears: 2,
    fields: [
      { key: 'component', label: 'Component', type: 'select', required: true, options: COMPONENTS },
      { key: 'action', label: 'Action', type: 'select', required: true, options: ['Inspected', 'Cleaned / backwashed', 'Adjusted', 'Repaired', 'Replaced', 'Calibrated', 'Winterized', 'Opened for season'] },
      { key: 'runtime_hours', label: 'Runtime (hours)', type: 'number', min: 0, max: 200000, unit: 'h' },
      { key: 'pressure_psi', label: 'Pressure (psi)', type: 'number', min: 0, max: 100, unit: 'psi' },
      { key: 'finding', label: 'Finding / part used', type: 'textarea' },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Manifest                                                             */
/* ------------------------------------------------------------------ */

export const POOL_SERVICE_PACK: TradePack = {
  key: 'pool_service',
  name: 'Pool Service',
  tagline: 'Chemistry readings with range flags, route scheduling, equipment and dosing history.',
  industrySlug: 'pool-service',
  serviceKeywords: ['pool', 'spa', 'hot tub', 'swim'],
  productKinds: ['sanitizer', 'ph_adjuster', 'alkalinity', 'stabilizer', 'algaecide', 'clarifier', 'salt', 'other'],
  logTypes: POOL_LOG_TYPES,
  complianceNote:
    'Ranges are typical residential targets. Public and commercial pools must follow local health-code limits and logging rules; retention defaults to 2 years.',
  customFields: [
    { entity: 'customer', key: 'pool_volume_gallons', label: 'Pool volume (gal)', field_type: 'number', show_in_table: false },
    { entity: 'customer', key: 'pool_surface', label: 'Pool surface', field_type: 'select', options: ['Plaster', 'Pebble', 'Vinyl liner', 'Fiberglass', 'Tile'], show_in_table: false, show_in_filters: true },
    { entity: 'customer', key: 'pool_sanitizer', label: 'Sanitizer system', field_type: 'select', options: ['Liquid chlorine', 'Trichlor tablets', 'Salt (SWG)', 'Bromine', 'Mineral / ozone', 'Other'], show_in_table: false, show_in_filters: true },
    { entity: 'customer', key: 'pool_gate_code', label: 'Gate / access code', field_type: 'text', show_in_table: false },
    { entity: 'customer', key: 'pool_dog_on_site', label: 'Dog on site', field_type: 'boolean', show_in_table: false },
    { entity: 'job', key: 'pool_visit_type', label: 'Pool visit type', field_type: 'select', options: ['Weekly service', 'Green-to-clean', 'Opening', 'Closing', 'Repair', 'Equipment install'], show_in_table: false, show_in_filters: true },
  ],
  forms: [
    {
      slug: 'pool_service_checklist',
      title: 'Pool service checklist',
      description: 'Weekly visit checklist — fails require a note.',
      kind: 'checklist',
      fields: [
        { id: 'skimmed', type: 'pass_fail', label: 'Surface skimmed, baskets emptied', allow_na: true, note_on_fail: true },
        { id: 'brushed', type: 'pass_fail', label: 'Walls, steps and tile brushed', allow_na: true, note_on_fail: true },
        { id: 'vacuumed', type: 'pass_fail', label: 'Floor vacuumed / cleaner running', allow_na: true, note_on_fail: true },
        { id: 'filter_ok', type: 'pass_fail', label: 'Filter pressure normal', allow_na: true, note_on_fail: true },
        { id: 'pump_ok', type: 'pass_fail', label: 'Pump primed and running quietly', allow_na: true, note_on_fail: true },
        { id: 'water_tested', type: 'pass_fail', label: 'Water tested and balanced', allow_na: false, note_on_fail: true },
        { id: 'gate_latched', type: 'pass_fail', label: 'Gate latched and secure on exit', allow_na: false, note_on_fail: true },
        { id: 'visit_photo', type: 'photo', label: 'After-service photo', min_photos: 0, max_photos: 4 },
      ],
    },
    {
      slug: 'pool_equipment_inspection',
      title: 'Pool equipment inspection',
      description: 'Pump, filter, heater and automation condition.',
      kind: 'form',
      fields: [
        { id: 'pump_condition', type: 'select', label: 'Pump condition', required: true, options: ['Good', 'Noisy', 'Leaking', 'Failing'] },
        { id: 'filter_type', type: 'select', label: 'Filter type', options: ['Sand', 'Cartridge', 'DE'] },
        { id: 'filter_psi', type: 'number', label: 'Filter pressure', unit: 'psi', min: 0, max: 100 },
        { id: 'heater_ok', type: 'pass_fail', label: 'Heater ignites and holds temperature', allow_na: true, note_on_fail: true },
        { id: 'leaks', type: 'yes_no', label: 'Visible leaks at equipment pad' },
        { id: 'notes', type: 'textarea', label: 'Recommendations' },
        { id: 'equipment_photos', type: 'photo', label: 'Equipment photos', min_photos: 0, max_photos: 6 },
      ],
    },
  ],
  pricingModels: [
    {
      key: 'weekly_by_volume',
      label: 'Weekly service — by pool volume',
      description: 'Flat weekly visit tiered by gallons, plus chemicals billed at cost-plus.',
      inputs: [
        { key: 'gallons', label: 'Pool volume', unit: 'gal', min: 500, max: 200000, defaultValue: 15000 },
        { key: 'chem_cost', label: 'Chemicals cost per visit (your cost)', unit: '$', min: 0, max: 1000, defaultValue: 12 },
      ],
      lines: [
        { kind: 'tier', key: 'service', label: 'Weekly service', inputKey: 'gallons', billing: 'per_visit', tiers: [{ upTo: 10000, price: 70 }, { upTo: 20000, price: 85 }, { upTo: 30000, price: 105 }, { upTo: null, price: 135 }] },
        { kind: 'cost_plus', key: 'chemicals', label: 'Chemicals (cost + markup)', inputKey: 'chem_cost', markupPct: 35, billing: 'per_visit' },
      ],
    },
    {
      key: 'green_to_clean',
      label: 'Green-to-clean (one-time)',
      description: 'Heavy cleanup priced by volume, chemicals at cost-plus.',
      inputs: [
        { key: 'gallons', label: 'Pool volume', unit: 'gal', min: 500, max: 200000, defaultValue: 15000 },
        { key: 'chem_cost', label: 'Chemicals cost (your cost)', unit: '$', min: 0, max: 5000, defaultValue: 90 },
      ],
      lines: [
        { kind: 'tier', key: 'labor', label: 'Cleanup labor', inputKey: 'gallons', billing: 'one_time', tiers: [{ upTo: 15000, price: 225 }, { upTo: 30000, price: 325 }, { upTo: null, price: 425 }] },
        { kind: 'cost_plus', key: 'chemicals', label: 'Chemicals (cost + markup)', inputKey: 'chem_cost', markupPct: 35, billing: 'one_time' },
      ],
    },
  ],
  plans: [
    { key: 'weekly', title: 'Pool — weekly full service', description: 'Brush, skim, vacuum, test and balance every week.', intervalUnit: 'week', intervalCount: 1, durationMinutes: 40, pricingModel: 'weekly_by_volume' },
    { key: 'biweekly', title: 'Pool — every 2 weeks', description: 'Light-use pools and the off-season.', intervalUnit: 'week', intervalCount: 2, durationMinutes: 40, pricingModel: 'weekly_by_volume' },
  ],
  routes: { workdayMinutes: 480, speedKmh: 35, defaultStopMinutes: 35, weekdays: [1, 2, 3, 4, 5] },
};
