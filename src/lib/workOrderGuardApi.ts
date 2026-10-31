// src/lib/workOrderGuardApi.ts
//
// Supabase access for Work-Order Guard. Reads go through RLS-scoped tables (account owner + billing
// managers only); every write goes through a SECURITY DEFINER RPC (see 20280215000000_work_order_guard.sql).

import { supabase } from '@/lib/supabase';
import { DEFAULT_TIMEZONE, mergeRules, SERVICECHANNEL_DEFAULTS, type PortalRules, type WorkOrder } from '@/lib/workOrderGuard';
import { orderToRow, rowToOrder } from '@/lib/workOrderGuardImport';
import type { DepositTxn } from '@/lib/workOrderGuardMatching';

export interface PortalProfile {
  id: string;
  name: string;
  payerName: string | null;
  timezone: string;
  rules: PortalRules;
  isDefault: boolean;
}

export interface DepositMatch { workOrderId: string; bankTransactionId: string; matchedCents: number; method: string; confidence: number; explanation: string | null }

const ERRORS: Record<string, string> = {
  not_authorized: 'You need billing access to use Work-Order Guard.',
  profile_not_found: 'That portal profile no longer exists.',
  name_required: 'Give the profile a name.',
  rules_invalid: 'The rules could not be saved.',
  timezone_invalid: 'That timezone is not valid.',
  orders_count_invalid: 'Import between 1 and 1000 work orders at a time.',
  batch_not_found: 'That import no longer exists.',
  transaction_not_found: 'That bank deposit is no longer available.',
  order_not_matchable: 'One of these invoices is no longer approved or was already matched.',
  amount_exceeds_deposit: 'The invoices add up to more than the deposit.',
  already_matched: 'One of these invoices was already matched. Refresh and try again.',
};

export function wogErrorMessage(error: { code?: string; message?: string } | string | null | undefined, fallback: string): string {
  const text = typeof error === 'string' ? error : error?.message ?? '';
  const hit = Object.keys(ERRORS).find((k) => text.includes(k));
  return hit ? ERRORS[hit] : fallback;
}

const fail = (error: { code?: string; message?: string }, fallback: string): never => {
  throw new Error(wogErrorMessage(error, fallback));
};

const toProfile = (r: Record<string, unknown>): PortalProfile => ({
  id: String(r.id), name: String(r.name), payerName: (r.payer_name as string | null) ?? null,
  timezone: String(r.timezone ?? DEFAULT_TIMEZONE), rules: mergeRules(r.rules), isDefault: Boolean(r.is_default),
});

export async function listProfiles(ownerId: string): Promise<PortalProfile[]> {
  const { data, error } = await supabase.from('wog_portal_profiles').select('*').eq('user_id', ownerId).order('created_at');
  if (error) fail(error, 'Could not load portal profiles.');
  return (data ?? []).map((r) => toProfile(r as Record<string, unknown>));
}

export async function saveProfile(p: { id: string | null; name: string; payerName: string; timezone: string; rules: PortalRules; makeDefault: boolean }): Promise<PortalProfile> {
  const { data, error } = await supabase.rpc('wog_profile_save', {
    p_id: p.id, p_name: p.name, p_payer_name: p.payerName, p_timezone: p.timezone, p_rules: p.rules, p_make_default: p.makeDefault,
  });
  if (error) fail(error, 'Could not save the profile.');
  return toProfile(data as Record<string, unknown>);
}

/** First-run helper: creates the ServiceChannel profile from the editable defaults. */
export const createDefaultProfile = () =>
  saveProfile({ id: null, name: 'ServiceChannel', payerName: 'ServiceChannel', timezone: DEFAULT_TIMEZONE, rules: SERVICECHANNEL_DEFAULTS, makeDefault: true });

export async function deleteProfile(id: string): Promise<void> {
  const { error } = await supabase.rpc('wog_profile_delete', { p_id: id });
  if (error) fail(error, 'Could not delete the profile.');
}

export async function listOrders(ownerId: string, profileId: string): Promise<WorkOrder[]> {
  const out: WorkOrder[] = [];
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await supabase.from('wog_work_orders').select('*').eq('user_id', ownerId).eq('profile_id', profileId)
      .order('received_at', { ascending: false }).range(from, from + 999);
    if (error) fail(error, 'Could not load work orders.');
    out.push(...(data ?? []).map((r) => rowToOrder(r as Record<string, unknown>)));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export interface ImportSummary { created: number; updated: number; batchIds: string[] }

/** Chunks of 500 keep each RPC small; re-importing the same file is idempotent (upsert by WO number). */
export async function importOrders(profileId: string, source: 'csv' | 'email', fileName: string, orders: WorkOrder[]): Promise<ImportSummary> {
  const summary: ImportSummary = { created: 0, updated: 0, batchIds: [] };
  for (let i = 0; i < orders.length; i += 500) {
    const { data, error } = await supabase.rpc('wog_import_orders', {
      p_profile_id: profileId, p_source: source, p_file_name: fileName, p_orders: orders.slice(i, i + 500).map(orderToRow),
    });
    if (error) fail(error, `Import stopped after ${summary.created + summary.updated} orders. Re-import the file to finish — it will not create duplicates.`);
    const r = data as { batch_id: string; created: number; updated: number };
    summary.created += r.created; summary.updated += r.updated; summary.batchIds.push(r.batch_id);
  }
  return summary;
}

export async function undoImport(batchId: string): Promise<number> {
  const { data, error } = await supabase.rpc('wog_import_delete', { p_batch_id: batchId });
  if (error) fail(error, 'Could not undo the import.');
  return Number(data ?? 0);
}

export async function listMatches(ownerId: string): Promise<DepositMatch[]> {
  const { data, error } = await supabase.from('wog_deposit_matches').select('work_order_id,bank_transaction_id,matched_cents,method,confidence,explanation').eq('user_id', ownerId);
  if (error) fail(error, 'Could not load deposit matches.');
  return (data ?? []).map((r) => ({
    workOrderId: String(r.work_order_id), bankTransactionId: String(r.bank_transaction_id), matchedCents: Number(r.matched_cents),
    method: String(r.method), confidence: Number(r.confidence), explanation: (r.explanation as string | null) ?? null,
  }));
}

/** Unreconciled deposits from the last `days` days: money IN, not pending/removed, not already applied in Bank Intelligence. */
export async function listCandidateDeposits(ownerId: string, days: number): Promise<DepositTxn[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('bank_transactions')
    .select('id,amount_cents,posted_date,name,merchant_key')
    .eq('user_id', ownerId).gt('amount_cents', 0).eq('pending', false).neq('status', 'removed').gte('posted_date', since)
    .order('posted_date', { ascending: false }).limit(1000);
  if (error) fail(error, 'Could not load bank deposits. Connect a bank in Bank Intelligence first.');
  const rows = data ?? [];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => String(r.id));
  const taken = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const [applied, ours] = await Promise.all([
      supabase.from('bank_matches').select('bank_transaction_id').eq('user_id', ownerId).eq('status', 'applied').in('bank_transaction_id', slice),
      supabase.from('wog_deposit_matches').select('bank_transaction_id').eq('user_id', ownerId).in('bank_transaction_id', slice),
    ]);
    if (applied.error) fail(applied.error, 'Could not check existing bank matches.');
    if (ours.error) fail(ours.error, 'Could not check existing deposit matches.');
    for (const r of [...(applied.data ?? []), ...(ours.data ?? [])]) taken.add(String(r.bank_transaction_id));
  }
  return rows.filter((r) => !taken.has(String(r.id))).map((r) => ({
    id: String(r.id), amountCents: Number(r.amount_cents), postedDate: String(r.posted_date), name: String(r.name ?? ''), merchantKey: (r.merchant_key as string | null) ?? null,
  }));
}

export async function applyDepositMatch(workOrderIds: string[], txnId: string, method: string, confidence: number, explanation: string): Promise<void> {
  const { error } = await supabase.rpc('wog_deposit_match_apply', {
    p_work_order_ids: workOrderIds, p_bank_transaction_id: txnId, p_method: method, p_confidence: confidence, p_explanation: explanation,
  });
  if (error) fail(error, 'Could not apply the match.');
}

export async function removeDepositMatch(workOrderId: string): Promise<void> {
  const { error } = await supabase.rpc('wog_deposit_match_remove', { p_work_order_id: workOrderId });
  if (error) fail(error, 'Could not remove the match.');
}
