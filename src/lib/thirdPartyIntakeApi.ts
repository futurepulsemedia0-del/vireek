/**
 * Data access for third-party work-order intake. Pure logic lives in thirdPartyIntake.ts.
 * Reads are plain selects (RLS scopes them); every write goes through the
 * `third_party_wo_act` RPC so the database enforces the approval steps.
 */

import { supabase } from '@/lib/supabase';
import { generateToken } from '@/lib/leadMarketplace';
import {
  toActArgs,
  type ActionInput,
  type IntakeAction,
  type IntakeEvent,
  type Payer,
  type ThirdPartyWorkOrder,
  type toPayerPayload,
} from '@/lib/thirdPartyIntake';

// raw_payload is loaded on demand (fetchRawPayload) - it can be large.
const INTAKE_COLUMNS =
  'id,user_id,payer_id,payer_name,received_via,external_ref,priority,title,description,service_type,customer_name,customer_phone,customer_email,service_address,policy_number,nte_cents,quoted_cents,status,needs_review,review_reasons,authorization_status,authorization_ref,authorized_cents,authorized_at,decline_reason,scheduled_for,work_order_id,received_at,accept_due_at,schedule_due_at,complete_due_at,responded_at,accepted_at,completed_at,paused_at,paused_from_status,created_at,updated_at';

export async function fetchIntakes(accountOwnerId: string, limit = 500): Promise<ThirdPartyWorkOrder[]> {
  const { data, error } = await supabase
    .from('third_party_work_orders')
    .select(INTAKE_COLUMNS)
    .eq('user_id', accountOwnerId)
    .order('received_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as ThirdPartyWorkOrder[] | null) ?? [];
}

export async function fetchEvents(intakeId: string): Promise<IntakeEvent[]> {
  const { data, error } = await supabase
    .from('third_party_work_order_events')
    .select('id,intake_id,kind,from_status,to_status,note,created_at')
    .eq('intake_id', intakeId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as IntakeEvent[] | null) ?? [];
}

export async function fetchRawPayload(intakeId: string): Promise<string | null> {
  const { data, error } = await supabase.from('third_party_work_orders').select('raw_payload').eq('id', intakeId).maybeSingle();
  if (error) throw error;
  return (data as { raw_payload: string | null } | null)?.raw_payload ?? null;
}

async function callAct(id: string, action: string, extra: Record<string, unknown>): Promise<ThirdPartyWorkOrder> {
  const { data, error } = await supabase.rpc('third_party_wo_act', { p_id: id, p_action: action, ...extra });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as ThirdPartyWorkOrder | null;
  if (!row) throw new Error('No response from the server.');
  return row;
}

export const actOnIntake = (id: string, action: Exclude<IntakeAction, 'edit'>, input: ActionInput) =>
  callAct(id, action, { ...toActArgs(action, input) });

export const editIntake = (id: string, fields: Record<string, string>) => callAct(id, 'edit', { p_fields: fields });

// ---------------- partners (owner only) ----------------

export async function fetchPayers(userId: string): Promise<Payer[]> {
  const { data, error } = await supabase.from('third_party_payers').select('*').eq('user_id', userId).order('name');
  if (error) throw error;
  return (data as Payer[] | null) ?? [];
}

export async function savePayer(userId: string, id: string | null, payload: ReturnType<typeof toPayerPayload>): Promise<Payer> {
  if (id) {
    const { data, error } = await supabase.from('third_party_payers').update(payload).eq('id', id).eq('user_id', userId).select('*').single();
    if (error) throw error;
    return data as Payer;
  }
  const { data, error } = await supabase.from('third_party_payers').insert({ ...payload, user_id: userId }).select('*').single();
  if (error) throw error;
  return data as Payer;
}

export async function rotatePayerToken(userId: string, id: string): Promise<Payer> {
  const { data, error } = await supabase
    .from('third_party_payers')
    .update({ intake_token: generateToken() })
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single();
  if (error) throw error;
  return data as Payer;
}

export async function deletePayer(userId: string, id: string): Promise<void> {
  const { error } = await supabase.from('third_party_payers').delete().eq('id', id).eq('user_id', userId);
  if (error) throw error;
}
