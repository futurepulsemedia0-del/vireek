import { supabase } from '@/lib/supabase';
import { draftToPayload, hasErrors, normalizeEntry, validateDraft, type ChangeDraft, type ChangeEntry } from '@/lib/changeCalendar';

/**
 * Data access for /staff/change-calendar. Reads rely on the staff-only SELECT policy; every write goes through a
 * SECURITY DEFINER RPC that re-checks staff status and writes the audit trail.
 * Schema + rules: supabase/migrations/20290311000000_change_calendar.sql.
 */

const COLUMNS =
  'id, category, title, summary, audience, owner_id, status, notice_date, effective_date, min_notice_days, reference_url, price_change_notice_id, notice_sent_at, decided_by, decided_at, decision_note, completed_at, cancelled_at, created_by, created_at, updated_at';

export interface StaffOption { id: string; label: string }
export interface CalendarEvent { id: number; entry_id: string; action: string; actor_id: string | null; at: string; note: string | null }

export async function fetchEntries(): Promise<ChangeEntry[]> {
  const { data, error } = await supabase.from('change_calendar_entries').select(COLUMNS).order('notice_date', { ascending: true }).limit(1000);
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []).flatMap((row) => {
    const e = normalizeEntry(row);
    return e ? [e] : [];
  });
}

export async function fetchEvents(entryId: string): Promise<CalendarEvent[]> {
  const { data, error } = await supabase
    .from('change_calendar_events')
    .select('id, entry_id, action, actor_id, at, note')
    .eq('entry_id', entryId)
    .order('at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? (data as CalendarEvent[]) : [];
}

/** Best effort: the owner picker. If profiles cannot be listed for this session the page falls back to the current user. */
export async function fetchStaffOptions(): Promise<StaffOption[]> {
  const { data, error } = await supabase.from('profiles').select('id, email').eq('is_staff', true).limit(100);
  if (error || !Array.isArray(data)) return [];
  return data.flatMap((r) => {
    const row = r as { id?: unknown; email?: unknown };
    return typeof row.id === 'string' ? [{ id: row.id, label: typeof row.email === 'string' && row.email ? row.email : row.id }] : [];
  });
}

async function rpc(name: string, args: Record<string, unknown>): Promise<ChangeEntry> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  const e = normalizeEntry(data);
  if (!e) throw new Error('unexpected_response');
  return e;
}

export async function saveEntry(draft: ChangeDraft, opts: { requireFuture: boolean }): Promise<ChangeEntry> {
  if (hasErrors(validateDraft(draft, opts))) throw new Error('invalid_entry');
  return rpc('staff_change_calendar_upsert', { p_entry: draftToPayload(draft) });
}
export const submitEntry = (id: string) => rpc('staff_change_calendar_submit', { p_id: id });
export const decideEntry = (id: string, approve: boolean, note: string | null) =>
  rpc('staff_change_calendar_decide', { p_id: id, p_approve: approve, p_note: note });
export const markNoticeSent = (id: string) => rpc('staff_change_calendar_mark_notice_sent', { p_id: id });
export const completeEntry = (id: string) => rpc('staff_change_calendar_complete', { p_id: id });
export const cancelEntry = (id: string, note: string) => rpc('staff_change_calendar_cancel', { p_id: id, p_note: note });
