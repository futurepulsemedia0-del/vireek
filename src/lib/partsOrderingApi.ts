/**
 * Job parts ordering — network layer. Pure logic lives in partsOrdering.ts.
 *
 * Reads rely on RLS (account-scoped); every write goes through a SECURITY DEFINER RPC so the
 * database re-validates ownership, roles and quantities (see 20271020000000_job_parts_ordering.sql).
 */
import { supabase } from '@/lib/supabase';
import {
  chunkItems,
  generateFeedKey,
  mergeImportResults,
  type CartLine,
  type CatalogHit,
  type CreateOrdersResult,
  type ImportItem,
  type ImportResult,
  type JobPartOrder,
} from '@/lib/partsOrdering';

function fail(error: { message?: string } | null, fallback: string): never {
  const msg = error?.message && error.message.length < 200 ? error.message : fallback;
  throw new Error(msg);
}

export async function searchSupplierCatalog(query: string, opts: { vendorId?: string | null; inStockOnly?: boolean; limit?: number } = {}): Promise<CatalogHit[]> {
  const { data, error } = await supabase.rpc('search_supplier_catalog', {
    p_query: query,
    p_vendor_id: opts.vendorId ?? null,
    p_in_stock_only: opts.inStockOnly ?? false,
    p_limit: opts.limit ?? 30,
  });
  if (error) fail(error, 'Search failed. Please try again.');
  return (data ?? []) as CatalogHit[];
}

export async function addToCart(args: {
  catalogItemId: string;
  quantity: number;
  jobId?: string | null;
  destinationLocationId?: string | null;
  addRequirement?: boolean;
}): Promise<string> {
  const { data, error } = await supabase.rpc('add_to_parts_cart', {
    p_catalog_item_id: args.catalogItemId,
    p_quantity: args.quantity,
    p_job_id: args.jobId ?? null,
    p_destination_location_id: args.destinationLocationId ?? null,
    p_add_requirement: args.addRequirement ?? false,
  });
  if (error) fail(error, 'Could not add this part.');
  return data as string;
}

export async function setCartQuantity(cartId: string, quantity: number): Promise<number> {
  const { data, error } = await supabase.rpc('set_parts_cart_quantity', { p_cart_id: cartId, p_quantity: quantity });
  if (error) fail(error, 'Could not update the quantity.');
  return data as number;
}

export async function removeFromCart(cartId: string): Promise<void> {
  const { error } = await supabase.rpc('remove_from_parts_cart', { p_cart_id: cartId });
  if (error) fail(error, 'Could not remove this line.');
}

export async function listCart(jobId: string): Promise<CartLine[]> {
  const { data, error } = await supabase
    .from('parts_order_cart')
    .select('id, job_id, destination_location_id, catalog_item_id, quantity, item:supplier_catalog_items(vendor_id, sku, name, unit_cost_cents, stock_status, min_order_qty, pack_size, active, inventory_vendors(name))')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true });
  if (error) fail(error, 'Could not load the order list.');
  return (data ?? []) as unknown as CartLine[];
}

export async function createOrdersFromCart(args: { jobId: string; holdJob: boolean; notes?: string }): Promise<CreateOrdersResult> {
  const { data, error } = await supabase.rpc('create_parts_orders_from_cart', {
    p_cart_ids: null,
    p_job_id: args.jobId,
    p_hold_jobs: args.holdJob,
    p_notes: args.notes?.trim() || null,
  });
  if (error) fail(error, 'Could not create the purchase order.');
  return data as CreateOrdersResult;
}

export async function getJobPartsOrders(jobId: string): Promise<JobPartOrder[]> {
  const { data, error } = await supabase.rpc('get_job_parts_orders', { p_job_id: jobId });
  if (error) fail(error, 'Could not load orders.');
  return (data ?? []) as JobPartOrder[];
}

export async function updateShipment(args: {
  poId: string;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  shipmentStatus?: string;
  expectedAt?: string | null;
}): Promise<void> {
  const { data, error } = await supabase.rpc('update_po_shipment', {
    p_po_id: args.poId,
    p_carrier: args.carrier || null,
    p_tracking_number: args.trackingNumber || null,
    p_tracking_url: args.trackingUrl || null,
    p_shipment_status: args.shipmentStatus || null,
    p_expected_at: args.expectedAt || null,
  });
  if (error) fail(error, 'Could not update delivery details.');
  const res = (data ?? {}) as { status?: string; reason?: string };
  if (res.status !== 'ok') throw new Error(res.reason && res.reason.length < 200 ? res.reason : 'Could not update delivery details.');
}

// ---------------------------------------------------------------- imports --

export async function importSupplierPrices(args: {
  vendorId: string;
  items: ImportItem[];
  fileName?: string;
  dryRun?: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<ImportResult> {
  const chunks = chunkItems(args.items);
  const results: ImportResult[] = [];
  let done = 0;
  for (const chunk of chunks) {
    const { data, error } = await supabase.rpc('import_supplier_prices', {
      p_vendor_id: args.vendorId,
      p_items: chunk,
      p_file_name: args.fileName ?? null,
      p_dry_run: args.dryRun ?? false,
    });
    if (error) fail(error, 'Import failed. Nothing in this batch was saved.');
    results.push(data as ImportResult);
    done += chunk.length;
    args.onProgress?.(done, args.items.length);
  }
  return mergeImportResults(results);
}

export interface ImportRun {
  id: string;
  vendor_id: string;
  source: 'csv' | 'api';
  file_name: string | null;
  status: 'completed' | 'completed_with_errors' | 'failed';
  total_rows: number;
  inserted_count: number;
  updated_count: number;
  unchanged_count: number;
  error_count: number;
  price_up_count: number;
  price_down_count: number;
  created_at: string;
}

export async function listImportRuns(limit = 20): Promise<ImportRun[]> {
  const { data, error } = await supabase
    .from('supplier_price_imports')
    .select('id, vendor_id, source, file_name, status, total_rows, inserted_count, updated_count, unchanged_count, error_count, price_up_count, price_down_count, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail(error, 'Could not load import history.');
  return (data ?? []) as ImportRun[];
}

export interface FeedKey {
  id: string;
  vendor_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export async function listFeedKeys(vendorId: string): Promise<FeedKey[]> {
  const { data, error } = await supabase
    .from('supplier_feed_keys')
    .select('id, vendor_id, name, key_prefix, scopes, last_used_at, revoked_at, created_at')
    .eq('vendor_id', vendorId)
    .order('created_at', { ascending: false });
  if (error) fail(error, 'Could not load API keys.');
  return (data ?? []) as FeedKey[];
}

/** Creates a key and returns the raw secret — it is never retrievable again. */
export async function createFeedKey(vendorId: string, name: string, scopes: string[]): Promise<string> {
  const key = await generateFeedKey();
  const { error } = await supabase.rpc('create_supplier_feed_key', {
    p_vendor_id: vendorId, p_name: name, p_key_prefix: key.prefix, p_key_hash: key.hash, p_scopes: scopes,
  });
  if (error) fail(error, 'Could not create the key.');
  return key.raw;
}

export async function revokeFeedKey(id: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_supplier_feed_key', { p_key_id: id });
  if (error) fail(error, 'Could not revoke the key.');
}

export interface SupplierOption {
  id: string;
  name: string;
}

export async function listSuppliers(): Promise<SupplierOption[]> {
  const { data, error } = await supabase.from('inventory_vendors').select('id, name').eq('active', true).order('name');
  if (error) fail(error, 'Could not load suppliers.');
  return (data ?? []) as SupplierOption[];
}

export interface LocationOption {
  id: string;
  name: string;
  location_type: string;
  assigned_technician_id: string | null;
}

export async function listLocations(): Promise<LocationOption[]> {
  const { data, error } = await supabase
    .from('inventory_locations')
    .select('id, name, location_type, assigned_technician_id')
    .eq('active', true)
    .order('name');
  if (error) fail(error, 'Could not load locations.');
  return (data ?? []) as LocationOption[];
}
