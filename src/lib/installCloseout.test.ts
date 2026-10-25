import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  blockingDependency,
  canSubmitStep,
  compareRisk,
  daysUntil,
  deadlineRisk,
  eligibilityCopy,
  escalationLevel,
  escalationTarget,
  friendlyCloseoutError,
  jobStartBlock,
  moneyAtRisk,
  nextStatuses,
  requiresApprover,
  ruleFreshness,
  safeHttpUrl,
  transitionAllowed,
  type StepKind,
  type StepStatus,
} from './installCloseout';

const TODAY = '2026-11-10';

describe('daysUntil', () => {
  it('counts whole days regardless of timezone', () => {
    expect(daysUntil('2026-11-10', TODAY)).toBe(0);
    expect(daysUntil('2026-11-15', TODAY)).toBe(5);
    expect(daysUntil('2026-11-09', TODAY)).toBe(-1);
    expect(daysUntil('2026-12-01', TODAY)).toBe(21);
  });
  it('returns null without a valid deadline', () => {
    expect(daysUntil(null, TODAY)).toBeNull();
    expect(daysUntil('nonsense', TODAY)).toBeNull();
  });
});

describe('escalation (tech -> office -> owner)', () => {
  it('maps days left to levels', () => {
    expect(escalationLevel(null)).toBe(0);
    expect(escalationLevel(30)).toBe(0);
    expect(escalationLevel(14)).toBe(1);
    expect(escalationLevel(8)).toBe(1);
    expect(escalationLevel(7)).toBe(2);
    expect(escalationLevel(4)).toBe(2);
    expect(escalationLevel(3)).toBe(3);
    expect(escalationLevel(-5)).toBe(3);
  });
  it('maps levels to the role that is told', () => {
    expect(escalationTarget(0)).toBeNull();
    expect(escalationTarget(1)).toBe('technician');
    expect(escalationTarget(2)).toBe('office');
    expect(escalationTarget(3)).toBe('owner');
  });
});

describe('deadlineRisk - missed deadlines', () => {
  it('flags overdue open steps and explicitly missed steps', () => {
    expect(deadlineRisk({ status: 'in_progress', deadline: '2026-11-09' }, TODAY)).toBe('overdue');
    expect(deadlineRisk({ status: 'missed', deadline: '2026-12-31' }, TODAY)).toBe('overdue');
  });
  it('grades upcoming deadlines', () => {
    expect(deadlineRisk({ status: 'not_started', deadline: '2026-11-13' }, TODAY)).toBe('critical');
    expect(deadlineRisk({ status: 'not_started', deadline: '2026-11-17' }, TODAY)).toBe('high');
    expect(deadlineRisk({ status: 'not_started', deadline: '2026-11-24' }, TODAY)).toBe('medium');
    expect(deadlineRisk({ status: 'not_started', deadline: '2026-12-31' }, TODAY)).toBe('low');
    expect(deadlineRisk({ status: 'not_started', deadline: null }, TODAY)).toBe('none');
  });
  it('treats finished and submitted steps as not at risk', () => {
    expect(deadlineRisk({ status: 'done', deadline: '2026-01-01' }, TODAY)).toBe('resolved');
    expect(deadlineRisk({ status: 'waived', deadline: '2026-01-01' }, TODAY)).toBe('resolved');
    expect(deadlineRisk({ status: 'submitted', deadline: '2026-11-11' }, TODAY)).toBe('low');
  });
  it('sorts the riskiest first', () => {
    const list = ['low', 'overdue', 'high'] as const;
    expect([...list].sort(compareRisk)).toEqual(['overdue', 'high', 'low']);
  });
});

describe('state machine', () => {
  it('allows the happy path', () => {
    const path: StepStatus[] = ['not_started', 'in_progress', 'awaiting_approval', 'submitted', 'done'];
    for (let i = 0; i < path.length - 1; i++) expect(transitionAllowed(path[i], path[i + 1])).toBe(true);
  });
  it('blocks shortcuts and terminal exits', () => {
    expect(transitionAllowed('not_started', 'submitted')).toBe(false);
    expect(transitionAllowed('in_progress', 'done')).toBe(false);
    expect(transitionAllowed('done', 'in_progress')).toBe(false);
    expect(transitionAllowed('waived', 'in_progress')).toBe(false);
    expect(nextStatuses('done')).toEqual([]);
  });
  it('lets a missed step be recovered late, never silently completed', () => {
    expect(transitionAllowed('missed', 'submitted')).toBe(true);
    expect(transitionAllowed('missed', 'done')).toBe(false);
  });
  it('requires owner/office for submit, done and waive only', () => {
    expect(requiresApprover('submitted')).toBe(true);
    expect(requiresApprover('done')).toBe(true);
    expect(requiresApprover('waived')).toBe(true);
    expect(requiresApprover('in_progress')).toBe(false);
    expect(requiresApprover('awaiting_approval')).toBe(false);
  });
});

describe('dependencies', () => {
  const mk = (m: Partial<Record<StepKind, StepStatus>>) =>
    (['permit', 'inspection', 'warranty', 'rebate', 'documents'] as StepKind[]).map((k) => ({
      step_kind: k,
      status: m[k] ?? 'not_started',
    }));
  it('inspection waits for the permit, rebate for the inspection', () => {
    expect(blockingDependency('inspection', mk({}))).toBe('permit');
    expect(blockingDependency('inspection', mk({ permit: 'done' }))).toBeNull();
    expect(blockingDependency('rebate', mk({ permit: 'done' }))).toBe('inspection');
    expect(blockingDependency('rebate', mk({ permit: 'done', inspection: 'waived' }))).toBeNull();
  });
  it('permit and warranty never wait (so a deadline cannot be lost to ordering)', () => {
    expect(blockingDependency('permit', mk({}))).toBeNull();
    expect(blockingDependency('warranty', mk({}))).toBeNull();
  });
  it('customer documents wait for everything else', () => {
    expect(blockingDependency('documents', mk({ permit: 'done', inspection: 'done', warranty: 'done' }))).toBe('rebate');
    expect(blockingDependency('documents', mk({ permit: 'done', inspection: 'done', warranty: 'done', rebate: 'waived' }))).toBeNull();
  });
});

describe('canSubmitStep - missing documents and pre-approval', () => {
  const steps = [
    { step_kind: 'permit' as const, status: 'done' as const },
    { step_kind: 'inspection' as const, status: 'done' as const },
    { step_kind: 'warranty' as const, status: 'done' as const },
    { step_kind: 'rebate' as const, status: 'awaiting_approval' as const },
  ];
  const base = {
    step_kind: 'rebate' as const,
    status: 'awaiting_approval' as const,
    missing_evidence: [] as string[],
    pre_approval_required: false,
    pre_approval_status: 'not_required' as const,
  };
  it('passes when everything is in place', () => {
    expect(canSubmitStep(base, steps)).toEqual({ ok: true, reason: null });
  });
  it('blocks and names missing evidence', () => {
    const r = canSubmitStep({ ...base, missing_evidence: ['ahri_certificate', 'invoice'] }, steps);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('AHRI certificate');
    expect(r.reason).toContain('Invoice');
  });
  it('blocks when pre-approval was never approved', () => {
    const r = canSubmitStep({ ...base, pre_approval_required: true, pre_approval_status: 'pending' }, steps);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/pre-approval/i);
  });
  it('blocks when an earlier step is open', () => {
    const open = steps.map((s) => (s.step_kind === 'inspection' ? { ...s, status: 'in_progress' as const } : s));
    expect(canSubmitStep(base, open).reason).toContain('Inspection');
  });
});

describe('rebate pre-approval gate (job start)', () => {
  const gate = (over: object) => ({
    step_kind: 'rebate' as const,
    status: 'not_started' as const,
    pre_approval_required: true,
    pre_approval_status: 'pending' as const,
    ...over,
  });
  it('blocks job start while the reservation is not approved', () => {
    expect(jobStartBlock([gate({})]).blocked).toBe(true);
    expect(jobStartBlock([gate({ pre_approval_status: 'denied' })]).reason).toMatch(/denied/i);
  });
  it('allows start once approved, waived, or not required', () => {
    expect(jobStartBlock([gate({ pre_approval_status: 'approved' })]).blocked).toBe(false);
    expect(jobStartBlock([gate({ status: 'waived' })]).blocked).toBe(false);
    expect(jobStartBlock([gate({ pre_approval_required: false, pre_approval_status: 'not_required' })]).blocked).toBe(false);
    expect(jobStartBlock([]).blocked).toBe(false);
  });
});

describe('moneyAtRisk (estimate)', () => {
  it('sums open steps due within 14 days plus missed steps', () => {
    const steps = [
      { status: 'in_progress' as const, deadline: '2026-11-15', estimated_value_cents: 50_000 },
      { status: 'not_started' as const, deadline: '2026-12-30', estimated_value_cents: 99_000 },
      { status: 'missed' as const, deadline: '2026-10-01', estimated_value_cents: 20_000 },
      { status: 'done' as const, deadline: '2026-11-11', estimated_value_cents: 70_000 },
      { status: 'submitted' as const, deadline: '2026-11-11', estimated_value_cents: 10_000 },
    ];
    expect(moneyAtRisk(steps, TODAY)).toBe(70_000);
  });
});

describe('rules as data', () => {
  it('flags unverified and stale rules', () => {
    expect(ruleFreshness(null, TODAY)).toBe('unverified');
    expect(ruleFreshness('2026-10-01', TODAY)).toBe('fresh');
    expect(ruleFreshness('2026-01-01', TODAY)).toBe('stale');
  });
  it('never claims a customer is eligible', () => {
    expect(eligibilityCopy('https://example.org/rules')).toMatch(/likely eligible.*verify/i);
    expect(eligibilityCopy(null)).toMatch(/verify/i);
    expect(eligibilityCopy('https://example.org/rules')).not.toMatch(/^eligible/i);
  });
  it('only accepts http(s) source links', () => {
    expect(safeHttpUrl('https://example.org/x')).toBe('https://example.org/x');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe('friendlyCloseoutError', () => {
  it('translates database guard messages', () => {
    expect(friendlyCloseoutError('CLOSEOUT_PREAPPROVAL_REQUIRED: x')).toMatch(/pre-approval/i);
    expect(friendlyCloseoutError('CLOSEOUT_EVIDENCE_MISSING: ahri_certificate, invoice')).toContain('AHRI certificate');
    expect(friendlyCloseoutError('CLOSEOUT_DEPENDENCY: finish "Permit" first.')).toContain('Permit');
    expect(friendlyCloseoutError(null)).toMatch(/try again/i);
  });
});
