/**
 * Pack 3 — Landscaping & lawn maintenance.
 *
 * Plugs into the generic Trade Pack framework (custom fields, forms, pricing models, plan templates,
 * route defaults) and adds the landscaping-specific module (contracts, crews, visits, add-ons, billing)
 * implemented by the sibling files and by supabase/migrations/20290301000000_landscaping_pack.sql.
 *
 * The pack is GATED: feature flag `landscaping_pack` AND the account entitlement `packs:landscaping`.
 * It is deliberately not part of TRADE_PACKS, so every existing screen behaves exactly as before.
 */

import type { TradePack } from '../types';
import type { AddonBilling, AddonKind, ChecklistTaskTemplate } from './types.ts';
import type { WeatherPolicy } from './weather.ts';

export const LANDSCAPING_FLAG = 'landscaping_pack';
export const LANDSCAPING_ENTITLEMENT = 'packs:landscaping';

export const DEFAULT_CHECKLIST: ChecklistTaskTemplate[] = [
  { key: 'mow', label: 'Mow all turf areas', required: true },
  { key: 'edge', label: 'Edge walks, drives and beds', required: true },
  { key: 'trim', label: 'String-trim fences, trees and obstacles', required: true },
  { key: 'blow', label: 'Blow clippings off hard surfaces', required: true },
  { key: 'beds', label: 'Weed and tidy planting beds', required: false },
  { key: 'irrigation', label: 'Check irrigation heads for damage', required: false },
  { key: 'gate', label: 'Gates latched and pets secured on exit', required: true },
];

export const DEFAULT_WEATHER_POLICY: WeatherPolicy = {
  rules: [
    { kind: 'rain_prob_pct', threshold: 70 },
    { kind: 'wind_kph', threshold: 60 },
    { kind: 'alert_keyword', keywords: ['flood', 'tornado', 'severe thunderstorm'] },
  ],
  makeup: 'next_workday',
};

export interface AddonTemplate {
  kind: AddonKind;
  label: string;
  billing: AddonBilling;
  seasonFromMonth: number;
  seasonToMonth: number;
  roundMonths: number[];
  snowTriggerCm: number | null;
  defaultPriceCents: number;
}

/** Starting points shown when a dispatcher adds a seasonal add-on to a contract (all editable). */
export const ADDON_TEMPLATES: AddonTemplate[] = [
  { kind: 'snow', label: 'Snow clearing (per event)', billing: 'per_event', seasonFromMonth: 11, seasonToMonth: 3, roundMonths: [], snowTriggerCm: 5, defaultPriceCents: 6500 },
  { kind: 'fertilization', label: 'Fertilization round', billing: 'per_visit', seasonFromMonth: 3, seasonToMonth: 11, roundMonths: [4, 6, 9, 11], snowTriggerCm: null, defaultPriceCents: 7500 },
  { kind: 'cleanup', label: 'Seasonal cleanup', billing: 'per_visit', seasonFromMonth: 3, seasonToMonth: 11, roundMonths: [4, 10], snowTriggerCm: null, defaultPriceCents: 18000 },
];

export const LANDSCAPING_PACK: TradePack = {
  key: 'landscaping',
  name: 'Landscaping & Lawn Care',
  tagline: 'Recurring maintenance contracts, crew routes with day-of re-routing, visit checklists with before/after photos, seasonal add-ons and batch invoicing.',
  industrySlug: 'lawn-care',
  serviceKeywords: ['lawn', 'mow', 'landscap', 'garden', 'snow', 'fertiliz', 'yard', 'hedge', 'leaf'],
  productKinds: ['herbicide', 'other'],
  logTypes: [],
  complianceNote:
    'Fertilizer and herbicide application rules, snow-removal liability and working-day rules differ by state and city. Vireek records what your crews did; it does not determine what is permitted where you work. REQUIRES COUNSEL before relying on any default (holiday sets, weather thresholds, retention) for compliance.',
  customFields: [
    { entity: 'customer', key: 'landscaping_gate_code', label: 'Gate / access code', field_type: 'text', show_in_table: false },
    { entity: 'customer', key: 'landscaping_dog_on_site', label: 'Dog on site', field_type: 'boolean', show_in_table: false },
    { entity: 'customer', key: 'landscaping_irrigation', label: 'Irrigation system', field_type: 'select', options: ['None', 'Sprinklers', 'Drip', 'Both'], show_in_table: false, show_in_filters: true },
    { entity: 'job', key: 'landscaping_visit_kind', label: 'Landscaping visit type', field_type: 'select', options: ['Maintenance', 'Add-on', 'Make-up', 'Snow event'], show_in_table: false, show_in_filters: true },
  ],
  forms: [
    {
      slug: 'landscaping_site_assessment',
      title: 'Landscaping site assessment',
      description: 'First-visit walkthrough: hazards, access and measurements to confirm before quoting a contract.',
      kind: 'form',
      fields: [
        { id: 'access', type: 'select', label: 'Equipment access', required: true, options: ['Open gate / drive', 'Narrow gate (<36 in)', 'Stairs / slope', 'Key or code needed'] },
        { id: 'slope', type: 'select', label: 'Steepest slope', options: ['Flat', 'Gentle', 'Steep (mower-limited)'] },
        { id: 'hazards', type: 'textarea', label: 'Hazards (pets, sprinkler heads, drains, wires)' },
        { id: 'turf_sqft', type: 'number', label: 'Turf area (measured)', unit: 'sq ft', min: 0, max: 5000000 },
        { id: 'bed_sqft', type: 'number', label: 'Bed area (measured)', unit: 'sq ft', min: 0, max: 5000000 },
        { id: 'site_photos', type: 'photo', label: 'Site photos', min_photos: 1, max_photos: 8 },
      ],
    },
  ],
  pricingModels: [
    {
      key: 'mowing_by_turf_area',
      label: 'Maintenance visit — by turf area',
      description: 'Flat visit price tiered by mowable square feet, plus a per-visit edging/trim charge for long edges.',
      inputs: [
        { key: 'turf_sqft', label: 'Turf area', unit: 'sq ft', min: 500, max: 5000000, defaultValue: 6000 },
        { key: 'edge_ft', label: 'Edging length', unit: 'ft', min: 0, max: 50000, defaultValue: 200 },
      ],
      lines: [
        { kind: 'tier', key: 'visit', label: 'Maintenance visit', inputKey: 'turf_sqft', billing: 'per_visit', tiers: [{ upTo: 5000, price: 40 }, { upTo: 10000, price: 55 }, { upTo: 20000, price: 75 }, { upTo: 43560, price: 110 }, { upTo: null, price: 160 }] },
        { kind: 'per_unit', key: 'edging', label: 'Edging', inputKey: 'edge_ft', unitPrice: 0.05, minCharge: 0, billing: 'per_visit' },
      ],
    },
    {
      key: 'fertilization_by_area',
      label: 'Fertilization round — by turf area',
      description: 'Priced per 1,000 sq ft with a minimum charge; product cost is included in the rate.',
      inputs: [{ key: 'turf_sqft', label: 'Turf area', unit: 'sq ft', min: 500, max: 5000000, defaultValue: 6000 }],
      lines: [{ kind: 'per_unit', key: 'round', label: 'Fertilization round', inputKey: 'turf_sqft', unitPrice: 0.0125, minCharge: 55, billing: 'per_visit' }],
    },
    {
      key: 'snow_by_event',
      label: 'Snow clearing — by driveway/walk area',
      description: 'Per-event price tiered by cleared square feet.',
      inputs: [{ key: 'cleared_sqft', label: 'Cleared area', unit: 'sq ft', min: 100, max: 500000, defaultValue: 1200 }],
      lines: [{ kind: 'tier', key: 'event', label: 'Snow clearing (per event)', inputKey: 'cleared_sqft', billing: 'per_visit', tiers: [{ upTo: 1000, price: 45 }, { upTo: 2500, price: 65 }, { upTo: 6000, price: 110 }, { upTo: null, price: 180 }] }],
    },
  ],
  plans: [
    { key: 'weekly_mowing', title: 'Lawn maintenance — weekly', description: 'Mow, edge, trim and blow every week through the growing season.', intervalUnit: 'week', intervalCount: 1, durationMinutes: 45, pricingModel: 'mowing_by_turf_area', season: { fromMonth: 4, toMonth: 10 } },
    { key: 'biweekly_mowing', title: 'Lawn maintenance — every 2 weeks', description: 'Lower-frequency maintenance for slower-growing lawns.', intervalUnit: 'week', intervalCount: 2, durationMinutes: 45, pricingModel: 'mowing_by_turf_area', season: { fromMonth: 4, toMonth: 10 } },
    { key: 'fertilization_rounds', title: 'Fertilization program', description: 'Four-round program (spring, early summer, early fall, late fall).', intervalUnit: 'month', intervalCount: 2, durationMinutes: 30, pricingModel: 'fertilization_by_area', season: { fromMonth: 3, toMonth: 11 } },
  ],
  routes: { workdayMinutes: 540, speedKmh: 40, defaultStopMinutes: 45, weekdays: [1, 2, 3, 4, 5] },
};
