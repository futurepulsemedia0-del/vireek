import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  ASSURANCE,
  DEFAULT_SETTINGS,
  FACTOR_WEIGHTS,
  combineFactors,
  computeCalibration,
  evaluateAll,
  evaluateJob,
  jobTypeMatches,
  shrunkRate,
  skillMatch,
  statusFor,
} from './outcomeAssurance';
import type { AssuranceContext, AssuranceJob, AssuranceTechnician, OutcomeRow, PartsLine } from './outcomeAssurance';

const NOW = new Date('2026-10-01T08:00:00Z').getTime();
const HOUR = 3600000;

function job(id: string, over: Partial<AssuranceJob> = {}): AssuranceJob {
  return {
    id,
    customer_name: `Customer ${id}`,
    service_type: 'AC Repair',
    scheduled_datetime: new Date(NOW + 4 * HOUR).toISOString(),
    duration_minutes: 90,
    assigned_technician_id: 't1',
    job_status: 'scheduled',
    customer_type: 'residential',
    sla_response_hours: null,
    is_rework: false,
    diagnosis_notes: null,
    ...over,
  };
}

function tech(id: string, over: Partial<AssuranceTechnician> = {}): AssuranceTechnician {
  return { id, name: `Tech ${id}`, skills: ['ac repair'], max_jobs_per_day: 6, dispatch_enabled: true, ...over };
}

function outcomes(techId: string, n: number, ok: number): OutcomeRow[] {
  return Array.from({ length: n }, (_, i) => ({
    job_id: `o-${techId}-${i}`,
    job_type_key: 'ac_repair',
    resolution: i < ok ? 'fixed_first_visit' : 'fixed_followup',
    duration_minutes: 100,
    is_rework: false,
    caused_callback: false,
    technician_id: techId,
  }));
}

const readyPart = (jobId: string): PartsLine => ({ job_id: jobId, part_name: 'Capacitor', quantity_required: 1, shortage_quantity: 0, readiness_status: 'ready' });
const shortPart = (jobId: string): PartsLine => ({ job_id: jobId, part_name: 'Compressor', quantity_required: 1, shortage_quantity: 1, readiness_status: 'short' });

function ctx(over: Partial<AssuranceContext> = {}): AssuranceContext {
  return { now: NOW, jobs: [job('j1')], technicians: [tech('t1'), tech('t2')], parts: [], briefs: [], outcomes: [], credentials: [], rules: [], ...over };
}

const brief = (jobId: string, confidence: number) => ({ job_id: jobId, confidence, risk_flag_count: 0, predicted_issue: 'Capacitor' });

describe('constants', () => {
  it('factor weights sum to 100', () => {
    expect(Object.values(FACTOR_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('helpers', () => {
  it('matches job types and skills', () => {
    expect(jobTypeMatches('AC Repair - no cooling', 'ac_repair')).toBe(true);
    expect(jobTypeMatches('Water heater install', 'ac_repair')).toBe(false);
    expect(skillMatch(['ac repair'], 'AC Repair')).toBe('full');
    expect(skillMatch(['plumbing'], 'AC Repair')).toBe('none');
    expect(skillMatch([], 'AC Repair')).toBe('unknown');
  });

  it('shrinks small samples toward the prior', () => {
    const three = shrunkRate(3, 3, ASSURANCE.prior);
    expect(three).toBeLessThan(0.9);
    expect(three).toBeGreaterThan(ASSURANCE.prior);
    expect(shrunkRate(190, 200, ASSURANCE.prior)).toBeGreaterThan(0.93);
  });
});

describe('evaluateJob', () => {
  it('refuses to promise a number without enough evidence', () => {
    const r = evaluateJob(job('j1'), ctx());
    expect(r.status).toBe('insufficient');
    expect(r.coverage).toBeLessThan(50);
    expect(r.interventions.some((i) => i.kind === 'add_evidence')).toBe(true);
  });

  it('assures a well-prepared job and never reaches 100%', () => {
    const c = ctx({ parts: [readyPart('j1')], briefs: [brief('j1', 0.95)], outcomes: [...outcomes('t1', 30, 29), ...outcomes('t2', 6, 4)] });
    const r = evaluateJob(c.jobs[0], c);
    expect(r.status).toBe('assured');
    expect(r.probability).toBeGreaterThanOrEqual(85);
    expect(r.probability).toBeLessThanOrEqual(99);
    expect(r.interventions).toHaveLength(0);
  });

  it('a missing part lowers probability and adds delay', () => {
    const good = ctx({ parts: [readyPart('j1')], briefs: [brief('j1', 0.9)], outcomes: outcomes('t1', 20, 18) });
    const short = { ...good, parts: [shortPart('j1'), readyPart('j1')] };
    const a = evaluateJob(good.jobs[0], good);
    const b = evaluateJob(short.jobs[0], short);
    expect(b.probability).toBeLessThan(a.probability);
    expect(b.partsReadiness).toBe(50);
    expect(b.expectedResolutionMinutes).toBeGreaterThan(a.expectedResolutionMinutes);
    expect(b.interventions[0].kind).toBe('resolve_parts');
  });

  it('caps probability and forces intervention on a blocking credential gap', () => {
    const c = ctx({
      parts: [readyPart('j1')],
      briefs: [brief('j1', 0.95)],
      outcomes: [...outcomes('t1', 20, 19), ...outcomes('t2', 20, 19)],
      rules: [{ service_type: 'ac repair', credential_type: 'EPA 608', is_blocking: true }],
      credentials: [{ technician_id: 't2', credential_type: 'EPA 608', status: 'active', expires_at: null }],
    });
    const r = evaluateJob(c.jobs[0], c);
    expect(r.status).toBe('intervene');
    expect(r.probability).toBeLessThanOrEqual(ASSURANCE.blockerCap * 100);
    expect(r.interventions[0].kind).toBe('resolve_compliance');
    expect(r.interventions[0].reassignTo?.technicianId).toBe('t2');
  });

  it('an expired credential does not satisfy a blocking rule', () => {
    const c = ctx({
      parts: [readyPart('j1')],
      rules: [{ service_type: 'ac repair', credential_type: 'EPA 608', is_blocking: true }],
      credentials: [{ technician_id: 't1', credential_type: 'EPA 608', status: 'active', expires_at: new Date(NOW - HOUR).toISOString() }],
    });
    expect(evaluateJob(c.jobs[0], c).blockers.length).toBe(1);
  });

  it('suggests a reassignment only when it helps by at least the minimum gain', () => {
    const weak = ctx({
      technicians: [tech('t1', { skills: ['plumbing'] }), tech('t2')],
      parts: [readyPart('j1')],
      briefs: [brief('j1', 0.85)],
      outcomes: [...outcomes('t1', 10, 4), ...outcomes('t2', 10, 9)],
    });
    const r = evaluateJob(weak.jobs[0], weak);
    const swap = r.interventions.find((i) => i.kind === 'reassign_technician');
    expect(swap?.reassignTo?.technicianId).toBe('t2');
    expect(swap?.reassignTo?.gain).toBeGreaterThanOrEqual(ASSURANCE.reassignMinGain);

    const equal = ctx({ parts: [readyPart('j1')], briefs: [brief('j1', 0.85)], outcomes: [...outcomes('t1', 10, 8), ...outcomes('t2', 10, 8)] });
    const r2 = evaluateJob(equal.jobs[0], equal);
    expect(r2.interventions.every((i) => !i.reassignTo)).toBe(true);
  });

  it('detects overlapping jobs for the same technician', () => {
    const c = ctx({
      jobs: [job('j1'), job('j2', { scheduled_datetime: new Date(NOW + 4.5 * HOUR).toISOString() })],
      parts: [readyPart('j1')],
      briefs: [brief('j1', 0.9)],
      outcomes: outcomes('t1', 10, 9),
    });
    const r = evaluateJob(c.jobs[0], c);
    const sched = r.factors.find((f) => f.key === 'schedule');
    expect(sched?.score).toBeLessThanOrEqual(25);
    expect(r.interventions.some((i) => i.kind === 'fix_schedule')).toBe(true);
  });

  it('flags an unassigned job', () => {
    const c = ctx({ jobs: [job('j1', { assigned_technician_id: null })], parts: [readyPart('j1')], briefs: [brief('j1', 0.9)], outcomes: outcomes('t2', 10, 9) });
    const r = evaluateJob(c.jobs[0], c);
    expect(r.technicianId).toBeNull();
    expect(r.interventions.some((i) => i.kind === 'assign_technician')).toBe(true);
  });

  it('rates disruption higher for emergency + tight SLA jobs', () => {
    const calm = ctx({ parts: [readyPart('j1')], briefs: [brief('j1', 0.9)], outcomes: outcomes('t1', 10, 9) });
    const hot = { ...calm, jobs: [job('j1', { service_type: 'Emergency AC Repair no cooling', sla_response_hours: 2, customer_type: 'commercial' })] };
    expect(evaluateJob(calm.jobs[0], calm).disruptionRisk).toBe('low');
    expect(['medium', 'high']).toContain(evaluateJob(hot.jobs[0], hot).disruptionRisk);
  });

  it('is deterministic', () => {
    const c = ctx({ parts: [shortPart('j1')], briefs: [brief('j1', 0.7)], outcomes: outcomes('t1', 8, 5) });
    expect(evaluateJob(c.jobs[0], c)).toEqual(evaluateJob(c.jobs[0], c));
  });
});

describe('combineFactors / statusFor', () => {
  it('one broken factor drags the result below the arithmetic mean', () => {
    const mk = (key: 'parts' | 'technician', score: number) => ({ key, label: key, weight: 50, score, evidence: 'measured' as const, detail: '', issues: [] });
    const { probability } = combineFactors([mk('parts', 10), mk('technician', 100)]);
    expect(probability).toBeLessThan(0.55);
  });

  it('applies thresholds', () => {
    expect(statusFor(90, 100, false, DEFAULT_SETTINGS)).toBe('assured');
    expect(statusFor(75, 100, false, DEFAULT_SETTINGS)).toBe('watch');
    expect(statusFor(60, 100, false, DEFAULT_SETTINGS)).toBe('intervene');
    expect(statusFor(95, 30, false, DEFAULT_SETTINGS)).toBe('insufficient');
    expect(statusFor(95, 30, true, DEFAULT_SETTINGS)).toBe('intervene');
  });
});

describe('evaluateAll', () => {
  it('evaluates only upcoming jobs and puts the riskiest first', () => {
    const c = ctx({
      jobs: [job('ok'), job('bad'), job('done', { job_status: 'completed' })],
      parts: [readyPart('ok'), shortPart('bad')],
      briefs: [brief('ok', 0.95), brief('bad', 0.4)],
      outcomes: outcomes('t1', 20, 18),
    });
    const rows = evaluateAll(c);
    expect(rows.map((r) => r.job.id)).toEqual(['bad', 'ok']);
  });
});

describe('computeCalibration', () => {
  it('compares predictions with what actually happened', () => {
    const cal = computeCalibration(
      [
        { job_id: 'a', probability: 92, status: 'assured', created_at: '2026-01-01' },
        { job_id: 'b', probability: 91, status: 'assured', created_at: '2026-01-01' },
        { job_id: 'c', probability: 60, status: 'intervene', created_at: '2026-01-01' },
      ],
      [
        { job_id: 'a', job_type_key: 'x', resolution: 'fixed_first_visit', duration_minutes: null, is_rework: false, caused_callback: false, technician_id: null },
        { job_id: 'b', job_type_key: 'x', resolution: 'fixed_followup', duration_minutes: null, is_rework: false, caused_callback: false, technician_id: null },
        { job_id: 'c', job_type_key: 'x', resolution: 'fixed_followup', duration_minutes: null, is_rework: false, caused_callback: false, technician_id: null },
      ],
    );
    expect(cal.n).toBe(3);
    expect(cal.buckets.find((b) => b.label === '90%+')?.actual).toBe(50);
    expect(cal.brier).not.toBeNull();
  });
});
