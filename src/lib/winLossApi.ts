/**
 * Win/loss analysis — data access. Staff only: access is enforced by RLS
 * (is_vireek_staff) on win_loss_records / win_loss_summary; the route is also wrapped in <StaffRoute>.
 * There is no account scoping because this is Vireek-internal data, not tenant data.
 */
import { supabase } from '@/lib/supabase';
import type { SummaryRow, WinLossPayload, WinLossRecord } from '@/lib/winLoss';

export type WinLossErrorCode = 'forbidden' | 'invalid' | 'unknown';

export class WinLossApiError extends Error {
  constructor(public readonly code: WinLossErrorCode) {
    super(code);
    this.name = 'WinLossApiError';
  }
}

interface PgError { code?: string }

const toError = (e: PgError): WinLossApiError =>
  new WinLossApiError(e.code === '42501' ? 'forbidden' : e.code === '23514' || e.code === '22023' ? 'invalid' : 'unknown');

const COLUMNS = 'id, deal_name, outcome, competitor, reasons, notes, closed_on, deal_value_cents, interview_status, created_at, updated_at';

export async function fetchWinLossRecords(limit = 200): Promise<WinLossRecord[]> {
  const { data, error } = await supabase
    .from('win_loss_records')
    .select(COLUMNS)
    .order('closed_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  if (error) throw toError(error);
  return (data as unknown as WinLossRecord[]) ?? [];
}

export async function fetchWinLossSummary(): Promise<SummaryRow[]> {
  const { data, error } = await supabase
    .from('win_loss_summary')
    .select('dimension, bucket, wins, losses, no_decisions, decided, win_rate_pct, won_value_cents, lost_value_cents');
  if (error) throw toError(error);
  return ((data as unknown as SummaryRow[]) ?? []).map((r) => ({
    ...r,
    win_rate_pct: r.win_rate_pct === null ? null : Number(r.win_rate_pct),
    won_value_cents: Number(r.won_value_cents),
    lost_value_cents: Number(r.lost_value_cents),
  }));
}

export async function createWinLossRecord(payload: WinLossPayload): Promise<void> {
  const { error } = await supabase.from('win_loss_records').insert(payload);
  if (error) throw toError(error);
}

export async function updateWinLossRecord(id: string, payload: WinLossPayload): Promise<void> {
  const { data, error } = await supabase.from('win_loss_records').update(payload).eq('id', id).select('id');
  if (error) throw toError(error);
  // RLS filters rows silently: zero rows updated means "not allowed or gone".
  if (!data || data.length === 0) throw new WinLossApiError('forbidden');
}

export async function deleteWinLossRecord(id: string): Promise<void> {
  const { data, error } = await supabase.from('win_loss_records').delete().eq('id', id).select('id');
  if (error) throw toError(error);
  if (!data || data.length === 0) throw new WinLossApiError('forbidden');
}
