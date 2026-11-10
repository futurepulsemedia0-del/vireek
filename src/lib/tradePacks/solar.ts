/**
 * Pack 3 — Solar (design → permit → interconnection → inspection → PTO, equipment + warranty, O&M).
 *
 * Config only: custom fields, forms/checklists, log types, pricing, plans. What the framework cannot express
 * (pipeline stages, equipment registry, warranty claims, jurisdiction profiles) lives in the solar_* tables
 * and solarPipeline.ts. Nothing here asserts code, permit or interconnection compliance — checklist wording
 * defers to the approved plan set, the manufacturer's instructions and the AHJ; retention periods and review
 * times are configurable defaults that REQUIRE COUNSEL / AHJ VERIFICATION.
 *
 * The module is OFF by default (feature flag `trade_pack_solar` + entitlement `packs:solar`).
 */

import type { LogTypeDef, TradePack } from './types';

export const SOLAR_MODULE_KEY = 'packs:solar';
export const SOLAR_FLAG_KEY = 'trade_pack_solar';

export const SOLAR_LOG_TYPES: LogTypeDef[] = [
  {
    key: 'commissioning_record',
    label: 'Commissioning record',
    description: 'Readings and attestations captured when a system is first energised. A record of what the technician measured — not a compliance certificate.',
    requiresJob: true,
    requiresTechnician: true,
    requiresEquipment: false,
    usesProduct: false,
    requiredCredentials: [],
    restrictedCredentials: [],
    retentionYears: 10,
    fields: [
      { key: 'system_size_kw_dc', label: 'DC system size', type: 'number', required: true, min: 0.1, max: 10000, unit: 'kW' },
      { key: 'array_voc_v', label: 'String open-circuit voltage (Voc)', type: 'number', min: 0, max: 1500, unit: 'V' },
      { key: 'array_isc_a', label: 'String short-circuit current (Isc)', type: 'number', min: 0, max: 100, unit: 'A' },
      { key: 'ac_voltage_v', label: 'AC voltage at inverter', type: 'number', min: 0, max: 1000, unit: 'V' },
      { key: 'insulation_resistance_mohm', label: 'Insulation resistance', type: 'number', min: 0, max: 10000, unit: 'MΩ' },
      { key: 'ground_continuity_ohm', label: 'Ground continuity', type: 'number', min: 0, max: 100, unit: 'Ω' },
      { key: 'firmware_version', label: 'Inverter firmware', type: 'text' },
      { key: 'monitoring_connected', label: 'Monitoring connected and reporting', type: 'boolean', required: true },
      { key: 'rapid_shutdown_tested', label: 'Rapid shutdown function exercised', type: 'boolean', required: true },
      { key: 'labels_placed', label: 'Labels / placards placed per approved plans', type: 'boolean', required: true },
      { key: 'customer_walkthrough', label: 'Customer walkthrough completed', type: 'boolean' },
      { key: 'result', label: 'Result', type: 'select', required: true, options: ['Completed — no open items', 'Completed — open items', 'Not commissioned'] },
      { key: 'open_items', label: 'Open items', type: 'textarea' },
    ],
  },
  {
    key: 'om_visit',
    label: 'O&M visit',
    description: 'Operations & maintenance visit record for an installed system.',
    requiresJob: true,
    requiresTechnician: true,
    requiresEquipment: false,
    usesProduct: false,
    requiredCredentials: [],
    restrictedCredentials: [],
    retentionYears: 7,
    fields: [
      { key: 'visit_type', label: 'Visit type', type: 'select', required: true, options: ['Annual inspection', 'Panel cleaning', 'Troubleshooting', 'Inverter service', 'Battery service', 'Warranty visit'] },
      { key: 'system_status', label: 'System status on arrival', type: 'select', required: true, options: ['Producing normally', 'Producing below expected', 'Partially offline', 'Not producing'] },
      { key: 'fault_codes', label: 'Fault / event codes seen', type: 'text' },
      { key: 'visual_damage', label: 'Visible damage found', type: 'boolean', required: true },
      { key: 'panels_cleaned', label: 'Panels cleaned', type: 'boolean' },
      { key: 'monitoring_ok', label: 'Monitoring reporting normally', type: 'boolean' },
      { key: 'findings', label: 'Findings', type: 'textarea' },
      { key: 'recommendations', label: 'Recommendations', type: 'textarea' },
    ],
  },
];

export const SOLAR_PACK: TradePack = {
  key: 'solar',
  name: 'Solar',
  tagline: 'Site surveys, permit-to-PTO pipeline, equipment and warranty registry, commissioning, O&M plans and warranty claims.',
  industrySlug: 'solar',
  serviceKeywords: ['solar', 'photovoltaic', 'pv ', 'battery storage', 'energy storage'],
  productKinds: ['other'],
  logTypes: SOLAR_LOG_TYPES,
  complianceNote:
    'REQUIRES COUNSEL / AHJ VERIFICATION. Vireek records your solar work; it does not assert code, permit, interconnection or incentive compliance. Review times, required steps, checklist wording and retention periods (10 years commissioning, 7 years O&M by default) are configurable starting points — confirm them with your AHJ, utility and counsel.',
  customFields: [
    { entity: 'job', key: 'solar_system_size_kw', label: 'System size (kW DC)', field_type: 'number', show_in_table: true },
    { entity: 'job', key: 'solar_roof_type', label: 'Roof type', field_type: 'select', options: ['Composition shingle', 'Tile', 'Metal standing seam', 'Flat / membrane', 'Ground mount', 'Carport / other'], show_in_filters: true },
    { entity: 'job', key: 'solar_permit_number', label: 'Permit number', field_type: 'text' },
    { entity: 'job', key: 'solar_ahj', label: 'Authority having jurisdiction (AHJ)', field_type: 'text' },
    { entity: 'job', key: 'solar_utility', label: 'Utility', field_type: 'text', show_in_filters: true },
    { entity: 'job', key: 'solar_interconnection_ref', label: 'Interconnection application ref.', field_type: 'text' },
    { entity: 'customer', key: 'solar_system_installed', label: 'Has installed solar system', field_type: 'boolean', show_in_filters: true },
  ],
  forms: [
    {
      slug: 'solar_site_survey',
      title: 'Solar site survey',
      description: 'Pre-design survey: roof, electrical service, shading and required photos.',
      kind: 'checklist',
      fields: [
        { id: 'roof_type', type: 'select', label: 'Roof type', required: true, options: ['Composition shingle', 'Tile', 'Metal standing seam', 'Flat / membrane', 'Ground mount', 'Other'] },
        { id: 'roof_age_years', type: 'number', label: 'Approximate roof age', unit: 'yrs', min: 0, max: 100 },
        { id: 'roof_condition', type: 'pass_fail', label: 'Roof in suitable condition for mounting', allow_na: true, note_on_fail: true },
        { id: 'framing_checked', type: 'pass_fail', label: 'Framing / attachment surface checked and suitable', allow_na: true, note_on_fail: true },
        { id: 'azimuth_deg', type: 'number', label: 'Primary roof azimuth', unit: '°', min: 0, max: 360 },
        { id: 'tilt_deg', type: 'number', label: 'Primary roof tilt', unit: '°', min: 0, max: 90 },
        { id: 'shading', type: 'select', label: 'Shading assessment', required: true, options: ['None', 'Light', 'Moderate', 'Heavy'] },
        { id: 'service_rating_a', type: 'number', label: 'Main service rating', unit: 'A', min: 0, max: 1200 },
        { id: 'panel_space', type: 'pass_fail', label: 'Space available in main panel / service equipment', allow_na: true, note_on_fail: true },
        { id: 'obstructions', type: 'pass_fail', label: 'Vents, skylights and obstructions mapped', allow_na: true, note_on_fail: true },
        { id: 'roof_photos', type: 'photo', label: 'Roof photos (all faces)', required: true, min_photos: 2, max_photos: 10 },
        { id: 'panel_photos', type: 'photo', label: 'Main panel / service photos (open and labels)', required: true, min_photos: 1, max_photos: 6 },
        { id: 'meter_photo', type: 'photo', label: 'Utility meter photo', required: true, min_photos: 1, max_photos: 3 },
        { id: 'attic_photos', type: 'photo', label: 'Attic / rafter photos', min_photos: 0, max_photos: 6 },
        { id: 'survey_notes', type: 'textarea', label: 'Notes for design' },
        { id: 'customer_signature', type: 'signature', label: 'Customer signature' },
      ],
    },
    {
      slug: 'solar_install_mechanical',
      title: 'Solar install checklist — mechanical',
      description: 'Racking, attachments and module placement, checked against the approved plan set and manufacturer instructions.',
      kind: 'checklist',
      fields: [
        { id: 'permit_on_site', type: 'yes_no', label: 'Approved plan set and permit documents on site', required: true },
        { id: 'safety_plan', type: 'yes_no', label: 'Fall protection / site safety plan in place', required: true },
        { id: 'layout_matches', type: 'pass_fail', label: 'Array layout matches the approved plans', allow_na: true, note_on_fail: true },
        { id: 'attachments', type: 'pass_fail', label: 'Roof attachments installed and flashed per manufacturer instructions', allow_na: true, note_on_fail: true },
        { id: 'racking', type: 'pass_fail', label: 'Racking assembled and secured per manufacturer instructions', allow_na: true, note_on_fail: true },
        { id: 'modules_secured', type: 'pass_fail', label: 'Modules clamped and secured', allow_na: true, note_on_fail: true },
        { id: 'module_serials', type: 'yes_no', label: 'Module serial numbers recorded in the equipment registry', required: true },
        { id: 'roof_condition_after', type: 'pass_fail', label: 'Roof clean; no damage left behind', allow_na: true, note_on_fail: true },
        { id: 'mech_photos', type: 'photo', label: 'Mechanical progress photos', required: true, min_photos: 3, max_photos: 10 },
      ],
    },
    {
      slug: 'solar_install_electrical',
      title: 'Solar install checklist — electrical',
      description: 'Wiring, inverter, storage and labelling, checked against the approved plan set and manufacturer instructions.',
      kind: 'checklist',
      fields: [
        { id: 'wiring_matches', type: 'pass_fail', label: 'Wiring and conductor sizing match the approved plans', allow_na: true, note_on_fail: true },
        { id: 'connections', type: 'pass_fail', label: 'Connections torqued / terminated per manufacturer instructions', allow_na: true, note_on_fail: true },
        { id: 'grounding', type: 'pass_fail', label: 'Grounding and bonding installed per approved plans', allow_na: true, note_on_fail: true },
        { id: 'inverter_mounted', type: 'pass_fail', label: 'Inverter mounted with required clearances', allow_na: true, note_on_fail: true },
        { id: 'disconnects', type: 'pass_fail', label: 'Disconnects / rapid shutdown devices installed as shown on plans', allow_na: true, note_on_fail: true },
        { id: 'storage', type: 'pass_fail', label: 'Battery / storage installed per manufacturer instructions (if applicable)', allow_na: true, note_on_fail: true },
        { id: 'labels', type: 'pass_fail', label: 'Labels and placards installed as required by the approved plans', allow_na: true, note_on_fail: true },
        { id: 'equipment_serials', type: 'yes_no', label: 'Inverter / battery serial numbers recorded in the equipment registry', required: true },
        { id: 'elec_photos', type: 'photo', label: 'Electrical photos (inverter, labels, service equipment)', required: true, min_photos: 3, max_photos: 10 },
      ],
    },
    {
      slug: 'solar_commissioning_report',
      title: 'Solar commissioning report',
      description: 'Customer-facing report of the commissioning visit. Pair it with a Commissioning record entry on the job.',
      kind: 'form',
      fields: [
        { id: 'system_size_kw', type: 'number', label: 'System size (kW DC)', required: true, min: 0.1, max: 10000 },
        { id: 'inverter_online', type: 'yes_no', label: 'Inverter online and exporting', required: true },
        { id: 'monitoring_registered', type: 'yes_no', label: 'Monitoring account created and customer invited', required: true },
        { id: 'customer_trained', type: 'yes_no', label: 'Customer shown shutdown procedure and monitoring', required: true },
        { id: 'open_items', type: 'textarea', label: 'Open items / follow-ups' },
        { id: 'nameplate_photos', type: 'photo', label: 'Nameplate and display photos', min_photos: 1, max_photos: 6 },
        { id: 'customer_signature', type: 'signature', label: 'Customer signature' },
      ],
    },
    {
      slug: 'solar_om_checklist',
      title: 'Solar O&M visit checklist',
      description: 'Recurring maintenance checklist — fails require a note.',
      kind: 'checklist',
      fields: [
        { id: 'production_review', type: 'pass_fail', label: 'Production in line with recent history', allow_na: true, note_on_fail: true },
        { id: 'modules_visual', type: 'pass_fail', label: 'Modules free of visible cracks, hot-spot discolouration or debris', allow_na: true, note_on_fail: true },
        { id: 'racking_visual', type: 'pass_fail', label: 'Racking and attachments visually sound', allow_na: true, note_on_fail: true },
        { id: 'wiring_visual', type: 'pass_fail', label: 'Exposed wiring intact; no rodent or UV damage', allow_na: true, note_on_fail: true },
        { id: 'inverter_status', type: 'pass_fail', label: 'Inverter running with no active faults', allow_na: true, note_on_fail: true },
        { id: 'battery_status', type: 'pass_fail', label: 'Battery / storage reporting normally (if applicable)', allow_na: true, note_on_fail: true },
        { id: 'vegetation', type: 'pass_fail', label: 'No new shading or vegetation growth', allow_na: true, note_on_fail: true },
        { id: 'om_photos', type: 'photo', label: 'Photos of any finding', min_photos: 0, max_photos: 8 },
      ],
    },
  ],
  pricingModels: [
    {
      key: 'solar_om_annual',
      label: 'Solar O&M inspection',
      description: 'Per-visit inspection price tiered by system size.',
      inputs: [{ key: 'system_kw', label: 'System size', unit: 'kW', min: 1, max: 1000, defaultValue: 8 }],
      lines: [{ kind: 'tier', key: 'inspection', label: 'O&M inspection', inputKey: 'system_kw', billing: 'per_visit', tiers: [{ upTo: 6, price: 175 }, { upTo: 12, price: 225 }, { upTo: null, price: 295 }] }],
    },
    {
      key: 'solar_panel_cleaning',
      label: 'Solar panel cleaning',
      description: 'Per-panel cleaning price with a minimum charge.',
      inputs: [{ key: 'panel_count', label: 'Panels', unit: 'panels', min: 1, max: 5000, defaultValue: 24 }],
      lines: [{ kind: 'per_unit', key: 'cleaning', label: 'Panel cleaning', inputKey: 'panel_count', unitPrice: 4.5, minCharge: 150, billing: 'per_visit' }],
    },
  ],
  plans: [
    { key: 'om_annual', title: 'Solar O&M — annual inspection', description: 'One inspection a year.', intervalUnit: 'year', intervalCount: 1, durationMinutes: 90, pricingModel: 'solar_om_annual' },
    { key: 'om_biannual', title: 'Solar O&M — every 6 months', description: 'Inspection twice a year.', intervalUnit: 'month', intervalCount: 6, durationMinutes: 90, pricingModel: 'solar_om_annual' },
    { key: 'cleaning_biannual', title: 'Panel cleaning — every 6 months', description: 'Cleaning twice a year.', intervalUnit: 'month', intervalCount: 6, durationMinutes: 60, pricingModel: 'solar_panel_cleaning' },
  ],
  routes: { workdayMinutes: 480, speedKmh: 45, defaultStopMinutes: 90, weekdays: [1, 2, 3, 4, 5] },
};
