/**
 * Procurement Network — data access (Supabase).
 *
 * Rules of the road (see the migration header):
 *  - Anything cross-tenant (programs, pool numbers) comes from SECURITY DEFINER RPCs that return
 *    aggregates only. Tenants never query supplier or other-tenant tables directly.
 *  - Prices are never sent from the client; pn_place_order() computes them server-side.
 *  - Pure logic lives in procurementNetwork.ts.
 */

import { supabase } from './supabase';
import type {
  CatalogImportRow,
  NetworkOrder,
  NetworkOrderLine,
  OrderSavingsRow,
  ProgramDetail,
  ProgramStatus,
  ProgramSummary,
  Rebate,
  ScheduleLineInput,
  ScheduleStatus,
  ShipTo,
  SupplierStatus,
  Tier,
  PoolPublic,
} from './procurementNetwork';

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

/** Supabase errors are plain objects, not Error instances: normalise so `catch (e)` always has a message. */
export function errorMessage(e: unknown, fallback = 'Something went wrong'): string {
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return fallback;
}

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

const ROW_LIMIT = 500;

// ------------------------------------------------------------------
// types (DB rows)
// ------------------------------------------------------------------

export interface Membership {
  id: string;
  user_id: string;
  status: 'active' | 'left';
  region: string | null;
  categories: string[];
  share_volume_consent: boolean;
  consented_at: string | null;
  joined_at: string;
}

export interface Supplier {
  id: string;
  name: string;
  legal_name: string | null;
  contact_name: string | null;
  contact_email: string;
  phone: string | null;
  website: string | null;
  description: string | null;
  regions: string[];
  categories: string[];
  status: SupplierStatus;
  w9_verified: boolean;
  insurance_verified: boolean;
  review_notes: string | null;
  created_at: string;
}

export interface SupplierMembership {
  role: 'admin' | 'member';
  supplier: Supplier;
}

export interface CatalogItem {
  id: string;
  supplier_id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  manufacturer: string | null;
  mpn: string | null;
  unit: string;
  list_price_cents: number;
  min_order_qty: number;
  lead_time_days: number | null;
  active: boolean;
}

export interface Program {
  id: string;
  supplier_id: string;
  title: string;
  description: string | null;
  category: string | null;
  terms: string | null;
  status: ProgramStatus;
  starts_on: string;
  ends_on: string;
  regions: string[];
  min_participants_for_tier: number;
  bonus_rebate_bps: number;
  bonus_min_spend_cents: number;
  settled_at: string | null;
  created_at: string;
}

export interface Schedule {
  id: string;
  program_id: string;
  version: number;
  status: ScheduleStatus;
  valid_from: string | null;
  valid_to: string | null;
  supplier_note: string | null;
  review_note: string | null;
  submitted_at: string | null;
  created_at: string;
}

export interface ScheduleLine {
  id: string;
  schedule_id: string;
  catalog_item_id: string;
  tier_id: string;
  unit_price_cents: number;
}

export interface SupplierProgramStats {
  pool: PoolPublic | null;
  items: Array<{ catalog_item_id: string; sku: string; name: string; ordered_qty: number; committed_qty: number }>;
  orders: number;
  rebates_accrued_cents: number;
  rebates_paid_cents: number;
}

export interface StaffOverview {
  pending_suppliers: Supplier[];
  proposed_schedules: Array<{
    id: string;
    version: number;
    submitted_at: string | null;
    supplier_note: string | null;
    program_id: string;
    program_title: string;
    supplier_name: string;
    lines: number;
  }>;
  network: { members: number; approved_suppliers: number; open_programs: number; orders_gmv_cents: number };
}

export interface PlaceOrderResult {
  order_id: string;
  order_number: string;
  po_id: string;
  subtotal_cents: number;
  tier_rank: number;
  lines: number;
}

// ------------------------------------------------------------------
// tenant: membership
// ------------------------------------------------------------------

export async function fetchMembership(): Promise<Membership | null> {
  const res = await supabase.from('pn_memberships').select('*').maybeSingle();
  return check<Membership | null>(res as never);
}

export function joinNetwork(region: string, categories: string[], consent: boolean) {
  return rpc<{ status: string }>('pn_join_network', { p_region: region, p_categories: categories, p_consent: consent });
}

export function leaveNetwork() {
  return rpc<{ status: string }>('pn_leave_network');
}

// ------------------------------------------------------------------
// tenant: programs, commitments, orders
// ------------------------------------------------------------------

export function listPrograms() {
  return rpc<ProgramSummary[]>('pn_list_programs');
}

export function getProgramDetail(programId: string) {
  return rpc<ProgramDetail>('pn_program_detail', { p_program: programId });
}

export function setCommitment(programId: string, catalogItemId: string, qty: number) {
  return rpc<{ ok: boolean }>('pn_set_commitment', { p_program: programId, p_item: catalogItemId, p_qty: qty });
}

export function placeOrder(input: {
  programId: string;
  lines: Array<{ catalog_item_id: string; qty: number; part_id?: string | null }>;
  shipTo: ShipTo;
  notes?: string;
  expectedDelivery?: string | null;
}) {
  return rpc<PlaceOrderResult>('pn_place_order', {
    p_program: input.programId,
    p_lines: input.lines,
    p_ship_to: input.shipTo,
    p_notes: input.notes?.trim() || null,
    p_expected_delivery: input.expectedDelivery || null,
  });
}

export function cancelOrder(orderId: string) {
  return rpc<{ ok: boolean }>('pn_cancel_order', { p_order: orderId });
}

export async function fetchMyOrders(): Promise<NetworkOrder[]> {
  const res = await supabase.from('pn_orders').select('*').order('created_at', { ascending: false }).limit(ROW_LIMIT);
  return check<NetworkOrder[]>(res as never) ?? [];
}

export async function fetchOrderLines(orderId: string): Promise<NetworkOrderLine[]> {
  const res = await supabase.from('pn_order_lines').select('*').eq('order_id', orderId).order('created_at');
  return check<NetworkOrderLine[]>(res as never) ?? [];
}

export async function fetchOrderSavings(): Promise<OrderSavingsRow[]> {
  const res = await supabase.from('pn_order_savings').select('*').order('ordered_at', { ascending: false }).limit(ROW_LIMIT * 4);
  return check<OrderSavingsRow[]>(res as never) ?? [];
}

export async function fetchMyRebates(): Promise<Rebate[]> {
  const res = await supabase.from('pn_rebates').select('*').order('created_at', { ascending: false }).limit(ROW_LIMIT);
  return check<Rebate[]>(res as never) ?? [];
}

// ------------------------------------------------------------------
// tenant: inventory part mapping (so received network orders update stock automatically)
// ------------------------------------------------------------------

export interface InventoryPartLite {
  id: string;
  name: string;
  part_number: string | null;
}

export async function fetchInventoryPartsLite(): Promise<InventoryPartLite[]> {
  const res = await supabase.from('inventory_parts').select('id, name, part_number').order('name').limit(1000);
  return check<InventoryPartLite[]>(res as never) ?? [];
}

export async function linkPart(catalogItemId: string, partId: string): Promise<void> {
  const { data: existing } = await supabase.from('pn_part_links').select('id').eq('catalog_item_id', catalogItemId).maybeSingle();
  if (existing?.id) {
    const { error } = await supabase.from('pn_part_links').update({ part_id: partId }).eq('id', existing.id);
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase.from('pn_part_links').insert({ catalog_item_id: catalogItemId, part_id: partId });
  if (error) throw new Error(error.message);
}

export async function unlinkPart(catalogItemId: string): Promise<void> {
  const { error } = await supabase.from('pn_part_links').delete().eq('catalog_item_id', catalogItemId);
  if (error) throw new Error(error.message);
}

// ------------------------------------------------------------------
// supplier: onboarding + profile
// ------------------------------------------------------------------

export interface SupplierApplication {
  name: string;
  legalName: string;
  contactName: string;
  contactEmail: string;
  phone: string;
  website: string;
  description: string;
  regions: string[];
  categories: string[];
}

export function applyAsSupplier(a: SupplierApplication) {
  return rpc<string>('pn_supplier_apply', {
    p_name: a.name,
    p_legal_name: a.legalName,
    p_contact_name: a.contactName,
    p_contact_email: a.contactEmail,
    p_phone: a.phone,
    p_website: a.website,
    p_description: a.description,
    p_regions: a.regions,
    p_categories: a.categories,
  });
}

export async function fetchMySupplier(): Promise<SupplierMembership | null> {
  const res = await supabase.from('pn_supplier_users').select('role, supplier:pn_suppliers(*)').limit(1).maybeSingle();
  const row = check<{ role: 'admin' | 'member'; supplier: Supplier | Supplier[] | null } | null>(res as never);
  if (!row) return null;
  const supplier = Array.isArray(row.supplier) ? row.supplier[0] : row.supplier;
  return supplier ? { role: row.role, supplier } : null;
}

export function updateSupplierProfile(
  supplierId: string,
  p: { contactName: string; contactEmail: string; phone: string; website: string; description: string; regions: string[]; categories: string[] },
) {
  return rpc<void>('pn_supplier_update_profile', {
    p_supplier: supplierId,
    p_contact_name: p.contactName,
    p_contact_email: p.contactEmail,
    p_phone: p.phone,
    p_website: p.website,
    p_description: p.description,
    p_regions: p.regions,
    p_categories: p.categories,
  });
}

export function addSupplierMember(supplierId: string, email: string, role: 'admin' | 'member') {
  return rpc<void>('pn_supplier_add_member', { p_supplier: supplierId, p_email: email, p_role: role });
}

export async function fetchSupplierMembers(supplierId: string): Promise<Array<{ id: string; user_id: string; role: string; created_at: string }>> {
  const res = await supabase.from('pn_supplier_users').select('id, user_id, role, created_at').eq('supplier_id', supplierId);
  return check<Array<{ id: string; user_id: string; role: string; created_at: string }>>(res as never) ?? [];
}

// ------------------------------------------------------------------
// supplier: catalog
// ------------------------------------------------------------------

export async function fetchCatalog(supplierId: string): Promise<CatalogItem[]> {
  const res = await supabase.from('pn_catalog_items').select('*').eq('supplier_id', supplierId).order('name').limit(5000);
  return check<CatalogItem[]>(res as never) ?? [];
}

export type CatalogItemInput = Omit<CatalogItem, 'id' | 'supplier_id'>;

export async function createCatalogItem(supplierId: string, input: CatalogItemInput): Promise<void> {
  const { error } = await supabase.from('pn_catalog_items').insert({ ...input, supplier_id: supplierId });
  if (error) throw new Error(error.message);
}

export async function updateCatalogItem(id: string, patch: Partial<CatalogItemInput>): Promise<void> {
  const { error } = await supabase.from('pn_catalog_items').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

export interface ImportOutcome {
  inserted: number;
  updated: number;
  failed: Array<{ sku: string; message: string }>;
}

/** New SKUs are inserted in batches; existing SKUs are updated (case-insensitive match). */
export async function importCatalogRows(supplierId: string, rows: CatalogImportRow[], existing: CatalogItem[]): Promise<ImportOutcome> {
  const bySku = new Map(existing.map((i) => [i.sku.toLowerCase(), i]));
  const toInsert = rows.filter((r) => !bySku.has(r.sku.toLowerCase()));
  const toUpdate = rows.filter((r) => bySku.has(r.sku.toLowerCase()));
  const out: ImportOutcome = { inserted: 0, updated: 0, failed: [] };

  for (let i = 0; i < toInsert.length; i += 200) {
    const batch = toInsert.slice(i, i + 200);
    const { error } = await supabase.from('pn_catalog_items').insert(batch.map((r) => ({ ...r, supplier_id: supplierId })));
    if (error) batch.forEach((r) => out.failed.push({ sku: r.sku, message: error.message }));
    else out.inserted += batch.length;
  }

  for (let i = 0; i < toUpdate.length; i += 20) {
    const batch = toUpdate.slice(i, i + 20);
    const results = await Promise.all(
      batch.map(async (r) => {
        const current = bySku.get(r.sku.toLowerCase());
        if (!current) return { r, message: 'not found' };
        const { error } = await supabase.from('pn_catalog_items').update({ ...r, active: true }).eq('id', current.id);
        return { r, message: error?.message ?? null };
      }),
    );
    for (const { r, message } of results) {
      if (message) out.failed.push({ sku: r.sku, message });
      else out.updated += 1;
    }
  }
  return out;
}

// ------------------------------------------------------------------
// supplier: programs, tiers, price schedules
// ------------------------------------------------------------------

export async function fetchSupplierPrograms(supplierId: string): Promise<Program[]> {
  const res = await supabase.from('pn_programs').select('*').eq('supplier_id', supplierId).order('created_at', { ascending: false });
  return check<Program[]>(res as never) ?? [];
}

export type ProgramInput = Pick<
  Program,
  'title' | 'description' | 'category' | 'terms' | 'starts_on' | 'ends_on' | 'regions' | 'min_participants_for_tier' | 'bonus_rebate_bps' | 'bonus_min_spend_cents'
>;

export async function createProgram(supplierId: string, input: ProgramInput): Promise<Program> {
  const res = await supabase.from('pn_programs').insert({ ...input, supplier_id: supplierId, status: 'draft' }).select().single();
  return check<Program>(res as never);
}

export async function updateProgram(id: string, patch: Partial<ProgramInput>): Promise<void> {
  const { error } = await supabase.from('pn_programs').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

export function setProgramStatus(programId: string, status: 'open' | 'closed' | 'cancelled') {
  return rpc<{ status: string }>('pn_supplier_set_program_status', { p_program: programId, p_status: status });
}

export async function fetchTiers(programId: string): Promise<Tier[]> {
  const res = await supabase.from('pn_volume_tiers').select('*').eq('program_id', programId).order('rank');
  return check<Tier[]>(res as never) ?? [];
}

export async function saveTier(programId: string, tier: Omit<Tier, 'id'> & { id?: string }): Promise<void> {
  const payload = { program_id: programId, rank: tier.rank, label: tier.label, min_qualifying_cents: tier.min_qualifying_cents, discount_bps: tier.discount_bps };
  const { error } = tier.id
    ? await supabase.from('pn_volume_tiers').update(payload).eq('id', tier.id)
    : await supabase.from('pn_volume_tiers').insert(payload);
  if (error) throw new Error(error.message);
}

export async function deleteTier(id: string): Promise<void> {
  const { error } = await supabase.from('pn_volume_tiers').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function fetchSchedules(programId: string): Promise<Schedule[]> {
  const res = await supabase.from('pn_price_schedules').select('*').eq('program_id', programId).order('version', { ascending: false });
  return check<Schedule[]>(res as never) ?? [];
}

export async function createSchedule(programId: string, note: string): Promise<Schedule> {
  const res = await supabase.from('pn_price_schedules').insert({ program_id: programId, supplier_note: note.trim() || null, status: 'draft' }).select().single();
  return check<Schedule>(res as never);
}

export async function fetchScheduleLines(scheduleId: string): Promise<ScheduleLine[]> {
  const res = await supabase.from('pn_price_schedule_lines').select('*').eq('schedule_id', scheduleId).limit(20000);
  return check<ScheduleLine[]>(res as never) ?? [];
}

/** Replaces all lines of a DRAFT schedule (RLS rejects anything else). */
export async function replaceScheduleLines(scheduleId: string, lines: ScheduleLineInput[]): Promise<void> {
  const del = await supabase.from('pn_price_schedule_lines').delete().eq('schedule_id', scheduleId);
  if (del.error) throw new Error(del.error.message);
  for (let i = 0; i < lines.length; i += 500) {
    const { error } = await supabase.from('pn_price_schedule_lines').insert(lines.slice(i, i + 500).map((l) => ({ ...l, schedule_id: scheduleId })));
    if (error) throw new Error(error.message);
  }
}

export function submitSchedule(scheduleId: string) {
  return rpc<void>('pn_supplier_submit_schedule', { p_schedule: scheduleId });
}

export function fetchSupplierProgramStats(programId: string) {
  return rpc<SupplierProgramStats>('pn_supplier_program_stats', { p_program: programId });
}

// ------------------------------------------------------------------
// supplier: orders and rebates
// ------------------------------------------------------------------

export async function fetchSupplierOrders(supplierId: string): Promise<NetworkOrder[]> {
  const res = await supabase.from('pn_orders').select('*').eq('supplier_id', supplierId).order('created_at', { ascending: false }).limit(ROW_LIMIT);
  return check<NetworkOrder[]>(res as never) ?? [];
}

export function updateSupplierOrder(orderId: string, action: 'confirm' | 'ship' | 'deliver' | 'cancel', opts: { tracking?: string; note?: string } = {}) {
  return rpc<{ ok: boolean }>('pn_supplier_update_order', { p_order: orderId, p_action: action, p_tracking: opts.tracking ?? null, p_note: opts.note ?? null });
}

export async function fetchSupplierRebates(supplierId: string): Promise<Rebate[]> {
  const res = await supabase.from('pn_rebates').select('*').eq('supplier_id', supplierId).order('created_at', { ascending: false }).limit(ROW_LIMIT);
  return check<Rebate[]>(res as never) ?? [];
}

export function markRebatePaid(rebateId: string, reference: string) {
  return rpc<void>('pn_supplier_mark_rebate_paid', { p_rebate: rebateId, p_reference: reference });
}

// ------------------------------------------------------------------
// staff (network operator)
// ------------------------------------------------------------------

export function fetchStaffOverview() {
  return rpc<StaffOverview>('pn_staff_overview');
}

export function reviewSupplier(supplierId: string, decision: 'approved' | 'rejected' | 'suspended', notes: string, w9: boolean, insurance: boolean) {
  return rpc<void>('pn_staff_review_supplier', { p_supplier: supplierId, p_decision: decision, p_notes: notes, p_w9: w9, p_insurance: insurance });
}

export function reviewSchedule(scheduleId: string, decision: 'approve' | 'counter', note: string) {
  return rpc<void>('pn_staff_review_schedule', { p_schedule: scheduleId, p_decision: decision, p_note: note });
}

export async function fetchScheduleForReview(scheduleId: string, programId: string) {
  const [lines, tiers] = await Promise.all([fetchScheduleLines(scheduleId), fetchTiers(programId)]);
  const itemIds = [...new Set(lines.map((l) => l.catalog_item_id))];
  const items: Array<{ id: string; sku: string; name: string; list_price_cents: number }> = [];
  for (let i = 0; i < itemIds.length; i += 100) {
    const res = await supabase.from('pn_catalog_items').select('id, sku, name, list_price_cents').in('id', itemIds.slice(i, i + 100));
    items.push(...(check<typeof items>(res as never) ?? []));
  }
  return { lines, tiers, items };
}
