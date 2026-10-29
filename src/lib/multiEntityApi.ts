import { supabase } from '@/lib/supabase';
import type {
  AccountingEntity, BalanceRow, EntityDraft, IcKind, IcTransaction, JournalLinePayload,
} from '@/lib/multiEntity';

/**
 * Multi-entity accounting — API layer.
 * Reads go through RLS-protected tables / the me_entity_balances RPC; every write
 * is a SECURITY DEFINER RPC (balanced entries, closed periods, owner/billing checks).
 */

const ENTITY_COLUMNS =
  'id, code, name, legal_name, entity_type, country, ownership_pct, consolidation_method, is_primary, is_active';
const TXN_COLUMNS =
  'id, txn_number, txn_date, kind, from_entity_id, to_entity_id, amount_cents, settled_cents, status, description, void_reason, created_at';

export async function fetchEntities(): Promise<AccountingEntity[]> {
  const { data, error } = await supabase
    .from('accounting_entities')
    .select(ENTITY_COLUMNS)
    .order('is_primary', { ascending: false })
    .order('code');
  if (error) throw error;
  return ((data ?? []) as AccountingEntity[]).map((e) => ({ ...e, ownership_pct: Number(e.ownership_pct) }));
}

export async function setupMultiEntity(primaryName?: string): Promise<void> {
  const { error } = await supabase.rpc('me_setup', { p_primary_name: primaryName?.trim() || null });
  if (error) throw error;
}

export async function saveEntity(d: EntityDraft): Promise<string> {
  const { data, error } = await supabase.rpc('me_upsert_entity', {
    p_id: d.id,
    p_code: d.code.trim(),
    p_name: d.name.trim(),
    p_legal_name: d.legal_name.trim() || null,
    p_entity_type: d.entity_type,
    p_country: d.country.trim() || null,
    p_ownership_pct: Number(d.ownership_pct),
    p_method: d.consolidation_method,
    p_is_active: d.is_active,
  });
  if (error) throw error;
  return data as string;
}

export async function fetchBalances(from: string, to: string): Promise<BalanceRow[]> {
  const { data, error } = await supabase.rpc('me_entity_balances', { p_start: from, p_end: to });
  if (error) throw error;
  return (data as BalanceRow[] | null) ?? [];
}

export async function fetchIntercompany(limit = 300): Promise<IcTransaction[]> {
  const { data, error } = await supabase
    .from('intercompany_transactions')
    .select(TXN_COLUMNS)
    .order('txn_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as IcTransaction[]).map((t) => ({
    ...t, amount_cents: Number(t.amount_cents), settled_cents: Number(t.settled_cents),
  }));
}

export interface PostIntercompanyInput {
  from_entity_id: string;
  to_entity_id: string;
  kind: IcKind;
  txn_date: string;
  amount_cents: number;
  description: string;
  idempotency_key: string;
}

export async function postIntercompany(i: PostIntercompanyInput): Promise<string> {
  const { data, error } = await supabase.rpc('me_post_intercompany', {
    p_from_entity: i.from_entity_id,
    p_to_entity: i.to_entity_id,
    p_kind: i.kind,
    p_date: i.txn_date,
    p_amount_cents: i.amount_cents,
    p_description: i.description.trim() || null,
    p_idempotency_key: i.idempotency_key,
  });
  if (error) throw error;
  return data as string;
}

export async function settleIntercompany(txnId: string, date: string, amountCents: number): Promise<string> {
  const { data, error } = await supabase.rpc('me_settle_intercompany', {
    p_txn_id: txnId, p_date: date, p_amount_cents: amountCents,
  });
  if (error) throw error;
  return data as string;
}

export async function voidIntercompany(txnId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('me_void_intercompany', { p_txn_id: txnId, p_reason: reason.trim() });
  if (error) throw error;
}

export async function postEntityJournal(
  entityId: string, date: string, memo: string, lines: JournalLinePayload[],
): Promise<string> {
  const { data, error } = await supabase.rpc('me_post_entity_journal', {
    p_entity_id: entityId, p_date: date, p_memo: memo.trim() || null, p_lines: lines,
  });
  if (error) throw error;
  return data as string;
}
