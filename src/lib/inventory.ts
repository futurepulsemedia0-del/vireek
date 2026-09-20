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
  barcode: string | null;
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
// ============================================================
// TYPES — vendor catalog, purchase orders, substitutes, serials,
// reservations, returns, bins, forecast. Mirrors
// 20261013000000_parts_inventory_expansion.sql.
// ============================================================

export type PurchaseOrderStatus = 'draft' | 'submitted' | 'partial' | 'received' | 'cancelled';
export type SerialStatus = 'in_stock' | 'reserved' | 'installed' | 'returned' | 'scrapped';
export type ReservationStatus = 'active' | 'released' | 'fulfilled';
export type ReturnType = 'customer_return' | 'core_return';
export type ReturnStatus = 'pending' | 'received' | 'credited' | 'rejected';
export type DemandTrend = 'rising' | 'falling' | 'flat';

export interface InventoryBinLocation {
  id: string;
  user_id: string;
  location_id: string;
  code: string;
  description: string | null;
  created_at: string;
}

export interface InventoryVendor {
  id: string;
  user_id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  default_lead_time_days: number;
  notes: string | null;
  active: boolean;
  created_at: string;
}

export interface PartVendorCatalogEntry {
  id: string;
  user_id: string;
  part_id: string;
  vendor_id: string;
  vendor_sku: string | null;
  unit_cost_cents: number;
  lead_time_days: number | null;
  is_preferred: boolean;
  created_at: string;
}

export interface InventoryPurchaseOrder {
  id: string;
  user_id: string;
  vendor_id: string;
  po_number: string | null;
  status: PurchaseOrderStatus;
  destination_location_id: string | null;
  expected_date: string | null;
  submitted_at: string | null;
  received_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryPurchaseOrderLine {
  id: string;
  user_id: string;
  purchase_order_id: string;
  part_id: string;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost_cents: number;
  created_at: string;
}

/** Mirrors the `purchase_order_summary` SQL view. */
export interface PurchaseOrderSummaryRow {
  purchase_order_id: string;
  user_id: string;
  po_number: string | null;
  status: PurchaseOrderStatus;
  vendor_id: string;
  vendor_name: string;
  destination_location_id: string | null;
  destination_location_name: string | null;
  expected_date: string | null;
  submitted_at: string | null;
  received_at: string | null;
  line_count: number;
  total_quantity_ordered: number;
  total_quantity_received: number;
  total_cost_cents: number;
  percent_received: number;
}

export interface PartSubstitute {
  id: string;
  user_id: string;
  part_id: string;
  substitute_part_id: string;
  note: string | null;
  created_at: string;
}

export interface InventorySerial {
  id: string;
  user_id: string;
  part_id: string;
  serial_number: string | null;
  lot_number: string | null;
  location_id: string | null;
  status: SerialStatus;
  job_id: string | null;
  received_at: string;
  installed_at: string | null;
  created_at: string;
}

export interface InventoryReservation {
  id: string;
  user_id: string;
  part_id: string;
  location_id: string;
  job_id: string | null;
  quantity: number;
  status: ReservationStatus;
  created_at: string;
  released_at: string | null;
}

export interface InventoryReturn {
  id: string;
  user_id: string;
  return_type: ReturnType;
  part_id: string;
  job_id: string | null;
  location_id: string;
  vendor_id: string | null;
  quantity: number;
  reason: string | null;
  core_credit_cents: number | null;
  status: ReturnStatus;
  created_at: string;
  resolved_at: string | null;
}

/** Mirrors the `inventory_forecast` SQL view. */
export interface InventoryForecastRow {
  user_id: string;
  part_id: string;
  part_name: string;
  part_number: string | null;
  location_id: string;
  location_name: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  quantity_available: number;
  avg_daily_usage_30d: number;
  avg_daily_usage_90d: number;
  demand_trend: DemandTrend;
  estimated_days_of_stock: number | null;
  suggested_par_level: number;
}

/** Mirrors the `open_core_returns` SQL view. */
export interface OpenCoreReturnRow {
  return_id: string;
  user_id: string;
  part_id: string;
  part_name: string;
  part_number: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  job_id: string | null;
  quantity: number;
  core_credit_cents: number | null;
  total_expected_credit_cents: number;
  status: ReturnStatus;
  created_at: string;
}

// ============================================================
// DISPLAY LABELS
// ============================================================

export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  partial: 'Partially received',
  received: 'Received',
  cancelled: 'Cancelled',
};

export const SERIAL_STATUS_LABELS: Record<SerialStatus, string> = {
  in_stock: 'In stock',
  reserved: 'Reserved',
  installed: 'Installed',
  returned: 'Returned',
  scrapped: 'Scrapped',
};

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  active: 'Active',
  released: 'Released',
  fulfilled: 'Fulfilled',
};

export const RETURN_TYPE_LABELS: Record<ReturnType, string> = {
  customer_return: 'Customer return',
  core_return: 'Core return',
};

export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  pending: 'Pending',
  received: 'Received',
  credited: 'Credited',
  rejected: 'Rejected',
};

export const DEMAND_TREND_LABELS: Record<DemandTrend, string> = {
  rising: 'Rising',
  falling: 'Falling',
  flat: 'Steady',
};

// ============================================================
// QUERIES — bins, vendors, vendor catalog
// ============================================================

export async function listBinLocations(locationId?: string): Promise<InventoryBinLocation[]> {
  let query = supabase.from('inventory_bin_locations').select('*').order('code');
  if (locationId) query = query.eq('location_id', locationId);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function upsertBinLocation(
  bin: Partial<InventoryBinLocation> & { location_id: string; code: string },
): Promise<InventoryBinLocation> {
  const { data, error } = await supabase.from('inventory_bin_locations').upsert(bin).select().single();
  if (error) throw error;
  return data;
}

export async function listInventoryVendors(activeOnly = true): Promise<InventoryVendor[]> {
  let query = supabase.from('inventory_vendors').select('*').order('name');
  if (activeOnly) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function upsertInventoryVendor(
  vendor: Partial<InventoryVendor> & { name: string },
): Promise<InventoryVendor> {
  const { data, error } = await supabase.from('inventory_vendors').upsert(vendor).select().single();
  if (error) throw error;
  return data;
}

export async function listPartVendorCatalog(partId?: string): Promise<PartVendorCatalogEntry[]> {
  let query = supabase.from('inventory_part_vendors').select('*').order('is_preferred', { ascending: false });
  if (partId) query = query.eq('part_id', partId);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function upsertPartVendorCatalogEntry(
  entry: Partial<PartVendorCatalogEntry> & { part_id: string; vendor_id: string },
): Promise<PartVendorCatalogEntry> {
  const { data, error } = await supabase
    .from('inventory_part_vendors')
    .upsert(entry, { onConflict: 'part_id,vendor_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Barcode/QR scan lookup — resolves a scanned code to a part. */
export async function findPartByBarcode(barcode: string): Promise<InventoryPart | null> {
  const { data, error } = await supabase
    .from('inventory_parts')
    .select('*')
    .eq('barcode', barcode)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ============================================================
// QUERIES — purchase orders
// ============================================================

export async function listPurchaseOrders(status?: PurchaseOrderStatus): Promise<PurchaseOrderSummaryRow[]> {
  let query = supabase.from('purchase_order_summary').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function getPurchaseOrderLines(purchaseOrderId: string): Promise<InventoryPurchaseOrderLine[]> {
  const { data, error } = await supabase
    .from('inventory_purchase_order_lines')
    .select('*')
    .eq('purchase_order_id', purchaseOrderId)
    .order('created_at');
  if (error) throw error;
  return data ?? [];
}

export async function createPurchaseOrder(
  po: Partial<InventoryPurchaseOrder> & { vendor_id: string },
): Promise<InventoryPurchaseOrder> {
  const { data, error } = await supabase.from('inventory_purchase_orders').insert(po).select().single();
  if (error) throw error;
  return data;
}

export async function addPurchaseOrderLine(
  line: Pick<InventoryPurchaseOrderLine, 'purchase_order_id' | 'part_id' | 'quantity_ordered' | 'unit_cost_cents'>,
): Promise<InventoryPurchaseOrderLine> {
  const { data, error } = await supabase.from('inventory_purchase_order_lines').insert(line).select().single();
  if (error) throw error;
  return data;
}

export async function submitPurchaseOrder(purchaseOrderId: string): Promise<void> {
  const { error } = await supabase
    .from('inventory_purchase_orders')
    .update({ status: 'submitted', submitted_at: new Date().toISOString() })
    .eq('id', purchaseOrderId)
    .eq('status', 'draft');
  if (error) throw error;
}

export async function cancelPurchaseOrder(purchaseOrderId: string): Promise<void> {
  const { error } = await supabase
    .from('inventory_purchase_orders')
    .update({ status: 'cancelled' })
    .eq('id', purchaseOrderId);
  if (error) throw error;
}

/** Logs the receipt (stock ledger entry) and advances the line's quantity_received — atomic RPC. */
export async function receivePurchaseOrderLine(params: {
  lineId: string;
  quantity: number;
  locationId: string;
  binLocationId?: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc('receive_purchase_order_line', {
    p_line_id: params.lineId,
    p_quantity: params.quantity,
    p_location_id: params.locationId,
    p_bin_location_id: params.binLocationId ?? null,
  });
  if (error) throw error;
}

// ============================================================
// QUERIES — substitutes
// ============================================================

export async function listPartSubstitutes(partId: string): Promise<PartSubstitute[]> {
  const { data, error } = await supabase
    .from('inventory_part_substitutes')
    .select('*')
    .eq('part_id', partId);
  if (error) throw error;
  return data ?? [];
}

export async function addPartSubstitute(
  partId: string,
  substitutePartId: string,
  note?: string,
): Promise<PartSubstitute> {
  const { data, error } = await supabase
    .from('inventory_part_substitutes')
    .insert({ part_id: partId, substitute_part_id: substitutePartId, note: note ?? null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function removePartSubstitute(id: string): Promise<void> {
  const { error } = await supabase.from('inventory_part_substitutes').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// QUERIES — serials / lots
// ============================================================

export async function listInventorySerials(params: {
  partId?: string;
  locationId?: string;
  status?: SerialStatus;
} = {}): Promise<InventorySerial[]> {
  let query = supabase.from('inventory_serials').select('*').order('received_at', { ascending: false });
  if (params.partId) query = query.eq('part_id', params.partId);
  if (params.locationId) query = query.eq('location_id', params.locationId);
  if (params.status) query = query.eq('status', params.status);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function registerInventorySerial(
  serial: Pick<InventorySerial, 'part_id'> &
    Partial<Pick<InventorySerial, 'serial_number' | 'lot_number' | 'location_id'>>,
): Promise<InventorySerial> {
  const { data, error } = await supabase.from('inventory_serials').insert(serial).select().single();
  if (error) throw error;
  return data;
}

export async function updateSerialStatus(
  id: string,
  status: SerialStatus,
  jobId?: string | null,
): Promise<InventorySerial> {
  const patch: Partial<InventorySerial> = { status };
  if (jobId !== undefined) patch.job_id = jobId;
  if (status === 'installed') patch.installed_at = new Date().toISOString();
  const { data, error } = await supabase.from('inventory_serials').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// ============================================================
// QUERIES — reservations
// ============================================================

export async function listInventoryReservations(params: {
  partId?: string;
  jobId?: string;
  status?: ReservationStatus;
} = {}): Promise<InventoryReservation[]> {
  let query = supabase.from('inventory_reservations').select('*').order('created_at', { ascending: false });
  if (params.partId) query = query.eq('part_id', params.partId);
  if (params.jobId) query = query.eq('job_id', params.jobId);
  if (params.status) query = query.eq('status', params.status);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function createInventoryReservation(
  reservation: Pick<InventoryReservation, 'part_id' | 'location_id' | 'quantity'> &
    Partial<Pick<InventoryReservation, 'job_id'>>,
): Promise<InventoryReservation> {
  const { data, error } = await supabase.from('inventory_reservations').insert(reservation).select().single();
  if (error) throw error;
  return data;
}

export async function releaseInventoryReservation(id: string): Promise<void> {
  const { error } = await supabase
    .from('inventory_reservations')
    .update({ status: 'released', released_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/** Marks a reservation fulfilled and logs the matching usage transaction in one call. */
export async function fulfillInventoryReservation(
  reservation: InventoryReservation,
  jobId: string,
): Promise<void> {
  const { error: resError } = await supabase
    .from('inventory_reservations')
    .update({ status: 'fulfilled' })
    .eq('id', reservation.id);
  if (resError) throw resError;
  await recordPartUsage({
    partId: reservation.part_id,
    locationId: reservation.location_id,
    jobId,
    quantity: reservation.quantity,
  });
}

// ============================================================
// QUERIES — returns (customer + core)
// ============================================================

export async function listInventoryReturns(status?: ReturnStatus): Promise<InventoryReturn[]> {
  let query = supabase.from('inventory_returns').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function listOpenCoreReturns(): Promise<OpenCoreReturnRow[]> {
  const { data, error } = await supabase
    .from('open_core_returns')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function createInventoryReturn(
  ret: Pick<InventoryReturn, 'return_type' | 'part_id' | 'location_id' | 'quantity'> &
    Partial<Pick<InventoryReturn, 'job_id' | 'vendor_id' | 'reason' | 'core_credit_cents'>>,
): Promise<InventoryReturn> {
  const { data, error } = await supabase.from('inventory_returns').insert(ret).select().single();
  if (error) throw error;
  return data;
}

/** Marks a return received/credited/rejected — and, when received, logs the stock-back-in ledger entry. */
export async function resolveInventoryReturn(
  ret: InventoryReturn,
  status: Extract<ReturnStatus, 'received' | 'credited' | 'rejected'>,
): Promise<void> {
  const { error } = await supabase
    .from('inventory_returns')
    .update({ status, resolved_at: new Date().toISOString() })
    .eq('id', ret.id);
  if (error) throw error;

  if (status === 'received' && ret.return_type === 'customer_return') {
    await recordInventoryTransaction({
      part_id: ret.part_id,
      location_id: ret.location_id,
      job_id: ret.job_id ?? null,
      transaction_type: 'return',
      quantity_delta: Math.abs(ret.quantity),
      note: `Customer return: ${ret.reason ?? 'no reason given'}`,
    });
  }
}

// ============================================================
// QUERIES — forecasting & transfers
// ============================================================

export async function listInventoryForecast(locationId?: string): Promise<InventoryForecastRow[]> {
  let query = supabase.from('inventory_forecast').select('*').order('estimated_days_of_stock', { ascending: true, nullsFirst: false });
  if (locationId) query = query.eq('location_id', locationId);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/** Atomic stock transfer between two locations (transfer_out + transfer_in as one ledger event). */
export async function transferInventoryStock(params: {
  partId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  note?: string;
  binLocationId?: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc('transfer_inventory_stock', {
    p_part_id: params.partId,
    p_from_location_id: params.fromLocationId,
    p_to_location_id: params.toLocationId,
    p_quantity: params.quantity,
    p_note: params.note ?? null,
    p_bin_location_id: params.binLocationId ?? null,
  });
  if (error) throw error;
}
