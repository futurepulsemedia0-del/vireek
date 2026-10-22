import { supabase } from '@/lib/supabase';
import type {
  LeaderboardData,
  LeaderboardPeriod,
  LeaderboardSettingsRow,
  MySpiffs,
  PayoutStatus,
  RulePayload,
  SpiffPayout,
  SpiffRule,
} from '@/lib/technicianLeaderboard';

/** Turns a Postgres / PostgREST error into a sentence a person can act on. */
export function leaderboardErrorMessage(err: unknown): string {
  const e = err as { message?: string; code?: string } | null;
  if (e?.code === '42501') return 'You don’t have permission to do that.';
  if (e?.code === '23503') return 'This is still referenced by payouts. Pause the rule instead of deleting it.';
  if (e?.code === '23514') return 'One of the values is out of range. Check the amounts and targets.';
  return e?.message && e.message.length < 200 ? e.message : 'Something went wrong. Please try again.';
}

export async function fetchLeaderboard(period: LeaderboardPeriod, anchor: string): Promise<LeaderboardData> {
  const { data, error } = await supabase.rpc('get_leaderboard', { p_period: period, p_anchor: anchor });
  if (error) throw error;
  return data as LeaderboardData;
}

export async function setLeaderboardOptOut(optedOut: boolean, teamMemberId?: string): Promise<void> {
  const { error } = await supabase.rpc('set_leaderboard_opt_out', {
    p_opted_out: optedOut,
    p_team_member_id: teamMemberId ?? null,
  });
  if (error) throw error;
}

export async function fetchLeaderboardSettings(ownerId: string): Promise<LeaderboardSettingsRow | null> {
  const { data, error } = await supabase.from('leaderboard_settings').select('*').eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  return (data as LeaderboardSettingsRow | null) ?? null;
}

export async function saveLeaderboardSettings(
  ownerId: string,
  s: Omit<LeaderboardSettingsRow, 'user_id'>,
): Promise<void> {
  const { error } = await supabase
    .from('leaderboard_settings')
    .upsert({ ...s, user_id: ownerId, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function fetchSpiffRules(ownerId: string): Promise<SpiffRule[]> {
  const { data, error } = await supabase
    .from('spiff_rules')
    .select('id, name, kpi, period, rule_type, threshold, payout_cents, rank_payouts_cents, min_jobs, active, starts_on, ends_on')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as SpiffRule[];
}

export async function createSpiffRule(ownerId: string, payload: RulePayload): Promise<void> {
  const { error } = await supabase.from('spiff_rules').insert({ ...payload, user_id: ownerId });
  if (error) throw error;
}

export async function updateSpiffRule(ownerId: string, id: string, payload: Partial<RulePayload> & { active?: boolean }): Promise<void> {
  const { error } = await supabase
    .from('spiff_rules')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', ownerId);
  if (error) throw error;
}

export async function deleteSpiffRule(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('spiff_rules').delete().eq('id', id).eq('user_id', ownerId);
  if (error) throw error;
}

export async function fetchSpiffPayouts(status?: PayoutStatus): Promise<SpiffPayout[]> {
  const { data, error } = await supabase.rpc('get_spiff_payouts', { p_status: status ?? null, p_limit: 200 });
  if (error) throw error;
  return (data ?? []) as SpiffPayout[];
}

export async function reviewSpiffPayout(id: string, action: 'approve' | 'reject', note?: string): Promise<void> {
  const { error } = await supabase.rpc('review_spiff_payout', { p_id: id, p_action: action, p_note: note ?? null });
  if (error) throw error;
}

export async function generateSpiffPayouts(
  period: LeaderboardPeriod,
  anchor?: string,
): Promise<{ inserted: number; total_cents: number; period_start: string; period_end: string }> {
  const { data, error } = await supabase.rpc('generate_spiff_payouts', { p_period: period, p_anchor: anchor ?? null });
  if (error) throw error;
  return data as { inserted: number; total_cents: number; period_start: string; period_end: string };
}

export async function fetchMySpiffs(): Promise<MySpiffs> {
  const { data, error } = await supabase.rpc('get_my_spiffs', { p_limit: 50 });
  if (error) throw error;
  return data as MySpiffs;
}
