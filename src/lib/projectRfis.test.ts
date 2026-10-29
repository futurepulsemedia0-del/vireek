import { describe, expect, it } from 'vitest';
import {
  buildAttachmentPath,
  canDeleteRfi,
  canTransitionChangeOrder,
  canTransitionRfi,
  changeOrderSummary,
  emptyRfiForm,
  filterRfis,
  inferAttachmentMime,
  isRfiLocked,
  parseSignedDollars,
  rfiAttention,
  rfiDaysOverdue,
  rfiDueState,
  rfiDueText,
  rfiError,
  rfiStatusLabel,
  rfiSummary,
  safeFileName,
  sortRfis,
  validateAnswer,
  validateAttachmentFile,
  validateChangeOrderForm,
  validateRfiForm,
  type ChangeOrder,
  type ProjectRfi,
  type RfiStatus,
} from '@/lib/projectRfis';

const TODAY = '2027-03-10';

function rfi(over: Partial<ProjectRfi> = {}): ProjectRfi {
  return {
    id: 'r1', project_id: 'p1', phase_id: null, change_order_id: null, rfi_number: 'RFI-001', subject: 'Curb height', question: 'Confirm?',
    direction: 'outgoing', party_name: 'GC', party_role: 'general_contractor', priority: 'normal', status: 'open', due_date: '2027-03-15',
    impacts_cost: false, impacts_schedule: false, answer: null, answered_at: null, sent_at: '2027-03-01T00:00:00Z', closed_at: null,
    created_at: '2027-03-01T00:00:00Z', updated_at: '2027-03-01T00:00:00Z', ...over,
  };
}

describe('RFI lifecycle', () => {
  it('follows draft → open → answered → closed', () => {
    expect(canTransitionRfi('draft', 'open')).toBe(true);
    expect(canTransitionRfi('open', 'answered')).toBe(true);
    expect(canTransitionRfi('answered', 'closed')).toBe(true);
  });
  it('rejects skipping steps', () => {
    expect(canTransitionRfi('draft', 'answered')).toBe(false);
    expect(canTransitionRfi('open', 'closed')).toBe(false);
    expect(canTransitionRfi('draft', 'closed')).toBe(false);
  });
  it('allows reopening answered and closed RFIs but never a void one', () => {
    expect(canTransitionRfi('answered', 'open')).toBe(true);
    expect(canTransitionRfi('closed', 'open')).toBe(true);
    for (const s of ['draft', 'open', 'answered', 'closed'] as RfiStatus[]) expect(canTransitionRfi('void', s)).toBe(false);
  });
  it('locks closed/void and only lets draft/void be deleted', () => {
    expect(isRfiLocked('closed')).toBe(true);
    expect(isRfiLocked('void')).toBe(true);
    expect(isRfiLocked('answered')).toBe(false);
    expect(canDeleteRfi('draft')).toBe(true);
    expect(canDeleteRfi('void')).toBe(true);
    expect(canDeleteRfi('open')).toBe(false);
  });
  it('words the open status by who owes the response', () => {
    expect(rfiStatusLabel('open', 'incoming')).toBe('Needs our response');
    expect(rfiStatusLabel('open', 'outgoing')).toBe('Awaiting response');
    expect(rfiStatusLabel('answered', 'outgoing')).toBe('Answered');
  });
  it('change orders: only pending can be approved', () => {
    expect(canTransitionChangeOrder('draft', 'approved')).toBe(false);
    expect(canTransitionChangeOrder('draft', 'pending')).toBe(true);
    expect(canTransitionChangeOrder('pending', 'approved')).toBe(true);
    expect(canTransitionChangeOrder('approved', 'void')).toBe(true);
    expect(canTransitionChangeOrder('approved', 'draft')).toBe(false);
  });
});

describe('overdue', () => {
  it('is overdue only when open and past due', () => {
    expect(rfiDaysOverdue(rfi({ due_date: '2027-03-07' }), TODAY)).toBe(3);
    expect(rfiDaysOverdue(rfi({ due_date: TODAY }), TODAY)).toBe(0);
    expect(rfiDaysOverdue(rfi({ due_date: '2027-03-20' }), TODAY)).toBe(0);
  });
  it('never flags drafts, answered, closed, void or undated RFIs', () => {
    for (const status of ['draft', 'answered', 'closed', 'void'] as RfiStatus[]) expect(rfiDaysOverdue(rfi({ status, due_date: '2027-01-01' }), TODAY)).toBe(0);
    expect(rfiDaysOverdue(rfi({ due_date: null }), TODAY)).toBe(0);
  });
  it('classifies due state', () => {
    expect(rfiDueState(rfi({ due_date: '2027-03-09' }), TODAY)).toBe('overdue');
    expect(rfiDueState(rfi({ due_date: TODAY }), TODAY)).toBe('due_soon');
    expect(rfiDueState(rfi({ due_date: '2027-03-12' }), TODAY)).toBe('due_soon');
    expect(rfiDueState(rfi({ due_date: '2027-03-13' }), TODAY)).toBe('on_track');
    expect(rfiDueState(rfi({ status: 'draft' }), TODAY)).toBe('none');
    expect(rfiDueState(rfi({ status: 'closed' }), TODAY)).toBe('resolved');
  });
  it('writes readable due text', () => {
    expect(rfiDueText(rfi({ due_date: '2027-03-09' }), TODAY)).toBe('1 day overdue');
    expect(rfiDueText(rfi({ due_date: '2027-03-05' }), TODAY)).toBe('5 days overdue');
    expect(rfiDueText(rfi({ due_date: TODAY }), TODAY)).toBe('Due today');
    expect(rfiDueText(rfi({ due_date: '2027-03-11' }), TODAY)).toBe('Due in 1 day');
    expect(rfiDueText(rfi({ due_date: null }), TODAY)).toBe('No due date');
  });
  it('summarises overdue, due soon and who owes the next move', () => {
    const list = [
      rfi({ id: 'a', due_date: '2027-03-01' }),
      rfi({ id: 'b', due_date: '2027-03-11', direction: 'incoming' }),
      rfi({ id: 'c', status: 'answered', answered_at: '2027-03-03T00:00:00Z', impacts_cost: true }),
      rfi({ id: 'd', status: 'void' }),
      rfi({ id: 'e', status: 'draft', due_date: '2020-01-01' }),
    ];
    const s = rfiSummary(list, TODAY);
    expect(s).toMatchObject({ total: 5, open: 2, overdue: 1, dueSoon: 1, answered: 1, draft: 1, voided: 1, oldestOverdueDays: 9, awaitingUs: 1, awaitingThem: 1, costImpacting: 1 });
    expect(s.avgResponseDays).toBe(2);
  });
  it('surfaces the worst overdue RFI first for the project overview', () => {
    const a = rfiAttention([rfi({ id: 'x', rfi_number: 'RFI-002', due_date: '2027-03-08' }), rfi({ id: 'y', due_date: '2027-03-01' }), rfi({ id: 'z', due_date: '2027-03-11' })], TODAY);
    expect(a.overdue.map((r) => r.id)).toEqual(['y', 'x']);
    expect(a.dueSoon.map((r) => r.id)).toEqual(['z']);
  });
  it('sorts overdue → open → draft → answered → closed → void', () => {
    const order = sortRfis([
      rfi({ id: 'closed', status: 'closed' }), rfi({ id: 'draft', status: 'draft' }), rfi({ id: 'open', due_date: '2027-03-20' }),
      rfi({ id: 'late', due_date: '2027-03-01' }), rfi({ id: 'void', status: 'void' }), rfi({ id: 'ans', status: 'answered' }),
    ], TODAY).map((r) => r.id);
    expect(order).toEqual(['late', 'open', 'draft', 'ans', 'closed', 'void']);
  });
  it('filters by overdue, status and text', () => {
    const list = [rfi({ id: 'a', due_date: '2027-03-01' }), rfi({ id: 'b', subject: 'Duct routing' }), rfi({ id: 'c', status: 'closed' })];
    expect(filterRfis(list, 'overdue', '', TODAY).map((r) => r.id)).toEqual(['a']);
    expect(filterRfis(list, 'open', '', TODAY)).toHaveLength(2);
    expect(filterRfis(list, 'all', 'duct', TODAY).map((r) => r.id)).toEqual(['b']);
  });
});

describe('forms', () => {
  it('defaults the due date to a week out and validates required fields', () => {
    const f = emptyRfiForm(TODAY);
    expect(f.dueDate).toBe('2027-03-17');
    expect(Object.keys(validateRfiForm(f)).sort()).toEqual(['partyName', 'question', 'subject']);
    expect(validateRfiForm({ ...f, subject: 'a', question: 'b', partyName: 'c' })).toEqual({});
    expect(validateRfiForm({ ...f, subject: 'a', question: 'b', partyName: 'c', dueDate: '2027-13-45' }).dueDate).toBeTruthy();
  });
  it('requires an answer', () => {
    expect(validateAnswer('   ')).toBeTruthy();
    expect(validateAnswer('Yes')).toBeNull();
  });
  it('parses signed money and days for change orders', () => {
    expect(parseSignedDollars('1,250.50')).toBe(125050);
    expect(parseSignedDollars('-$300')).toBe(-30000);
    expect(parseSignedDollars('(300)')).toBe(-30000);
    expect(parseSignedDollars('')).toBe(0);
    expect(parseSignedDollars('abc')).toBeNull();
    expect(validateChangeOrderForm({ title: '', description: '', amount: 'x', scheduleDays: '9999' })).toMatchObject({ title: expect.any(String), amount: expect.any(String), scheduleDays: expect.any(String) });
    expect(validateChangeOrderForm({ title: 'Adapter', description: '', amount: '-100', scheduleDays: '-2' })).toEqual({});
  });
  it('totals only approved and pending change orders', () => {
    const co = (status: ChangeOrder['status'], amount_cents: number, schedule_days: number): ChangeOrder => ({ id: status + amount_cents, project_id: 'p1', co_number: 'CO-001', title: 't', description: null, amount_cents, schedule_days, status, decided_at: null, created_at: '', updated_at: '' });
    expect(changeOrderSummary([co('approved', 1000, 2), co('approved', -300, 0), co('pending', 500, 1), co('draft', 9999, 9), co('rejected', 9999, 9), co('void', 9999, 9)]))
      .toEqual({ approvedCents: 700, approvedDays: 2, approvedCount: 2, pendingCents: 500, pendingCount: 1 });
  });
});

describe('attachments', () => {
  it('builds a path the database accepts', () => {
    expect(buildAttachmentPath('o', 'p', 'r', 'Site Plan (v2).PDF', 'u1')).toBe('o/p/r/u1-Site-Plan-v2.pdf');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('???')).toBe('file');
  });
  it('infers mime from the extension when the browser sends none', () => {
    expect(inferAttachmentMime('photo.HEIC', '')).toBe('image/heic');
    expect(inferAttachmentMime('x.exe', 'application/octet-stream')).toBeNull();
  });
  it('enforces size, type and count limits', () => {
    expect(validateAttachmentFile({ name: 'a.pdf', size: 100, type: 'application/pdf' }, 0)).toBeNull();
    expect(validateAttachmentFile({ name: 'a.pdf', size: 26_214_401, type: 'application/pdf' }, 0)).toMatch(/larger/);
    expect(validateAttachmentFile({ name: 'a.exe', size: 5, type: '' }, 0)).toMatch(/use PDF/);
    expect(validateAttachmentFile({ name: 'a.pdf', size: 5, type: 'application/pdf' }, 20)).toMatch(/up to 20/);
  });
});

describe('errors', () => {
  it('maps database errors to friendly copy', () => {
    expect(rfiError(new Error('rfi_locked'), 'x')).toMatch(/closed or void/);
    expect(rfiError({ message: 'answer_required' }, 'x')).toMatch(/Write the answer/);
    expect(rfiError(new Error('boom'), 'Fallback.')).toBe('Fallback.');
  });
});
