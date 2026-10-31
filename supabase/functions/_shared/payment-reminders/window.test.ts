import { describe, it, expect } from 'vitest';
import { MAX_REMINDERS, OVERDUE_AFTER_DAYS, REMINDER_INTERVAL_DAYS, nextReminderUpdate, reminderCutoffs } from './window';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');

describe('reminderCutoffs', () => {
  it('uses a 3-day reminder interval and a 14-day overdue window', () => {
    expect([MAX_REMINDERS, REMINDER_INTERVAL_DAYS, OVERDUE_AFTER_DAYS]).toEqual([3, 3, 14]);
    expect(reminderCutoffs(NOW)).toEqual({ cutoff: '2026-10-26T12:00:00.000Z', overdueCutoff: '2026-10-15T12:00:00.000Z' });
  });
});

describe('nextReminderUpdate (overdue window)', () => {
  const { overdueCutoff } = reminderCutoffs(NOW);
  const base = { reminder_count: 1, status: 'sent' };
  const NOW_ISO = new Date(NOW).toISOString();

  it('keeps the status when the request is younger than 14 days', () => {
    expect(nextReminderUpdate({ ...base, created_at: '2026-10-20T00:00:00.000Z' }, overdueCutoff, NOW_ISO)).toEqual({
      reminder_count: 2, last_reminder_sent_at: NOW_ISO, status: 'sent',
    });
  });
  it('flips to overdue when older than 14 days', () => {
    expect(nextReminderUpdate({ ...base, created_at: '2026-10-14T00:00:00.000Z' }, overdueCutoff, NOW_ISO).status).toBe('overdue');
  });
  it('exactly on the cutoff is NOT overdue yet (strict comparison)', () => {
    expect(nextReminderUpdate({ ...base, created_at: overdueCutoff }, overdueCutoff, NOW_ISO).status).toBe('sent');
  });
  it('an already overdue request stays overdue', () => {
    expect(nextReminderUpdate({ reminder_count: 2, status: 'overdue', created_at: '2026-10-25T00:00:00.000Z' }, overdueCutoff, NOW_ISO).status).toBe('overdue');
  });
  it('increments the count by exactly one and stamps the send time', () => {
    const r = nextReminderUpdate({ ...base, reminder_count: 2, created_at: '2026-10-20T00:00:00.000Z' }, overdueCutoff, NOW_ISO);
    expect(r.reminder_count).toBe(3);
    expect(r.last_reminder_sent_at).toBe(NOW_ISO);
  });
});
