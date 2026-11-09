/**
 * Parts sourcing — network layer. Pure logic lives in partsSourcing.ts.
 * Reads rely on RLS (account-scoped, module-gated); every write that moves money or approvals goes through
 * a SECURITY DEFINER RPC that re-checks module, ownership and role (see 20290301000000_parts_sourcing.sql).
 */
import { supabase } from '@/lib/supabase';
import {
  etaConflict,
  type EtaCheck,
  type MarginRule,
  type RuleScope,
  type SourcingSettings,
  type StockStatus,
  type SupplierOffer,
  type VendorSpendRow,
} from '@/lib/partsSourcing';

function fail(error: { message?: string } | null, fallback: string): never {
  const msg = error?.message && error.message.length < 200 ? error.message : fallback;
  throw new Error(msg);
}

export async function isPartsSourcingEnabled(): Promise<boolean> {
  const { data, error } = await supabase.rpc('parts_sourcing_enabled');
  if (error) return false;
  return data === true;
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------
export interface PartHit {
  id: string;
  part_number: string | null;
  name: string;
  category: string | null;
  unit_cost_cents: number;
}

/** Strips characters that have meaning inside PostgREST `or()` / ilike patterns. */
export function sanitizeSearch(raw: string): string {
  return raw.replace(/[%_,()*\\"'`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export async function searchParts(query: string): Promise<PartHit[]> {
  const q = sanitizeSearch(query);
  if (q.length < 2) return [];
  const { data, error } = await supabase
    .from('inventory_parts')
    .select('id, part_number, name, category, unit_cost_cents')
    .eq('active', true)
    .or(`name.ilike.%${q}%,part_number.ilike.%${q}%`)
    .order('name', { ascending: true })
    .limit(15);
  if (error) fail(error, 'Could not search parts.');
  return (data ?? []) as PartHit[];
}

export interface OffersPayload {
  can_manage: boolean;
  part: PartHit;
  stock: { truck: number; branch: number; other_trucks: number };
  offers: SupplierOffer[];
  rules: MarginRule[];
  settings: SourcingSettings;
  job: { id: string; scheduled_datetime: string | null; assigned_technician_id: string | null } | null;
}

export async function getOffers(partId: string, jobId?: string | null): Promise<OffersPayload> {
  const { data, error } = await supabase.rpc('parts_sourcing_offers', { p_part_id: partId, p_job_id: jobId ?? null });
  if (error) fail(error, 'Could not compare sources for this part.');
  return data as OffersPayload;
}

export interface SourcingJob {
  id: string;
  customer_name: string | null;
  service_type: string | null;
  scheduled_datetime: string | null;
  job_status: string | null;
}

export async function listSourcingJobs(): Promise<SourcingJob[]> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('jobs')
    .select('id, customer_name, service_type, scheduled_datetime, job_status')
    .gte('scheduled_datetime', since)
    .not('job_status', 'in', '(completed,cancelled,no_show)')
    .order('scheduled_datetime', { ascending: true })
    .limit(60);
  if (error) fail(error, 'Could not load jobs.');
  return (data ?? []) as SourcingJob[];
}

export type { StockStatus };

// ---------------------------------------------------------------------------
// Orders: idempotent submit, approval, receiving, technician request
// ---------------------------------------------------------------------------
export interface SubmittedOrder {
  po_id: string;
  po_number: string;
  vendor_name: string;
  status: string;
  total_cents: number;
  expected_at: string | null;
  line_count: number;
}

export interface SubmitResult {
  orders: SubmittedOrder[];
  jobs: { job_id: string; hold: string; reason?: string | null }[];
  skipped: { cart_id: string; sku: string; reason: string }[];
  replayed: boolean;
}

export async function submitOrder(args: {
  idempotencyKey: string;
  cartIds: string[];
  jobId: string | null;
  holdJob: boolean;
  notes?: string;
}): Promise<SubmitResult> {
  const { data, error } = await supabase.rpc('parts_sourcing_submit_order', {
    p_idempotency_key: args.idempotencyKey,
    p_cart_ids: args.cartIds,
    p_job_id: args.jobId,
    p_hold_jobs: args.holdJob,
    p_notes: args.notes?.trim() || null,
  });
  if (error) fail(error, 'Could not submit the order. Nothing was ordered — it is safe to try again.');
  return data as SubmitResult;
}

export async function requestParts(jobId: string, note?: string): Promise<{ status: string }> {
  const { data, error } = await supabase.rpc('parts_sourcing_request_parts', { p_job_id: jobId, p_note: note?.trim() || null });
  if (error) fail(error, 'Could not send the request.');
  return data as { status: string };
}

export interface OrderRow {
  id: string;
  po_number: string;
  vendor_name: string | null;
  status: 'pending_approval' | 'sent' | 'partially_received';
  total_cents: number;
  expected_at: string | null;
  created_at: string;
}

export async function listOpenOrders(): Promise<OrderRow[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('id, po_number, vendor_name, status, total_cents, expected_at, created_at')
    .in('status', ['pending_approval', 'sent', 'partially_received'])
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) fail(error, 'Could not load orders.');
  return (data ?? []) as OrderRow[];
}

export async function decideOrder(poId: string, decision: 'approve' | 'reject', note?: string): Promise<void> {
  const { error } = await supabase.rpc('parts_sourcing_decide_po', { p_po_id: poId, p_decision: decision, p_note: note?.trim() || null });
  if (error) fail(error, 'Could not record the decision.');
}

/** Receiving reuses the existing inventory flow (stock levels + transactions + job auto-resume). */
export async function receiveOrder(poId: string): Promise<void> {
  const { error } = await supabase.rpc('receive_purchase_order', { p_po_id: poId, p_lines: null });
  if (error) fail(error, 'Could not receive this order.');
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------
export interface SpendReport {
  from: string;
  to: string;
  totals: { po_count: number; committed_cents: number; received_cents: number };
  by_vendor: VendorSpendRow[];
  by_month: { month: string; po_count: number; committed_cents: number }[];
}

export async function getSpend(from: string, to: string): Promise<SpendReport> {
  const { data, error } = await supabase.rpc('parts_sourcing_spend', { p_from: from, p_to: to });
  if (error) fail(error, 'Could not load spend.');
  return data as SpendReport;
}

// ---------------------------------------------------------------------------
// Setup: settings, margin rules, cross references, equipment links, audit
// ---------------------------------------------------------------------------
export async function getSettings(): Promise<SourcingSettings> {
  const { data, error } = await supabase.from('parts_sourcing_settings').select('truck_first, eta_buffer_days, approval_threshold_cents').maybeSingle();
  if (error) fail(error, 'Could not load settings.');
  return (data as SourcingSettings | null) ?? { truck_first: true, eta_buffer_days: 0, approval_threshold_cents: null };
}

export async function saveSettings(s: SourcingSettings): Promise<void> {
  const { error } = await supabase.rpc('parts_sourcing_save_settings', {
    p_truck_first: s.truck_first,
    p_eta_buffer_days: s.eta_buffer_days,
    p_approval_threshold_cents: s.approval_threshold_cents,
  });
  if (error) fail(error, 'Could not save settings.');
}

export async function listRules(): Promise<MarginRule[]> {
  const { data, error } = await supabase
    .from('parts_margin_rules')
    .select('id, scope, scope_value, markup_bps, min_margin_bps, round_to_cents, priority, active')
    .order('scope', { ascending: true })
    .order('priority', { ascending: false });
  if (error) fail(error, 'Could not load margin rules.');
  return (data ?? []) as MarginRule[];
}

export async function saveRule(rule: {
  id?: string;
  scope: RuleScope;
  scope_value: string | null;
  markup_bps: number;
  min_margin_bps: number;
  round_to_cents: number;
  priority: number;
  active: boolean;
}): Promise<void> {
  const { id, ...fields } = rule;
  const q = id ? supabase.from('parts_margin_rules').update(fields).eq('id', id) : supabase.from('parts_margin_rules').insert(fields);
  const { error } = await q;
  if (error) fail(error, error.code === '23505' ? 'A rule for this scope already exists.' : 'Could not save the rule.');
}

export async function deleteRule(id: string): Promise<void> {
  const { error } = await supabase.from('parts_margin_rules').delete().eq('id', id);
  if (error) fail(error, 'Could not delete the rule.');
}

export interface CrossRef {
  id: string;
  alt_part_id: string | null;
  alt_mpn: string | null;
  relation: 'equivalent' | 'alternate' | 'supersedes' | 'superseded_by';
  note: string | null;
}

export async function listCrossRefs(partId: string): Promise<CrossRef[]> {
  const { data, error } = await supabase.from('part_cross_references').select('id, alt_part_id, alt_mpn, relation, note').eq('part_id', partId).order('created_at');
  if (error) fail(error, 'Could not load cross references.');
  return (data ?? []) as CrossRef[];
}

export async function addCrossRef(args: { partId: string; altMpn: string; relation: CrossRef['relation']; note?: string }): Promise<void> {
  const { error } = await supabase.from('part_cross_references').insert({
    part_id: args.partId,
    alt_mpn: args.altMpn.trim(),
    relation: args.relation,
    note: args.note?.trim() || null,
  });
  if (error) fail(error, error.code === '23505' ? 'That cross reference already exists.' : 'Could not add the cross reference.');
}

export async function deleteCrossRef(id: string): Promise<void> {
  const { error } = await supabase.from('part_cross_references').delete().eq('id', id);
  if (error) fail(error, 'Could not remove the cross reference.');
}

export interface EquipmentModelLink {
  id: string;
  make: string | null;
  model: string | null;
  ahri_ref_number: string | null;
  fit_note: string | null;
}

export async function listEquipmentModels(partId: string): Promise<EquipmentModelLink[]> {
  const { data, error } = await supabase.from('part_equipment_models').select('id, make, model, ahri_ref_number, fit_note').eq('part_id', partId).order('created_at');
  if (error) fail(error, 'Could not load equipment links.');
  return (data ?? []) as EquipmentModelLink[];
}

export async function addEquipmentModel(args: { partId: string; make?: string; model?: string; ahri?: string; note?: string }): Promise<void> {
  const { error } = await supabase.from('part_equipment_models').insert({
    part_id: args.partId,
    make: args.make?.trim() || null,
    model: args.model?.trim() || null,
    ahri_ref_number: args.ahri?.trim() || null,
    fit_note: args.note?.trim() || null,
  });
  if (error) fail(error, error.code === '23505' ? 'That link already exists.' : 'Could not add the equipment link.');
}

export async function deleteEquipmentModel(id: string): Promise<void> {
  const { error } = await supabase.from('part_equipment_models').delete().eq('id', id);
  if (error) fail(error, 'Could not remove the equipment link.');
}

export interface EquipmentPart {
  part_id: string;
  part_number: string | null;
  name: string;
  category: string | null;
  fit_note: string | null;
  ahri_ref_number: string | null;
}

export async function partsForEquipment(equipmentId: string): Promise<EquipmentPart[]> {
  const { data, error } = await supabase.rpc('parts_sourcing_parts_for_equipment', { p_equipment_id: equipmentId });
  if (error) fail(error, 'Could not find parts for this equipment.');
  return (data ?? []) as EquipmentPart[];
}

export interface AuditRow {
  id: string;
  action: string;
  target_table: string | null;
  actor_id: string | null;
  created_at: string;
}

export async function listAudit(limit = 50): Promise<AuditRow[]> {
  const { data, error } = await supabase
    .from('parts_sourcing_audit')
    .select('id, action, target_table, actor_id, created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) fail(error, 'Could not load the audit trail.');
  return (data ?? []) as AuditRow[];
}

// ---------------------------------------------------------------------------
// Dispatch: delivery vs appointment
// ---------------------------------------------------------------------------
export type JobEtaWarnings = Record<string, EtaCheck & { eta: string | null }>;

/** Returns {} when the module is OFF (the RPC yields no rows) or on any failure — dispatch must never break. */
export async function fetchJobEtaWarnings(jobIds: string[]): Promise<JobEtaWarnings> {
  if (jobIds.length === 0) return {};
  try {
    const { data, error } = await supabase.rpc('parts_sourcing_job_eta', { p_job_ids: jobIds.slice(0, 300) });
    if (error || !Array.isArray(data)) return {};
    const out: JobEtaWarnings = {};
    for (const r of data as { job_id: string; scheduled_datetime: string | null; eta: string | null; parts_ready: boolean; buffer_days: number }[]) {
      out[r.job_id] = {
        ...etaConflict({ eta: r.eta, scheduled: r.scheduled_datetime, bufferDays: r.buffer_days, partsReady: r.parts_ready }),
        eta: r.eta,
      };
    }
    return out;
  } catch {
    return {};
  }
}
