/**
 * Stored-value liability — API layer. RLS already limits every read to the account owner and
 * billing-permitted managers; the explicit account_owner_id filter is defence-in-depth.
 */
import { supabase } from '@/lib/supabase';
import {
  DEFAULT_SETTINGS,
  type DormancyRow,
  type InstrumentRow,
  type LiabilitySummaryRow,
  type StoredValueSettings,
} from '@/lib/storedValueLiability';

const SUMMARY_COLS =
  'account_owner_id, instrument_kind, currency, instrument_count, outstanding_cents, expired_count, expired_cents, past_review_count, past_review_cents, unreconciled_count, oldest_activity_at';
const DORMANCY_COLS = 'account_owner_id, instrument_kind, currency, inactivity_bucket, instrument_count, balance_cents';
const INSTRUMENT_COLS =
  'account_owner_id, instrument_id, instrument_kind, balance_cents, currency, issued_at, expires_at, last_activity_at, reference_suffix, ledger_reconciled, is_expired, days_inactive, inactivity_bucket, review_period_months, past_review_period';

const PAGE = 1000;
export const EXPORT_ROW_CAP = 50_000;

export async function fetchLiabilitySnapshot(ownerId: string): Promise<{
  summary: LiabilitySummaryRow[];
  dormancy: DormancyRow[];
  settings: StoredValueSettings;
}> {
  const [s, d, c] = await Promise.all([
    supabase.from('stored_value_liability_summary_v').select(SUMMARY_COLS).eq('account_owner_id', ownerId),
    supabase.from('stored_value_dormancy_v').select(DORMANCY_COLS).eq('account_owner_id', ownerId),
    supabase
      .from('stored_value_settings')
      .select('state_code, review_period_months, include_loyalty_points')
      .eq('account_owner_id', ownerId)
      .maybeSingle(),
  ]);
  if (s.error) throw s.error;
  if (d.error) throw d.error;
  if (c.error) throw c.error;
  return {
    summary: (s.data ?? []) as LiabilitySummaryRow[],
    dormancy: (d.data ?? []) as DormancyRow[],
    settings: (c.data as StoredValueSettings | null) ?? DEFAULT_SETTINGS,
  };
}

/** Pages through the instrument view (stable order) up to EXPORT_ROW_CAP. `truncated` tells the UI to say so. */
export async function fetchAllInstruments(ownerId: string): Promise<{ rows: InstrumentRow[]; truncated: boolean }> {
  const rows: InstrumentRow[] = [];
  for (let from = 0; from < EXPORT_ROW_CAP; from += PAGE) {
    const { data, error } = await supabase
      .from('stored_value_instruments_v')
      .select(INSTRUMENT_COLS)
      .eq('account_owner_id', ownerId)
      .order('last_activity_at', { ascending: true })
      .order('instrument_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as InstrumentRow[];
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export async function saveSettings(input: StoredValueSettings): Promise<void> {
  const { error } = await supabase.rpc('set_stored_value_settings', {
    p_state_code: input.state_code,
    p_review_period_months: input.review_period_months,
    p_include_loyalty_points: input.include_loyalty_points,
  });
  if (error) throw error;
}

/** Triggers a browser download. Revokes the object URL afterwards. */
export function downloadCsv(csv: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
