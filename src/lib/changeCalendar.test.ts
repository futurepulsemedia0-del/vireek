import { describe, expect, it } from 'vitest';
import {
  actionsFor, composeReminderEmail, dayNumber, daysBetween, draftToPayload, emptyDraft, hasErrors, normalizeEntry,
  noticeShortfallDays, reminderKind, sortEntries, summarize, urgencyOf, validateDraft,
  type ChangeEntry, type ChangeDraft, type ReminderKind, type Status,
} from '@/lib/changeCalendar';

const OWNER = '00000000-0000-0000-0000-0000000000b1';
const TODAY = '2027-03-10';

const entry = (o: Partial<ChangeEntry> = {}): ChangeEntry => ({
  id: '10000000-0000-0000-0000-000000000001', category: 'pricing', title: 'Starter price update', summary: null,
  audience: 'all_customers', owner_id: OWNER, status: 'approved', notice_date: '2027-04-01', effective_date: '2027-05-01',
  min_notice_days: null, reference_url: null, price_change_notice_id: null, notice_sent_at: null, decided_by: OWNER,
  decided_at: '2027-03-01T00:00:00Z', decision_note: null, completed_at: null, cancelled_at: null, created_by: OWNER,
  created_at: '2027-02-01T00:00:00Z', updated_at: '2027-02-01T00:00:00Z', ...o,
});

// The SAME table is asserted in supabase/tests/database/change_calendar.test.sql against the SQL function.
const CASES: Array<[string, Status, string, string, boolean, ReminderKind | null]> = [
  ['draft, notice far away', 'draft', '2027-04-20', '2027-06-01', false, null],
  ['draft, notice in 7 days', 'draft', '2027-03-17', '2027-06-01', false, 'approval_needed'],
  ['pending, notice in 8 days', 'pending_approval', '2027-03-18', '2027-06-01', false, null],
  ['pending, notice today', 'pending_approval', '2027-03-10', '2027-06-01', false, 'unapproved_past_notice'],
  ['draft, notice passed', 'draft', '2027-03-01', '2027-06-01', false, 'unapproved_past_notice'],
  ['approved, notice passed, unsent', 'approved', '2027-03-09', '2027-06-01', false, 'notice_overdue'],
  ['approved, notice today, unsent', 'approved', '2027-03-10', '2027-06-01', false, 'notice_1d'],
  ['approved, notice tomorrow, unsent', 'approved', '2027-03-11', '2027-06-01', false, 'notice_1d'],
  ['approved, notice in 2 days, unsent', 'approved', '2027-03-12', '2027-06-01', false, 'notice_7d'],
  ['approved, notice in 7 days, unsent', 'approved', '2027-03-17', '2027-06-01', false, 'notice_7d'],
  ['approved, notice in 8 days, unsent', 'approved', '2027-03-18', '2027-06-01', false, null],
  ['approved, sent, effective in 7 days', 'approved', '2027-02-01', '2027-03-17', true, 'effective_7d'],
  ['approved, sent, effective in 8 days', 'approved', '2027-02-01', '2027-03-18', true, null],
  ['approved, sent, effective passed', 'approved', '2027-02-01', '2027-03-09', true, 'completion_due'],
  ['approved, unsent, effective passed too: notice first', 'approved', '2027-02-01', '2027-03-09', false, 'notice_overdue'],
  ['rejected is quiet', 'rejected', '2027-03-01', '2027-03-05', false, null],
  ['completed is quiet', 'completed', '2027-03-01', '2027-03-05', true, null],
  ['cancelled is quiet', 'cancelled', '2027-03-01', '2027-03-05', false, null],
];

describe('reminderKind', () => {
  for (const [name, status, notice, effective, sent, want] of CASES) {
    it(name, () => {
      expect(reminderKind({ status, notice_date: notice, effective_date: effective, notice_sent_at: sent ? '2027-02-20T00:00:00Z' : null }, TODAY)).toBe(want);
    });
  }
  it('returns null for malformed dates instead of throwing', () => {
    expect(reminderKind({ status: 'approved', notice_date: 'x', effective_date: '2027-01-01', notice_sent_at: null }, TODAY)).toBeNull();
  });
});

describe('dates', () => {
  it('rejects impossible dates and counts days', () => {
    expect(dayNumber('2027-02-30')).toBeNull();
    expect(dayNumber('2028-02-29')).not.toBeNull();
    expect(daysBetween('2027-03-10', '2027-03-17')).toBe(7);
    expect(daysBetween('2027-03-10', '2027-03-01')).toBe(-9);
    expect(daysBetween('nope', '2027-03-01')).toBeNull();
  });
});

describe('validateDraft', () => {
  const ok = (): ChangeDraft => ({ ...emptyDraft(OWNER), title: 'New SLA wording', notice_date: '2027-04-01', effective_date: '2027-05-01' });
  it('accepts a valid draft', () => expect(hasErrors(validateDraft(ok()))).toBe(false));
  it('flags title, owner, dates, url, notice link, min notice', () => {
    expect(validateDraft({ ...ok(), title: 'ab' }).title).toBe('title_length');
    expect(validateDraft({ ...ok(), owner_id: '' }).owner_id).toBe('owner_required');
    expect(validateDraft({ ...ok(), notice_date: '2027-02-30' }).notice_date).toBe('notice_date_invalid');
    expect(validateDraft({ ...ok(), effective_date: '2027-03-01' }).effective_date).toBe('dates_order');
    expect(validateDraft({ ...ok(), reference_url: 'http://x.io' }).reference_url).toBe('url_invalid');
    expect(validateDraft({ ...ok(), reference_url: 'javascript:alert(1)' }).reference_url).toBe('url_invalid');
    expect(validateDraft({ ...ok(), price_change_notice_id: 'abc' }).price_change_notice_id).toBe('notice_link_invalid');
    expect(validateDraft({ ...ok(), min_notice_days: '-1' }).min_notice_days).toBe('min_notice_invalid');
    expect(validateDraft({ ...ok(), min_notice_days: '366' }).min_notice_days).toBe('min_notice_invalid');
    expect(validateDraft({ ...ok(), min_notice_days: '45' }).min_notice_days).toBe('min_notice_not_met');
    expect(validateDraft({ ...ok(), min_notice_days: '30' }).min_notice_days).toBeUndefined();
  });
  it('requireFuture only rejects an effective date in the past', () => {
    const d = { ...ok(), notice_date: '2027-01-01', effective_date: '2027-02-01' };
    expect(validateDraft(d, { today: TODAY, requireFuture: true }).effective_date).toBe('effective_in_past');
    expect(validateDraft(d, { today: TODAY }).effective_date).toBeUndefined();
  });
});

describe('draftToPayload', () => {
  it('trims, nulls empties, converts min notice, omits id for new entries', () => {
    const p = draftToPayload({ ...emptyDraft(OWNER), title: '  Terms v3 ', notice_date: '2027-04-01', effective_date: '2027-05-01', min_notice_days: ' 30 ' });
    expect(p).toEqual({
      category: 'pricing', title: 'Terms v3', summary: null, audience: 'all_customers', owner_id: OWNER,
      notice_date: '2027-04-01', effective_date: '2027-05-01', min_notice_days: 30, reference_url: null, price_change_notice_id: null,
    });
    expect('id' in p).toBe(false);
  });
});

describe('urgency, summary, sorting', () => {
  it('maps kinds to levels and ignores closed entries', () => {
    expect(urgencyOf(entry({ notice_date: '2027-03-01' }), TODAY).level).toBe('critical');
    expect(urgencyOf(entry({ notice_date: '2027-03-11' }), TODAY).level).toBe('warning');
    expect(urgencyOf(entry({ notice_date: '2027-03-15' }), TODAY).level).toBe('info');
    expect(urgencyOf(entry(), TODAY).level).toBe('none');
    expect(urgencyOf(entry({ status: 'cancelled', cancelled_at: 'x' }), TODAY).level).toBe('closed');
    expect(urgencyOf(entry({ notice_sent_at: '2027-03-01T00:00:00Z' }), TODAY).noticeInDays).toBeNull();
  });
  it('summarizes open work', () => {
    const list = [
      entry({ id: 'a', notice_date: '2027-03-01' }),
      entry({ id: 'b', status: 'pending_approval', decided_by: null, decided_at: null }),
      entry({ id: 'c', status: 'completed', completed_at: 'x' }),
      entry({ id: 'd', audience: 'internal' }),
    ];
    expect(summarize(list, TODAY)).toEqual({ open: 3, critical: 1, warning: 0, awaitingApproval: 1, noticeToSend: 1 });
  });
  it('sorts open by next date, closed last', () => {
    const s = sortEntries([
      entry({ id: 'late', title: 'B', notice_date: '2027-06-01' }),
      entry({ id: 'done', title: 'A', status: 'completed', completed_at: 'x' }),
      entry({ id: 'soon', title: 'C', notice_date: '2027-03-12' }),
    ]).map((e) => e.id);
    expect(s).toEqual(['soon', 'late', 'done']);
  });
});

describe('actionsFor', () => {
  it('offers only valid transitions', () => {
    expect(actionsFor(entry({ status: 'draft' }), TODAY)).toMatchObject({ submit: true, approve: false, markNoticeSent: false, complete: false });
    expect(actionsFor(entry({ status: 'pending_approval' }), TODAY)).toMatchObject({ approve: true, reject: true, submit: false });
    expect(actionsFor(entry(), TODAY)).toMatchObject({ markNoticeSent: true, complete: false, locked: false });
    expect(actionsFor(entry({ notice_sent_at: '2027-03-01T00:00:00Z', effective_date: '2027-03-10' }), TODAY)).toMatchObject({ complete: true, locked: true, markNoticeSent: false });
    expect(actionsFor(entry({ audience: 'internal', effective_date: '2027-03-10' }), TODAY).complete).toBe(true);
    expect(actionsFor(entry({ status: 'completed', completed_at: 'x' }), TODAY)).toMatchObject({ edit: false, cancel: false });
  });
});

describe('noticeShortfallDays', () => {
  it('is informational and never negative', () => {
    expect(noticeShortfallDays({ min_notice_days: null, notice_sent_at: '2027-03-01T00:00:00Z', effective_date: '2027-03-02' })).toBe(0);
    expect(noticeShortfallDays({ min_notice_days: 30, notice_sent_at: null, effective_date: '2027-05-01' })).toBe(0);
    expect(noticeShortfallDays({ min_notice_days: 30, notice_sent_at: '2027-04-10T08:00:00Z', effective_date: '2027-05-01' })).toBe(9);
    expect(noticeShortfallDays({ min_notice_days: 30, notice_sent_at: '2027-03-01T08:00:00Z', effective_date: '2027-05-01' })).toBe(0);
  });
});

describe('normalizeEntry', () => {
  it('drops malformed rows and keeps valid ones', () => {
    expect(normalizeEntry(null)).toBeNull();
    expect(normalizeEntry({ ...entry(), category: 'bogus' })).toBeNull();
    expect(normalizeEntry({ ...entry(), notice_date: '2027-13-01' })).toBeNull();
    expect(normalizeEntry({ ...entry(), min_notice_days: 'x' })?.min_notice_days).toBeNull();
    expect(normalizeEntry(entry())?.title).toBe('Starter price update');
  });
});

describe('composeReminderEmail', () => {
  it('escapes HTML and links to the staff page', () => {
    const m = composeReminderEmail({ entry_id: 'x', kind: 'notice_overdue', title: '<script>alert(1)</script>', category: 'terms', status: 'approved', notice_date: '2027-03-01', effective_date: '2027-04-01', owner_email: 'a@b.c' }, 'https://vireek.com/');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.text).toContain('https://vireek.com/staff/change-calendar');
    expect(m.subject.startsWith('[Change calendar] terms:')).toBe(true);
  });
});
