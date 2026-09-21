import { supabase } from './supabase';
import type { InventoryLocation, InventoryPart } from './inventory';

export { formatCents } from './inventory';

// ============================================================
// TYPES — mirror 20261110000000_truck_stock_replenishment.sql
// ============================================================

export type SourcingStatus = 'on_truck' | 'warehouse_transfer' | 'other_truck' | 'awaiting_delivery' | 'order_required';
export type DispatchReadiness = 'ready' | 'needs_restock' | 'awaiting_delivery' | 'blocked';
export type TruckStockStatus = 'ok' | 'low' | 'empty';
export type PurchaseOrderStatus = 'draft' | 'pending_approval' | 'sent' | 'partially_received' | 'received' | 'cancelled';
export type TaskStatus = 'open' | 'completed' | 'cancelled';
export type TaskReason = 'par_level' | 'job_shortage' | 'manual';

export type PartWithVendor = InventoryPart & { preferred_vendor_id?: string | null };

export interface Vendor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  lead_time_days: number;
  notes: string | null;
  active: boolean;
}

export interface ParLevel {
  id: string;
  part_id: string;
  location_id: string;
  min_quantity: number;
  target_quantity: number;
}

export interface TruckStockRow {
  par_level_id: string;
  location_id: string;
  location_name: string;
  assigned_technician_id: string | null;
  part_id: string;
  part_name: string;
  part_number: string | null;
  quantity_available: number;
  min_quantity: number;
  target_quantity: number;
  refill_quantity: number;
  status: TruckStockStatus;
}

export interface JobPartSourcing {
  requirement_id: string;
  job_id: string;
  customer_name: string;
  service_type: string | null;
  scheduled_datetime: string | null;
  assigned_technician_id: string | null;
  part_id: string;
  part_name: string;
  part_number: string | null;
  quantity_required: number;
  van_qty: number;
  warehouse_qty: number;
  other_van_qty: number;
  on_order_qty: number;
  sourcing_status: SourcingStatus;
  stock_shortfall: number;
  order_shortfall: number;
}

export interface JobDispatchReadiness {
  job_id: string;
  customer_name: string;
  service_type: string | null;
  scheduled_datetime: string | null;
  assigned_technician_id: string | null;
  parts_required_count: number;
  parts_on_truck_count: number;
  overall_status: DispatchReadiness;
}

export interface StockFitRow {
  job_id: string;
  technician_id: string;
  parts_required: number;
  parts_on_van: number;
}

export interface ReplenishmentTask {
  id: string;
  part_id: string;
  from_location_id: string;
  to_location_id: string;
  quantity: number;
  status: TaskStatus;
  reason: TaskReason;
  job_id: string | null;
  created_at: string;
}

export interface PurchaseOrderLine {
  id: string;
  purchase_order_id: string;
  part_id: string;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost_cents: number;
}

export interface PurchaseOrder {
  id: string;
  po_number: string;
  vendor_id: string | null;
  vendor_name: string | null;
  status: PurchaseOrderStatus;
  source: 'auto' | 'manual';
  destination_location_id: string | null;
  total_cents: number;
  expected_at: string | null;
  sent_at: string | null;
  notes: string | null;
  created_at: string;
  lines: PurchaseOrderLine[];
}

export interface ServiceKitItem {
  id: string;
  service_type: string;
  part_id: string;
  quantity: number;
}

export interface ReplenishmentSettings {
  auto_replenish_enabled: boolean;
  auto_deduct_on_completion: boolean;
  po_approval_threshold_cents: number;
  lookahead_days: number;
}

export const DEFAULT_SETTINGS: ReplenishmentSettings = {
  auto_replenish_enabled: false,
  auto_deduct_on_completion: false,
  po_approval_threshold_cents: 50000,
  lookahead_days: 7,
};

export interface RunResult {
  status: string;
  tasks_created?: number;
  pos_created?: number;
  po_lines?: number;
}

// ============================================================
// DISPLAY HELPERS
// ============================================================

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

export const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-success-500/10 text-success-500',
  warning: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger/10 text-danger',
  neutral: 'bg-bg-tertiary text-text-secondary',
  accent: 'bg-accent/10 text-accent',
};

export const SOURCING_META: Record<SourcingStatus, { label: string; tone: Tone }> = {
  on_truck: { label: 'On truck', tone: 'success' },
  warehouse_transfer: { label: 'In warehouse', tone: 'warning' },
  other_truck: { label: 'On another truck', tone: 'warning' },
  awaiting_delivery: { label: 'On order', tone: 'accent' },
  order_required: { label: 'Must order', tone: 'danger' },
};

export const READINESS_META: Record<DispatchReadiness, { label: string; tone: Tone }> = {
  ready: { label: 'Ready to dispatch', tone: 'success' },
  needs_restock: { label: 'Needs truck restock', tone: 'warning' },
  awaiting_delivery: { label: 'Awaiting delivery', tone: 'accent' },
  blocked: { label: 'Parts unavailable', tone: 'danger' },
};

export const TRUCK_STATUS_META: Record<TruckStockStatus, { label: string; tone: Tone }> = {
  ok: { label: 'Stocked', tone: 'success' },
  low: { label: 'Low', tone: 'warning' },
  empty: { label: 'Empty', tone: 'danger' },
};

export const PO_STATUS_META: Record<PurchaseOrderStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  pending_approval: { label: 'Needs approval', tone: 'warning' },
  sent: { label: 'Sent', tone: 'accent' },
  partially_received: { label: 'Partly received', tone: 'accent' },
  received: { label: 'Received', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const TASK_REASON_LABELS: Record<TaskReason, string> = {
  par_level: 'Below truck minimum',
  job_shortage: 'Needed for upcoming job',
  manual: 'Manual',
};

export type ActionKind = 'none' | 'restock' | 'reassign' | 'wait' | 'order';

/** What a dispatcher should do about one required part — the "before dispatch" answer. */
export function recommendedAction(row: JobPartSourcing): { kind: ActionKind; label: string } {
  switch (row.sourcing_status) {
    case 'on_truck':
      return { kind: 'none', label: 'On the assigned truck' };
    case 'warehouse_transfer':
      return { kind: 'restock', label: `Load ${Math.max(row.quantity_required - row.van_qty, 1)} from warehouse before dispatch` };
    case 'other_truck':
      return { kind: 'reassign', label: 'Another truck has it — reassign the job or transfer the part' };
    case 'awaiting_delivery':
      return { kind: 'wait', label: `${row.on_order_qty} on order — hold dispatch until it arrives` };
    default:
      return { kind: 'order', label: `Order ${Math.max(row.order_shortfall, 1)} now` };
  }
}

/** job_id -> technician_id -> fit. */
export function buildStockFitMap(rows: StockFitRow[]): Record<string, Record<string, StockFitRow>> {
  const map: Record<string, Record<string, StockFitRow>> = {};
  for (const r of rows) {
    (map[r.job_id] ??= {})[r.technician_id] = r;
  }
  return map;
}

/** Score bonus for dispatch ranking: full kit on the van beats skill/capacity ties. */
export function stockFitBonus(fit: StockFitRow | undefined): number {
  if (!fit || fit.parts_required <= 0) return 0;
  if (fit.parts_on_van >= fit.parts_required) return 12;
  return Math.round((fit.parts_on_van / fit.parts_required) * 6);
}

export function stockFitReason(fit: StockFitRow | undefined): string | null {
  if (!fit || fit.parts_required <= 0) return null;
  return fit.parts_on_van >= fit.parts_required
    ? `Van has all ${fit.parts_required} required part(s)`
    : `Van has ${fit.parts_on_van}/${fit.parts_required} required parts`;
}

export function buildPoMailto(
  po: PurchaseOrder,
  partsById: Record<string, InventoryPart>,
  vendorEmail?: string | null,
): string {
  const lines = po.lines.map((l) => {
    const p = partsById[l.part_id];
    const label = [p?.part_number, p?.name].filter(Boolean).join(' — ') || 'Part';
    return `${l.quantity_ordered} x ${label}`;
  });
  const body = `Hello,\n\nPlease confirm availability and delivery date for purchase order ${po.po_number}:\n\n${lines.join('\n')}\n\nThank you.`;
  return `mailto:${vendorEmail ?? ''}?subject=${encodeURIComponent(`Purchase Order ${po.po_number}`)}&body=${encodeURIComponent(body)}`;
}

const RPC_MESSAGES: Record<string, string> = {
  forbidden: 'You do not have permission to do this.',
  not_found: 'That record no longer exists.',
  not_open: 'This restock was already handled.',
  not_receivable: 'Only sent purchase orders can be received.',
  no_destination: 'Add a warehouse location first.',
  nothing_received: 'Nothing left to receive on this order.',
  invalid_quantity: 'Quantity is not valid.',
  insufficient_stock: 'The warehouse does not have enough stock to complete this restock.',
};

export function describeRpcStatus(status: string): string {
  return RPC_MESSAGES[status] ?? 'Something went wrong.';
}

// ============================================================
// QUERIES
// ============================================================

export async function listParts(): Promise<PartWithVendor[]> {
  const { data, error } = await supabase.from('inventory_parts').select('*').eq('active', true).order('name');
  if (error) throw error;
  return (data ?? []) as PartWithVendor[];
}

export async function createPart(input: {
  name: string;
  part_number: string | null;
  unit_cost_cents: number;
  reorder_point: number;
  reorder_quantity: number;
  preferred_vendor_id: string | null;
}): Promise<void> {
  const { error } = await supabase.from('inventory_parts').insert(input);
  if (error) throw error;
}

export async function listVendors(): Promise<Vendor[]> {
  const { data, error } = await supabase.from('inventory_vendors').select('*').eq('active', true).order('name');
  if (error) throw error;
  return (data ?? []) as Vendor[];
}

export async function upsertVendor(v: Partial<Vendor> & { name: string }): Promise<void> {
  const { error } = await supabase.from('inventory_vendors').upsert(v);
  if (error) throw error;
}

export async function listTruckStock(): Promise<TruckStockRow[]> {
  const { data, error } = await supabase
    .from('truck_stock_status')
    .select('*')
    .order('location_name')
    .order('part_name');
  if (error) throw error;
  return (data ?? []) as TruckStockRow[];
}

export async function listJobDispatchReadiness(): Promise<JobDispatchReadiness[]> {
  const { data, error } = await supabase
    .from('job_dispatch_readiness')
    .select('*')
    .order('scheduled_datetime', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as JobDispatchReadiness[];
}

export async function listJobSourcing(): Promise<JobPartSourcing[]> {
  const { data, error } = await supabase.from('job_parts_sourcing').select('*').order('part_name');
  if (error) throw error;
  return (data ?? []) as JobPartSourcing[];
}

/** Non-throwing: dispatch must keep working even if stock data is unavailable. */
export async function fetchStockFit(jobIds: string[]): Promise<StockFitRow[]> {
  if (jobIds.length === 0) return [];
  const { data, error } = await supabase.rpc('dispatch_stock_fit', { p_job_ids: jobIds });
  if (error) return [];
  return (data ?? []) as StockFitRow[];
}

export async function listReplenishmentTasks(): Promise<ReplenishmentTask[]> {
  const { data, error } = await supabase
    .from('replenishment_tasks')
    .select('*')
    .eq('status', 'open')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ReplenishmentTask[];
}

export async function listPurchaseOrders(limit = 100): Promise<PurchaseOrder[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*, lines:purchase_order_lines(*)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as PurchaseOrder[];
}

export async function getReplenishmentSettings(): Promise<ReplenishmentSettings> {
  const { data, error } = await supabase.from('replenishment_settings').select('*').maybeSingle();
  if (error) throw error;
  return data ? { ...DEFAULT_SETTINGS, ...(data as Partial<ReplenishmentSettings>) } : DEFAULT_SETTINGS;
}

export async function saveReplenishmentSettings(next: ReplenishmentSettings): Promise<void> {
  const { error } = await supabase.from('replenishment_settings').upsert(next, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function listParLevels(): Promise<ParLevel[]> {
  const { data, error } = await supabase.from('inventory_par_levels').select('*');
  if (error) throw error;
  return (data ?? []) as ParLevel[];
}

export async function upsertParLevel(p: Omit<ParLevel, 'id'>): Promise<void> {
  const { error } = await supabase.from('inventory_par_levels').upsert(p, { onConflict: 'part_id,location_id' });
  if (error) throw error;
}

export async function deleteParLevel(id: string): Promise<void> {
  const { error } = await supabase.from('inventory_par_levels').delete().eq('id', id);
  if (error) throw error;
}

export async function listServiceKits(): Promise<ServiceKitItem[]> {
  const { data, error } = await supabase.from('service_part_kits').select('*').order('service_type');
  if (error) throw error;
  return (data ?? []) as ServiceKitItem[];
}

export async function upsertServiceKitItem(k: Omit<ServiceKitItem, 'id'>): Promise<void> {
  const { error } = await supabase
    .from('service_part_kits')
    .upsert({ ...k, service_type: k.service_type.trim() }, { onConflict: 'user_id,service_type,part_id' });
  if (error) throw error;
}

export async function deleteServiceKitItem(id: string): Promise<void> {
  const { error } = await supabase.from('service_part_kits').delete().eq('id', id);
  if (error) throw error;
}

export async function createLocation(input: {
  name: string;
  location_type: InventoryLocation['location_type'];
  assigned_technician_id: string | null;
}): Promise<void> {
  const { error } = await supabase.from('inventory_locations').insert(input);
  if (error) throw error;
}

/** Set which required parts a job needs (dispatcher / technician). */
export async function addJobRequirement(jobId: string, partId: string, quantity: number): Promise<void> {
  const { error } = await supabase
    .from('job_parts_required')
    .upsert({ job_id: jobId, part_id: partId, quantity_required: quantity }, { onConflict: 'job_id,part_id' });
  if (error) throw error;
}

// ============================================================
// ACTIONS
// ============================================================

export async function runReplenishment(): Promise<RunResult> {
  const { data, error } = await supabase.rpc('run_my_replenishment');
  if (error) throw error;
  return data as RunResult;
}

export async function completeReplenishmentTask(taskId: string, quantity?: number): Promise<RunResult> {
  const { data, error } = await supabase.rpc('complete_replenishment_task', {
    p_task_id: taskId,
    p_quantity: quantity ?? null,
  });
  if (error) throw error;
  return data as RunResult;
}

export async function cancelReplenishmentTask(taskId: string): Promise<void> {
  const { error } = await supabase.from('replenishment_tasks').update({ status: 'cancelled' }).eq('id', taskId).eq('status', 'open');
  if (error) throw error;
}

export async function createPurchaseOrder(
  vendorId: string | null,
  lines: { part_id: string; quantity: number }[],
  notes?: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('create_purchase_order', {
    p_vendor_id: vendorId,
    p_lines: lines,
    p_notes: notes ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function setPurchaseOrderStatus(id: string, status: 'sent' | 'cancelled'): Promise<void> {
  const patch = status === 'sent' ? { status, sent_at: new Date().toISOString() } : { status };
  const { error } = await supabase
    .from('purchase_orders')
    .update(patch)
    .eq('id', id)
    .in('status', status === 'sent' ? ['draft', 'pending_approval'] : ['draft', 'pending_approval', 'sent']);
  if (error) throw error;
}

export async function receivePurchaseOrder(id: string): Promise<RunResult> {
  const { data, error } = await supabase.rpc('receive_purchase_order', { p_po_id: id, p_lines: null });
  if (error) throw error;
  return data as RunResult;
}
