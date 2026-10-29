import { describe, expect, it } from 'vitest';
import {
  availableActions,
  ballInCourt,
  checkAction,
  compareSubmittals,
  EMPTY_SUBMITTAL_FORM,
  formatRevision,
  formatSubmittalNumber,
  isOverdue,
  normalizeSpecSection,
  summarizeSubmittals,
  validateSubmittalForm,
  type ActionContext,
  type SubmittalStatus,
} from '@/lib/submittals';

const ctx = (over: Partial<ActionContext>): ActionContext => ({
  action: 'submit',
  status: 'draft',
  currentRevision: 0,
  reviewerName: 'Pat Engineer',
  packageCount: 1,
  note: '',
  ...over,
});

describe('submittal workflow', () => {
  it('submits a draft that has a reviewer and a package file', () => {
    expect(checkAction(ctx({}))).toEqual({ ok: true, to: 'submitted' });
  });

  it('refuses to submit without a reviewer or without an attachment', () => {
    expect(checkAction(ctx({ reviewerName: '  ' }))).toMatchObject({ ok: false, code: 'reviewer_required' });
    expect(checkAction(ctx({ reviewerName: null }))).toMatchObject({ ok: false, code: 'reviewer_required' });
    expect(checkAction(ctx({ packageCount: 0 }))).toMatchObject({ ok: false, code: 'attachment_required' });
  });

  it('only a submitted or in-review submittal can be decided', () => {
    for (const status of ['draft', 'approved', 'approved_as_noted', 'revise_resubmit', 'rejected', 'void'] as SubmittalStatus[]) {
      expect(checkAction(ctx({ action: 'approve', status }))).toMatchObject({ ok: false, code: 'invalid_transition' });
    }
    expect(checkAction(ctx({ action: 'approve', status: 'submitted' }))).toEqual({ ok: true, to: 'approved' });
    expect(checkAction(ctx({ action: 'approve', status: 'in_review' }))).toEqual({ ok: true, to: 'approved' });
  });

  it('requires a note for every decision except a plain approval', () => {
    for (const action of ['approve_as_noted', 'revise_resubmit', 'reject'] as const) {
      expect(checkAction(ctx({ action, status: 'in_review', note: ' ab ' }))).toMatchObject({ ok: false, code: 'note_required' });
      expect(checkAction(ctx({ action, status: 'in_review', note: 'See markup' })).ok).toBe(true);
    }
    expect(checkAction(ctx({ action: 'approve', status: 'in_review', note: '' })).ok).toBe(true);
  });

  it('a new revision is only possible after revise & resubmit or a rejection', () => {
    expect(checkAction(ctx({ action: 'new_revision', status: 'revise_resubmit', currentRevision: 0 }))).toEqual({ ok: true, to: 'draft' });
    expect(checkAction(ctx({ action: 'new_revision', status: 'rejected', currentRevision: 3 }))).toEqual({ ok: true, to: 'draft' });
    for (const status of ['draft', 'submitted', 'in_review', 'approved', 'approved_as_noted', 'void'] as SubmittalStatus[]) {
      expect(checkAction(ctx({ action: 'new_revision', status })).ok).toBe(false);
    }
  });

  it('caps revisions at 25', () => {
    expect(checkAction(ctx({ action: 'new_revision', status: 'rejected', currentRevision: 25 }))).toMatchObject({ ok: false, code: 'revision_limit' });
    expect(checkAction(ctx({ action: 'new_revision', status: 'rejected', currentRevision: 24 })).ok).toBe(true);
  });

  it('void needs a note and is terminal', () => {
    expect(checkAction(ctx({ action: 'void', status: 'approved', note: '' }))).toMatchObject({ ok: false, code: 'note_required' });
    expect(checkAction(ctx({ action: 'void', status: 'approved', note: 'Superseded' }))).toEqual({ ok: true, to: 'void' });
    expect(availableActions('void')).toEqual([]);
  });

  it('a full Rev 0 → Rev 1 → approved path is walkable', () => {
    let status: SubmittalStatus = 'draft';
    let rev = 0;
    const step = (action: ActionContext['action'], note = '', packageCount = 1) => {
      const r = checkAction(ctx({ action, status, currentRevision: rev, note, packageCount }));
      expect(r.ok).toBe(true);
      if (r.ok) status = r.to;
      if (action === 'new_revision') rev += 1;
    };
    step('submit');
    step('start_review');
    step('revise_resubmit', 'Wrong model number');
    step('new_revision');
    expect(rev).toBe(1);
    expect(status).toBe('draft');
    // the new revision starts without files, so it cannot be submitted yet
    expect(checkAction(ctx({ action: 'submit', status, currentRevision: rev, packageCount: 0 })).ok).toBe(false);
    step('submit');
    step('approve');
    expect(status).toBe('approved');
  });
});

describe('ball in court, overdue and summary', () => {
  it('assigns the ball correctly', () => {
    expect(ballInCourt('draft')).toBe('us');
    expect(ballInCourt('revise_resubmit')).toBe('us');
    expect(ballInCourt('submitted')).toBe('reviewer');
    expect(ballInCourt('in_review')).toBe('reviewer');
    expect(ballInCourt('approved')).toBe('none');
  });

  it('never flags closed-out submittals as overdue', () => {
    expect(isOverdue({ status: 'in_review', due_date: '2027-03-01' }, '2027-03-10')).toBe(true);
    expect(isOverdue({ status: 'approved', due_date: '2027-03-01' }, '2027-03-10')).toBe(false);
    expect(isOverdue({ status: 'void', due_date: '2027-03-01' }, '2027-03-10')).toBe(false);
    expect(isOverdue({ status: 'draft', due_date: null }, '2027-03-10')).toBe(false);
    expect(isOverdue({ status: 'draft', due_date: '2027-03-10' }, '2027-03-10')).toBe(false);
  });

  it('summarizes the register and ignores void', () => {
    const s = summarizeSubmittals(
      [
        { status: 'approved', due_date: null },
        { status: 'approved_as_noted', due_date: null },
        { status: 'in_review', due_date: '2027-03-01' },
        { status: 'revise_resubmit', due_date: null },
        { status: 'void', due_date: '2027-03-01' },
      ],
      '2027-03-10',
    );
    expect(s).toMatchObject({ total: 5, active: 4, approved: 2, awaitingReview: 1, needsAction: 1, overdue: 1, approvedPercent: 50 });
    expect(summarizeSubmittals([], '2027-03-10').approvedPercent).toBe(0);
  });
});

describe('numbering and spec sections', () => {
  it('formats numbers and revisions', () => {
    expect(formatSubmittalNumber(7)).toBe('SUB-007');
    expect(formatSubmittalNumber(1234)).toBe('SUB-1234');
    expect(formatRevision(0)).toBe('Rev 0');
  });

  it('normalizes MasterFormat sections', () => {
    expect(normalizeSpecSection('230500')).toBe('23 05 00');
    expect(normalizeSpecSection('23 05 00')).toBe('23 05 00');
    expect(normalizeSpecSection('23-05-00.13')).toBe('23 05 00.13');
    expect(normalizeSpecSection('2305')).toBe('23 05');
    expect(normalizeSpecSection('23')).toBe('23');
    expect(normalizeSpecSection('2')).toBeNull();
    expect(normalizeSpecSection('23050')).toBeNull();
    expect(normalizeSpecSection('2305000')).toBeNull();
    expect(normalizeSpecSection('23 05 00.123')).toBeNull();
    expect(normalizeSpecSection('23 05 00.1.2')).toBeNull();
    expect(normalizeSpecSection('abc')).toBeNull();
    expect(normalizeSpecSection('')).toBeNull();
  });

  it('sorts by section then sequence', () => {
    const list = [
      { spec_section: '26 05 00', seq: 1 },
      { spec_section: '23 05 00', seq: 5 },
      { spec_section: '23 05 00', seq: 2 },
      { spec_section: '23', seq: 9 },
    ];
    expect([...list].sort(compareSubmittals).map((s) => `${s.spec_section}#${s.seq}`)).toEqual(['23#9', '23 05 00#2', '23 05 00#5', '26 05 00#1']);
  });

  it('validates the form', () => {
    expect(validateSubmittalForm(EMPTY_SUBMITTAL_FORM)).toMatchObject({ specSection: expect.any(String), title: expect.any(String) });
    expect(validateSubmittalForm({ ...EMPTY_SUBMITTAL_FORM, specSection: '230500', title: 'RTU data', reviewerEmail: 'bad' }).reviewerEmail).toBeDefined();
    expect(validateSubmittalForm({ ...EMPTY_SUBMITTAL_FORM, specSection: '230500', title: 'RTU data', reviewerEmail: 'pat@firm.com' })).toEqual({});
  });
});
