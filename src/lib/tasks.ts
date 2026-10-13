/**
 * Tasks — pure domain logic (no network, no React).
 *
 * Everything time-dependent takes an injectable `now` so it is deterministic
 * under test. All calendar maths is done in the viewer's LOCAL time zone,
 * because "due today" / "every Monday at 9" mean the user's wall clock.
 *
 * Network access lives in tasksApi.ts; this file is covered by tasks.test.ts.
 */

export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskRecurrence = 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';

export interface TaskRow {
  id: string;
  user_id: string;
  created_by: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  reminder_offset_minutes: number | null;
  recurrence: TaskRecurrence;
  recurrence_ends_on: string | null;
  recurrence_parent_id: string | null;
  customer_id: string | null;
  job_id: string | null;
  lead_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskItem extends TaskRow {
  customer: { id: string; name: string } | null;
  job: { id: string; customer_name: string; service_type: string | null } | null;
  lead: { id: string; name: string } | null;
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

const PRIORITY_WEIGHT: Record<TaskPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

export const RECURRENCE_LABELS: Record<TaskRecurrence, string> = {
  none: 'Does not repeat',
  daily: 'Every day',
  weekly: 'Every week',
  biweekly: 'Every 2 weeks',
  monthly: 'Every month',
  quarterly: 'Every 3 months',
  yearly: 'Every year',
};

export const REMINDER_PRESETS: { minutes: number; label: string }[] = [
  { minutes: 0, label: 'At due time' },
  { minutes: 15, label: '15 minutes before' },
  { minutes: 60, label: '1 hour before' },
  { minutes: 240, label: '4 hours before' },
  { minutes: 1440, label: '1 day before' },
  { minutes: 2880, label: '2 days before' },
];

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 4000;

// ---------------------------------------------------------------- dates ---

const DAY_MS = 86_400_000;

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD (what a <input type="date"> uses). */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO instant -> value for <input type="datetime-local"> in local time. */
export function toInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${localDateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value (local time) -> ISO instant, or null. */
export function fromInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function addMonthsClamped(base: Date, months: number): Date {
  const d = new Date(base.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function stepFrom(base: Date, rule: Exclude<TaskRecurrence, 'none'>, k: number): Date {
  const d = new Date(base.getTime());
  switch (rule) {
    case 'daily':
      d.setDate(d.getDate() + k);
      return d;
    case 'weekly':
      d.setDate(d.getDate() + 7 * k);
      return d;
    case 'biweekly':
      d.setDate(d.getDate() + 14 * k);
      return d;
    case 'monthly':
      return addMonthsClamped(base, k);
    case 'quarterly':
      return addMonthsClamped(base, 3 * k);
    case 'yearly':
      return addMonthsClamped(base, 12 * k);
  }
}

/**
 * Next due date for a recurring task that is being completed `now`.
 *
 * - Always computed from the ORIGINAL due date (k steps), so a task on the
 *   31st does not drift to the 28th within one catch-up.
 * - Skips occurrences that are already in the past (a weekly task finished
 *   3 weeks late yields the next FUTURE slot, not three overdue clones).
 * - Returns null when the rule is 'none', the due date is invalid, or the
 *   next slot falls after `endsOn` (YYYY-MM-DD, local).
 */
export function nextOccurrence(
  rule: TaskRecurrence,
  dueIso: string | null,
  now: Date = new Date(),
  endsOn: string | null = null,
): Date | null {
  if (rule === 'none' || !dueIso) return null;
  const due = new Date(dueIso);
  if (Number.isNaN(due.getTime())) return null;

  let next: Date | null = null;
  for (let k = 1; k <= 5000; k += 1) {
    const candidate = stepFrom(due, rule, k);
    if (candidate.getTime() > now.getTime()) {
      next = candidate;
      break;
    }
  }
  if (!next) return null;
  if (endsOn && localDateKey(next) > endsOn) return null;
  return next;
}

// ---------------------------------------------------------- task status ---

export const isOpen = (t: Pick<TaskRow, 'status'>): boolean => t.status !== 'done';

export function isOverdue(t: Pick<TaskRow, 'status' | 'due_at'>, now: Date = new Date()): boolean {
  return isOpen(t) && t.due_at !== null && new Date(t.due_at).getTime() < now.getTime();
}

export type TaskBucket = 'overdue' | 'today' | 'upcoming' | 'no_date' | 'done';

export function bucketOf(t: Pick<TaskRow, 'status' | 'due_at'>, now: Date = new Date()): TaskBucket {
  if (!isOpen(t)) return 'done';
  if (!t.due_at) return 'no_date';
  if (isOverdue(t, now)) return 'overdue';
  return new Date(t.due_at).getTime() <= endOfDay(now).getTime() ? 'today' : 'upcoming';
}

export interface DueLabel {
  text: string;
  tone: 'danger' | 'accent' | 'neutral';
}

const timeFmt: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

export function describeDue(t: Pick<TaskRow, 'status' | 'due_at'>, now: Date = new Date()): DueLabel {
  if (!t.due_at) return { text: 'No due date', tone: 'neutral' };
  const due = new Date(t.due_at);
  if (Number.isNaN(due.getTime())) return { text: 'No due date', tone: 'neutral' };

  const time = due.toLocaleTimeString('en-US', timeFmt);
  const dayDiff = Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / DAY_MS);
  const open = isOpen(t);

  let day: string;
  if (dayDiff === 0) day = 'Today';
  else if (dayDiff === 1) day = 'Tomorrow';
  else if (dayDiff === -1) day = 'Yesterday';
  else {
    day = due.toLocaleDateString('en-US', {
      weekday: dayDiff > 1 && dayDiff < 7 ? 'short' : undefined,
      month: 'short',
      day: 'numeric',
      year: due.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
  }

  if (open && isOverdue(t, now)) {
    const hours = Math.round((now.getTime() - due.getTime()) / 3_600_000);
    const ago = hours < 1 ? 'just now' : hours < 24 ? `${hours}h overdue` : `${Math.round(hours / 24)}d overdue`;
    return { text: `${day}, ${time} · ${ago}`, tone: 'danger' };
  }
  return { text: `${day}, ${time}`, tone: open && dayDiff === 0 ? 'accent' : 'neutral' };
}

export function describeRecurrence(rule: TaskRecurrence, endsOn: string | null): string {
  if (rule === 'none') return '';
  const base = RECURRENCE_LABELS[rule];
  return endsOn ? `${base} until ${endsOn}` : base;
}

export function describeReminder(minutes: number | null): string {
  if (minutes === null) return '';
  return REMINDER_PRESETS.find((p) => p.minutes === minutes)?.label ?? `${minutes} minutes before`;
}

// ------------------------------------------------------------ reminders ---

export const REMINDER_GRACE_MS = 24 * 3_600_000;

export function reminderAt(t: Pick<TaskRow, 'due_at' | 'reminder_offset_minutes'>): Date | null {
  if (!t.due_at || t.reminder_offset_minutes === null) return null;
  const due = new Date(t.due_at);
  if (Number.isNaN(due.getTime())) return null;
  return new Date(due.getTime() - t.reminder_offset_minutes * 60_000);
}

/** True while an open task's reminder time has passed (within the grace window). */
export function isReminderDue(
  t: Pick<TaskRow, 'status' | 'due_at' | 'reminder_offset_minutes'>,
  now: Date = new Date(),
): boolean {
  if (!isOpen(t)) return false;
  const at = reminderAt(t);
  if (!at) return false;
  const elapsed = now.getTime() - at.getTime();
  return elapsed >= 0 && elapsed <= REMINDER_GRACE_MS;
}

// -------------------------------------------------------- sort / filter ---

/** Open first; overdue, then soonest due, then priority, then newest. */
export function compareTasks(a: TaskRow, b: TaskRow, now: Date = new Date()): number {
  const aOpen = isOpen(a);
  const bOpen = isOpen(b);
  if (aOpen !== bOpen) return aOpen ? -1 : 1;

  if (!aOpen) {
    return (b.completed_at ?? '').localeCompare(a.completed_at ?? '');
  }

  const aOver = isOverdue(a, now);
  const bOver = isOverdue(b, now);
  if (aOver !== bOver) return aOver ? -1 : 1;

  const aDue = a.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY;
  const bDue = b.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue < bDue ? -1 : 1;

  const byPriority = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
  if (byPriority !== 0) return byPriority;

  return b.created_at.localeCompare(a.created_at);
}

export type TaskTab = 'open' | 'today' | 'overdue' | 'done';

export interface TaskFilters {
  tab: TaskTab;
  search: string;
  priority: 'all' | TaskPriority;
  /** 'all' | 'me' | 'unassigned' | a user id */
  assignee: string;
  meId: string | null;
}

export function filterTasks(tasks: TaskItem[], f: TaskFilters, now: Date = new Date()): TaskItem[] {
  const q = f.search.trim().toLowerCase();
  return tasks
    .filter((t) => {
      const bucket = bucketOf(t, now);
      if (f.tab === 'open' && bucket === 'done') return false;
      if (f.tab === 'today' && bucket !== 'today' && bucket !== 'overdue') return false;
      if (f.tab === 'overdue' && bucket !== 'overdue') return false;
      if (f.tab === 'done' && bucket !== 'done') return false;

      if (f.priority !== 'all' && t.priority !== f.priority) return false;

      if (f.assignee === 'me' && t.assigned_to !== f.meId) return false;
      if (f.assignee === 'unassigned' && t.assigned_to !== null) return false;
      if (f.assignee !== 'all' && f.assignee !== 'me' && f.assignee !== 'unassigned' && t.assigned_to !== f.assignee) {
        return false;
      }

      if (q) {
        const hay = [
          t.title,
          t.description,
          t.assigned_to_name,
          t.customer?.name,
          t.job?.customer_name,
          t.job?.service_type,
          t.lead?.name,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => compareTasks(a, b, now));
}

export interface TaskSummary {
  open: number;
  overdue: number;
  dueToday: number;
  completedRecently: number;
}

export function summarize(tasks: TaskRow[], now: Date = new Date()): TaskSummary {
  const s: TaskSummary = { open: 0, overdue: 0, dueToday: 0, completedRecently: 0 };
  for (const t of tasks) {
    const b = bucketOf(t, now);
    if (b === 'done') s.completedRecently += 1;
    else s.open += 1;
    if (b === 'overdue') s.overdue += 1;
    if (b === 'today') s.dueToday += 1;
  }
  return s;
}

// ---------------------------------------------------------------- draft ---

export interface TaskDraft {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** datetime-local value, local time; '' = none */
  dueLocal: string;
  reminderOffset: number | null;
  recurrence: TaskRecurrence;
  /** YYYY-MM-DD; '' = never */
  recurrenceEndsOn: string;
  assignedTo: string | null;
  customerId: string | null;
  jobId: string | null;
  leadId: string | null;
}

export function emptyDraft(assignedTo: string | null = null): TaskDraft {
  return {
    title: '',
    description: '',
    status: 'todo',
    priority: 'normal',
    dueLocal: '',
    reminderOffset: null,
    recurrence: 'none',
    recurrenceEndsOn: '',
    assignedTo,
    customerId: null,
    jobId: null,
    leadId: null,
  };
}

export function draftFromTask(t: TaskRow): TaskDraft {
  return {
    title: t.title,
    description: t.description ?? '',
    status: t.status,
    priority: t.priority,
    dueLocal: toInputValue(t.due_at),
    reminderOffset: t.reminder_offset_minutes,
    recurrence: t.recurrence,
    recurrenceEndsOn: t.recurrence_ends_on ?? '',
    assignedTo: t.assigned_to,
    customerId: t.customer_id,
    jobId: t.job_id,
    leadId: t.lead_id,
  };
}

export type DraftErrors = Partial<Record<'title' | 'description' | 'dueLocal' | 'recurrenceEndsOn', string>>;

export function validateDraft(d: TaskDraft): DraftErrors {
  const errors: DraftErrors = {};
  const title = d.title.trim();
  if (!title) errors.title = 'Give the task a title.';
  else if (title.length > TITLE_MAX) errors.title = `Keep the title under ${TITLE_MAX} characters.`;

  if (d.description.length > DESCRIPTION_MAX) {
    errors.description = `Keep notes under ${DESCRIPTION_MAX} characters.`;
  }

  const dueIso = fromInputValue(d.dueLocal);
  if (d.dueLocal && !dueIso) errors.dueLocal = 'That date is not valid.';
  else if (!dueIso && d.recurrence !== 'none') errors.dueLocal = 'Repeating tasks need a due date.';
  else if (!dueIso && d.reminderOffset !== null) errors.dueLocal = 'Reminders need a due date.';

  if (d.recurrence !== 'none' && d.recurrenceEndsOn && dueIso) {
    if (d.recurrenceEndsOn < localDateKey(new Date(dueIso))) {
      errors.recurrenceEndsOn = 'The end date must be on or after the due date.';
    }
  }
  return errors;
}

/** Draft -> columns for insert/update (null-safe, trimmed). */
export function draftToColumns(d: TaskDraft, assigneeName: string | null) {
  const dueIso = fromInputValue(d.dueLocal);
  const repeating = d.recurrence !== 'none' && dueIso !== null;
  return {
    title: d.title.trim(),
    description: d.description.trim() ? d.description.trim() : null,
    status: d.status,
    priority: d.priority,
    due_at: dueIso,
    reminder_offset_minutes: dueIso ? d.reminderOffset : null,
    recurrence: repeating ? d.recurrence : ('none' as TaskRecurrence),
    recurrence_ends_on: repeating && d.recurrenceEndsOn ? d.recurrenceEndsOn : null,
    assigned_to: d.assignedTo,
    assigned_to_name: d.assignedTo ? assigneeName : null,
    customer_id: d.customerId,
    job_id: d.jobId,
    lead_id: d.leadId,
  };
}
