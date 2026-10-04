import { supabase } from '@/lib/supabase';

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
