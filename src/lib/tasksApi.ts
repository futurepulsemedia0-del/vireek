import { supabase } from '@/lib/supabase';
import {
  draftToColumns,
  endOfDay,
  nextOccurrence,
  type TaskDraft,
  type TaskItem,
  type TaskStatus,
} from '@/lib/tasks';

/**
 * Tasks — Supabase access. All scoping/permissions are enforced by RLS
 * (see 20270501000000_tasks.sql); nothing here trusts the client.
 */

const SELECT_WITH_LINKS =
  '*, customer:customers(id,name), job:jobs(id,customer_name,service_type), lead:leads(id,name)';

const DONE_WINDOW_DAYS = 30;

export interface Assignee {
  userId: string;
  name: string;
  role: string;
}

export interface LinkOption {
  id: string;
  label: string;
  sublabel: string | null;
}

export type LinkKind = 'customer' | 'job' | 'lead';

/** Open tasks (up to 500) + tasks completed in the last 30 days (up to 150). */
export async function fetchTasks(now: Date = new Date()): Promise<TaskItem[]> {
  const since = new Date(now.getTime() - DONE_WINDOW_DAYS * 86_400_000).toISOString();
  const [open, done] = await Promise.all([
    supabase
      .from('tasks')
      .select(SELECT_WITH_LINKS)
      .neq('status', 'done')
      .order('due_at', { ascending: true, nullsFirst: false })
      .limit(500),
    supabase
      .from('tasks')
      .select(SELECT_WITH_LINKS)
      .eq('status', 'done')
      .gte('completed_at', since)
      .order('completed_at', { ascending: false })
      .limit(150),
  ]);
  if (open.error) throw open.error;
  if (done.error) throw done.error;
  return [...((open.data as unknown as TaskItem[]) ?? []), ...((done.data as unknown as TaskItem[]) ?? [])];
}

/** Open tasks due by the end of today (overdue included) for "me or unassigned". */
export async function fetchTodayTasks(userId: string, now: Date = new Date()): Promise<TaskItem[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select(SELECT_WITH_LINKS)
    .neq('status', 'done')
    .not('due_at', 'is', null)
    .lte('due_at', endOfDay(now).toISOString())
    .or(`assigned_to.eq.${userId},assigned_to.is.null`)
    .order('due_at', { ascending: true })
    .limit(50);
  if (error) throw error;
  return (data as unknown as TaskItem[]) ?? [];
}

/** Open tasks that have a reminder — used by the in-app reminder watcher. */
export async function fetchReminderCandidates(userId: string, now: Date = new Date()): Promise<TaskItem[]> {
  const horizon = new Date(now.getTime() + 3 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .neq('status', 'done')
    .not('reminder_offset_minutes', 'is', null)
    .not('due_at', 'is', null)
    .lte('due_at', horizon)
    .or(`assigned_to.eq.${userId},assigned_to.is.null`)
    .limit(50);
  if (error) throw error;
  return ((data as unknown as TaskItem[]) ?? []).map((t) => ({ ...t, customer: null, job: null, lead: null }));
}

export async function createTask(draft: TaskDraft, assigneeName: string | null): Promise<void> {
  const { error } = await supabase.from('tasks').insert(draftToColumns(draft, assigneeName));
  if (error) throw error;
}

export async function updateTask(id: string, draft: TaskDraft, assigneeName: string | null): Promise<void> {
  const { error } = await supabase.from('tasks').update(draftToColumns(draft, assigneeName)).eq('id', id);
  if (error) throw error;
}

export async function setTaskStatus(id: string, status: Exclude<TaskStatus, 'done'>): Promise<void> {
  const { error } = await supabase.from('tasks').update({ status }).eq('id', id);
  if (error) throw error;
}

/**
 * Completes a task atomically on the server. For recurring tasks the next
 * occurrence is computed here (tested logic) and created in the same
 * transaction. Returns true when a follow-up task was created.
 */
export async function completeTask(task: TaskItem, now: Date = new Date()): Promise<boolean> {
  const next = nextOccurrence(task.recurrence, task.due_at, now, task.recurrence_ends_on);
  const { data, error } = await supabase.rpc('complete_task', {
    p_task_id: task.id,
    p_next_due_at: next ? next.toISOString() : null,
  });
  if (error) throw error;
  return Boolean(data);
}

export async function reopenTask(id: string): Promise<void> {
  const { error } = await supabase.from('tasks').update({ status: 'todo' }).eq('id', id);
  if (error) throw error;
}

export async function deleteTask(id: string): Promise<void> {
  const { error } = await supabase.from('tasks').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Who a task can be assigned to. Managers get the account owner (themselves,
 * when they are the owner) plus every active teammate that has a login;
 * everyone else can only pick themselves (RLS enforces the same rule).
 */
export async function fetchAssignees(args: {
  userId: string;
  selfName: string;
  isManager: boolean;
}): Promise<Assignee[]> {
  const self: Assignee = { userId: args.userId, name: args.selfName, role: 'you' };
  if (!args.isManager) return [self];

  const { data, error } = await supabase
    .from('team_members')
    .select('user_id, member_name, member_email, role, invite_status')
    .eq('invite_status', 'active')
    .not('user_id', 'is', null);
  if (error) return [self];

  const others: Assignee[] = (
    (data as { user_id: string; member_name: string | null; member_email: string; role: string }[] | null) ?? []
  )
    .filter((m) => m.user_id !== args.userId)
    .map((m) => ({ userId: m.user_id, name: m.member_name || m.member_email, role: m.role }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [self, ...others];
}

/** Strips characters that have meaning inside PostgREST ilike filters. */
export function sanitizeSearch(q: string): string {
  return q.replace(/[%_\\,()*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Type-ahead for the link picker; empty query returns the most recent rows. */
export async function searchLinkTargets(kind: LinkKind, query: string): Promise<LinkOption[]> {
  const q = sanitizeSearch(query);

  if (kind === 'customer') {
    let req = supabase.from('customers').select('id, name, phone').order('updated_at', { ascending: false }).limit(8);
    if (q) req = req.ilike('name', `%${q}%`);
    const { data, error } = await req;
    if (error) throw error;
    return (data ?? []).map((c: { id: string; name: string; phone: string | null }) => ({
      id: c.id,
      label: c.name,
      sublabel: c.phone,
    }));
  }

  if (kind === 'lead') {
    let req = supabase.from('leads').select('id, name, service_interested').order('created_at', { ascending: false }).limit(8);
    if (q) req = req.ilike('name', `%${q}%`);
    const { data, error } = await req;
    if (error) throw error;
    return (data ?? []).map((l: { id: string; name: string; service_interested: string | null }) => ({
      id: l.id,
      label: l.name,
      sublabel: l.service_interested,
    }));
  }

  let req = supabase
    .from('jobs')
    .select('id, customer_name, service_type, scheduled_datetime')
    .order('created_at', { ascending: false })
    .limit(8);
  if (q) req = req.ilike('customer_name', `%${q}%`);
  const { data, error } = await req;
  if (error) throw error;
  return (data ?? []).map(
    (j: { id: string; customer_name: string; service_type: string | null; scheduled_datetime: string | null }) => ({
      id: j.id,
      label: j.customer_name,
      sublabel: [j.service_type, j.scheduled_datetime ? new Date(j.scheduled_datetime).toLocaleDateString('en-US') : null]
        .filter(Boolean)
        .join(' · ') || null,
    }),
  );
}
