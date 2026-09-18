import { supabase } from './supabase';
import { formatCents } from './priceBook';

// ============================================================
// TYPES — mirror the parts_inventory_availability migration.
// ============================================================

export type LocationType = 'warehouse' | 'van' | 'jobsite' | 'other';
export type TransactionType = 'receipt' | 'usage' | 'transfer_in' | 'transfer_out' | 'adjustment' | 'return';
export type PartRequirementStatus = 'needed' | 'allocated' | 'installed' | 'backordered';
export type StockoutRisk = 'critical' | 'low' | 'ok';
export type ReadinessStatus = 'ready' | 'short' | 'no_location';
export type JobOverallReadiness = 'ready' | 'at_risk';

export interface InventoryLocation {
  id: string;
  user_id: string;
  name: string;
  location_type: LocationType;
  assigned_technician_id: string | null;
  active: boolean;
  created_at: string;
}

export interface InventoryPart {
  id: string;
  user_id: string;
  part_number: string | null;
  name: string;
  category: string | null;
  unit_label: string | null;
  unit_cost_cents: number;
  reorder_point: number;
  reorder_quantity: number;
  preferred_vendor: string | null;
  price_book_item_id: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface InventoryTransaction {
  id: string;
  user_id: string;
  part_id: string;
  location_id: string;
  job_id: string | null;
  transaction_type: TransactionType;
  quantity_delta: number;
  unit_cost_cents: number | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface JobPartRequirement {
  id: string;
  user_id: string;
  job_id: string;
  part_id: string;
  quantity_required: number;
  status: PartRequirementStatus;
  created_at: string;
  updated_at: string;
}

/** Mirrors the `parts_availability` SQL view. */
export interface PartsAvailabilityRow {
  stock_level_id: string;
  user_id: string;
  part_id: string;
  part_name: string;
  part_number: string | null;
  category: string | null;
  reorder_point: number;
  reorder_quantity: number;
  unit_cost_cents: number;
  location_id: string;
  location_name: string;
  location_type: LocationType;
  quantity_on_hand: number;
  quantity_reserved: number;
  quantity_available: number;
  avg_daily_usage_30d: number;
  estimated_days_of_stock: number | null;
  stockout_risk: StockoutRisk;
}

/** Mirrors the `low_stock_alerts` SQL view. */
export interface LowStockAlert {
  user_id: string;
  part_id: string;
  part_name: string;
  part_number: string | null;
  category: string | null;
  location_id: string;
  location_name: string;
  quantity_available: number;
  reorder_point: number;
  estimated_days_of_stock: number | null;
  stockout_risk: StockoutRisk;
  suggested_reorder_quantity: number;
  estimated_reorder_cost_cents: number;
}

/** Mirrors the `job_parts_readiness` SQL view. */
export interface JobPartReadiness {
  requirement_id: string;
  user_id: string;
  job_id: string;
  customer_name: string;
  scheduled_datetime: string | null;
  assigned_technician_id: string | null;
  part_id: string;
  part_name: string;
  quantity_required: number;
  status: PartRequirementStatus;
  source_location_id: string | null;
  source_location_name: string | null;
  quantity_available_at_source: number;
  readiness_status: ReadinessStatus;
  shortage_quantity: number;
}

/** Mirrors the `job_readiness_summary` SQL view. */
export interface JobReadinessSummary {
  user_id: string;
  job_id: string;
  customer_name: string;
  scheduled_datetime: string | null;
  assigned_technician_id: string | null;
  parts_required_count: number;
  parts_ready_count: number;
  parts_short_count: number;
  overall_status: JobOverallReadiness;
}

// ============================================================
// DISPLAY LABELS / COLORS — same convention as jobCosting.ts
// ============================================================

export const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  warehouse: 'Warehouse',
  van: 'Technician Van',
  jobsite: 'Job Site',
  other: 'Other',
};

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  receipt: 'Received',
  usage: 'Used on job',
  transfer_in: 'Transferred in',
  transfer_out: 'Transferred out',
  adjustment: 'Adjustment',
  return: 'Returned',
};

export const STOCKOUT_RISK_LABELS: Record<StockoutRisk, string> = {
  critical: 'Out of stock',
  low: 'Low stock',
  ok: 'In stock',
};

export const STOCKOUT_RISK_COLORS: Record<StockoutRisk, string> = {
  critical: '#ef4444',
  low: '#f59e0b',
  ok: '#10b981',
};

export const READINESS_STATUS_LABELS: Record<ReadinessStatus, string> = {
  ready: 'Ready',
  short: 'Short on stock',
  no_location: 'No stock location',
};

export { formatCents };

// ============================================================
// QUERIES — parts catalog & locations
// ============================================================

export async function listInventoryParts(activeOnly = true): Promise<InventoryPart[]> {
  let query = supabase.from('inventory_parts').select('*').order('name');
  if (activeOnly) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function listInventoryLocations(activeOnly = true): Promise<InventoryLocation[]> {
  let query = supabase.from('inventory_locations').select('*').order('name');
  if (activeOnly) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function upsertInventoryPart(
  part: Partial<InventoryPart> & { name: string },
): Promise<InventoryPart> {
  const { data, error } = await supabase
    .from('inventory_parts')
    .upsert(part)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ============================================================
// QUERIES — availability intelligence
// ============================================================

export async function listPartsAvailability(partId?: string): Promise<PartsAvailabilityRow[]> {
  let query = supabase.from('parts_availability').select('*').order('part_name');
  if (partId) query = query.eq('part_id', partId);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function listLowStockAlerts(): Promise<LowStockAlert[]> {
  const { data, error } = await supabase
    .from('low_stock_alerts')
    .select('*')
    .order('stockout_risk', { ascending: true })
    .order('estimated_days_of_stock', { ascending: true, nullsFirst: true });
  if (error) throw error;
  return data ?? [];
}

export async function getJobPartsReadiness(jobId: string): Promise<JobPartReadiness[]> {
  const { data, error } = await supabase
    .from('job_parts_readiness')
    .select('*')
    .eq('job_id', jobId);
  if (error) throw error;
  return data ?? [];
}

/** At-risk (and, optionally, ready) upcoming jobs — for a dispatch-board banner/list. */
export async function listJobReadinessSummary(onlyAtRisk = true): Promise<JobReadinessSummary[]> {
  let query = supabase
    .from('job_readiness_summary')
    .select('*')
    .order('scheduled_datetime', { ascending: true, nullsFirst: false });
  if (onlyAtRisk) query = query.eq('overall_status', 'at_risk');
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

// ============================================================
// MUTATIONS — the ledger (inventory_transactions is append-only;
// never update/delete a row — record a correcting 'adjustment' instead)
// ============================================================

export interface RecordTransactionInput {
  part_id: string;
  location_id: string;
  job_id?: string | null;
  transaction_type: TransactionType;
  /** Positive for receipt/return/transfer_in, negative for usage/transfer_out, either sign for adjustment. */
  quantity_delta: number;
  unit_cost_cents?: number | null;
  note?: string | null;
  created_by?: string | null;
}

export async function recordInventoryTransaction(
  input: RecordTransactionInput,
): Promise<InventoryTransaction> {
  const { data, error } = await supabase
    .from('inventory_transactions')
    .insert(input)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Convenience wrapper: log parts consumed while working a job. */
export async function recordPartUsage(params: {
  partId: string;
  locationId: string;
  jobId: string;
  quantity: number;
  unitCostCents?: number;
  technicianId?: string;
}): Promise<InventoryTransaction> {
  return recordInventoryTransaction({
    part_id: params.partId,
    location_id: params.locationId,
    job_id: params.jobId,
    transaction_type: 'usage',
    quantity_delta: -Math.abs(params.quantity),
    unit_cost_cents: params.unitCostCents ?? null,
    created_by: params.technicianId ?? null,
  });
}

export async function setJobPartRequired(
  jobId: string,
  partId: string,
  quantityRequired: number,
): Promise<JobPartRequirement> {
  const { data, error } = await supabase
    .from('job_parts_required')
    .upsert(
      { job_id: jobId, part_id: partId, quantity_required: quantityRequired },
      { onConflict: 'job_id,part_id' },
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}
