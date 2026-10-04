import { supabase, type Equipment } from '@/lib/supabase';
import { isNearingEndOfLife } from '@/lib/propertyTwin';

/**
 * Property Intelligence OS — client data layer.
 * All prediction math happens server-side (the property-intelligence-agent edge
 * function + _shared/property-intelligence/model.ts). The UI only DISPLAYS what is
 * stored, so there is nothing here to keep in sync with the model.
 */

export type MissionStage =
  | 'detected' | 'awaiting_customer' | 'scheduled' | 'dispatched'
  | 'repaired' | 'verified' | 'declined' | 'dismissed' | 'expired';

export type PartStatus = 'unchecked' | 'reserved' | 'low_stock' | 'backorder' | 'not_found' | 'not_required';
export type MissionOutcome = 'confirmed' | 'not_needed' | 'different_issue';
export type DeviceStatus = 'active' | 'paused' | 'revoked';
export type DeviceProtocol = 'http' | 'mqtt' | 'matter' | 'modbus' | 'bacnet' | 'manual';

export interface PioEvidence {
  metric: string;
  label: string;
  recent_mean: number;
  baseline_mean: number;
  change_pct: number | null;
  strength: number;
}

export interface PioPrediction {
  id: string;
  customer_id: string;
  equipment_id: string;
  failure_mode: string;
  label: string;
  probability: number;
  confidence: number;
  horizon_days_min: number;
  horizon_days_max: number;
  severity: 'watch' | 'high' | 'critical';
  probable_cause: string;
  evidence: PioEvidence[];
  status: 'active' | 'resolved' | 'confirmed' | 'false_positive';
  updated_at: string;
  equipment: { equipment_type: string; make: string | null; model: string | null } | null;
  customer: { name: string } | null;
}

export interface PioMission {
  id: string;
  customer_id: string;
  equipment_id: string;
  failure_mode: string;
  stage: MissionStage;
  urgency: 'high' | 'critical';
  headline: string;
  explanation: string | null;
  probability: number;
  deadline_at: string;
  part_status: PartStatus;
  part_eta: string | null;
  part_quantity: number;
  blocked_reason: string | null;
  outcome: MissionOutcome | null;
  job_id: string | null;
  created_at: string;
  updated_at: string;
  part: { name: string } | null;
  customer: { name: string } | null;
}

export interface PioDevice {
  id: string;
  equipment_id: string;
  name: string;
  sensor_kind: string;
  protocol: DeviceProtocol;
  key_prefix: string;
  status: DeviceStatus;
  last_seen_at: string | null;
  battery_pct: number | null;
  created_at: string;
  equipment: { equipment_type: string; make: string | null } | null;
}

export interface EquipmentOption {
  id: string;
  label: string;
}

export interface RegisteredDevice {
  device_id: string;
  api_key: string;
  key_prefix: string;
}

export interface AgentRunResult {
  accounts: number;
  predictions: number;
  missions_opened: number;
  parts_reserved: number;
  quoted: number;
  awaiting_approval: number;
  scheduled: number;
  dispatched: number;
  repaired: number;
  verified: number;
  blocked: number;
  alerts: number;
}

/** Ordered pipeline shown on every mission card. */
export const PIPELINE: { key: string; label: string; stages: MissionStage[] }[] = [
  { key: 'predicted', label: 'Predicted', stages: ['detected'] },
  { key: 'customer', label: 'Customer', stages: ['awaiting_customer'] },
  { key: 'scheduled', label: 'Scheduled', stages: ['scheduled'] },
  { key: 'dispatched', label: 'Dispatched', stages: ['dispatched'] },
  { key: 'repaired', label: 'Repaired', stages: ['repaired'] },
  { key: 'verified', label: 'Verified', stages: ['verified'] },
];

const ORDER: MissionStage[] = ['detected', 'awaiting_customer', 'scheduled', 'dispatched', 'repaired', 'verified'];

/** Index of the current pipeline step, or -1 for terminal-but-not-successful stages. */
export function stageIndex(stage: MissionStage): number {
  return ORDER.indexOf(stage);
}

export const PART_STATUS_LABEL: Record<PartStatus, string> = {
  unchecked: 'Checking parts…',
  reserved: 'Part reserved',
  low_stock: 'Part low / out of stock',
  backorder: 'Part on backorder',
  not_found: 'No matching part in inventory',
  not_required: 'No part needed',
};

export const PART_STATUS_STYLE: Record<PartStatus, string> = {
  unchecked: 'bg-bg-tertiary text-text-secondary',
  reserved: 'bg-success-500/10 text-success-500',
  low_stock: 'bg-warning-500/10 text-warning-500',
  backorder: 'bg-warning-500/10 text-warning-500',
  not_found: 'bg-warning-500/10 text-warning-500',
  not_required: 'bg-bg-tertiary text-text-secondary',
};

export const SEVERITY_STYLE: Record<'watch' | 'high' | 'critical', string> = {
  watch: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger-500/10 text-danger-500',
  critical: 'bg-danger-500 text-white',
};

export function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

export function deviceIsOnline(d: Pick<PioDevice, 'status' | 'last_seen_at'>): boolean {
  return d.status === 'active' && !!d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < 6 * 3_600_000;
}

export async function fetchMissions(): Promise<PioMission[]> {
  const { data, error } = await supabase
    .from('pio_missions')
    .select(
      'id, customer_id, equipment_id, failure_mode, stage, urgency, headline, explanation, probability, deadline_at, part_status, part_eta, part_quantity, blocked_reason, outcome, job_id, created_at, updated_at, part:part_id (name), customer:customer_id (name)',
    )
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data as unknown as PioMission[]) ?? [];
}

export async function fetchPredictions(): Promise<PioPrediction[]> {
  const { data, error } = await supabase
    .from('pio_predictions')
    .select(
      'id, customer_id, equipment_id, failure_mode, label, probability, confidence, horizon_days_min, horizon_days_max, severity, probable_cause, evidence, status, updated_at, equipment:equipment_id (equipment_type, make, model), customer:customer_id (name)',
    )
    .eq('status', 'active')
    .order('probability', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data as unknown as PioPrediction[]) ?? [];
}

export async function fetchDevices(): Promise<PioDevice[]> {
  const { data, error } = await supabase
    .from('pio_devices')
    .select('id, equipment_id, name, sensor_kind, protocol, key_prefix, status, last_seen_at, battery_pct, created_at, equipment:equipment_id (equipment_type, make)')
    .neq('status', 'revoked')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as unknown as PioDevice[]) ?? [];
}

export async function fetchEquipmentOptions(): Promise<EquipmentOption[]> {
  const { data, error } = await supabase
    .from('equipment')
    .select('id, equipment_type, make, model, customer:customer_id (name)')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return ((data as unknown as { id: string; equipment_type: string; make: string | null; model: string | null; customer: { name: string } | null }[]) ?? []).map((e) => ({
    id: e.id,
    label: `${[e.make, e.equipment_type, e.model].filter(Boolean).join(' ')} — ${e.customer?.name ?? 'Customer'}`,
  }));
}

export async function registerDevice(input: {
  equipmentId: string;
  name: string;
  sensorKind: string;
  protocol: DeviceProtocol;
}): Promise<RegisteredDevice> {
  const { data, error } = await supabase.rpc('pio_register_device', {
    p_equipment_id: input.equipmentId,
    p_name: input.name,
    p_sensor_kind: input.sensorKind,
    p_protocol: input.protocol,
  });
  if (error) throw error;
  return data as RegisteredDevice;
}

export async function setDeviceStatus(deviceId: string, status: DeviceStatus): Promise<boolean> {
  const { data, error } = await supabase.rpc('pio_set_device_status', { p_device_id: deviceId, p_status: status });
  if (error) throw error;
  return Boolean(data);
}

export async function dismissMission(missionId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('pio_dismiss_mission', { p_mission_id: missionId });
  if (error) throw error;
  return Boolean(data);
}

export async function recordOutcome(missionId: string, outcome: MissionOutcome): Promise<boolean> {
  const { data, error } = await supabase.rpc('pio_record_outcome', { p_mission_id: missionId, p_outcome: outcome });
  if (error) throw error;
  return Boolean(data);
}

export async function runPropertyIntelligenceAgent(): Promise<AgentRunResult> {
  const { data, error } = await supabase.functions.invoke('property-intelligence-agent', { body: {} });
  if (error) throw error;
  return data as AgentRunResult;
}

/** Ready-to-paste example for the "device registered" panel. */
export function curlExample(apiKey: string): string {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? 'https://<project-ref>.supabase.co';
  return `curl -X POST ${base}/functions/v1/iot-ingest \\\n  -H "X-Device-Key: ${apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"readings":[{"metric":"vibration_mm_s","value":4.2},{"metric":"current_a","value":11.8}]}'`;
}

// =====================================================================================
// PART 2 — Property Intelligence Graph (building knowledge graph, separate from the twin)
// =====================================================================================

/**
 * Property Intelligence Graph — client model, API and pure derivations.
 *
 * Separate from the Property Digital Twin (src/lib/propertyTwin.ts), which stays the service
 * system of record (equipment, jobs, maintenance). This module adds what is known ABOUT the
 * building: location, physical graph, characteristics, climate, hazards, permits/history,
 * energy and area-level economics — every datum carrying provenance (source, confidence, as_of).
 *
 * Schema: supabase/migrations/20270210000000_property_intelligence_graph.sql
 * Enrichment: supabase/functions/property-intelligence-enrich
 */

// ---------------------------------------------------------------- types

export type IntelLayerKey = 'climate' | 'hazards' | 'economic' | 'energy' | 'characteristics';
export type IntelLayerStatus = 'ok' | 'partial' | 'unavailable' | 'manual' | 'failed';
export type IntelNodeKind = 'parcel' | 'building' | 'structure' | 'unit' | 'permit' | 'construction_event';
export type EnrichmentStatus = 'never' | 'running' | 'complete' | 'partial' | 'failed';

export interface PropertyProfile {
  id: string;
  site_id: string;
  normalized_address: string | null;
  latitude: number | null;
  longitude: number | null;
  geocode_confidence: number | null;
  country_code: string | null;
  census_geoid: string | null;
  enrichment_status: EnrichmentStatus;
  last_enriched_at: string | null;
}

export interface IntelLayer {
  id: string;
  layer: IntelLayerKey;
  status: IntelLayerStatus;
  data: Record<string, unknown>;
  source: string;
  confidence: number;
  as_of: string | null;
  fetched_at: string;
  error: string | null;
}

export interface IntelNode {
  id: string;
  parent_id: string | null;
  site_building_id: string | null;
  kind: IntelNodeKind;
  name: string;
  occurred_on: string | null;
  attributes: Record<string, unknown>;
  source: string;
  verified: boolean;
  created_at: string;
}

export interface PropertyIntelligence {
  profile: PropertyProfile;
  layers: Partial<Record<IntelLayerKey, IntelLayer>>;
  nodes: IntelNode[];
}

export const LAYER_LABELS: Record<IntelLayerKey, string> = {
  climate: 'Climate',
  hazards: 'Hazards',
  economic: 'Area economics',
  energy: 'Energy',
  characteristics: 'Building characteristics',
};

export const NODE_KIND_LABELS: Record<IntelNodeKind, string> = {
  parcel: 'Parcel',
  building: 'Building',
  structure: 'Structure',
  unit: 'Unit',
  permit: 'Permit',
  construction_event: 'Construction event',
};

/** Allowed parent kinds — mirrors pin_validate_node() in the migration. */
export const ALLOWED_PARENTS: Record<IntelNodeKind, IntelNodeKind[]> = {
  parcel: [],
  building: ['parcel'],
  structure: ['building'],
  unit: ['structure', 'building'],
  permit: ['parcel', 'building', 'structure'],
  construction_event: ['parcel', 'building', 'structure', 'unit'],
};

// ---------------------------------------------------------------- API

export async function fetchPropertyIntelligence(siteId: string, create = true): Promise<PropertyIntelligence | null> {
  const { data, error } = await supabase.rpc('get_property_intelligence', { p_site_id: siteId, p_create: create });
  if (error) throw error;
  if (!data) return null;
  const raw = data as { profile: PropertyProfile; layers: IntelLayer[]; nodes: IntelNode[] };
  const layers: Partial<Record<IntelLayerKey, IntelLayer>> = {};
  for (const l of raw.layers ?? []) layers[l.layer] = l;
  return { profile: raw.profile, layers, nodes: raw.nodes ?? [] };
}

async function functionErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = (await ctx.json()) as { error?: unknown };
      if (typeof body?.error === 'string') return body.error;
    } catch {
      /* fall through */
    }
  }
  return error instanceof Error ? error.message : 'Request failed';
}

export interface EnrichResult {
  status: 'complete' | 'partial' | 'failed';
  layers: Array<{ layer: string; status: string; error: string | null }>;
  skipped_manual: string[];
}

export async function enrichProperty(siteId: string): Promise<EnrichResult> {
  const { data, error } = await supabase.functions.invoke('property-intelligence-enrich', { body: { site_id: siteId } });
  if (error) throw new Error(await functionErrorMessage(error));
  return data as EnrichResult;
}

export async function saveManualLayer(
  profileId: string,
  layer: 'characteristics' | 'energy',
  data: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from('property_intel_layers').upsert(
    {
      profile_id: profileId,
      layer,
      status: 'manual',
      data,
      source: 'manual entry',
      confidence: 1,
      as_of: new Date().toISOString().slice(0, 10),
      fetched_at: new Date().toISOString(),
      error: null,
    },
    { onConflict: 'profile_id,layer' },
  );
  if (error) throw error;
}

export interface NewNodeInput {
  profile_id: string;
  kind: IntelNodeKind;
  name: string;
  parent_id: string | null;
  occurred_on: string | null;
  notes: string | null;
}

export async function addNode(input: NewNodeInput): Promise<void> {
  const { error } = await supabase.from('property_intel_nodes').insert({
    profile_id: input.profile_id,
    kind: input.kind,
    name: input.name.trim(),
    parent_id: input.parent_id,
    occurred_on: input.occurred_on || null,
    attributes: input.notes?.trim() ? { notes: input.notes.trim().slice(0, 1000) } : {},
    source: 'manual',
    verified: true,
  });
  if (error) throw error;
}

export async function deleteNode(nodeId: string): Promise<void> {
  const { error } = await supabase.from('property_intel_nodes').delete().eq('id', nodeId);
  if (error) throw error;
}

// ---------------------------------------------------------------- manual field definitions

export interface FieldDef {
  key: string;
  label: string;
  type: 'number' | 'text' | 'select';
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
  unit?: string;
}

const opt = (...values: string[]) => values.map((v) => ({ value: v, label: v.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) }));

export const CHARACTERISTIC_FIELDS: FieldDef[] = [
  { key: 'year_built', label: 'Year built', type: 'number', min: 1600, max: new Date().getFullYear() + 1 },
  { key: 'gross_area_sqft', label: 'Gross area', type: 'number', min: 1, max: 50_000_000, unit: 'sq ft' },
  { key: 'stories', label: 'Stories', type: 'number', min: 1, max: 200 },
  { key: 'units_count', label: 'Units', type: 'number', min: 1, max: 100_000 },
  { key: 'construction_type', label: 'Construction', type: 'select', options: opt('wood_frame', 'masonry', 'steel', 'concrete', 'mixed', 'other') },
  { key: 'foundation_type', label: 'Foundation', type: 'select', options: opt('slab', 'crawlspace', 'basement', 'pier', 'other') },
  { key: 'roof_type', label: 'Roof type', type: 'select', options: opt('asphalt_shingle', 'metal', 'tile', 'flat_membrane', 'slate', 'other') },
  { key: 'roof_installed_year', label: 'Roof installed', type: 'number', min: 1600, max: new Date().getFullYear() + 1 },
  { key: 'heating_fuel', label: 'Primary heating', type: 'select', options: opt('natural_gas', 'electric', 'heat_pump', 'oil', 'propane', 'other') },
];

export const ENERGY_FIELDS: FieldDef[] = [
  { key: 'annual_electricity_kwh', label: 'Electricity', type: 'number', min: 0, max: 1_000_000_000, unit: 'kWh / yr' },
  { key: 'annual_gas_therms', label: 'Natural gas', type: 'number', min: 0, max: 100_000_000, unit: 'therms / yr' },
  { key: 'annual_energy_cost_usd', label: 'Annual energy cost', type: 'number', min: 0, max: 1_000_000_000, unit: 'USD' },
  { key: 'solar_kw', label: 'Solar capacity', type: 'number', min: 0, max: 1_000_000, unit: 'kW' },
  { key: 'utility_provider', label: 'Utility provider', type: 'text' },
];

/** Validates raw form strings. Empty values are omitted; invalid ones are reported per field key. */
export function parseFieldValues(
  fields: FieldDef[],
  raw: Record<string, string>,
): { data: Record<string, unknown>; errors: Record<string, string> } {
  const data: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = (raw[f.key] ?? '').trim();
    if (!v) continue;
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) errors[f.key] = 'Enter a number';
      else if (f.min !== undefined && n < f.min) errors[f.key] = `Must be at least ${f.min}`;
      else if (f.max !== undefined && n > f.max) errors[f.key] = `Must be at most ${f.max}`;
      else data[f.key] = n;
    } else if (f.type === 'select') {
      if (f.options?.some((o) => o.value === v)) data[f.key] = v;
      else errors[f.key] = 'Choose a listed option';
    } else {
      data[f.key] = v.slice(0, 120);
    }
  }
  return { data, errors };
}

export function fieldFormValues(fields: FieldDef[], data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = data?.[f.key];
    out[f.key] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

// ---------------------------------------------------------------- safe accessors

export const numOf = (d: Record<string, unknown> | undefined, k: string): number | null => {
  const v = d?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
export const strOf = (d: Record<string, unknown> | undefined, k: string): string | null => {
  const v = d?.[k];
  return typeof v === 'string' && v ? v : null;
};
export const objOf = (d: Record<string, unknown> | undefined, k: string): Record<string, unknown> | undefined => {
  const v = d?.[k];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
};

// ---------------------------------------------------------------- graph tree

export interface IntelTreeNode extends IntelNode {
  children: IntelTreeNode[];
}

const KIND_ORDER: Record<IntelNodeKind, number> = { parcel: 0, building: 1, structure: 2, unit: 3, permit: 4, construction_event: 5 };

/** Nested tree for display. Orphans (missing parent) surface as roots instead of vanishing. */
export function buildNodeTree(nodes: IntelNode[]): IntelTreeNode[] {
  const byId = new Map<string, IntelTreeNode>(nodes.map((n) => [n.id, { ...n, children: [] }]));
  const roots: IntelTreeNode[] = [];
  for (const n of byId.values()) {
    const parent = n.parent_id ? byId.get(n.parent_id) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const sort = (list: IntelTreeNode[]) => {
    list.sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        (a.occurred_on ?? '9999').localeCompare(b.occurred_on ?? '9999') ||
        a.name.localeCompare(b.name),
    );
    list.forEach((c) => sort(c.children));
  };
  sort(roots);
  return roots;
}

export function eligibleParents(kind: IntelNodeKind, nodes: IntelNode[]): IntelNode[] {
  const allowed = ALLOWED_PARENTS[kind];
  return nodes.filter((n) => allowed.includes(n.kind));
}

// ---------------------------------------------------------------- completeness

export interface CoverageComponent {
  key: string;
  label: string;
  weight: number;
  quality: number; // 0..1
}

export interface Coverage {
  score: number; // 0..100
  components: CoverageComponent[];
  gaps: CoverageComponent[];
}

const WEIGHTS = {
  address: 10,
  parcel: 5,
  structure: 10,
  history: 10,
  characteristics: 20,
  climate: 10,
  hazards: 10,
  economic: 5,
  energy: 10,
  equipment: 10,
} as const;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function layerQuality(layer: IntelLayer | undefined, fields?: FieldDef[]): number {
  if (!layer) return 0;
  if (layer.status === 'manual') {
    if (!fields?.length) return 1;
    const filled = fields.filter((f) => layer.data[f.key] !== undefined && layer.data[f.key] !== null && layer.data[f.key] !== '').length;
    return clamp01(filled / fields.length);
  }
  if (layer.status === 'ok') return clamp01(layer.confidence);
  if (layer.status === 'partial') return clamp01(layer.confidence * 0.5);
  return 0;
}

/** Data completeness weighted by provenance quality. Measures what we KNOW, not how good the property is. */
export function computeCoverage(intel: PropertyIntelligence, equipmentCount: number): Coverage {
  const { profile, layers, nodes } = intel;
  const has = (k: IntelNodeKind) => nodes.some((n) => n.kind === k);
  const historyCount = nodes.filter((n) => n.kind === 'permit' || n.kind === 'construction_event').length;

  const q: Record<keyof typeof WEIGHTS, number> = {
    address: profile.latitude !== null && profile.longitude !== null ? clamp01(profile.geocode_confidence ?? 0.7) : 0,
    parcel: has('parcel') ? 1 : 0,
    structure: has('structure') ? 1 : has('building') ? 0.6 : 0,
    history: historyCount >= 3 ? 1 : historyCount >= 1 ? 0.6 : 0,
    characteristics: layerQuality(layers.characteristics, CHARACTERISTIC_FIELDS),
    climate: layerQuality(layers.climate),
    hazards: layerQuality(layers.hazards),
    economic: layerQuality(layers.economic),
    energy: layerQuality(layers.energy, ENERGY_FIELDS),
    equipment: equipmentCount > 0 ? 1 : 0,
  };

  const labels: Record<keyof typeof WEIGHTS, string> = {
    address: 'Located address',
    parcel: 'Parcel record',
    structure: 'Building & structure',
    history: 'Permits & construction history',
    characteristics: 'Building characteristics',
    climate: 'Climate',
    hazards: 'Hazards',
    economic: 'Area economics',
    energy: 'Energy',
    equipment: 'Equipment inventory',
  };

  const components = (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).map((key) => ({
    key,
    label: labels[key],
    weight: WEIGHTS[key],
    quality: q[key],
  }));
  const score = Math.round(components.reduce((s, c) => s + c.weight * c.quality, 0));
  const gaps = components.filter((c) => c.quality < 0.5).sort((a, b) => b.weight - a.weight);
  return { score, components, gaps };
}

// ---------------------------------------------------------------- insights

export type InsightSeverity = 'high' | 'medium' | 'low';
export type InsightKind = 'risk' | 'opportunity' | 'compliance' | 'data_quality';

export interface Insight {
  id: string;
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  detail: string;
  evidence: string[];
}

const HEATING_RE = /furnace|boiler|heat pump|heater|air handler|hvac|heating/i;
const COOLING_RE = /air condition|a\/c|\bac\b|condens|heat pump|chiller|hvac|cooling/i;
const PERMIT_TYPICAL_RE = /furnace|boiler|heat pump|water heater|air condition|condens|panel|generator|hvac/i;
const SEVERITY_ORDER: Record<InsightSeverity, number> = { high: 0, medium: 1, low: 2 };

const yearOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const y = new Date(iso).getUTCFullYear();
  return Number.isFinite(y) ? y : null;
};

const equipLabel = (e: Equipment) =>
  `${[e.make, e.model].filter(Boolean).join(' ') || e.equipment_type}${yearOf(e.install_date) ? ` (installed ${yearOf(e.install_date)})` : ''}`;

function pastEndOfLife(e: Pick<Equipment, 'install_date' | 'expected_lifespan_years'>, now: Date): boolean {
  if (!e.install_date) return false;
  const eol = new Date(e.install_date);
  eol.setFullYear(eol.getFullYear() + e.expected_lifespan_years);
  return eol.getTime() < now.getTime();
}

/**
 * Deterministic, evidence-cited insights from the graph joined with the twin's equipment.
 * No model calls: every insight lists the facts it rests on, and rules only fire on known data.
 */
export function deriveInsights(intel: PropertyIntelligence, equipment: Equipment[], now = new Date()): Insight[] {
  const out: Insight[] = [];
  const active = equipment.filter((e) => e.status === 'active');
  const ch = intel.layers.characteristics?.data;
  const climate = intel.layers.climate?.data;
  const hazards = intel.layers.hazards?.data;
  const thisYear = now.getUTCFullYear();

  const hdd = numOf(climate, 'hdd65_f');
  const cdd = numOf(climate, 'cdd65_f');
  const profile = strOf(climate, 'climate_profile');

  // 1. Climate load on aging HVAC
  if (profile === 'heating_dominated' && hdd !== null && hdd >= 3000) {
    const aging = active.filter((e) => HEATING_RE.test(e.equipment_type) && isNearingEndOfLife(e));
    if (aging.length) {
      out.push({
        id: 'aging-heating-cold-climate',
        kind: 'risk',
        severity: aging.some((e) => pastEndOfLife(e, now)) ? 'high' : 'medium',
        title: 'Aging heating equipment in a heating-dominated climate',
        detail: 'Heating equipment near or past expected life carries the highest failure cost where it runs the most. Offer inspection or planned replacement before the heating season.',
        evidence: [`${hdd.toLocaleString('en-US')} heating degree-days per year`, ...aging.map(equipLabel)],
      });
    }
  }
  if (profile === 'cooling_dominated' && cdd !== null && cdd >= 1500) {
    const aging = active.filter((e) => COOLING_RE.test(e.equipment_type) && isNearingEndOfLife(e));
    if (aging.length) {
      out.push({
        id: 'aging-cooling-hot-climate',
        kind: 'risk',
        severity: aging.some((e) => pastEndOfLife(e, now)) ? 'high' : 'medium',
        title: 'Aging cooling equipment in a cooling-dominated climate',
        detail: 'Cooling equipment near or past expected life is under heavy load here. A pre-season tune-up or replacement plan reduces emergency calls.',
        evidence: [`${cdd.toLocaleString('en-US')} cooling degree-days per year`, ...aging.map(equipLabel)],
      });
    }
  }

  // 2. Flood
  const flood = objOf(hazards, 'flood');
  if (flood?.sfha === true) {
    out.push({
      id: 'flood-sfha',
      kind: 'risk',
      severity: 'medium',
      title: 'Inside a FEMA Special Flood Hazard Area',
      detail: 'Confirm the elevation of the furnace, water heater and electrical panel, and whether flood coverage is in place before recommending installs in low areas.',
      evidence: [`FEMA flood zone ${strOf(flood, 'zone') ?? 'unknown'}`],
    });
  }

  // 3. Era-based compliance / safety flags
  const yearBuilt = numOf(ch, 'year_built');
  if (yearBuilt !== null && yearBuilt < 1978) {
    out.push({
      id: 'pre-1978',
      kind: 'compliance',
      severity: 'medium',
      title: 'Built before 1978 — lead-safe work rules may apply',
      detail: 'EPA Renovation, Repair and Painting rules can apply to work that disturbs painted surfaces in pre-1978 housing and child-occupied facilities. Verify requirements and certification before starting.',
      evidence: [`Year built ${yearBuilt}`],
    });
  }
  if (yearBuilt !== null && yearBuilt >= 1965 && yearBuilt <= 1973) {
    out.push({
      id: 'aluminum-wiring-era',
      kind: 'risk',
      severity: 'low',
      title: 'Built in the aluminum branch-wiring era',
      detail: 'Homes from this period may contain aluminum branch wiring. Verify the wiring type before electrical work or adding load.',
      evidence: [`Year built ${yearBuilt}`],
    });
  }

  // 4. Data quality: equipment older than the building
  if (yearBuilt !== null) {
    const impossible = active.filter((e) => {
      const y = yearOf(e.install_date);
      return y !== null && y < yearBuilt;
    });
    if (impossible.length) {
      out.push({
        id: 'equipment-predates-building',
        kind: 'data_quality',
        severity: 'low',
        title: 'Equipment install date is earlier than the year built',
        detail: 'Either the year built or the install date is wrong, or the equipment was relocated. Correct whichever record is mistaken so lifespan predictions stay reliable.',
        evidence: [`Year built ${yearBuilt}`, ...impossible.map(equipLabel)],
      });
    }
  }

  // 5. Roof age
  const roofYear = numOf(ch, 'roof_installed_year');
  if (roofYear !== null && thisYear - roofYear >= 20) {
    const age = thisYear - roofYear;
    out.push({
      id: 'roof-age',
      kind: 'opportunity',
      severity: age >= 25 ? 'medium' : 'low',
      title: `Roof is ${age} years old`,
      detail: 'A roof inspection is a natural next service visit; roof condition also affects attic HVAC loads and insulation performance.',
      evidence: [`Roof installed ${roofYear}`, strOf(ch, 'roof_type') ? `Roof type: ${strOf(ch, 'roof_type')!.replace(/_/g, ' ')}` : ''].filter(Boolean),
    });
  }

  // 6. Climate stress
  const freeze = numOf(climate, 'freeze_days_32f');
  if (freeze !== null && freeze >= 60) {
    out.push({
      id: 'freeze-exposure',
      kind: 'opportunity',
      severity: 'low',
      title: 'Freeze-prone area',
      detail: 'Frequent freezing makes pipe insulation, outdoor spigots and heat-trace worth checking in fall maintenance visits.',
      evidence: [`${freeze} days per year at or below 32°F`],
    });
  }
  const heatDays = numOf(climate, 'heat_days_95f');
  if (heatDays !== null && heatDays >= 30) {
    out.push({
      id: 'extreme-heat',
      kind: 'opportunity',
      severity: 'low',
      title: 'Extreme-heat area',
      detail: 'Many 95°F+ days stress cooling equipment and attics; pre-summer checks reduce emergency calls.',
      evidence: [`${heatDays} days per year at or above 95°F`],
    });
  }

  // 7. Seismic
  const seismic = objOf(hazards, 'seismic');
  const quakes = numOf(seismic, 'events_m4_100km');
  if (quakes !== null && quakes >= 10) {
    out.push({
      id: 'seismic-activity',
      kind: 'risk',
      severity: 'low',
      title: 'Seismically active region',
      detail: 'Check water-heater strapping and gas shut-off provisions during visits; some jurisdictions require them.',
      evidence: [`${quakes} earthquakes of magnitude 4+ within 100 km in the last ${numOf(seismic, 'window_years') ?? 10} years`],
    });
  }

  // 8. Permit gap — only when permits are recorded at all (otherwise it is missing data, not a gap)
  const permits = intel.nodes.filter((n) => n.kind === 'permit' && n.occurred_on);
  if (permits.length) {
    const windowMs = 180 * 24 * 60 * 60 * 1000;
    const unpermitted = active.filter((e) => {
      if (!e.install_date || !PERMIT_TYPICAL_RE.test(e.equipment_type)) return false;
      const t = new Date(e.install_date).getTime();
      return !permits.some((p) => Math.abs(new Date(p.occurred_on as string).getTime() - t) <= windowMs);
    });
    if (unpermitted.length) {
      out.push({
        id: 'permit-gap',
        kind: 'compliance',
        severity: 'low',
        title: 'No permit on file near some install dates',
        detail: 'Confirm whether a permit was required for these installs and add it to the record if one exists.',
        evidence: unpermitted.map(equipLabel),
      });
    }
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
