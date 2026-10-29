import { describe, expect, it } from 'vitest';
import {
  checkPunchAction,
  comparePunch,
  EMPTY_PUNCH_FORM,
  formatPunchNumber,
  isLocked,
  isPunchOverdue,
  offeredPunchActions,
  summarizePunch,
  validatePunchForm,
  type PunchActionContext,
  type PunchActor,
  type PunchStatus,
} from '@/lib/punchList';

const reviewer: PunchActor = { isReviewer: true, isAssignee: false, isAccountOwner: false, userId: 'u-mgr' };
const owner: PunchActor = { isReviewer: true, isAssignee: false, isAccountOwner: true, userId: 'u-owner' };
const tech: PunchActor = { isReviewer: false, isAssignee: true, isAccountOwner: false, userId: 'u-tech' };
const stranger: PunchActor = { isReviewer: false, isAssignee: false, isAccountOwner: false, userId: 'u-x' };

const ctx = (over: Partial<PunchActionContext> & { status?: PunchStatus; fixedBy?: string | null }): PunchActionContext => ({
  action: 'start',
  item: { status: over.status ?? 'open', fixed_by: over.fixedBy ?? null },
  actor: reviewer,
  afterPhotoCount: 1,
  note: '',
  ...over,
});

describe('punch close rules', () => {
  it('an assignee can start work and mark fixed, with an After photo', () => {
    expect(checkPunchAction(ctx({ action: 'start', actor: tech }))).toEqual({ ok: true, to: 'in_progress' });
    expect(checkPunchAction(ctx({ action: 'mark_fixed', status: 'in_progress', actor: tech }))).toEqual({ ok: true, to: 'ready_for_review' });
  });

  it('marking fixed requires at least one After photo', () => {
    expect(checkPunchAction(ctx({ action: 'mark_fixed', actor: tech, afterPhotoCount: 0 }))).toMatchObject({ ok: false, code: 'after_photo_required' });
  });

  it('an assignee can never verify, close, reject or reopen', () => {
    for (const action of ['verify', 'verify_close', 'reject', 'close', 'reopen'] as const) {
      expect(checkPunchAction(ctx({ action, status: 'ready_for_review', actor: tech, note: 'because' }))).toMatchObject({ ok: false, code: 'not_authorized' });
    }
  });

  it('someone who is neither reviewer nor assignee can do nothing', () => {
    expect(checkPunchAction(ctx({ action: 'start', actor: stranger }))).toMatchObject({ ok: false, code: 'not_authorized' });
  });

  it('closing is only possible after verification', () => {
    expect(checkPunchAction(ctx({ action: 'close', status: 'open' }))).toMatchObject({ ok: false, code: 'invalid_transition' });
    expect(checkPunchAction(ctx({ action: 'close', status: 'in_progress' }))).toMatchObject({ ok: false, code: 'invalid_transition' });
    expect(checkPunchAction(ctx({ action: 'close', status: 'ready_for_review' }))).toMatchObject({ ok: false, code: 'invalid_transition' });
    expect(checkPunchAction(ctx({ action: 'close', status: 'verified' }))).toEqual({ ok: true, to: 'closed' });
  });

  it('the person who marked it fixed cannot verify it — except the account owner', () => {
    const base = { status: 'ready_for_review' as const, fixedBy: 'u-mgr' };
    expect(checkPunchAction(ctx({ ...base, action: 'verify' }))).toMatchObject({ ok: false, code: 'verifier_must_differ' });
    expect(checkPunchAction(ctx({ ...base, action: 'verify_close' }))).toMatchObject({ ok: false, code: 'verifier_must_differ' });
    expect(checkPunchAction(ctx({ ...base, action: 'verify', actor: { ...reviewer, userId: 'u-other' } }))).toEqual({ ok: true, to: 'verified' });
    expect(checkPunchAction(ctx({ status: 'ready_for_review', fixedBy: 'u-owner', action: 'verify_close', actor: owner }))).toEqual({ ok: true, to: 'closed' });
  });

  it('sending back or reopening needs a note and increments through open', () => {
    expect(checkPunchAction(ctx({ action: 'reject', status: 'ready_for_review', note: '' }))).toMatchObject({ ok: false, code: 'note_required' });
    expect(checkPunchAction(ctx({ action: 'reject', status: 'ready_for_review', note: 'Still leaking' }))).toEqual({ ok: true, to: 'open' });
    expect(checkPunchAction(ctx({ action: 'reopen', status: 'closed', note: '  ' }))).toMatchObject({ ok: false, code: 'note_required' });
    expect(checkPunchAction(ctx({ action: 'reopen', status: 'closed', note: 'Customer found it again' }))).toEqual({ ok: true, to: 'open' });
    expect(checkPunchAction(ctx({ action: 'reopen', status: 'open', note: 'nope nope' }))).toMatchObject({ ok: false, code: 'invalid_transition' });
  });

  it('offers the right buttons per status', () => {
    expect(offeredPunchActions('open')).toEqual(['start', 'mark_fixed']);
    expect(offeredPunchActions('in_progress')).toEqual(['mark_fixed']);
    expect(offeredPunchActions('ready_for_review')).toEqual(['verify', 'verify_close', 'reject']);
    expect(offeredPunchActions('verified')).toEqual(['close', 'reopen']);
    expect(offeredPunchActions('closed')).toEqual(['reopen']);
  });

  it('freezes evidence once an item is ready for review', () => {
    expect(isLocked('open')).toBe(false);
    expect(isLocked('in_progress')).toBe(false);
    expect(isLocked('ready_for_review')).toBe(true);
    expect(isLocked('closed')).toBe(true);
  });
});

describe('punch summary and sorting', () => {
  it('summarizes progress', () => {
    const s = summarizePunch(
      [
        { status: 'open', due_date: '2027-03-01', priority: 'critical' },
        { status: 'in_progress', due_date: null, priority: 'normal' },
        { status: 'ready_for_review', due_date: null, priority: 'high' },
        { status: 'closed', due_date: '2027-01-01', priority: 'critical' },
      ],
      '2027-03-10',
    );
    expect(s).toMatchObject({ total: 4, open: 1, inProgress: 1, awaitingVerification: 1, closed: 1, overdue: 1, critical: 1, remaining: 3, closedPercent: 25 });
    expect(summarizePunch([], '2027-03-10')).toMatchObject({ total: 0, closedPercent: 0, remaining: 0 });
  });

  it('closed items are never overdue', () => {
    expect(isPunchOverdue({ status: 'closed', due_date: '2020-01-01' }, '2027-03-10')).toBe(false);
    expect(isPunchOverdue({ status: 'open', due_date: '2027-03-09' }, '2027-03-10')).toBe(true);
  });

  it('sorts open work first, by priority, due date then number', () => {
    const items = [
      { status: 'closed' as const, priority: 'critical' as const, due_date: null, seq: 1 },
      { status: 'open' as const, priority: 'low' as const, due_date: null, seq: 2 },
      { status: 'open' as const, priority: 'critical' as const, due_date: '2027-04-01', seq: 3 },
      { status: 'open' as const, priority: 'critical' as const, due_date: '2027-03-01', seq: 4 },
      { status: 'open' as const, priority: 'critical' as const, due_date: null, seq: 5 },
    ];
    expect([...items].sort(comparePunch).map((i) => i.seq)).toEqual([4, 3, 5, 2, 1]);
  });

  it('formats numbers and validates the form', () => {
    expect(formatPunchNumber(12)).toBe('PL-012');
    expect(validatePunchForm(EMPTY_PUNCH_FORM)).toMatchObject({ title: expect.any(String), location: expect.any(String) });
    expect(validatePunchForm({ ...EMPTY_PUNCH_FORM, title: 'Scuffed wall', location: 'Kitchen' })).toEqual({});
  });
});
