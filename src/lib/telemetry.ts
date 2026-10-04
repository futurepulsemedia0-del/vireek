import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/* ------------------------------------------------------------------ */
/*  Building Telemetry Intelligence — types, helpers, data hook        */
/* ------------------------------------------------------------------ */

export type Protocol =
  | 'bacnet' | 'modbus' | 'mqtt' | 'bms_bas' | 'thermostat' | 'smart_meter' | 'sensor' | 'iot_gateway' | 'rest';

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  bacnet: 'BACnet',
  modbus: 'Modbus',
  mqtt: 'MQTT',
  bms_bas: 'BMS / BAS',
  thermostat: 'Smart thermostat',
  smart_meter: 'Smart meter',
  sensor: 'Standalone sensors',
  iot_gateway: 'IoT gateway',
  rest: 'Custom / REST',
};

export const METRIC_OPTIONS: { value: string; label: string }[] = [
  { value: 'supply_air_temp', label: 'Supply air temperature' },
  { value: 'return_air_temp', label: 'Return air temperature' },
  { value: 'delta_t', label: 'Delta-T (return − supply)' },
  { value: 'zone_temp', label: 'Zone temperature' },
  { value: 'setpoint', label: 'Setpoint' },
  { value: 'discharge_pressure', label: 'Discharge pressure' },
  { value: 'suction_pressure', label: 'Suction pressure' },
  { value: 'superheat', label: 'Superheat' },
  { value: 'subcooling', label: 'Subcooling' },
  { value: 'compressor_current', label: 'Compressor current' },
  { value: 'fan_current', label: 'Fan / blower current' },
  { value: 'vibration', label: 'Vibration' },
  { value: 'filter_dp', label: 'Filter pressure drop' },
  { value: 'power_kw', label: 'Power (kW)' },
  { value: 'energy_kwh', label: 'Energy (kWh)' },
  { value: 'water_temp_supply', label: 'Water supply temperature' },
  { value: 'water_temp_return', label: 'Water return temperature' },
  { value: 'pump_pressure', label: 'Pump pressure' },
  { value: 'flow_rate', label: 'Flow rate' },
  { value: 'humidity', label: 'Humidity' },
  { value: 'co2', label: 'CO₂' },
  { value: 'runtime_hours', label: 'Runtime hours' },
  { value: 'other', label: 'Other' },
];

export const metricLabel = (m: string) => METRIC_OPTIONS.find((o) => o.value === m)?.label ?? m;

export type Severity = 'low' | 'medium' | 'high';

export interface Gateway {
  id: string;
  name: string;
  protocol: Protocol;
  customer_id: string | null;
  token_prefix: string;
  auto_register: boolean;
  max_points: number;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface TelemetryPoint {
  id: string;
  gateway_id: string;
  equipment_id: string | null;
  external_id: string;
  label: string | null;
  metric: string;
  unit: string | null;
  status: 'active' | 'muted';
  baseline_n: number;
  last_value: number | null;
  last_ts: string | null;
}

export interface TelemetryAnomaly {
  id: string;
  point_id: string;
  equipment_id: string | null;
  metric: string;
  kind: 'spike' | 'drift' | 'flatline' | 'out_of_range' | 'rate_of_change';
  severity: Severity;
  direction: 'high' | 'low';
  explanation: string;
  detected_at: string;
}

export interface PredictedPart {
  label: string;
  qty: number;
  part_id: string | null;
  part_name: string | null;
  in_stock: number | null;
}

export interface FailurePrediction {
  id: string;
  equipment_id: string;
  failure_mode: string;
  failure_label: string;
  probability: number;
  confidence: number;
  horizon_days: number;
  drivers: { metric: string; kind: string; direction: string; evidence: number }[];
  predicted_parts: PredictedPart[];
  recommended_action: string | null;
  status: 'open' | 'prepared' | 'serviced' | 'dismissed' | 'expired';
  job_id: string | null;
  created_at: string;
  equipment: { equipment_type: string; make: string | null; model: string | null; customer_id: string } | null;
}

export const equipmentLabel = (e: FailurePrediction['equipment']) =>
  e ? [e.make, e.model].filter(Boolean).join(' ') || e.equipment_type : 'Equipment';

export const SEVERITY_STYLES: Record<Severity, string> = {
  high: 'bg-danger-500/10 text-danger-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-success-500/10 text-success-500',
};

export function riskTone(p: number): Severity {
  return p >= 0.6 ? 'high' : p >= 0.35 ? 'medium' : 'low';
}

/** "Last seen" helper — gateways silent for > 30 min are shown as offline. */
export function isOnline(lastSeen: string | null): boolean {
  return !!lastSeen && Date.now() - Date.parse(lastSeen) < 30 * 60_000;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/* ------------------------------ gateways ---------------------------- */

const bytesToHex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');

async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

/** Creates a gateway; the raw token is returned ONCE and never stored. */
export async function createGateway(
  input: { name: string; protocol: Protocol; customerId?: string | null; autoRegister?: boolean },
  userId: string,
): Promise<{ gateway: Gateway; rawToken: string }> {
  const secret = new Uint8Array(24);
  crypto.getRandomValues(secret);
  const rawToken = `vrk_tg_${bytesToHex(secret)}`;
  const { data, error } = await supabase
    .from('telemetry_gateways')
    .insert({
      user_id: userId,
      name: input.name.trim(),
      protocol: input.protocol,
      customer_id: input.customerId ?? null,
      auto_register: input.autoRegister ?? true,
      token_prefix: rawToken.slice(0, 15),
      token_hash: await sha256Hex(rawToken),
    })
    .select('id, name, protocol, customer_id, token_prefix, auto_register, max_points, last_seen_at, revoked_at, created_at')
    .single();
  if (error) throw error;
  return { gateway: data as Gateway, rawToken };
}

export async function revokeGateway(id: string): Promise<void> {
  const { error } = await supabase.from('telemetry_gateways').update({ revoked_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function mapPointToEquipment(pointId: string, equipmentId: string | null): Promise<void> {
  const { error } = await supabase.from('telemetry_points').update({ equipment_id: equipmentId }).eq('id', pointId);
  if (error) throw error;
}

export async function setPointMetric(pointId: string, metric: string): Promise<void> {
  const { error } = await supabase.from('telemetry_points').update({ metric }).eq('id', pointId);
  if (error) throw error;
}

export async function setPointStatus(pointId: string, status: 'active' | 'muted'): Promise<void> {
  const { error } = await supabase.from('telemetry_points').update({ status }).eq('id', pointId);
  if (error) throw error;
}

export async function runAnalysisNow(): Promise<{ points: number; newAnomalies: number; predictions: number }> {
  const { data, error } = await supabase.functions.invoke('telemetry-analyze', { body: {} });
  if (error) throw error;
  return data as { points: number; newAnomalies: number; predictions: number };
}

/* ----------------------------- predictions -------------------------- */

export async function dismissPrediction(id: string): Promise<void> {
  const { error } = await supabase.from('equipment_failure_predictions').update({ status: 'dismissed' }).eq('id', id);
  if (error) throw error;
}

/**
 * Turns a prediction into a prepared service visit: creates the job,
 * links the equipment, reserves the predicted parts (only parts that exist
 * in the account's catalogue), and marks the prediction "prepared".
 */
export async function scheduleProactiveVisit(p: FailurePrediction): Promise<string> {
  if (!p.equipment) throw new Error('Equipment not found');
  const { data: customer } = await supabase
    .from('customers').select('id, name, phone, address').eq('id', p.equipment.customer_id).maybeSingle();
  if (!customer) throw new Error('Customer not found for this equipment');

  const { data: job, error } = await supabase
    .from('jobs')
    .insert({
      customer_id: customer.id,
      customer_name: customer.name,
      customer_phone: customer.phone ?? null,
      address: customer.address ?? null,
      service_type: `Proactive: ${p.failure_label}`,
      job_status: 'scheduled',
      invoice_status: 'not_sent',
    })
    .select('id')
    .single();
  if (error || !job) throw error ?? new Error('Could not create job');

  await supabase.from('job_equipment').insert({ job_id: job.id, equipment_id: p.equipment_id, service_type: 'proactive_telemetry' });

  const partRows = p.predicted_parts
    .filter((x) => x.part_id)
    .map((x) => ({ job_id: job.id, part_id: x.part_id as string, quantity_required: Math.max(1, x.qty) }));
  if (partRows.length > 0) {
    // Non-fatal: the visit is still valid if parts reservation is not permitted for this role.
    await supabase.from('job_parts_required').insert(partRows);
  }

  const { error: updErr } = await supabase
    .from('equipment_failure_predictions').update({ status: 'prepared', job_id: job.id }).eq('id', p.id);
  if (updErr) throw updErr;
  return job.id as string;
}

/** Technician feedback — the compounding learning loop. */
export async function recordOutcome(
  p: Pick<FailurePrediction, 'id' | 'equipment_id' | 'failure_mode' | 'probability' | 'job_id'>,
  outcome: 'confirmed' | 'false_alarm',
): Promise<void> {
  const { error } = await supabase.from('telemetry_outcomes').insert({
    prediction_id: p.id, equipment_id: p.equipment_id, failure_mode: p.failure_mode,
    outcome, predicted_probability: p.probability, job_id: p.job_id,
  });
  if (error && error.code !== '23505') throw error; // 23505 = already recorded
  await supabase.from('equipment_failure_predictions').update({ status: 'serviced' }).eq('id', p.id);
}

/* -------------------------------- hook ------------------------------ */

export interface TelemetryOverview {
  gateways: Gateway[];
  points: TelemetryPoint[];
  anomalies: TelemetryAnomaly[];
  predictions: FailurePrediction[];
  customerNames: Record<string, string>;
  equipmentOptions: { id: string; label: string }[];
}

const EMPTY: TelemetryOverview = {
  gateways: [], points: [], anomalies: [], predictions: [], customerNames: {}, equipmentOptions: [],
};

export function useTelemetryOverview(enabled: boolean) {
  const [data, setData] = useState<TelemetryOverview>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const [gw, pts, an, pr, eq] = await Promise.all([
        supabase.from('telemetry_gateways')
          .select('id, name, protocol, customer_id, token_prefix, auto_register, max_points, last_seen_at, revoked_at, created_at')
          .order('created_at', { ascending: false }),
        supabase.from('telemetry_points')
          .select('id, gateway_id, equipment_id, external_id, label, metric, unit, status, baseline_n, last_value, last_ts')
          .order('last_ts', { ascending: false, nullsFirst: false }).limit(500),
        supabase.from('telemetry_anomalies')
          .select('id, point_id, equipment_id, metric, kind, severity, direction, explanation, detected_at')
          .eq('status', 'open').order('detected_at', { ascending: false }).limit(100),
        supabase.from('equipment_failure_predictions')
          .select('id, equipment_id, failure_mode, failure_label, probability, confidence, horizon_days, drivers, predicted_parts, recommended_action, status, job_id, created_at, equipment:equipment_id (equipment_type, make, model, customer_id)')
          .in('status', ['open', 'prepared']).order('probability', { ascending: false }).limit(100),
        supabase.from('equipment').select('id, equipment_type, make, model, customer_id').eq('status', 'active').limit(500),
      ]);
      const firstError = gw.error ?? pts.error ?? an.error ?? pr.error ?? eq.error;
      if (firstError) throw firstError;

      const predictions = (pr.data ?? []) as unknown as FailurePrediction[];
      const customerIds = Array.from(new Set((eq.data ?? []).map((e) => e.customer_id as string).filter(Boolean)));
      let customerNames: Record<string, string> = {};
      if (customerIds.length > 0) {
        const { data: cs } = await supabase.from('customers').select('id, name').in('id', customerIds.slice(0, 200));
        customerNames = Object.fromEntries((cs ?? []).map((c) => [c.id as string, c.name as string]));
      }
      setData({
        gateways: (gw.data ?? []) as Gateway[],
        points: (pts.data ?? []) as TelemetryPoint[],
        anomalies: (an.data ?? []) as TelemetryAnomaly[],
        predictions,
        customerNames,
        equipmentOptions: (eq.data ?? []).map((e) => ({
          id: e.id as string,
          label: `${[e.make, e.model].filter(Boolean).join(' ') || (e.equipment_type as string)} · ${customerNames[e.customer_id as string] ?? 'Customer'}`,
        })),
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load telemetry');
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  return { data, loading, error, refresh };
}
