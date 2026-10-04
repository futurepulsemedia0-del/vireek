import { describe, expect, it } from 'vitest';
import {
  benjaminiHochberg,
  checkPolicies,
  compileLearning,
  evaluatePolicy,
  observe,
  type GuardPolicy,
  type OutcomeRow,
} from '@/lib/learningCompiler';

const NOW = Date.parse('2027-02-01T12:00:00Z');
const DAY = 86_400_000;
const TECH_BAD = '11111111-1111-1111-1111-111111111111';
const TECH_OK = '22222222-2222-2222-2222-222222222222';

function row(i: number, over: Partial<OutcomeRow> = {}): OutcomeRow {
  return {
    job_id: `job-${i}`,
    job_type_key: 'water_heater_replace',
    resolution: 'fixed_first_visit',
    caused_callback: false,
    is_rework: false,
    technician_id: TECH_OK,
    root_cause_key: null,
    parts_used: [],
    checklist_done: ['a', 'b'],
    checklist_total: 2,
    recorded_at: new Date(NOW - (200 - i) * DAY).toISOString(),
    ...over,
  };
}

/** 60 jobs spread evenly over time: TECH_BAD fails ~63% of 24, TECH_OK ~8% of 36. */
function dataset(): OutcomeRow[] {
  const rows: OutcomeRow[] = [];
  for (let i = 0; i < 60; i++) {
    const bad = i % 5 < 2 || i % 10 === 4;
    const tech = bad ? TECH_BAD : TECH_OK;
    const failed = bad ? i % 8 !== 0 : i % 12 === 3;
    rows.push(row(i, { technician_id: tech, caused_callback: failed, resolution: failed ? 'fixed_followup' : 'fixed_first_visit' }));
  }
  return rows;
}

describe('observe', () => {
  it('drops rework, declined quotes and rows outside the window', () => {
    const rows = [
      row(1, { is_rework: true }),
      row(2, { resolution: 'quote_declined' }),
      row(3, { recorded_at: new Date(NOW - 900 * DAY).toISOString() }),
      row(4, { resolution: 'quote_declined', caused_callback: true }),
      row(5),
    ];
    const obs = observe(rows, NOW);
    expect(obs.map((o) => o.jobId)).toEqual(['job-4', 'job-5']);
    expect(obs[0].failed).toBe(true);
  });

  it('marks an incomplete checklist and dedupes parts', () => {
    const [o] = observe([row(1, { checklist_done: ['a'], parts_used: ['Valve', ' valve '] })], NOW);
    expect(o.facets.filter((f) => f.dimension === 'part')).toHaveLength(1);
    expect(o.facets.some((f) => f.dimension === 'checklist_incomplete')).toBe(true);
  });
});

describe('benjaminiHochberg', () => {
  it('returns monotone adjusted values in input order', () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.5]);
    expect(q[0]).toBeCloseTo(0.04, 5);
    expect(q[3]).toBeCloseTo(0.5, 5);
    expect(Math.max(...q)).toBeLessThanOrEqual(1);
  });
});

describe('compileLearning', () => {
  it('compiles a replicated technician pattern into a review policy', () => {
    const result = compileLearning(dataset(), { now: NOW, technicianName: (id) => (id === TECH_BAD ? 'Sam' : 'Alex') });
    const policy = result.policies.find((p) => p.kind === 'dispatch_review');
    expect(policy).toBeDefined();
    expect(policy?.dimension_value).toBe(TECH_BAD);
    expect(policy?.severity).toBe('avoid');
    expect(policy?.backtest.replicated).toBe(true);
    expect(policy?.workflow_blueprint?.steps[0].type).toBe('human_approval');
    expect(policy?.title).toContain('Sam');
    expect(result.stages.policies).toBe(result.policies.length);
  });

  it('proposes nothing from tiny samples', () => {
    const result = compileLearning(dataset().slice(0, 10), { now: NOW });
    expect(result.policies).toHaveLength(0);
  });

  it('proposes nothing when failures are spread evenly', () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(i, {
        technician_id: i % 2 === 0 ? TECH_BAD : TECH_OK,
        caused_callback: i % 3 === 0,
        resolution: i % 3 === 0 ? 'fixed_followup' : 'fixed_first_visit',
      }),
    );
    expect(compileLearning(rows, { now: NOW }).policies).toHaveLength(0);
  });

  it('drops the protective mirror image of a harmful pattern', () => {
    const kinds = compileLearning(dataset(), { now: NOW }).policies.map((p) => p.kind);
    expect(kinds).toEqual(['dispatch_review']);
  });
});

describe('evaluatePolicy', () => {
  const activatedAt = new Date(NOW - 30 * DAY).toISOString();
  const scope = { job_type_key: 'water_heater_replace', dimension: 'technician' as const, dimension_value: TECH_BAD, kind: 'dispatch_review' as const, activated_at: activatedAt };

  it('reports insufficient data before enough jobs follow activation', () => {
    const obs = observe(dataset(), NOW);
    expect(evaluatePolicy({ ...scope, activated_at: new Date(NOW).toISOString() }, obs, NOW).verdict).toBe('insufficient_data');
  });

  /** failures out of 10 jobs for a technician in a period (`daysAgo` = start, one job per day). */
  function period(tech: string, daysAgo: number, failures: number, offset: number): OutcomeRow[] {
    return Array.from({ length: 10 }, (_, k) =>
      row(offset + k, {
        technician_id: tech,
        caused_callback: k < failures,
        resolution: k < failures ? 'fixed_followup' : 'fixed_first_visit',
        recorded_at: new Date(NOW - (daysAgo - k) * DAY).toISOString(),
      }),
    );
  }

  it('detects improvement against the uncovered control group', () => {
    const rows = [
      ...period(TECH_BAD, 60, 6, 0), ...period(TECH_OK, 60, 2, 100),
      ...period(TECH_BAD, 20, 1, 200), ...period(TECH_OK, 20, 2, 300),
    ];
    const r = evaluatePolicy(scope, observe(rows, NOW), NOW);
    expect(r.verdict).toBe('effective');
    expect(r.control.used).toBe(true);
    expect(r.didEffect).toBeCloseTo(0.5, 5);
  });

  it('flags a policy that coincides with things getting worse', () => {
    const rows = [
      ...period(TECH_BAD, 60, 6, 0), ...period(TECH_OK, 60, 2, 100),
      ...period(TECH_BAD, 20, 8, 200), ...period(TECH_OK, 20, 2, 300),
    ];
    expect(evaluatePolicy(scope, observe(rows, NOW), NOW).verdict).toBe('harmful');
  });

  it('does not measure preference policies', () => {
    expect(evaluatePolicy({ ...scope, kind: 'dispatch_prefer' }, [], NOW).verdict).toBe('not_applicable');
  });
});

describe('checkPolicies', () => {
  const policy: GuardPolicy = {
    id: 'p1',
    job_type_key: 'water_heater_replace',
    dimension: 'technician',
    dimension_value: TECH_BAD,
    kind: 'dispatch_review',
    severity: 'avoid',
    enforcement: 'require_approval',
    title: 'Review Sam',
    rationale: 'because',
  };

  it('matches the technician on the same job type only', () => {
    expect(checkPolicies({ jobTypeKey: 'Water Heater Replace', technicianId: TECH_BAD }, [policy])).toHaveLength(1);
    expect(checkPolicies({ jobTypeKey: 'water_heater_replace', technicianId: TECH_OK }, [policy])).toHaveLength(0);
    expect(checkPolicies({ jobTypeKey: 'drain_clear', technicianId: TECH_BAD }, [policy])).toHaveLength(0);
  });

  it('flags require_approval and never forces a preference policy', () => {
    const [m] = checkPolicies({ jobTypeKey: 'water_heater_replace', technicianId: TECH_BAD }, [policy]);
    expect(m.requiresApproval).toBe(true);
    const [p] = checkPolicies({ jobTypeKey: 'water_heater_replace', technicianId: TECH_BAD }, [{ ...policy, kind: 'dispatch_prefer' }]);
    expect(p.requiresApproval).toBe(false);
  });
});
