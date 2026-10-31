/**
 * Approval-to-Cash client API. All rules live in the shared pure module (mirrored in SQL);
 * every write goes through a SECURITY DEFINER RPC — the browser never writes the tracking tables.
 */
import { supabase } from '@/lib/supabase';
import type { ApState, GateFinding } from '../../supabase/functions/_shared/approvalToCash/logic';

export * from '../../supabase/functions/_shared/approvalToCash/logic';

export interface GateDb {
  ok: boolean;
  overridden: boolean;
  findings: GateFinding[];
  total_cents: number;
  approved_cents: number | null;
  committed_cents: number | null;
  has_work_order: boolean;
}

export interface ArTracking {
  invoice_id: string;
  ap_state: ApState;
  rejection_reason: string | null;
  state_note: string | null;
  state_changed_at: string;
  followups_approved_at: string | null;
  followups_paused: boolean;
  last_ladder_step: number;
  last_followup_at: string | null;
}

export interface WorkOrderOption {
  id: string;
  work_order_number: string | null;
  po_number: string | null;
  title: string;
  approval_status: 'not_required' | 'pending' | 'approved' | 'rejected';
  not_to_exceed_cents: number | null;
}

export interface A2cSettings {
  a2c_require_po: boolean;
  a2c_require_completion_proof: boolean;
  a2c_followup_days: number[];
}

export interface DemandDraft {
  id: string;
  status: 'draft' | 'reviewed' | 'discarded';
  body: string;
  facts: Record<string, unknown>;
  created_at: string;
  reviewed_at: string | null;
}

export interface PacketData {
  generated_at: string;
  business_name: string | null;
  invoice: {
    id: string; number: string | null; status: string; sent_at: string | null; due_date: string | null;
    customer_name: string; line_items: { description: string; quantity: number; unit_price_cents: number }[];
    tax_percent: number; notes: string | null; total_cents: number; paid_cents: number; balance_cents: number;
  };
  work_order: {
    number: string | null; po_number: string | null; title: string; approval_status: string; approver_name: string | null;
    approved_at: string | null; approval_notes: string | null; not_to_exceed_cents: number | null;
    site_name: string | null; site_address: string | null;
  } | null;
  completed_visits: { visit_number: number | null; completed_at: string | null; notes: string | null }[];
  evidence: { seq: number; stage: string; kind: string; title: string; recorded_at: string; actor_name: string | null; media_count: number }[];
  ap: { state: ApState; rejection_reason: string | null; changed_at: string } | null;
  gate: GateDb;
}

const fail = (e: { message: string } | null): never => { throw new Error(e?.message || 'Request failed'); };

export async function fetchGate(invoiceId: string): Promise<GateDb> {
  const { data, error } = await supabase.rpc('invoice_send_gate', { p_invoice_id: invoiceId });
  if (error) fail(error);
  return data as GateDb;
}

export async function fetchTracking(invoiceId: string): Promise<ArTracking | null> {
  const { data, error } = await supabase.from('invoice_ar_tracking').select('*').eq('invoice_id', invoiceId).maybeSingle();
  if (error) fail(error);
  return (data as ArTracking | null) ?? null;
}

export async function fetchWorkOrderOptions(ownerId: string): Promise<WorkOrderOption[]> {
  const { data, error } = await supabase
    .from('work_orders')
    .select('id, work_order_number, po_number, title, approval_status, not_to_exceed_cents')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) fail(error);
  return (data ?? []) as WorkOrderOption[];
}

export async function linkInvoiceWorkOrder(invoiceId: string, workOrderId: string | null): Promise<void> {
  const { error } = await supabase.from('invoices').update({ work_order_id: workOrderId }).eq('id', invoiceId);
  if (error) fail(error);
}

export async function setApState(invoiceId: string, state: 'received' | 'approved' | 'rejected', reason?: string, note?: string): Promise<void> {
  const { error } = await supabase.rpc('set_invoice_ap_state', { p_invoice_id: invoiceId, p_state: state, p_reason: reason ?? null, p_note: note ?? null });
  if (error) fail(error);
}

export async function approveFollowups(invoiceId: string): Promise<void> {
  const { error } = await supabase.rpc('a2c_approve_followups', { p_invoice_id: invoiceId });
  if (error) fail(error);
}

export async function setFollowupsPaused(invoiceId: string, paused: boolean): Promise<void> {
  const { error } = await supabase.rpc('a2c_set_followups_paused', { p_invoice_id: invoiceId, p_paused: paused });
  if (error) fail(error);
}

export async function overrideGate(invoiceId: string, reason: string): Promise<GateDb> {
  const { data, error } = await supabase.rpc('a2c_override_gate', { p_invoice_id: invoiceId, p_reason: reason });
  if (error) fail(error);
  return data as GateDb;
}

export async function fetchSettings(ownerId: string): Promise<A2cSettings> {
  const { data, error } = await supabase
    .from('business_profile')
    .select('a2c_require_po, a2c_require_completion_proof, a2c_followup_days')
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error) fail(error);
  return (data as A2cSettings | null) ?? { a2c_require_po: false, a2c_require_completion_proof: false, a2c_followup_days: [3, 7, 14, 30] };
}

export async function saveSettings(s: A2cSettings): Promise<void> {
  const { error } = await supabase.rpc('a2c_save_settings', {
    p_require_po: s.a2c_require_po, p_require_proof: s.a2c_require_completion_proof, p_days: s.a2c_followup_days,
  });
  if (error) fail(error);
}

export async function fetchPacketData(invoiceId: string): Promise<PacketData> {
  const { data, error } = await supabase.rpc('invoice_packet_data', { p_invoice_id: invoiceId });
  if (error) fail(error);
  return data as PacketData;
}

export async function fetchOpenDraft(invoiceId: string): Promise<DemandDraft | null> {
  const { data, error } = await supabase
    .from('invoice_demand_drafts')
    .select('id, status, body, facts, created_at, reviewed_at')
    .eq('invoice_id', invoiceId)
    .in('status', ['draft', 'reviewed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fail(error);
  return (data as DemandDraft | null) ?? null;
}

export async function saveDemandDraft(invoiceId: string, body: string): Promise<string> {
  const { data, error } = await supabase.rpc('a2c_save_demand_draft', { p_invoice_id: invoiceId, p_body: body });
  if (error) fail(error);
  return data as string;
}

export async function reviewDemandDraft(draftId: string): Promise<void> {
  const { error } = await supabase.rpc('a2c_review_demand_draft', { p_draft_id: draftId });
  if (error) fail(error);
}

export async function discardDemandDraft(draftId: string): Promise<void> {
  const { error } = await supabase.rpc('a2c_discard_demand_draft', { p_draft_id: draftId });
  if (error) fail(error);
}
