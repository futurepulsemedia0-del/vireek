import { describe, it, expect } from 'vitest';
import {
  canTransition, transitionBlockers, missingEvidence, daysLeft, deadlineRisk, escalationTier,
  moneyAtRisk, programFreshness, preApprovalBlockers, isCloseoutGateError, parseCloseoutGateError,
  unmetDependencies, DEFAULT_SETTINGS, ELIGIBILITY_LABELS, riskCounts,
  type StepLike,
} from './installCloseoutLogic';

const step = (o: Partial<StepLike> = {}): StepLike => ({
  id: 's1', step_key: 'permit', status: 'in_progress', deadline_on: '2030-01-20',
  estimated_value_cents: 100_00, pre_approval_required: false, pre_approval_status: 'not_required', ...o,
});

describe('state transitions', () => {
  it('allows the happy path', () => {
    expect(canTransition('pending', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'ready_for_approval')).toBe(true);
    expect(canTransition('ready_for_approval', 'submitted')).toBe(true);
    expect(canTransition('submitted', 'completed')).toBe(true);
  });
  it('rejects skipping and terminal exits', () => {
    expect(canTransition('pending', 'submitted')).toBe(false);
    expect(canTransition('in_progress', 'completed')).toBe(false);
    expect(canTransition('completed', 'in_progress')).toBe(false);
    expect(canTransition('in_progress', 'missed')).toBe(false); // only the engine sets missed
  });
  it('lets a missed step be reopened but not submitted directly', () => {
    expect(canTransition('missed', 'in_progress')).toBe(true);
    expect(canTransition('missed', 'submitted')).toBe(false);
  });
  it('requires human attestation + reference to submit', () => {
    const b = transitionBlockers({ step: step({ status: 'ready_for_approval' }), to: 'submitted', siblings: [], missing: [] });
    expect(b.map((x) => x.code)).toEqual(expect.arrayContaining(['needs_attestation', 'needs_reference']));
    const ok = transitionBlockers({ step: step({ status: 'ready_for_approval' }), to: 'submitted', siblings: [], missing: [], attested: true, reference: 'ABC-1' });
    expect(ok).toEqual([]);
  });
  it('requires a reason for not_applicable', () => {
    expect(transitionBlockers({ step: step(), to: 'not_applicable', siblings: [], missing: [] })[0].code).toBe('needs_note');
  });
});

describe('dependencies', () => {
  it('blocks rebate until inspection is done or N/A', () => {
    expect(unmetDependencies('rebate', [{ step_key: 'inspection', status: 'in_progress' }])).toEqual(['inspection']);
    expect(unmetDependencies('rebate', [{ step_key: 'inspection', status: 'not_applicable' }])).toEqual([]);
    expect(unmetDependencies('rebate', [{ step_key: 'inspection', status: 'completed' }])).toEqual([]);
  });
});

describe('missing documents', () => {
  it('flags required evidence with nothing attached', () => {
    const m = missingEvidence(['serial_number', 'photo', 'invoice'], [
      { kind: 'serial_number', value: 'SN123', job_photo_id: null, document_id: null },
      { kind: 'photo', value: null, job_photo_id: null, document_id: null }, // empty = not present
    ]);
    expect(m).toEqual(['invoice', 'photo']);
  });
  it('accepts a linked photo or document', () => {
    expect(missingEvidence(['photo', 'certificate'], [
      { kind: 'photo', value: null, job_photo_id: 'p1', document_id: null },
      { kind: 'certificate', value: '  ', job_photo_id: null, document_id: 'd1' },
    ])).toEqual([]);
  });
  it('blocks ready_for_approval while evidence is missing', () => {
    const b = transitionBlockers({ step: step(), to: 'ready_for_approval', siblings: [], missing: ['photo'] });
    expect(b[0].code).toBe('missing_evidence');
  });
});

describe('deadlines / missed deadlines / escalation', () => {
  it('computes days left across month boundaries', () => {
    expect(daysLeft('2030-03-01', '2030-02-27')).toBe(2);
    expect(daysLeft('2030-01-01', '2030-01-02')).toBe(-1);
  });
  it('classifies risk', () => {
    const today = '2030-01-10';
    expect(deadlineRisk(step({ deadline_on: '2030-01-09' }), today)).toBe('overdue');
    expect(deadlineRisk(step({ deadline_on: '2030-01-12' }), today)).toBe('critical');
    expect(deadlineRisk(step({ deadline_on: '2030-01-16' }), today)).toBe('at_risk');
    expect(deadlineRisk(step({ deadline_on: '2030-03-01' }), today)).toBe('on_track');
    expect(deadlineRisk(step({ deadline_on: null }), today)).toBe('no_deadline');
    expect(deadlineRisk(step({ status: 'completed' }), today)).toBe('done');
    expect(deadlineRisk(step({ status: 'submitted' }), today)).toBe('filed');
    expect(deadlineRisk(step({ status: 'missed', deadline_on: '2030-01-01' }), today)).toBe('overdue');
  });
  it('escalates technician → office → owner', () => {
    expect(escalationTier(10, DEFAULT_SETTINGS)).toBe(0);
    expect(escalationTier(7, DEFAULT_SETTINGS)).toBe(1);
    expect(escalationTier(3, DEFAULT_SETTINGS)).toBe(2);
    expect(escalationTier(0, DEFAULT_SETTINGS)).toBe(3);
    expect(escalationTier(-5, DEFAULT_SETTINGS)).toBe(3);
  });
  it('money at risk is always labeled an estimate and ignores done/filed steps', () => {
    const m = moneyAtRisk([
      step({ id: 'a', deadline_on: '2030-01-05', estimated_value_cents: 500_00 }), // overdue
      step({ id: 'b', deadline_on: '2030-01-14', estimated_value_cents: 200_00 }), // inside window
      step({ id: 'c', deadline_on: '2030-06-01', estimated_value_cents: 900_00 }), // far
      step({ id: 'd', deadline_on: '2030-01-05', status: 'completed', estimated_value_cents: 700_00 }),
      step({ id: 'e', deadline_on: '2030-01-05', status: 'submitted', estimated_value_cents: 300_00 }),
    ], '2030-01-10');
    expect(m).toMatchObject({ atRiskCents: 700_00, overdueCents: 500_00, stepCount: 2, isEstimate: true });
    expect(m.disclaimer).toMatch(/estimate/i);
  });
  it('counts risk buckets', () => {
    const c = riskCounts([step({ deadline_on: '2030-01-01' }), step({ status: 'completed' })], '2030-01-10');
    expect(c.overdue).toBe(1); expect(c.done).toBe(1);
  });
});

describe('pre-approval gating', () => {
  it('lists unapproved pre-approval programs and ignores N/A or approved', () => {
    const blockers = preApprovalBlockers([
      step({ id: '1', pre_approval_required: true, pre_approval_status: 'pending', program_name: 'Utility Rebate' }),
      step({ id: '2', pre_approval_required: true, pre_approval_status: 'approved', program_name: 'Approved' }),
      step({ id: '3', pre_approval_required: true, pre_approval_status: 'pending', status: 'not_applicable', program_name: 'NA' }),
    ]);
    expect(blockers).toEqual(['Utility Rebate']);
  });
  it('blocks submission without pre-approval', () => {
    const b = transitionBlockers({
      step: step({ status: 'ready_for_approval', pre_approval_required: true, pre_approval_status: 'requested' }),
      to: 'submitted', siblings: [], missing: [], attested: true, reference: 'X',
    });
    expect(b.map((x) => x.code)).toContain('pre_approval');
  });
  it('parses the database error', () => {
    const msg = 'new row violates: CLOSEOUT_PRE_APPROVAL_REQUIRED: Utility A||Utility, B';
    expect(isCloseoutGateError(msg)).toBe(true);
    expect(parseCloseoutGateError(msg)).toEqual(['Utility A', 'Utility, B']);
  });
});

describe('rules as data', () => {
  it('flags unverified and stale programs', () => {
    expect(programFreshness({ source_url: null, last_verified_on: null, reverify_days: 180 }, '2030-01-01')).toBe('unverified');
    expect(programFreshness({ source_url: 'https://x.org', last_verified_on: '2029-01-01', reverify_days: 180 }, '2030-01-01')).toBe('stale');
    expect(programFreshness({ source_url: 'https://x.org', last_verified_on: '2029-12-01', reverify_days: 180 }, '2030-01-01')).toBe('fresh');
  });
  it('never offers a bare "eligible" label', () => {
    expect(Object.values(ELIGIBILITY_LABELS).join(' ')).not.toMatch(/(^|\s)eligible(\s|$)(?!.*verify)/i);
    expect(ELIGIBILITY_LABELS.likely_verify).toMatch(/verify/i);
  });
});
