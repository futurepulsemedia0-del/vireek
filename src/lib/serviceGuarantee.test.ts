import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  clampCoverageDays,
  daysLeft,
  nextCheckpoint,
  nextStepLabel,
  rankRecoveryTechnicians,
  summarizeGuarantees,
  verificationProgress,
} from './serviceGuarantee';
import type { CheckpointRow, ClaimRow, GuaranteeRow } from './serviceGuarantee';
import type { AssuranceContext, AssuranceTechnician, OutcomeRow } from './outcomeAssurance';

const NOW = new Date('2026-10-10T08:00:00Z').getTime();
const H = 3600000;

function g(id: string, over: Partial<GuaranteeRow> = {}): GuaranteeRow {
  return {
    id,
    job_id: `job-${id}`,
    technician_id: 't1',
    customer_name: 'Customer',
    service_type: 'AC Repair',
    status: 'verifying',
    evidence_level: 'none',
    started_at: new Date(NOW - 10 * H).toISOString(),
    expires_at: new Date(NOW + 29 * 24 * H).toISOString(),
    verified_at: null,
    last_checkpoint: null,
    recovered_by_job_id: null,
    void_reason: null,
    created_at: new Date(NOW - 10 * H).toISOString(),
    ...over,
  };
}

function cp(stage: CheckpointRow['stage'], hoursFromNow: number, over: Partial<CheckpointRow> = {}): CheckpointRow {
  return {
    id: `${stage}-${hoursFromNow}`,
    guarantee_id: 'a',
    stage,
    due_at: new Date(NOW + hoursFromNow * H).toISOString(),
    status: 'pending',
    evidence: null,
    prompted_at: null,
    customer_response: null,
    checked_at: null,
    ...over,
  };
}

function claim(id: string, over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id,
    guarantee_id: 'a',
    job_id: 'job-a',
    source: 'customer',
    description: null,
    status: 'open',
    warranty_check: {},
    parts_check: {},
    root_cause_key: null,
    proposed_technician_id: null,
    redispatch_job_id: null,
    resolution_note: null,
    escalated_at: null,
    created_at: new Date(NOW - 5 * H).toISOString(),
    resolved_at: null,
    ...over,
  };
}

describe('helpers', () => {
  it('clamps coverage days into the supported range', () => {
    expect(clampCoverageDays(10)).toBe(30);
    expect(clampCoverageDays(90.4)).toBe(90);
    expect(clampCoverageDays(9999)).toBe(365);
    expect(clampCoverageDays(Number.NaN)).toBe(30);
  });

  it('counts remaining days rounding up and never goes negative', () => {
    expect(daysLeft(new Date(NOW + 25 * H).toISOString(), NOW)).toBe(2);
    expect(daysLeft(new Date(NOW - H).toISOString(), NOW)).toBe(0);
    expect(daysLeft('not a date', NOW)).toBe(0);
  });

  it('picks the earliest pending checkpoint', () => {
    const list = [cp('d7', 100), cp('h48', 5), cp('d30', 600, { status: 'passed' })];
    expect(nextCheckpoint(list)?.stage).toBe('h48');
    expect(nextCheckpoint([cp('h48', 1, { status: 'passed' })])).toBeNull();
  });

  it('computes verification progress ignoring voided checkpoints', () => {
    expect(verificationProgress([])).toBe(0);
    expect(verificationProgress([cp('h48', -1, { status: 'passed' }), cp('d7', 5), cp('d30', 50)])).toBe(33);
    expect(verificationProgress([cp('h48', -1, { status: 'passed' }), cp('d7', 5, { status: 'voided' }), cp('d30', 50, { status: 'voided' })])).toBe(100);
  });
});

describe('nextStepLabel', () => {
  it('describes each lifecycle state', () => {
    expect(nextStepLabel(g('a', { status: 'claim_open' }), [], NOW)).toMatch(/approve a recovery/i);
    expect(nextStepLabel(g('a', { status: 'recovering' }), [], NOW)).toMatch(/scheduled/i);
    expect(nextStepLabel(g('a', { status: 'voided', void_reason: 'Customer damage' }), [], NOW)).toContain('Customer damage');
    expect(nextStepLabel(g('a', { status: 'verifying' }), [cp('h48', 5)], NOW)).toMatch(/48 hours check in 5 h/);
    expect(nextStepLabel(g('a', { status: 'verifying' }), [cp('d7', 24 * 5)], NOW)).toMatch(/7 days check in 5 days/);
    expect(nextStepLabel(g('a', { status: 'verifying' }), [cp('h48', -2, { prompted_at: new Date(NOW - H).toISOString() })], NOW)).toMatch(/waiting for the customer/);
  });
});

describe('summarizeGuarantees', () => {
  it('returns nulls when nothing is decided yet', () => {
    const s = summarizeGuarantees([g('a'), g('b')], []);
    expect(s.holdRate).toBeNull();
    expect(s.recoveryRate).toBeNull();
    expect(s.medianRecoveryHours).toBeNull();
    expect(s.confirmedShare).toBeNull();
    expect(s.verifying).toBe(2);
  });

  it('computes hold rate from decided guarantees only', () => {
    const rows = [
      g('1', { status: 'verified', evidence_level: 'customer_confirmed' }),
      g('2', { status: 'expired', evidence_level: 'no_failure_signal' }),
      g('3', { status: 'verified', evidence_level: 'customer_confirmed' }),
      g('4', { status: 'recovered' }),
      g('5', { status: 'verifying' }),
      g('6', { status: 'voided' }),
    ];
    const s = summarizeGuarantees(rows, []);
    expect(s.holdRate).toBe(75);
    expect(s.confirmedShare).toBe(66.7);
    expect(s.recovered).toBe(1);
  });

  it('computes median recovery time and recovery rate, ignoring rejected claims', () => {
    const claims = [
      claim('1', { status: 'resolved', resolved_at: new Date(NOW - 5 * H + 10 * H).toISOString() }),
      claim('2', { status: 'resolved', resolved_at: new Date(NOW - 5 * H + 30 * H).toISOString() }),
      claim('3', { status: 'open' }),
      claim('4', { status: 'rejected', resolved_at: new Date(NOW).toISOString() }),
    ];
    const s = summarizeGuarantees([], claims);
    expect(s.medianRecoveryHours).toBe(20);
    expect(s.recoveryRate).toBe(66.7);
    expect(s.openClaims).toBe(1);
  });
});

describe('rankRecoveryTechnicians', () => {
  const tech = (id: string, name: string, skills: string[]): AssuranceTechnician => ({ id, name, skills, max_jobs_per_day: 6, dispatch_enabled: true });
  const outcome = (technician_id: string, good: boolean, i: number): OutcomeRow => ({
    job_id: `o${technician_id}${i}`,
    job_type_key: 'ac repair',
    resolution: good ? 'fixed_first_visit' : 'fixed_followup',
    duration_minutes: 90,
    is_rework: false,
    caused_callback: !good,
    technician_id,
  });

  const ctx: AssuranceContext = {
    now: NOW,
    jobs: [],
    technicians: [
      tech('t1', 'Original', ['ac repair']),
      tech('t2', 'Strong', ['ac repair']),
      { ...tech('t3', 'Off duty', ['ac repair']), dispatch_enabled: false },
    ],
    parts: [],
    briefs: [],
    outcomes: [
      ...[0, 1, 2, 3, 4].map((i) => outcome('t1', i === 0, i)),
      ...[0, 1, 2, 3, 4].map((i) => outcome('t2', true, i)),
    ],
    credentials: [],
    rules: [],
  };

  it('ranks the technician with the better track record first and skips non-dispatchable ones', () => {
    const ranked = rankRecoveryTechnicians(ctx, { customer_name: 'C', service_type: 'AC Repair', duration_minutes: 90, technician_id: 't1' }, new Date(NOW + 24 * H).toISOString());
    expect(ranked.map((r) => r.technicianId)).toEqual(['t2', 't1']);
    expect(ranked[1].isOriginal).toBe(true);
    expect(ranked[0].probability).toBeGreaterThan(ranked[1].probability);
  });

  it('excludes technicians with a blocking credential gap', () => {
    const blocked: AssuranceContext = { ...ctx, rules: [{ service_type: 'AC Repair', credential_type: 'EPA 608', is_blocking: true }], credentials: [{ technician_id: 't1', credential_type: 'EPA 608', status: 'active', expires_at: null }] };
    const ranked = rankRecoveryTechnicians(blocked, { customer_name: 'C', service_type: 'AC Repair', duration_minutes: 90, technician_id: 't1' }, new Date(NOW + 24 * H).toISOString());
    expect(ranked.map((r) => r.technicianId)).toEqual(['t1']);
  });
});
