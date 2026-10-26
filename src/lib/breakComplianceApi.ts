import { supabase } from './supabase';
import {
  normalizeSettings,
  type BreakSettings,
  type ReviewRecord,
  type ShiftRecord,
  type ViolationCode,
} from './breakCompliance';

export interface BreakOptions {
  can_manage: boolean;
  settings: BreakSettings;
  members: { id: string; name: string }[];
}

type RawShift = {
  id: string;
  team_member_id: string;
  work_date: string;
  clock_in_at: string;
  clock_out_at: string | null;
  time_shift_breaks: { started_at: string; ended_at: string | null }[] | null;
};

const RULES_CACHE_KEY = 'vireek.breakRules.v1';

// ============================================================
// QUERIES
// ============================================================

export async function getBreakOptions(): Promise<BreakOptions> {
  const { data, error } = await supabase.rpc('break_compliance_options');
  if (error) throw error;
  const d = (data ?? {}) as { can_manage?: boolean; settings?: unknown; members?: { id: string; name: string }[] };
  return {
    can_manage: d.can_manage ?? false,
    settings: normalizeSettings(d.settings),
    members: d.members ?? [],
  };
}

/** Shifts (with their breaks) from `sinceDate` (YYYY-MM-DD) on. `accountOwnerId` is an explicit filter on top of RLS. */
export async function listShiftsForReport(accountOwnerId: string, sinceDate: string): Promise<ShiftRecord[]> {
  const { data, error } = await supabase
    .from('time_shifts')
    .select('id, team_member_id, work_date, clock_in_at, clock_out_at, time_shift_breaks(started_at, ended_at)')
    .eq('user_id', accountOwnerId)
    .gte('work_date', sinceDate)
    .order('clock_in_at', { ascending: false })
    .limit(5000);
  if (error) throw error;
  return ((data ?? []) as unknown as RawShift[]).map((s) => ({
    id: s.id,
    team_member_id: s.team_member_id,
    work_date: s.work_date,
    clock_in_at: s.clock_in_at,
    clock_out_at: s.clock_out_at,
    breaks: s.time_shift_breaks ?? [],
  }));
}

export async function listReviews(accountOwnerId: string, shiftIds: string[]): Promise<ReviewRecord[]> {
  if (shiftIds.length === 0) return [];
  const out: ReviewRecord[] = [];
  // Chunked so the request URL stays short for large reports.
  for (let i = 0; i < shiftIds.length; i += 200) {
    const { data, error } = await supabase
      .from('break_violation_reviews')
      .select('shift_id, code, status, note')
      .eq('user_id', accountOwnerId)
      .in('shift_id', shiftIds.slice(i, i + 200));
    if (error) throw error;
    out.push(...((data ?? []) as ReviewRecord[]));
  }
  return out;
}

// ============================================================
// TECHNICIAN RULES (cached so prompts also work offline)
// ============================================================

export function readCachedRules(): BreakSettings | null {
  try {
    const raw = window.localStorage.getItem(RULES_CACHE_KEY);
    return raw ? normalizeSettings(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export async function fetchMyBreakRules(): Promise<BreakSettings> {
  const { data, error } = await supabase.rpc('my_break_rules');
  if (error) throw error;
  const rules = normalizeSettings(data);
  try {
    window.localStorage.setItem(RULES_CACHE_KEY, JSON.stringify(rules));
  } catch {
    /* storage unavailable: prompts just refetch next time */
  }
  return rules;
}

// ============================================================
// MUTATIONS — every write is an RPC; the server re-checks permissions
// ============================================================

export async function saveBreakSettings(s: BreakSettings): Promise<void> {
  const { error } = await supabase.rpc('save_break_compliance_settings', {
    p_enabled: s.enabled,
    p_meal_min: s.meal_min_minutes,
    p_meal_deadline: s.meal_deadline_minutes,
    p_meal_thresholds: s.meal_thresholds,
    p_rest_min: s.rest_min_minutes,
    p_rest_thresholds: s.rest_thresholds,
    p_premium: s.premium_minutes,
    p_prompts: s.prompts_enabled,
    p_lead: s.prompt_lead_minutes,
  });
  if (error) throw error;
}

export async function reviewViolation(
  shiftId: string,
  code: ViolationCode,
  status: 'open' | 'waived' | 'excused' | 'premium_paid',
  note: string,
): Promise<void> {
  const { error } = await supabase.rpc('review_break_violation', {
    p_shift_id: shiftId,
    p_code: code,
    p_status: status,
    p_note: note.trim() ? note.trim() : null,
  });
  if (error) throw error;
}
