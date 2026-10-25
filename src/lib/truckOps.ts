// src/lib/truckOps.ts
// Truck replenishment, transfer orders (scan-confirmed), van audits, shrinkage/variance detection and
// dispatch alerts. Server side: supabase/migrations/20271105000000_truck_replenishment_transfers.sql.
//
// Everything above the "Server" banner is pure (and unit-tested); everything below talks to Supabase.

import { supabase } from '@/lib/supabase';
import type { Tone } from '@/lib/truckStock';

// ============================================================
// TYPES — mirror the SQL objects
// ============================================================

export type ForecastReason = 'job_demand' | 'forecast_min' | 'below_min';
export type ForecastConfidence = 'high' | 'medium' | 'low';

export interface ForecastRow {
  location_id: string;
  location_name: string;
  technician_id: string | null;
  part_id: string;
  part_name: string;
  part_number: string | null;
  available: number;
  min_quantity: number | null;
  target_quantity: number | null;
  upcoming_jobs: number;
  explicit_demand: number;
  statistical_demand: number;
  forecast_demand: number;
  inbound: number;
  projected: number;
  suggested_qty: number;
  warehouse_available: number;
  fulfillable_qty: number;
  order_shortfall: number;
  reason: ForecastReason;
  confidence: ForecastConfidence;
  first_short_job_id: string | null;
  first_short_at: string | null;
  unit_cost_cents: number;
}

export type TransferStatus = 'open' | 'in_transit' | 'completed' | 'cancelled';
export type TransferStage = 'pick' | 'receive';

export interface TransferLine {
  id: string;
  transfer_id: string;
  part_id: string;
  qty_planned: number;
  qty_picked: number;
  qty_received: number;
  unit_cost_cents: number;
  picked_at: string | null;
  pick_scanned: boolean;
  pick_override_reason: string | null;
  received_at: string | null;
  receive_scanned: boolean;
  receive_override_reason: string | null;
  replenishment_task_id: string | null;
  part?: { name: string; part_number: string | null; barcode: string | null } | null;
}

export interface TransferOrder {
  id: string;
  transfer_number: string;
  from_location_id: string;
  to_location_id: string;
  status: TransferStatus;
  source: 'manual' | 'forecast' | 'par_level' | 'job_shortage' | 'task';
  notes: string | null;
  has_variance: boolean;
  shipped_at: string | null;
  received_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  from_location?: { name: string } | null;
  to_location?: { name: string } | null;
  lines: TransferLine[];
}

export type VarianceKind =
  | 'count_shortage'
  | 'count_overage'
  | 'transfer_shortage'
  | 'negative_stock'
  | 'unassigned_usage'
  | 'overuse_vs_job'
  | 'shrink_pattern';
export type Severity = 'info' | 'warning' | 'critical';
export type VarianceStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed';

export interface VarianceEvent {
  id: string;
  kind: VarianceKind;
  severity: Severity;
  location_id: string | null;
  technician_id: string | null;
  part_id: string | null;
  job_id: string | null;
  quantity: number | null;
  value_cents: number;
  details: Record<string, unknown>;
  status: VarianceStatus;
  detected_at: string;
  resolution_note: string | null;
  location?: { name: string } | null;
  part?: { name: string } | null;
}

export type AlertType = 'low_stock' | 'stockout' | 'job_at_risk' | 'audit_overdue';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface TruckAlert {
  id: string;
  alert_type: AlertType;
  severity: Severity;
  location_id: string | null;
  technician_id: string | null;
  part_id: string | null;
  job_id: string | null;
  message: string;
  status: AlertStatus;
  first_seen_at: string;
  last_seen_at: string;
}

export type AuditStatus = 'ok' | 'due_soon' | 'overdue' | 'in_progress';

export interface VanAuditRow {
  location_id: string;
  location_name: string;
  technician_id: string | null;
  technician_name: string | null;
  last_audit_at: string | null;
  last_accuracy_pct: number | null;
  open_count_id: string | null;
  interval_days: number;
  due_at: string;
  days_overdue: number;
  audit_status: AuditStatus;
}

export interface VarianceSummaryRow {
  location_id: string;
  location_name: string;
  technician_id: string | null;
  technician_name: string | null;
  usage_value_cents: number;
  shrink_value_cents: number;
  shrink_rate_pct: number;
  open_events: number;
  critical_events: number;
  last_audit_at: string | null;
  last_accuracy_pct: number | null;
}

export interface TruckOpsSettings {
  forecast_horizon_days: number;
  history_days: number;
  safety_factor: number;
  audit_interval_days: number;
  shrink_alert_pct: number;
  shrink_min_value_cents: number;
  low_stock_alerts_enabled: boolean;
  alert_cooldown_hours: number;
  require_scan: boolean;
}

export const DEFAULT_TRUCK_OPS_SETTINGS: TruckOpsSettings = {
  forecast_horizon_days: 7,
  history_days: 90,
  safety_factor: 1.2,
  audit_interval_days: 14,
  shrink_alert_pct: 5,
  shrink_min_value_cents: 2000,
  low_stock_alerts_enabled: true,
  alert_cooldown_hours: 12,
  require_scan: true,
};

export interface MyVan {
  status: 'ok' | 'not_a_technician' | 'no_truck';
  technician_id?: string;
  van_id?: string;
  van_name?: string;
}

/** Every RPC answers `{ status, ... }`; business outcomes are statuses, not exceptions. */
export interface RpcResult {
  status: string;
  [key: string]: unknown;
}

// ============================================================
// LABELS / TONES
// ============================================================

export const SEVERITY_TONE: Record<Severity, Tone> = { info: 'neutral', warning: 'warning', critical: 'danger' };

export const TRANSFER_STATUS_META: Record<TransferStatus, { label: string; tone: Tone }> = {
  open: { label: 'To pick', tone: 'accent' },
  in_transit: { label: 'On the way', tone: 'warning' },
  completed: { label: 'Received', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const VARIANCE_KIND_LABELS: Record<VarianceKind, string> = {
  count_shortage: 'Count shortage',
  count_overage: 'Count overage',
  transfer_shortage: 'Transfer arrived short',
  negative_stock: 'Negative stock',
  unassigned_usage: 'Usage without a job',
  overuse_vs_job: 'Used more than the job needed',
  shrink_pattern: 'Unusual loss pattern',
};

export const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  low_stock: 'Low stock',
  stockout: 'Out of stock',
  job_at_risk: 'Job at risk',
  audit_overdue: 'Audit overdue',
};

export const AUDIT_STATUS_META: Record<AuditStatus, { label: string; tone: Tone }> = {
  ok: { label: 'On schedule', tone: 'success' },
  due_soon: { label: 'Due soon', tone: 'warning' },
  overdue: { label: 'Overdue', tone: 'danger' },
  in_progress: { label: 'In progress', tone: 'accent' },
};

export const FORECAST_REASON_LABELS: Record<ForecastReason, string> = {
  job_demand: 'Upcoming jobs need more than the truck has',
  forecast_min: 'Will fall to the minimum after upcoming jobs',
  below_min: 'At or below the minimum',
};

export const CONFIDENCE_LABELS: Record<ForecastConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence (little history)',
};

/** Human wording for every `status` the transfer / audit / alert RPCs can return. */
const STATUS_MESSAGES: Record<string, string> = {
  forbidden: "You don't have permission to do that.",
  not_found: 'That record no longer exists. Refresh and try again.',
  invalid_stage: 'Unknown step.',
  not_open: 'This transfer has already been shipped or closed.',
  not_in_transit: 'This transfer is not on its way (it may already be received or cancelled).',
  not_shipped: 'Nothing was shipped for this line.',
  not_cancellable: 'This transfer can no longer be cancelled.',
  invalid_quantity: 'That quantity is not allowed for this line.',
  invalid_locations: 'Choose two different, active locations.',
  invalid_lines: 'Add at least one part with a quantity above zero.',
  invalid_status: 'Unknown status.',
  invalid_location: 'That location is not an active truck.',
  part_not_found: 'One of the parts no longer exists.',
  job_not_found: 'That job no longer exists.',
  task_conflict: 'A restock request on this transfer is already in another transfer or was closed.',
  unknown_code: "That code doesn't match any part.",
  wrong_part: 'That is a different part than this line.',
  scan_required: 'Scan the barcode, or give a short reason if the label is unreadable.',
  insufficient_stock: 'Not enough stock at the source.',
  unconfirmed_lines: 'Confirm every line first.',
  nothing_picked: 'Nothing was picked — confirm at least one line above zero, or cancel the transfer.',
  no_truck: 'No truck is assigned to you yet.',
  empty_van: 'This truck has no parts to count yet.',
  not_a_technician: 'This action is for technicians.',
};

export function describeStatus(result: RpcResult | null | undefined): string {
  if (!result) return 'Something went wrong. Please try again.';
  const base = STATUS_MESSAGES[result.status] ?? 'Something went wrong. Please try again.';
  if (result.status === 'wrong_part' && typeof result.scanned_part === 'string') {
    return `That barcode is ${result.scanned_part}, not this part.`;
  }
  if (result.status === 'insufficient_stock') {
    const part = typeof result.part === 'string' ? `${result.part}: ` : '';
    const avail = typeof result.available === 'number' ? ` Only ${result.available} available.` : '';
    return `${part}${base}${avail}`;
  }
  if (result.status === 'invalid_quantity' && typeof result.max === 'number') {
    return `Enter a quantity between 0 and ${result.max}.`;
  }
  if (result.status === 'unconfirmed_lines' && typeof result.count === 'number') {
    return `${result.count} line(s) still need confirming.`;
  }
  return base;
}

export function isOk(result: RpcResult | null | undefined, ...okStatuses: string[]): boolean {
  if (!result) return false;
  const accepted = okStatuses.length ? okStatuses : ['ok'];
  return accepted.includes(result.status);
}

// ============================================================
// PURE HELPERS
// ============================================================

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function sortBySeverity<T extends { severity: Severity }>(items: T[]): T[] {
  return [...items].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** How soon the first job runs short: drives the badge colour in the forecast table. */
export type Urgency = 'now' | 'soon' | 'planned';

export function forecastUrgency(row: Pick<ForecastRow, 'first_short_at' | 'available'>, now: number = Date.now()): Urgency {
  if (row.available <= 0) return 'now';
  if (!row.first_short_at) return 'planned';
  const at = Date.parse(row.first_short_at);
  if (!Number.isFinite(at)) return 'planned';
  const hours = (at - now) / 3_600_000;
  if (hours <= 24) return 'now';
  if (hours <= 72) return 'soon';
  return 'planned';
}

export const URGENCY_META: Record<Urgency, { label: string; tone: Tone }> = {
  now: { label: 'Needed within 24h', tone: 'danger' },
  soon: { label: 'Needed within 3 days', tone: 'warning' },
  planned: { label: 'Planned', tone: 'neutral' },
};

export interface ForecastGroup {
  location_id: string;
  location_name: string;
  rows: ForecastRow[];
  totalSuggested: number;
  totalFulfillable: number;
  totalShortfall: number;
  valueCents: number;
}

export function groupForecastByTruck(rows: ForecastRow[]): ForecastGroup[] {
  const map = new Map<string, ForecastGroup>();
  for (const row of rows) {
    let g = map.get(row.location_id);
    if (!g) {
      g = { location_id: row.location_id, location_name: row.location_name, rows: [], totalSuggested: 0, totalFulfillable: 0, totalShortfall: 0, valueCents: 0 };
      map.set(row.location_id, g);
    }
    g.rows.push(row);
    g.totalSuggested += row.suggested_qty;
    g.totalFulfillable += row.fulfillable_qty;
    g.totalShortfall += row.order_shortfall;
    g.valueCents += row.fulfillable_qty * row.unit_cost_cents;
  }
  return [...map.values()].sort((a, b) => b.totalShortfall - a.totalShortfall || a.location_name.localeCompare(b.location_name));
}

/** Pick/receive progress of a transfer: used for the progress bar and the enabled state of the buttons. */
export interface TransferProgress {
  lines: number;
  confirmed: number;
  allConfirmed: boolean;
  unitsPlanned: number;
  unitsPicked: number;
  unitsReceived: number;
  shortUnits: number;
}

export function transferProgress(order: Pick<TransferOrder, 'status' | 'lines'>): TransferProgress {
  const stage: TransferStage = order.status === 'in_transit' || order.status === 'completed' ? 'receive' : 'pick';
  const relevant = stage === 'receive' ? order.lines.filter((l) => l.qty_picked > 0) : order.lines;
  const confirmed = relevant.filter((l) => (stage === 'receive' ? l.received_at !== null : l.picked_at !== null)).length;
  const unitsPlanned = order.lines.reduce((s, l) => s + l.qty_planned, 0);
  const unitsPicked = order.lines.reduce((s, l) => s + l.qty_picked, 0);
  const unitsReceived = order.lines.reduce((s, l) => s + l.qty_received, 0);
  return {
    lines: relevant.length,
    confirmed,
    allConfirmed: relevant.length > 0 && confirmed === relevant.length,
    unitsPlanned,
    unitsPicked,
    unitsReceived,
    shortUnits: order.status === 'completed' || order.status === 'in_transit' ? Math.max(unitsPicked - unitsReceived, 0) : 0,
  };
}

export function canShip(order: Pick<TransferOrder, 'status' | 'lines'>): boolean {
  if (order.status !== 'open' || order.lines.length === 0) return false;
  return order.lines.every((l) => l.picked_at !== null) && order.lines.some((l) => l.qty_picked > 0);
}

export function canComplete(order: Pick<TransferOrder, 'status' | 'lines'>): boolean {
  if (order.status !== 'in_transit') return false;
  const shipped = order.lines.filter((l) => l.qty_picked > 0);
  return shipped.length > 0 && shipped.every((l) => l.received_at !== null);
}

export type ParsedQty = { ok: true; value: number } | { ok: false; error: string };

/** Quantity typed into a confirm box: whole number between 0 and `max`. */
export function parseConfirmQty(raw: string, max: number): ParsedQty {
  const text = raw.trim();
  if (text === '') return { ok: false, error: 'Enter a quantity.' };
  if (!/^\d{1,7}$/.test(text)) return { ok: false, error: 'Use a whole number, 0 or more.' };
  const value = Number(text);
  if (value > max) return { ok: false, error: `At most ${max}.` };
  return { ok: true, value };
}

export function describeVariance(e: Pick<VarianceEvent, 'kind' | 'quantity' | 'details'>): string {
  const d = e.details ?? {};
  const num = (k: string): number | null => (typeof d[k] === 'number' ? (d[k] as number) : null);
  switch (e.kind) {
    case 'count_shortage':
      return `Counted ${num('counted') ?? '?'} but the system expected ${num('expected') ?? '?'}.`;
    case 'count_overage':
      return `Counted ${num('counted') ?? '?'} but the system expected ${num('expected') ?? '?'} — an unrecorded receipt or return?`;
    case 'transfer_shortage':
      return `Shipped ${num('picked') ?? '?'}, truck received ${num('received') ?? '?'} (${typeof d.transfer_number === 'string' ? d.transfer_number : 'transfer'}).`;
    case 'negative_stock':
      return `The truck shows ${num('on_hand') ?? '?'} on hand — usage was recorded for parts it never received.`;
    case 'unassigned_usage':
      return `${num('share_pct') ?? '?'}% of this truck's recent usage is not tied to any job.`;
    case 'overuse_vs_job':
      return `Used ${num('used') ?? '?'} but the job only required ${num('required') ?? '?'}.`;
    case 'shrink_pattern':
      return `Loss rate ${num('rate_pct') ?? '?'}% vs fleet median ${num('fleet_median_pct') ?? '?'}% over ${num('window_days') ?? 30} days.`;
    default:
      return '';
  }
}

export interface SettingsErrors {
  [field: string]: string;
}

/** Same bounds as the CHECK constraints in the migration, so the UI rejects what the database would. */
export function validateSettings(s: TruckOpsSettings): SettingsErrors {
  const errors: SettingsErrors = {};
  const int = (v: number) => Number.isInteger(v);
  if (!int(s.forecast_horizon_days) || s.forecast_horizon_days < 1 || s.forecast_horizon_days > 30) errors.forecast_horizon_days = 'Between 1 and 30 days.';
  if (!int(s.history_days) || s.history_days < 14 || s.history_days > 365) errors.history_days = 'Between 14 and 365 days.';
  if (!Number.isFinite(s.safety_factor) || s.safety_factor < 1 || s.safety_factor > 3) errors.safety_factor = 'Between 1.0 and 3.0.';
  if (!int(s.audit_interval_days) || s.audit_interval_days < 1 || s.audit_interval_days > 180) errors.audit_interval_days = 'Between 1 and 180 days.';
  if (!Number.isFinite(s.shrink_alert_pct) || s.shrink_alert_pct < 0.5 || s.shrink_alert_pct > 100) errors.shrink_alert_pct = 'Between 0.5% and 100%.';
  if (!int(s.shrink_min_value_cents) || s.shrink_min_value_cents < 0) errors.shrink_min_value_cents = 'Zero or more.';
  if (!int(s.alert_cooldown_hours) || s.alert_cooldown_hours < 1 || s.alert_cooldown_hours > 168) errors.alert_cooldown_hours = 'Between 1 and 168 hours.';
  return errors;
}

/** Message for a thrown Postgres / network error. */
export function opsErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return fallback;
  if (e.code === '42501') return "You don't have permission to do that.";
  if (e.message && /Failed to fetch|NetworkError|network/i.test(e.message)) return "You're offline — check your connection and try again.";
  if (e.code === 'PGRST202' || (e.message && /could not find the function/i.test(e.message))) {
    return 'This feature needs the latest database update. Ask an admin to run the truck-operations migration.';
  }
  return fallback;
}

// ============================================================
// Server
// ============================================================

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}

export async function listForecast(locationId?: string): Promise<ForecastRow[]> {
  const rows = await rpc<ForecastRow[] | null>('truck_restock_forecast', { p_location_id: locationId ?? null });
  return (rows ?? []).map((r) => ({ ...r, statistical_demand: Number(r.statistical_demand) }));
}

export function createTransfersFromForecast(locationIds?: string[]): Promise<RpcResult> {
  return rpc<RpcResult>('create_transfers_from_forecast', { p_location_ids: locationIds && locationIds.length ? locationIds : null });
}

export function createTransfer(input: {
  fromLocationId: string;
  toLocationId: string;
  lines: { part_id: string; quantity: number; task_id?: string }[];
  notes?: string;
  source?: TransferOrder['source'];
}): Promise<RpcResult> {
  return rpc<RpcResult>('create_stock_transfer', {
    p_from: input.fromLocationId,
    p_to: input.toLocationId,
    p_lines: input.lines,
    p_source: input.source ?? 'manual',
    p_notes: input.notes ?? null,
    p_job_id: null,
  });
}

export function confirmTransferLine(input: {
  lineId: string;
  stage: TransferStage;
  quantity: number;
  code?: string;
  overrideReason?: string;
}): Promise<RpcResult> {
  return rpc<RpcResult>('confirm_transfer_line', {
    p_line_id: input.lineId,
    p_stage: input.stage,
    p_quantity: input.quantity,
    p_code: input.code ?? null,
    p_override_reason: input.overrideReason ?? null,
  });
}

export const shipTransfer = (id: string) => rpc<RpcResult>('ship_stock_transfer', { p_transfer_id: id });
export const completeTransfer = (id: string) => rpc<RpcResult>('complete_stock_transfer', { p_transfer_id: id });
export const cancelTransfer = (id: string, reason?: string) => rpc<RpcResult>('cancel_stock_transfer', { p_transfer_id: id, p_reason: reason ?? null });

const TRANSFER_SELECT =
  '*, from_location:inventory_locations!from_location_id(name), to_location:inventory_locations!to_location_id(name), lines:stock_transfer_lines(*, part:inventory_parts(name, part_number, barcode))';

export async function listTransfers(opts: { statuses?: TransferStatus[]; toLocationId?: string; limit?: number } = {}): Promise<TransferOrder[]> {
  let q = supabase.from('stock_transfer_orders').select(TRANSFER_SELECT).order('created_at', { ascending: false }).limit(opts.limit ?? 60);
  if (opts.statuses?.length) q = q.in('status', opts.statuses);
  if (opts.toLocationId) q = q.eq('to_location_id', opts.toLocationId);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as unknown as TransferOrder[]).map((o) => ({
    ...o,
    lines: [...(o.lines ?? [])].sort((a, b) => (a.part?.name ?? '').localeCompare(b.part?.name ?? '')),
  }));
}

export async function listAlerts(statuses: AlertStatus[] = ['open', 'acknowledged']): Promise<TruckAlert[]> {
  const { data, error } = await supabase.from('truck_stock_alerts').select('*').in('status', statuses).order('last_seen_at', { ascending: false }).limit(300);
  if (error) throw error;
  return sortBySeverity((data ?? []) as TruckAlert[]);
}

export const setAlertStatus = (id: string, status: 'acknowledged' | 'resolved') => rpc<RpcResult>('set_truck_alert_status', { p_alert_id: id, p_status: status });

export async function listVariance(statuses: VarianceStatus[] = ['open', 'acknowledged']): Promise<VarianceEvent[]> {
  const { data, error } = await supabase
    .from('inventory_variance_events')
    .select('*, location:inventory_locations(name), part:inventory_parts(name)')
    .in('status', statuses)
    .order('detected_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  return sortBySeverity((data ?? []) as unknown as VarianceEvent[]);
}

export const setVarianceStatus = (id: string, status: 'acknowledged' | 'resolved' | 'dismissed', note?: string) =>
  rpc<RpcResult>('set_variance_event_status', { p_event_id: id, p_status: status, p_note: note ?? null });

export async function getVarianceSummary(days = 30): Promise<VarianceSummaryRow[]> {
  const rows = await rpc<VarianceSummaryRow[] | null>('truck_variance_summary', { p_days: days });
  return (rows ?? []).map((r) => ({
    ...r,
    usage_value_cents: Number(r.usage_value_cents),
    shrink_value_cents: Number(r.shrink_value_cents),
    shrink_rate_pct: Number(r.shrink_rate_pct),
    last_accuracy_pct: r.last_accuracy_pct === null ? null : Number(r.last_accuracy_pct),
  }));
}

export async function listVanAudits(): Promise<VanAuditRow[]> {
  const { data, error } = await supabase.from('van_audit_status').select('*').order('location_name');
  if (error) throw error;
  return (data ?? []) as VanAuditRow[];
}

export const startVanAudit = (locationId?: string) => rpc<RpcResult>('start_van_audit', { p_location_id: locationId ?? null });
export const runTruckOpsScan = () => rpc<RpcResult>('run_my_truck_ops_scan');
export const getMyVan = () => rpc<MyVan>('get_my_van');

export async function listLocations(): Promise<{ id: string; name: string; location_type: string }[]> {
  const { data, error } = await supabase.from('inventory_locations').select('id, name, location_type').eq('active', true).order('name');
  if (error) throw error;
  return (data ?? []) as { id: string; name: string; location_type: string }[];
}

export async function getSettings(): Promise<TruckOpsSettings> {
  const { data, error } = await supabase.from('truck_ops_settings').select('*').maybeSingle();
  if (error) throw error;
  if (!data) return { ...DEFAULT_TRUCK_OPS_SETTINGS };
  const d = data as Record<string, unknown>;
  return {
    forecast_horizon_days: Number(d.forecast_horizon_days),
    history_days: Number(d.history_days),
    safety_factor: Number(d.safety_factor),
    audit_interval_days: Number(d.audit_interval_days),
    shrink_alert_pct: Number(d.shrink_alert_pct),
    shrink_min_value_cents: Number(d.shrink_min_value_cents),
    low_stock_alerts_enabled: Boolean(d.low_stock_alerts_enabled),
    alert_cooldown_hours: Number(d.alert_cooldown_hours),
    require_scan: Boolean(d.require_scan),
  };
}

/** `ownerId` is the ACCOUNT OWNER id (profile id for owners, team_members.account_owner_id for staff). */
export async function saveSettings(ownerId: string, s: TruckOpsSettings): Promise<void> {
  const errors = validateSettings(s);
  if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
  const { error } = await supabase.from('truck_ops_settings').upsert({ user_id: ownerId, ...s }, { onConflict: 'user_id' });
  if (error) throw error;
}
