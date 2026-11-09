/**
 * Sample pack that proves the framework end-to-end: appliance repair, shipped as two versions.
 * It exercises EVERY artifact kind. 1.1.0 changes some artifacts, adds some and drops one, which is
 * what the upgrade / rollback / customization-preservation tests rely on.
 * No code, no migration, no fork: this file is the entire "new trade".
 */

import type { PackManifest } from './types';

export const SAMPLE_PACK_V1: PackManifest = {
  schemaVersion: 1,
  id: 'appliance_repair',
  version: '1.0.0',
  name: 'Appliance repair',
  description: 'Washers, dryers, refrigerators, ovens and dishwashers — diagnostics, parts and warranty-friendly paperwork.',
  terminology: [
    { key: 'job', singular: 'Service call', plural: 'Service calls' },
    { key: 'technician', singular: 'Appliance tech', plural: 'Appliance techs' },
  ],
  statuses: [
    { key: 'new_call', label: 'New call', category: 'open', order: 10 },
    { key: 'awaiting_part', label: 'Awaiting part', category: 'active', order: 40 },
    { key: 'repaired', label: 'Repaired', category: 'done', order: 90 },
  ],
  forms: [{
    key: 'appliance_intake',
    title: 'Appliance intake',
    kind: 'form',
    items: [
      { id: 'model_number', label: 'Model number', type: 'text', required: true },
      { id: 'serial_number', label: 'Serial number', type: 'text' },
      { id: 'data_plate_photo', label: 'Photo of the data plate', type: 'photo', required: true },
      { id: 'power_off', label: 'Appliance unplugged / breaker off before opening', type: 'check', critical: true },
    ],
  }],
  customFields: [
    { key: 'appliance_brand', label: 'Appliance brand', entity: 'job', fieldType: 'select', options: ['Whirlpool', 'GE', 'Samsung', 'LG', 'Other'] },
    { key: 'under_warranty', label: 'Under manufacturer warranty', entity: 'job', fieldType: 'boolean' },
  ],
  workflowRules: [
    { key: 'finish_repair', label: 'Complete the repair', from: 'awaiting_part', to: 'repaired', requiresFormKeys: ['appliance_intake'], requiresPhoto: true },
  ],
  pricingTemplates: [{
    key: 'appliance_price_book',
    label: 'Appliance starter prices',
    lines: [
      { key: 'diagnostic', label: 'Diagnostic visit', pricingModel: 'flat', priceCents: 8900, estimatedCostCents: 3000 },
      { key: 'drain_pump', label: 'Replace drain pump', pricingModel: 'starting_at', priceCents: 24900, estimatedCostCents: 9000 },
    ],
  }],
  jobTypes: [
    { key: 'washer_not_draining', label: 'Washer not draining', defaultDurationMinutes: 75, checklistFormKey: 'appliance_intake', pricingTemplateKey: 'appliance_price_book', ticketMinCents: 14900, ticketMaxCents: 32900 },
    { key: 'fridge_not_cooling', label: 'Refrigerator not cooling', defaultDurationMinutes: 90 },
  ],
  documentTemplates: [{
    key: 'service_estimate',
    label: 'Service estimate',
    docType: 'estimate',
    body: 'Estimate for {{customer.name}}\nAppliance: {{job.appliance_brand}} {{job.model_number}}\nTotal: {{estimate.total}}\nParts carry a 90-day warranty.',
  }],
  recurringRules: [{ key: 'annual_checkup', label: 'Annual appliance checkup', intervalUnit: 'year', intervalCount: 1, durationMinutes: 60, jobTypeKey: 'washer_not_draining' }],
  reports: [{ key: 'repairs_by_month', label: 'Repairs completed by month', metric: 'jobs_completed', groupBy: 'month' }],
  onboardingPresets: [{ key: 'appliance_onboarding', label: 'Appliance repair setup', steps: [{ key: 'pick_brands', label: 'Choose the brands you service', route: '/dashboard/custom-fields' }] }],
};

/** 1.1.0: relabels a term, raises a price, adds a job type and a status, drops the annual checkup rule. */
export const SAMPLE_PACK_V1_1: PackManifest = {
  ...SAMPLE_PACK_V1,
  version: '1.1.0',
  terminology: [
    { key: 'job', singular: 'Repair visit', plural: 'Repair visits' },
    { key: 'technician', singular: 'Appliance tech', plural: 'Appliance techs' },
  ],
  statuses: [
    ...SAMPLE_PACK_V1.statuses!,
    { key: 'quote_sent', label: 'Quote sent', category: 'open', order: 20 },
  ],
  pricingTemplates: [{
    key: 'appliance_price_book',
    label: 'Appliance starter prices',
    lines: [
      { key: 'diagnostic', label: 'Diagnostic visit', pricingModel: 'flat', priceCents: 9900, estimatedCostCents: 3000 },
      { key: 'drain_pump', label: 'Replace drain pump', pricingModel: 'starting_at', priceCents: 24900, estimatedCostCents: 9000 },
    ],
  }],
  jobTypes: [
    ...SAMPLE_PACK_V1.jobTypes!,
    { key: 'dryer_not_heating', label: 'Dryer not heating', defaultDurationMinutes: 60, pricingTemplateKey: 'appliance_price_book' },
  ],
  recurringRules: [],
};
