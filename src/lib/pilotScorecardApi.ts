// src/lib/pilotScorecardApi.ts — data access. Tenant and permission are resolved server-side by the RPCs.
import { supabase } from './supabase';
import { buildScorecard, type RawScorecard, type Scorecard } from './pilotScorecard';

export type WrongCallReason = 'wrong_price' | 'wrong_booking' | 'missed_emergency' | 'false_emergency' | 'wrong_escalation' | 'promised_arrival' | 'other';

export async function fetchWeeklyScorecard(weekStart?: string): Promise<Scorecard> {
  const { data, error } = await supabase.rpc('get_weekly_scorecard', { p_week_start: weekStart ?? null });
  if (error) {
    if (error.code === '42501') throw new Error('You don’t have permission to view the scorecard.');
    throw new Error(error.message);
  }
  return buildScorecard(data as RawScorecard);
}

/** Returns the new candidate id, or null when this call had already been reported. Transcript is stored only with consent. */
export async function reportWrongCall(input: { callId: string; reason: WrongCallReason; note?: string; shareForEval: boolean }): Promise<string | null> {
  const { data, error } = await supabase.rpc('report_wrong_call', {
    p_call_id: input.callId, p_reason: input.reason, p_note: input.note ?? null, p_share_for_eval: input.shareForEval,
  });
  if (error) {
    if (error.code === '42501') throw new Error('You don’t have permission to report calls.');
    throw new Error(error.message);
  }
  return (data as string | null) ?? null;
}
