import { supabase } from '@/lib/supabase';
import {
  type AgendaSegment,
  type Direction,
  type Issue,
  type IssueSource,
  type IssueStatus,
  type MetricKey,
  type MetricValue,
  type Priority,
  type PriorityStatus,
  type Seat,
  type SnapshotRow,
  type Target,
} from '@/lib/cadence';

/**
 * Operating Cadence — Supabase access. Scoping, role rules and masking of
 * financial data are enforced by RLS / SECURITY DEFINER functions
 * (see 20271120000000_operating_cadence.sql); nothing here trusts the client.
 */

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Settings, scorecard, snapshots, targets
// ---------------------------------------------------------------------------
export async function fetchTimezone(): Promise<string | null> {
  const { data, error } = await supabase.from('cadence_settings').select('timezone').maybeSingle();
  if (error) throw error;
  return (data as { timezone: string } | null)?.timezone ?? null;
}

export async function saveTimezone(timezone: string): Promise<void> {
  const { data: existing, error: readErr } = await supabase.from('cadence_settings').select('user_id').maybeSingle();
  if (readErr) throw readErr;
  const { error } = existing
    ? await supabase.from('cadence_settings').update({ timezone }).eq('user_id', (existing as { user_id: string }).user_id)
    : await supabase.from('cadence_settings').insert({ timezone });
  if (error) throw error;
}

export async function fetchScorecard(weekStart: string): Promise<MetricValue[]> {
  const { data, error } = await supabase.rpc('cadence_scorecard', { p_week_start: weekStart });
  if (error) throw error;
  return ((data as MetricValue[] | null) ?? []).map((m) => ({
    ...m,
    value: m.value === null ? null : Number(m.value),
    detail: m.detail ?? {},
  }));
}

/** Managers only (others get 'forbidden'); callers treat that as "nothing to capture". */
export async function captureWeeks(weeks = 13): Promise<number> {
  const { data, error } = await supabase.rpc('cadence_capture_weeks', { p_weeks: weeks });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function fetchSnapshots(weeks: string[]): Promise<SnapshotRow[]> {
  if (!weeks.length) return [];
  const { data, error } = await supabase
    .from('cadence_snapshots')
    .select('week_start, metric_key, value')
    .in('week_start', weeks)
    .limit(weeks.length * 7);
  if (error) throw error;
  return ((data as SnapshotRow[] | null) ?? []).map((s) => ({ ...s, value: s.value === null ? null : Number(s.value) }));
}

export async function fetchTargets(): Promise<Target[]> {
  const { data, error } = await supabase.from('cadence_targets').select('metric_key, target_value, direction');
  if (error) throw error;
  return ((data as Target[] | null) ?? []).map((t) => ({ ...t, target_value: Number(t.target_value) }));
}

export async function saveTarget(metricKey: MetricKey, targetValue: number, direction: Direction): Promise<void> {
  const { error } = await supabase
    .from('cadence_targets')
    .upsert({ metric_key: metricKey, target_value: targetValue, direction }, { onConflict: 'user_id,metric_key' });
  if (error) throw error;
}

export async function deleteTarget(metricKey: MetricKey): Promise<void> {
  const { error } = await supabase.from('cadence_targets').delete().eq('metric_key', metricKey);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Priorities (+ optional link to strategic_goals)
// ---------------------------------------------------------------------------
const PRIORITY_COLS = 'id, title, description, owner_user_id, owner_name, due_date, status, progress_pct, goal_id, completed_at';

export async function fetchPriorities(quarterFrom: string): Promise<Priority[]> {
  // Everything not done, plus what was completed/due since the quarter began.
  const { data, error } = await supabase
    .from('cadence_priorities')
    .select(PRIORITY_COLS)
    .or(`status.neq.done,due_date.gte.${quarterFrom},completed_at.gte.${quarterFrom}`)
    .order('due_date', { ascending: true })
    .limit(300);
  if (error) throw error;
  return (data as Priority[] | null) ?? [];
}

export interface PriorityInput {
  title: string;
  description: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  due_date: string;
  goal_id: string | null;
}

export async function createPriority(input: PriorityInput): Promise<void> {
  const { error } = await supabase.from('cadence_priorities').insert({ ...input, title: input.title.trim() });
  if (error) throw error;
}

export async function updatePriority(id: string, input: PriorityInput): Promise<void> {
  const { error } = await supabase.from('cadence_priorities').update({ ...input, title: input.title.trim() }).eq('id', id);
  if (error) throw error;
}

export async function setPriorityProgress(id: string, status: PriorityStatus, progress: number): Promise<void> {
  const { error } = await supabase
    .from('cadence_priorities')
    .update({ status, progress_pct: Math.min(100, Math.max(0, Math.round(progress))) })
    .eq('id', id);
  if (error) throw error;
}

export async function deletePriority(id: string): Promise<void> {
  const { error } = await supabase.from('cadence_priorities').delete().eq('id', id);
  if (error) throw error;
}

export interface GoalOption {
  id: string;
  vision: string;
  progress_pct: number;
}

/** Active strategic goals (Goal Orchestrator) that a priority can point at. */
export async function fetchGoals(): Promise<GoalOption[]> {
  const { data, error } = await supabase
    .from('strategic_goals')
    .select('id, vision, progress_pct')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return []; // table optional: priorities work without goals
  return ((data as GoalOption[] | null) ?? []).map((g) => ({ ...g, progress_pct: Number(g.progress_pct) }));
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------
const ISSUE_COLS =
  'id, title, description, status, source_type, source_ref, metric_key, impact_cents, needs_decision, owner_user_id, owner_name, resolution, solved_at, created_at, created_by';

/** Live issues + issues closed in the last 120 days (for the 90-day review). */
export async function fetchIssues(now: Date = new Date()): Promise<Issue[]> {
  const since = new Date(now.getTime() - 120 * 86_400_000).toISOString();
  const [live, closed] = await Promise.all([
    supabase.from('cadence_issues').select(ISSUE_COLS).in('status', ['open', 'discussing']).order('created_at', { ascending: false }).limit(300),
    supabase.from('cadence_issues').select(ISSUE_COLS).in('status', ['solved', 'dropped']).gte('solved_at', since).order('solved_at', { ascending: false }).limit(300),
  ]);
  if (live.error) throw live.error;
  if (closed.error) throw closed.error;
  const norm = (rows: unknown) =>
    ((rows as Issue[] | null) ?? []).map((i) => ({ ...i, impact_cents: i.impact_cents === null ? null : Number(i.impact_cents) }));
  return [...norm(live.data), ...norm(closed.data)];
}

export interface IssueInput {
  title: string;
  description: string | null;
  impact_cents: number | null;
  needs_decision: boolean;
  owner_user_id: string | null;
  owner_name: string | null;
  source_type?: IssueSource;
  source_ref?: string | null;
  metric_key?: MetricKey | null;
}

export type EscalateResult = 'created' | 'duplicate';

/** Creates an issue; the same alert / KPI miss / NBA can't be escalated twice while live. */
export async function createIssue(input: IssueInput): Promise<EscalateResult> {
  const { error } = await supabase.from('cadence_issues').insert({
    source_type: 'manual',
    source_ref: null,
    metric_key: null,
    ...input,
    title: input.title.trim(),
  });
  if (error) {
    if ((error as { code?: string }).code === '23505') return 'duplicate';
    throw error;
  }
  return 'created';
}

export async function updateIssue(id: string, patch: Partial<Pick<IssueInput, 'title' | 'description' | 'impact_cents' | 'needs_decision' | 'owner_user_id' | 'owner_name'>> & { status?: IssueStatus; resolution?: string | null }): Promise<void> {
  const { data, error } = await supabase.from('cadence_issues').update(patch).eq('id', id).select('id');
  if (error) throw error;
  // RLS filters rows you may not change instead of raising an error.
  if (!data?.length) throw new Error('You don’t have permission to change this issue.');
}

export async function deleteIssue(id: string): Promise<void> {
  const { error } = await supabase.from('cadence_issues').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Accountability chart
// ---------------------------------------------------------------------------
const SEAT_COLS = 'id, parent_id, title, holder_user_id, holder_name, responsibilities, metric_keys, sort_order';

export async function fetchSeats(): Promise<Seat[]> {
  const { data, error } = await supabase.from('cadence_seats').select(SEAT_COLS).order('sort_order').limit(200);
  if (error) throw error;
  return (data as Seat[] | null) ?? [];
}

export type SeatInput = Omit<Seat, 'id' | 'sort_order'> & { sort_order?: number };

export async function createSeat(input: SeatInput): Promise<void> {
  const { error } = await supabase.from('cadence_seats').insert({ ...input, title: input.title.trim() });
  if (error) throw error;
}

export async function updateSeat(id: string, input: SeatInput): Promise<void> {
  const { error } = await supabase.from('cadence_seats').update({ ...input, title: input.title.trim() }).eq('id', id);
  if (error) throw error;
}

export async function deleteSeat(id: string): Promise<void> {
  const { error } = await supabase.from('cadence_seats').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Meetings + action items
// ---------------------------------------------------------------------------
export interface Meeting {
  id: string;
  week_start: string;
  status: 'in_progress' | 'completed';
  agenda: AgendaSegment[];
  current_segment: number;
  segment_started_at: string | null;
  segment_elapsed_ms: number[];
  attendee_user_ids: string[];
  notes: string | null;
  started_at: string;
  ended_at: string | null;
  recap_sent_at: string | null;
}

const MEETING_COLS =
  'id, week_start, status, agenda, current_segment, segment_started_at, segment_elapsed_ms, attendee_user_ids, notes, started_at, ended_at, recap_sent_at';

export async function fetchLiveMeeting(): Promise<Meeting | null> {
  const { data, error } = await supabase.from('cadence_meetings').select(MEETING_COLS).eq('status', 'in_progress').maybeSingle();
  if (error) throw error;
  return (data as Meeting | null) ?? null;
}

export async function fetchRecentMeetings(limit = 10): Promise<Meeting[]> {
  const { data, error } = await supabase
    .from('cadence_meetings')
    .select(MEETING_COLS)
    .eq('status', 'completed')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as Meeting[] | null) ?? [];
}

export async function startMeeting(args: { weekStart: string; agenda: AgendaSegment[]; attendeeIds: string[] }): Promise<Meeting> {
  const { data, error } = await supabase
    .from('cadence_meetings')
    .insert({
      week_start: args.weekStart,
      agenda: args.agenda,
      attendee_user_ids: args.attendeeIds,
      current_segment: 0,
      segment_started_at: new Date().toISOString(),
      segment_elapsed_ms: [],
    })
    .select(MEETING_COLS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505') throw new Error('A meeting is already in progress.');
    throw error;
  }
  return data as Meeting;
}

export async function saveMeetingProgress(
  id: string,
  patch: Partial<Pick<Meeting, 'notes' | 'current_segment' | 'segment_started_at' | 'segment_elapsed_ms' | 'attendee_user_ids'>>,
): Promise<void> {
  const { error } = await supabase.from('cadence_meetings').update(patch).eq('id', id).eq('status', 'in_progress');
  if (error) throw error;
}

export async function completeMeeting(id: string, patch: { notes: string | null; segment_elapsed_ms: number[] }): Promise<void> {
  const { error } = await supabase
    .from('cadence_meetings')
    .update({ ...patch, status: 'completed', segment_started_at: null })
    .eq('id', id)
    .eq('status', 'in_progress');
  if (error) throw error;
}

export interface ActionItem {
  id: string;
  meeting_id: string;
  title: string;
  owner_user_id: string | null;
  owner_name: string | null;
  due_date: string | null;
  task_id: string | null;
  created_at: string;
  /** Live status of the linked task (null when there is none). */
  task_status: 'todo' | 'in_progress' | 'done' | null;
}

export async function fetchActionItems(meetingIds: string[]): Promise<ActionItem[]> {
  if (!meetingIds.length) return [];
  const { data, error } = await supabase
    .from('cadence_action_items')
    .select('id, meeting_id, title, owner_user_id, owner_name, due_date, task_id, created_at')
    .in('meeting_id', meetingIds)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  const items = (data as Omit<ActionItem, 'task_status'>[] | null) ?? [];
  const taskIds = items.map((i) => i.task_id).filter((x): x is string => Boolean(x));
  const status = new Map<string, ActionItem['task_status']>();
  if (taskIds.length) {
    const { data: tasks } = await supabase.from('tasks').select('id, status').in('id', taskIds);
    for (const t of (tasks as { id: string; status: ActionItem['task_status'] }[] | null) ?? []) status.set(t.id, t.status);
  }
  return items.map((i) => ({ ...i, task_status: i.task_id ? status.get(i.task_id) ?? null : null }));
}

export async function addActionItem(args: { meetingId: string; title: string; ownerUserId: string | null; ownerName: string | null; dueDate: string | null }): Promise<void> {
  const { error } = await supabase.rpc('cadence_add_action_item', {
    p_meeting_id: args.meetingId,
    p_title: args.title,
    p_owner_user_id: args.ownerUserId,
    p_owner_name: args.ownerName,
    p_due: args.dueDate,
  });
  if (error) throw error;
}

export async function deleteActionItem(id: string): Promise<void> {
  const { error } = await supabase.from('cadence_action_items').delete().eq('id', id);
  if (error) throw error;
}

export async function sendMeetingRecap(meetingId: string, resend = false): Promise<{ sent: number }> {
  const { data, error } = await supabase.functions.invoke('cadence-meeting-recap', { body: { meeting_id: meetingId, resend } });
  if (error) throw new Error(await functionErrorMessage(error, 'Could not send the recap. Try again shortly.'));
  if (data?.error) throw new Error(String(data.error));
  return { sent: Number(data?.sent ?? 0) };
}
