import { describe, expect, it } from 'vitest';
import {
  bucketOf,
  compareTasks,
  describeDue,
  draftToColumns,
  emptyDraft,
  filterTasks,
  fromInputValue,
  isOverdue,
  isReminderDue,
  nextOccurrence,
  summarize,
  toInputValue,
  validateDraft,
  type TaskItem,
} from '@/lib/tasks';

// Wednesday 7 Oct 2026, 12:00 local.
const NOW = new Date(2026, 9, 7, 12, 0, 0);
const at = (y: number, m: number, d: number, h = 9, min = 0) => new Date(y, m, d, h, min).toISOString();

function task(over: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 't1',
    user_id: 'owner',
    created_by: 'owner',
    assigned_to: null,
    assigned_to_name: null,
    title: 'Call back',
    description: null,
    status: 'todo',
    priority: 'normal',
    due_at: null,
    reminder_offset_minutes: null,
    recurrence: 'none',
    recurrence_ends_on: null,
    recurrence_parent_id: null,
    customer_id: null,
    job_id: null,
    lead_id: null,
    completed_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    customer: null,
    job: null,
    lead: null,
    ...over,
  };
}

describe('nextOccurrence', () => {
  it('returns null when not repeating or due date missing', () => {
    expect(nextOccurrence('none', at(2026, 9, 7), NOW)).toBeNull();
    expect(nextOccurrence('daily', null, NOW)).toBeNull();
  });

  it('advances one step from a future due date', () => {
    const next = nextOccurrence('weekly', at(2026, 9, 9), NOW)!;
    expect(next.getDate()).toBe(16);
  });

  it('skips missed occurrences instead of creating overdue clones', () => {
    const next = nextOccurrence('weekly', at(2026, 8, 16), NOW)!; // 3 weeks late
    expect(next.getTime()).toBeGreaterThan(NOW.getTime());
    expect(next.getDay()).toBe(new Date(at(2026, 8, 16)).getDay());
    expect(next.getDate()).toBe(14);
  });

  it('clamps month-end and does not drift across a catch-up', () => {
    const feb = nextOccurrence('monthly', at(2026, 0, 31), new Date(2026, 0, 31, 10))!;
    expect([feb.getMonth(), feb.getDate()]).toEqual([1, 28]);
    const mar = nextOccurrence('monthly', at(2026, 0, 31), new Date(2026, 2, 1))!;
    expect([mar.getMonth(), mar.getDate()]).toEqual([2, 31]);
  });

  it('supports quarterly, yearly and biweekly', () => {
    expect(nextOccurrence('quarterly', at(2026, 9, 10), NOW)!.getMonth()).toBe(0);
    expect(nextOccurrence('yearly', at(2026, 9, 10), NOW)!.getFullYear()).toBe(2027);
    expect(nextOccurrence('biweekly', at(2026, 9, 10), NOW)!.getDate()).toBe(24);
  });

  it('stops after the end date', () => {
    expect(nextOccurrence('daily', at(2026, 9, 7), NOW, '2026-10-07')).toBeNull();
    expect(nextOccurrence('daily', at(2026, 9, 7), NOW, '2026-10-08')).not.toBeNull();
  });
});

describe('buckets and overdue', () => {
  it('classifies tasks by due date', () => {
    expect(bucketOf(task({ due_at: at(2026, 9, 7, 8) }), NOW)).toBe('overdue');
    expect(bucketOf(task({ due_at: at(2026, 9, 7, 18) }), NOW)).toBe('today');
    expect(bucketOf(task({ due_at: at(2026, 9, 8, 9) }), NOW)).toBe('upcoming');
    expect(bucketOf(task(), NOW)).toBe('no_date');
    expect(bucketOf(task({ status: 'done', due_at: at(2026, 9, 1) }), NOW)).toBe('done');
  });

  it('never marks a done task overdue', () => {
    expect(isOverdue(task({ status: 'done', due_at: at(2026, 9, 1) }), NOW)).toBe(false);
  });
});

describe('describeDue', () => {
  it('labels relative days and overdue tone', () => {
    expect(describeDue(task({ due_at: at(2026, 9, 7, 18) }), NOW)).toMatchObject({ tone: 'accent' });
    expect(describeDue(task({ due_at: at(2026, 9, 8, 9) }), NOW).text).toMatch(/^Tomorrow/);
    const late = describeDue(task({ due_at: at(2026, 9, 5, 9) }), NOW);
    expect(late.tone).toBe('danger');
    expect(late.text).toMatch(/overdue/);
  });
});

describe('reminders', () => {
  it('fires only inside the grace window', () => {
    const due = at(2026, 9, 7, 13);
    expect(isReminderDue(task({ due_at: due, reminder_offset_minutes: 120 }), NOW)).toBe(true);
    expect(isReminderDue(task({ due_at: at(2026, 9, 9, 13), reminder_offset_minutes: 60 }), NOW)).toBe(false);
    expect(isReminderDue(task({ due_at: at(2026, 9, 1, 13), reminder_offset_minutes: 0 }), NOW)).toBe(false);
    expect(isReminderDue(task({ status: 'done', due_at: due, reminder_offset_minutes: 120 }), NOW)).toBe(false);
  });
});

describe('sorting, filtering, summary', () => {
  const tasks = [
    task({ id: 'later', title: 'Later', due_at: at(2026, 9, 12) }),
    task({ id: 'overdue', title: 'Overdue', due_at: at(2026, 9, 6) }),
    task({ id: 'today-urgent', title: 'Today urgent', due_at: at(2026, 9, 7, 18), priority: 'urgent' }),
    task({ id: 'nodate', title: 'Someday' }),
    task({ id: 'done', title: 'Finished', status: 'done', completed_at: '2026-10-06T10:00:00.000Z' }),
    task({ id: 'mine', title: 'Mine', due_at: at(2026, 9, 7, 17), assigned_to: 'me', customer: { id: 'c1', name: 'Acme HVAC' } }),
  ];

  it('orders overdue, then soonest, then no-date, then done', () => {
    const ids = [...tasks].sort((a, b) => compareTasks(a, b, NOW)).map((t) => t.id);
    expect(ids).toEqual(['overdue', 'mine', 'today-urgent', 'later', 'nodate', 'done']);
  });

  it('filters by tab, assignee and search (incl. linked customer)', () => {
    const base = { tab: 'open' as const, search: '', priority: 'all' as const, assignee: 'all', meId: 'me' };
    expect(filterTasks(tasks, { ...base, tab: 'overdue' }, NOW).map((t) => t.id)).toEqual(['overdue']);
    expect(filterTasks(tasks, { ...base, tab: 'today' }, NOW).map((t) => t.id)).toEqual(['overdue', 'mine', 'today-urgent']);
    expect(filterTasks(tasks, { ...base, tab: 'done' }, NOW).map((t) => t.id)).toEqual(['done']);
    expect(filterTasks(tasks, { ...base, assignee: 'me' }, NOW).map((t) => t.id)).toEqual(['mine']);
    expect(filterTasks(tasks, { ...base, assignee: 'unassigned' }, NOW)).toHaveLength(4);
    expect(filterTasks(tasks, { ...base, search: 'acme' }, NOW).map((t) => t.id)).toEqual(['mine']);
    expect(filterTasks(tasks, { ...base, priority: 'urgent' }, NOW).map((t) => t.id)).toEqual(['today-urgent']);
  });

  it('summarises counts', () => {
    expect(summarize(tasks, NOW)).toEqual({ open: 5, overdue: 1, dueToday: 2, completedRecently: 1 });
  });
});

describe('drafts', () => {
  it('round-trips datetime-local values', () => {
    expect(toInputValue(fromInputValue('2026-10-07T09:30'))).toBe('2026-10-07T09:30');
    expect(fromInputValue('')).toBeNull();
    expect(fromInputValue('nonsense')).toBeNull();
  });

  it('validates title, due date requirements and end date', () => {
    expect(validateDraft({ ...emptyDraft(), title: '  ' }).title).toBeTruthy();
    expect(validateDraft({ ...emptyDraft(), title: 'x', recurrence: 'weekly' }).dueLocal).toBeTruthy();
    expect(validateDraft({ ...emptyDraft(), title: 'x', reminderOffset: 15 }).dueLocal).toBeTruthy();
    expect(
      validateDraft({ ...emptyDraft(), title: 'x', dueLocal: '2026-10-07T09:00', recurrence: 'daily', recurrenceEndsOn: '2026-10-01' })
        .recurrenceEndsOn,
    ).toBeTruthy();
    expect(validateDraft({ ...emptyDraft(), title: 'Call', dueLocal: '2026-10-07T09:00' })).toEqual({});
  });

  it('drops reminder/recurrence columns when there is no due date', () => {
    const cols = draftToColumns({ ...emptyDraft('u1'), title: ' Hi ', reminderOffset: 15, recurrence: 'daily' }, 'Sam');
    expect(cols).toMatchObject({
      title: 'Hi',
      due_at: null,
      reminder_offset_minutes: null,
      recurrence: 'none',
      assigned_to: 'u1',
      assigned_to_name: 'Sam',
    });
  });
});
