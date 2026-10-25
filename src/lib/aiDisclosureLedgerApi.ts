import { supabase } from '@/lib/supabase';
import {
  normalizeSummary,
  type DriftCheck,
  type LedgerRow,
  type LedgerStatus,
  type LedgerSummary,
  type VersionRow,
} from '@/lib/aiDisclosureLedger';

/**
 * AI Disclosure Proof Ledger — Supabase access. Permissions and account scoping
 * are enforced by RLS (see 20271112000000_ai_disclosure_proof_ledger.sql); the
 * explicit user_id filter is defence in depth, like the other call pages.
 */

export const PAGE_SIZE = 25;
const EXPORT_PAGE = 1000;
export const EXPORT_MAX_ROWS = 20_000;
const ROW_SELECT = '*, calls(caller_name, caller_phone, call_datetime)';

export interface LedgerQuery {
  from: string;
  to: string;
  status: LedgerStatus | 'all';
  search: string;
  page: number;
}

export async function fetchSummary(from: string, to: string): Promise<LedgerSummary> {
  const { data, error } = await supabase.rpc('ai_disclosure_summary', { p_from: from, p_to: to });
  if (error) throw error;
  return normalizeSummary(data);
}

export async function fetchLedgerPage(accountOwnerId: string, q: LedgerQuery): Promise<{ rows: LedgerRow[]; total: number }> {
  let query = supabase
    .from('call_ai_disclosures')
    .select(ROW_SELECT, { count: 'exact' })
    .eq('user_id', accountOwnerId)
    .gte('created_at', q.from)
    .lt('created_at', q.to)
    .order('created_at', { ascending: false })
    .range(q.page * PAGE_SIZE, q.page * PAGE_SIZE + PAGE_SIZE - 1);
  if (q.status !== 'all') query = query.eq('status', q.status);
  const term = q.search.trim().replace(/[%,()]/g, '');
  if (term) query = query.ilike('vapi_call_id', `%${term}%`);
  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: (data ?? []) as unknown as LedgerRow[], total: count ?? 0 };
}

/** Every row in the range (paged), capped so a huge account can't freeze the tab. */
export async function fetchAllForExport(
  accountOwnerId: string,
  from: string,
  to: string,
): Promise<{ rows: LedgerRow[]; truncated: boolean }> {
  const rows: LedgerRow[] = [];
  for (let offset = 0; offset < EXPORT_MAX_ROWS; offset += EXPORT_PAGE) {
    const { data, error } = await supabase
      .from('call_ai_disclosures')
      .select(ROW_SELECT)
      .eq('user_id', accountOwnerId)
      .gte('created_at', from)
      .lt('created_at', to)
      .order('created_at', { ascending: true })
      .range(offset, offset + EXPORT_PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as LedgerRow[];
    rows.push(...batch);
    if (batch.length < EXPORT_PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export async function fetchVersions(accountOwnerId: string): Promise<VersionRow[]> {
  const { data, error } = await supabase
    .from('ai_disclosure_versions')
    .select('*')
    .eq('user_id', accountOwnerId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as VersionRow[];
}

export async function fetchDriftChecks(accountOwnerId: string): Promise<DriftCheck[]> {
  const { data, error } = await supabase
    .from('ai_disclosure_drift_checks')
    .select('*')
    .eq('user_id', accountOwnerId)
    .order('checked_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as DriftCheck[];
}

export async function runDriftCheck(): Promise<void> {
  const { error } = await supabase.functions.invoke('ai-disclosure-drift-scan', { body: {} });
  if (error) throw error;
}

export async function fetchScriptConfig(accountOwnerId: string): Promise<{ script: string; language: string } | null> {
  const { data, error } = await supabase
    .from('business_profile')
    .select('ai_disclosure_script, ai_disclosure_language')
    .eq('user_id', accountOwnerId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    script: (data as { ai_disclosure_script: string }).ai_disclosure_script,
    language: (data as { ai_disclosure_language?: string }).ai_disclosure_language ?? 'en',
  };
}

export async function saveScriptLanguage(accountOwnerId: string, language: string): Promise<void> {
  const { error } = await supabase.from('business_profile').update({ ai_disclosure_language: language }).eq('user_id', accountOwnerId);
  if (error) throw error;
}
