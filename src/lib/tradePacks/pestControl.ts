/**
 * Pack 1 — Pest control.
 * Chemical + treatment logs, regulated-product (restricted-use) records, recurring plans, service routes.
 */

import { PRODUCT_UNITS, PESTICIDE_KINDS, type LogTypeDef, type TradePack } from './types';

export const PEST_CREDENTIAL = 'pesticide_applicator';
export const PEST_RESTRICTED_CREDENTIAL = 'pesticide_applicator_restricted';

const PESTS = ['Ants', 'Cockroaches', 'Rodents', 'Termites', 'Bed bugs', 'Mosquitoes', 'Spiders', 'Wasps / bees', 'Fleas / ticks', 'Wildlife', 'Other'];
const SITES = ['Interior', 'Exterior', 'Perimeter only', 'Crawlspace', 'Attic', 'Lawn / yard', 'Commercial kitchen'];

export const PEST_LOG_TYPES: LogTypeDef[] = [
  {
    key: 'chemical_application',
    label: 'Chemical application',
    description: 'Every pesticide application: product, amount, area, method, conditions.',
    requiresJob: true,
    requiresTechnician: true,
    requiresEquipment: false,
    usesProduct: true,
    requiredCredentials: [PEST_CREDENTIAL, PEST_RESTRICTED_CREDENTIAL],
    restrictedCredentials: [PEST_RESTRICTED_CREDENTIAL],
    retentionYears: 3,
    fields: [
      { key: 'amount', label: 'Amount applied', type: 'number', required: true, min: 0.0001, max: 100000 },
      { key: 'amount_unit', label: 'Unit', type: 'select', required: true, options: [...PRODUCT_UNITS] },
      { key: 'area_sqft', label: 'Area treated (sq ft)', type: 'number', min: 1, max: 10000000, unit: 'sq ft' },
      { key: 'dilution', label: 'Dilution / mix rate', type: 'text' },
      { key: 'method', label: 'Method', type: 'select', required: true, options: ['Spray', 'Dust', 'Bait placement', 'Fog / ULV', 'Granular', 'Injection', 'Trench / drench'] },
      { key: 'application_site', label: 'Site treated', type: 'select', required: true, options: SITES },
      { key: 'target_pests', label: 'Target pests', type: 'multiselect', required: true, options: PESTS },
      { key: 'wind_mph', label: 'Wind (mph)', type: 'number', min: 0, max: 100, unit: 'mph' },
      { key: 'temp_f', label: 'Air temperature (°F)', type: 'number', min: -20, max: 130, unit: '°F' },
      { key: 'ppe_used', label: 'Required PPE worn', type: 'boolean', required: true },
      { key: 'customer_notified', label: 'Customer notified (re-entry, pets, food)', type: 'boolean' },
    ],
  },
  {
    key: 'treatment',
    label: 'Treatment / inspection',
    description: 'Visit summary: type, areas, findings and pest-activity level.',
    requiresJob: true,
    requiresTechnician: true,
    requiresEquipment: false,
    usesProduct: false,
    requiredCredentials: [],
    restrictedCredentials: [],
    retentionYears: 3,
    fields: [
      { key: 'treatment_type', label: 'Visit type', type: 'select', required: true, options: ['Initial', 'Recurring', 'Callback', 'Inspection only', 'Exclusion', 'Monitoring'] },
      { key: 'areas_serviced', label: 'Areas serviced', type: 'multiselect', options: SITES },
      { key: 'pest_activity', label: 'Pest activity (0 none – 5 severe)', type: 'number', required: true, min: 0, max: 5 },
      { key: 'bait_stations_checked', label: 'Bait / monitor stations checked', type: 'number', min: 0, max: 1000 },
      { key: 'findings', label: 'Findings', type: 'textarea' },
      { key: 'conducive_conditions', label: 'Conducive conditions', type: 'textarea' },
      { key: 'recommendations', label: 'Recommendations to customer', type: 'textarea' },
      { key: 'customer_present', label: 'Customer present', type: 'boolean' },
    ],
  },
  {
    key: 'regulated_product',
    label: 'Regulated-product record',
    description: 'Receipt, transfer, disposal and counts for restricted-use and other registered products.',
    requiresJob: false,
    requiresTechnician: true,
    requiresEquipment: false,
    usesProduct: true,
    requiredCredentials: [],
    restrictedCredentials: [PEST_RESTRICTED_CREDENTIAL],
    retentionYears: 3,
    fields: [
      { key: 'action', label: 'Action', type: 'select', required: true, options: ['Received', 'Transferred out', 'Disposed', 'Count'] },
      { key: 'quantity', label: 'Quantity', type: 'number', required: true, min: 0, max: 1000000 },
      { key: 'unit', label: 'Unit', type: 'select', required: true, options: [...PRODUCT_UNITS] },
      { key: 'lot_number', label: 'Lot / batch', type: 'text' },
      { key: 'supplier', label: 'Supplier / recipient', type: 'text' },
      { key: 'reference', label: 'Invoice / manifest / disposal ref', type: 'text' },
    ],
  },
];

/** Entries as stored (only the fields the pure helpers need). */
export interface StockEntry {
  entry_type: string;
  performed_at: string;
  voided_at: string | null;
  product_id: string | null;
  data: Record<string, unknown>;
}

export interface StockBalance {
  balance: number;
  unit: string | null;
  lastCountAt: string | null;
  /** Entries skipped because their unit differs from the product's ledger unit. */
  unitMismatches: number;
}

/**
 * Running on-hand balance for ONE product. Received adds; transferred/disposed and chemical
 * applications subtract; a Count resets the balance to the counted quantity (so drift between
 * book and shelf is visible, not silently carried). Voided rows are ignored.
 */
export function computeStockBalance(entries: StockEntry[], productId: string, productUnit: string): StockBalance {
  const rows = entries
    .filter((e) => e.product_id === productId && !e.voided_at)
    .sort((a, b) => a.performed_at.localeCompare(b.performed_at));
  let balance = 0;
  let lastCountAt: string | null = null;
  let unitMismatches = 0;
  for (const e of rows) {
    const d = e.data;
    if (e.entry_type === 'chemical_application') {
      if (d.amount_unit !== productUnit) {
        unitMismatches++;
        continue;
      }
      balance -= Number(d.amount) || 0;
    } else if (e.entry_type === 'regulated_product') {
      if (d.unit !== productUnit) {
        unitMismatches++;
        continue;
      }
      const q = Number(d.quantity) || 0;
      if (d.action === 'Received') balance += q;
      else if (d.action === 'Transferred out' || d.action === 'Disposed') balance -= q;
      else if (d.action === 'Count') {
        balance = q;
        lastCountAt = e.performed_at;
      }
    }
  }
  return { balance: Math.round(balance * 10000) / 10000, unit: productUnit, lastCountAt, unitMismatches };
}

export type ActivityTrend = 'new' | 'improving' | 'stable' | 'worsening';

/** Pest-activity trend from the last two treatment records of a site (higher = worse). */
export function summarizeActivity(entries: StockEntry[]): { latest: number | null; previous: number | null; trend: ActivityTrend } {
  const levels = entries
    .filter((e) => e.entry_type === 'treatment' && !e.voided_at && typeof e.data.pest_activity === 'number')
    .sort((a, b) => b.performed_at.localeCompare(a.performed_at))
    .map((e) => e.data.pest_activity as number);
  const latest = levels[0] ?? null;
  const previous = levels[1] ?? null;
  if (latest === null || previous === null) return { latest, previous, trend: 'new' };
  return { latest, previous, trend: latest < previous ? 'improving' : latest > previous ? 'worsening' : 'stable' };
}

export const PEST_CONTROL_PACK: TradePack = {
  key: 'pest_control',
  name: 'Pest Control',
  tagline: 'Chemical and treatment logs, restricted-use product records, recurring plans and service routes.',
  industrySlug: 'pest-control',
  serviceKeywords: ['pest', 'termite', 'rodent', 'roach', 'mosquito', 'bed bug', 'bedbug', 'wildlife', 'insect', 'wasp', 'flea', 'exterminat'],
  productKinds: PESTICIDE_KINDS,
  logTypes: PEST_LOG_TYPES,
  complianceNote:
    'Records support — but never replace — your state lead agency’s rules. Retention defaults to 3 years (federal restricted-use minimum is 2; some states require more). Confirm local requirements.',
  customFields: [
    { entity: 'job', key: 'pest_primary_target', label: 'Primary target pest', field_type: 'select', options: PESTS, show_in_table: false, show_in_filters: true },
    { entity: 'job', key: 'pest_treatment_area', label: 'Treatment area', field_type: 'select', options: ['Interior', 'Exterior', 'Both', 'Crawlspace / attic', 'Perimeter only'], show_in_table: false },
    { entity: 'job', key: 'pest_warranty_expires', label: 'Service warranty expires', field_type: 'date', show_in_table: false },
    { entity: 'customer', key: 'pest_structure_type', label: 'Structure type', field_type: 'select', options: ['Single-family', 'Multi-family', 'Commercial – food service', 'Commercial – other', 'Rental'], show_in_table: false, show_in_filters: true },
    { entity: 'customer', key: 'pest_pets_children', label: 'Pets or children on site', field_type: 'boolean', show_in_table: false },
    { entity: 'customer', key: 'pest_sensitive_site', label: 'Sensitive site (school, care home, food)', field_type: 'boolean', show_in_table: false },
  ],
  forms: [
    {
      slug: 'pest_service_report',
      title: 'Pest service report',
      description: 'Customer-facing summary captured at the end of every pest visit.',
      kind: 'form',
      fields: [
        { id: 'visit_type', type: 'select', label: 'Visit type', required: true, options: ['Initial', 'Recurring', 'Callback', 'Inspection only', 'Exclusion'] },
        { id: 'activity_level', type: 'number', label: 'Pest activity (0 none – 5 severe)', required: true, min: 0, max: 5 },
        { id: 'areas', type: 'textarea', label: 'Areas treated / inspected', required: true },
        { id: 'findings', type: 'textarea', label: 'Findings & conducive conditions' },
        { id: 'customer_actions', type: 'textarea', label: 'What the customer should do before next visit' },
        { id: 'pets_secured', type: 'yes_no', label: 'Pets / children kept clear during treatment' },
        { id: 'photos', type: 'photo', label: 'Photos of activity or treated areas', min_photos: 0, max_photos: 6 },
        { id: 'customer_signature', type: 'signature', label: 'Customer signature' },
      ],
    },
    {
      slug: 'pest_inspection_checklist',
      title: 'Pest inspection checklist',
      description: 'Standard structural inspection — fails require a note.',
      kind: 'checklist',
      fields: [
        { id: 'entry_points', type: 'pass_fail', label: 'Entry points sealed (doors, vents, utility penetrations)', allow_na: true, note_on_fail: true },
        { id: 'moisture', type: 'pass_fail', label: 'No standing water or moisture problems', allow_na: true, note_on_fail: true },
        { id: 'harborage', type: 'pass_fail', label: 'No clutter / harborage against the structure', allow_na: true, note_on_fail: true },
        { id: 'food_storage', type: 'pass_fail', label: 'Food and waste properly stored', allow_na: true, note_on_fail: true },
        { id: 'vegetation', type: 'pass_fail', label: 'Vegetation and wood cleared from foundation', allow_na: true, note_on_fail: true },
        { id: 'evidence', type: 'pass_fail', label: 'No droppings, frass or live activity found', allow_na: true, note_on_fail: true },
        { id: 'stations', type: 'pass_fail', label: 'Bait / monitor stations intact and labelled', allow_na: true, note_on_fail: true },
        { id: 'evidence_photos', type: 'photo', label: 'Photos of any evidence', min_photos: 0, max_photos: 8 },
      ],
    },
  ],
  pricingModels: [
    {
      key: 'general_pest',
      label: 'General pest — initial + recurring',
      description: 'Initial service fee plus a per-visit recurring price, both tiered by home size.',
      inputs: [{ key: 'home_sqft', label: 'Home size', unit: 'sq ft', min: 300, max: 50000, defaultValue: 2000 }],
      lines: [
        { kind: 'tier', key: 'initial', label: 'Initial service', inputKey: 'home_sqft', billing: 'one_time', tiers: [{ upTo: 1500, price: 129 }, { upTo: 2500, price: 159 }, { upTo: 3500, price: 189 }, { upTo: 5000, price: 229 }, { upTo: null, price: 289 }] },
        { kind: 'tier', key: 'recurring', label: 'Recurring visit', inputKey: 'home_sqft', billing: 'per_visit', tiers: [{ upTo: 1500, price: 89 }, { upTo: 2500, price: 99 }, { upTo: 3500, price: 119 }, { upTo: 5000, price: 139 }, { upTo: null, price: 169 }] },
      ],
    },
    {
      key: 'termite_linear_foot',
      label: 'Termite — per linear foot + annual renewal',
      description: 'Liquid / bait treatment priced by foundation perimeter with a minimum charge.',
      inputs: [{ key: 'linear_feet', label: 'Linear feet treated', unit: 'ft', min: 10, max: 5000, defaultValue: 200 }],
      lines: [
        { kind: 'per_unit', key: 'treatment', label: 'Termite treatment', inputKey: 'linear_feet', unitPrice: 11, minCharge: 650, billing: 'one_time' },
        { kind: 'flat', key: 'renewal', label: 'Annual renewal / monitoring', amount: 195, billing: 'per_visit' },
      ],
    },
    {
      key: 'mosquito_seasonal',
      label: 'Mosquito — seasonal',
      description: 'Per-visit price tiered by yard size; run monthly April–October.',
      inputs: [{ key: 'yard_sqft', label: 'Yard size', unit: 'sq ft', min: 1000, max: 200000, defaultValue: 10000 }],
      lines: [
        { kind: 'tier', key: 'visit', label: 'Barrier treatment', inputKey: 'yard_sqft', billing: 'per_visit', tiers: [{ upTo: 10000, price: 75 }, { upTo: 20000, price: 95 }, { upTo: null, price: 125 }] },
      ],
    },
  ],
  plans: [
    { key: 'quarterly', title: 'General pest — quarterly', description: 'Interior/exterior perimeter service every 3 months.', intervalUnit: 'month', intervalCount: 3, durationMinutes: 45, pricingModel: 'general_pest' },
    { key: 'bimonthly', title: 'General pest — every 2 months', description: 'Higher-frequency plan for heavy-pressure areas or commercial kitchens.', intervalUnit: 'month', intervalCount: 2, durationMinutes: 45, pricingModel: 'general_pest' },
    { key: 'mosquito', title: 'Mosquito — monthly (Apr–Oct)', description: 'Seasonal barrier treatment, monthly.', intervalUnit: 'month', intervalCount: 1, durationMinutes: 40, pricingModel: 'mosquito_seasonal', season: { fromMonth: 4, toMonth: 10 } },
    { key: 'termite', title: 'Termite — annual monitoring', description: 'Yearly inspection and renewal.', intervalUnit: 'year', intervalCount: 1, durationMinutes: 60, pricingModel: 'termite_linear_foot' },
  ],
  routes: { workdayMinutes: 480, speedKmh: 40, defaultStopMinutes: 40, weekdays: [1, 2, 3, 4, 5] },
};
