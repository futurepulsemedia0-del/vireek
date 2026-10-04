import { describe, expect, it } from 'vitest';
import {
  analyzeExperiment,
  buildReworkedSet,
  collectCells,
  enrollmentCandidates,
  estimateEffect,
  observe,
  recommend,
  requiredPerArm,
  srmCheck,
  summarize,
  twoSidedP,
  validateDraft,
  type Assignment,
  type DraftInput,
  type ExpJob,
  type ExperimentConfig,
  type GuardrailResult,
} from '@/lib/opsExperiments';

const DAY = 86_400_000;
const NOW = new Date('2026-10-01T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

function job(id: string, over: Partial<ExpJob> = {}): ExpJob {
  return {
    id,
    service_type: 'AC Repair',
    job_status: 'completed',
    scheduled_datetime: daysAgo(40),
    created_at: daysAgo(41),
    completed_at: daysAgo(40),
    invoice_amount: 300,
    sla_response_hours: null,
    assigned_technician_id: 't1',
    is_rework: false,
    rework_of_job_id: null,
    ...over,
  };
}

function config(over: Partial<ExperimentConfig> = {}): ExperimentConfig {
  return {
    id: 'exp1',
    design: 'randomized',
    primary_metric: 'callback_rate',
    guardrail_metric: null,
    guardrail_tolerance: null,
    min_detectable_effect: 10,
    alpha: 0.05,
    duration_days: 28,
    treatment_share: 50,
    service_types: [],
    maturity_days: 14,
    status: 'running',
    started_at: daysAgo(60),
    concluded_at: null,
    ...over,
  };
}

const bin = (ones: number, total: number) => [...Array(ones).fill(1), ...Array(total - ones).fill(0)] as number[];

describe('numerics', () => {
  it('computes two-sided p-values for the normal distribution', () => {
    expect(twoSidedP(0)).toBeCloseTo(1, 6);
    expect(twoSidedP(1.96)).toBeCloseTo(0.05, 3);
    expect(twoSidedP(-2.5758)).toBeCloseTo(0.01, 3);
  });

  it('summarizes with an unbiased variance', () => {
    const s = summarize([1, 2, 3, 4]);
    expect(s.n).toBe(4);
    expect(s.mean).toBe(2.5);
    expect(s.variance).toBeCloseTo(1.6667, 3);
    expect(summarize([])).toEqual({ n: 0, mean: 0, variance: 0 });
  });
});

describe('observe', () => {
  const ctx = { reworked: new Set(['bad']), now: NOW, maturityDays: 14 };

  it('only counts first-time-fix once the callback window has passed', () => {
    expect(observe('ftf_rate', job('ok', { completed_at: daysAgo(20) }), ctx)).toBe(1);
    expect(observe('ftf_rate', job('young', { completed_at: daysAgo(5) }), ctx)).toBeNull();
    expect(observe('ftf_rate', job('bad', { completed_at: daysAgo(20) }), ctx)).toBe(0);
    expect(observe('callback_rate', job('bad', { completed_at: daysAgo(20) }), ctx)).toBe(1);
  });

  it('ignores rework jobs and unfinished jobs for quality metrics', () => {
    expect(observe('ftf_rate', job('r', { is_rework: true }), ctx)).toBeNull();
    expect(observe('ftf_rate', job('p', { job_status: 'in_progress', completed_at: null }), ctx)).toBeNull();
  });

  it('measures completion, SLA and revenue', () => {
    expect(observe('completion_rate', job('c'), ctx)).toBe(1);
    expect(observe('completion_rate', job('x', { job_status: 'no_show', completed_at: null }), ctx)).toBe(0);
    expect(observe('completion_rate', job('s', { job_status: 'scheduled', completed_at: null }), ctx)).toBeNull();
    expect(observe('sla_met_rate', job('a', { sla_response_hours: 48, created_at: daysAgo(10), scheduled_datetime: daysAgo(9) }), ctx)).toBe(1);
    expect(observe('sla_met_rate', job('b', { sla_response_hours: 4, created_at: daysAgo(10), scheduled_datetime: daysAgo(9) }), ctx)).toBe(0);
    expect(observe('sla_met_rate', job('n'), ctx)).toBeNull();
    expect(observe('avg_revenue', job('r1', { invoice_amount: 420 }), ctx)).toBe(420);
    expect(observe('avg_revenue', job('r2', { invoice_amount: null }), ctx)).toBeNull();
  });
});

describe('estimateEffect', () => {
  it('estimates a randomized difference with a confidence interval', () => {
    const est = estimateEffect('randomized', { treatment: bin(160, 200), control: bin(140, 200), treatmentPre: [], controlPre: [] }, 1.96);
    expect(est).not.toBeNull();
    expect(est!.effect).toBeCloseTo(0.1, 6);
    expect(est!.se).toBeCloseTo(0.0431, 3);
    expect(est!.p).toBeLessThan(0.05);
    expect(est!.ciLow).toBeGreaterThan(0);
    expect(est!.relativePct).toBeCloseTo(14.29, 1);
  });

  it('returns null when a group is too small', () => {
    expect(estimateEffect('randomized', { treatment: [1], control: bin(10, 20), treatmentPre: [], controlPre: [] }, 1.96)).toBeNull();
  });

  it('computes a difference-in-differences estimate and a counterfactual', () => {
    const est = estimateEffect(
      'comparison',
      { treatment: bin(70, 100), treatmentPre: bin(50, 100), control: bin(55, 100), controlPre: bin(50, 100) },
      1.96,
    );
    expect(est!.effect).toBeCloseTo(0.15, 6);
    expect(est!.counterfactual).toBeCloseTo(0.55, 6);
  });
});

describe('sample size and SRM', () => {
  it('sizes a binary test for 80% power', () => {
    const n = requiredPerArm('ftf_rate', 'randomized', { n: 500, mean: 0.8, sd: 0.4 }, 0.05, 0.05);
    expect(n).toBeGreaterThanOrEqual(902);
    expect(n).toBeLessThanOrEqual(904);
  });

  it('doubles the requirement for comparison designs and needs a spread for continuous metrics', () => {
    const rand = requiredPerArm('ftf_rate', 'randomized', { n: 500, mean: 0.8, sd: 0.4 }, 0.05, 0.05)!;
    const comp = requiredPerArm('ftf_rate', 'comparison', { n: 500, mean: 0.8, sd: 0.4 }, 0.05, 0.05)!;
    expect(comp).toBeGreaterThanOrEqual(rand * 2 - 1);
    expect(requiredPerArm('avg_revenue', 'randomized', null, 25, 0.05)).toBeNull();
    expect(requiredPerArm('avg_revenue', 'randomized', { n: 100, mean: 400, sd: 150 }, 25, 0.05)).toBeGreaterThan(30);
  });

  it('flags a sample-ratio mismatch only when the split is clearly off', () => {
    expect(srmCheck(500, 500, 50).failed).toBe(false);
    expect(srmCheck(520, 480, 50).failed).toBe(false);
    expect(srmCheck(600, 400, 50).failed).toBe(true);
    expect(srmCheck(5, 1, 50).failed).toBe(false);
  });
});

describe('analyzeExperiment (randomized)', () => {
  function build(trtReworkEvery: number, ctlReworkEvery: number, perArm = 200) {
    const jobs: ExpJob[] = [];
    const assignments: Assignment[] = [];
    for (let arm = 0; arm < 2; arm++) {
      const every = arm === 0 ? trtReworkEvery : ctlReworkEvery;
      for (let i = 0; i < perArm; i++) {
        const id = `${arm === 0 ? 't' : 'c'}${i}`;
        jobs.push(job(id));
        assignments.push({ unit_type: 'job', unit_id: id, arm: arm === 0 ? 'treatment' : 'control' });
        if (every > 0 && i % every === 0) jobs.push(job(`${id}-rw`, { is_rework: true, rework_of_job_id: id, assigned_technician_id: 't1' }));
      }
    }
    return { jobs, assignments };
  }

  it('declares a win when the intervention clearly lowers callbacks', () => {
    const { jobs, assignments } = build(10, 4);
    const a = analyzeExperiment(config(), jobs, assignments, { n: 400, mean: 0.18, sd: 0.38 }, NOW);
    expect(a.verdict).toBe('win');
    expect(a.primary.benefit).toBeGreaterThan(0);
    expect(a.recommendation).toBe('adopt');
    expect(a.srm?.failed).toBe(false);
  });

  it('keeps collecting when there is no difference and not enough data', () => {
    const { jobs, assignments } = build(5, 5, 60);
    const a = analyzeExperiment(config({ min_detectable_effect: 3 }), jobs, assignments, { n: 400, mean: 0.2, sd: 0.4 }, NOW);
    expect(a.verdict).toBe('collecting');
    expect(a.recommendation).toBe('continue');
  });

  it('declares a loss when callbacks go up', () => {
    const { jobs, assignments } = build(4, 10);
    const a = analyzeExperiment(config(), jobs, assignments, { n: 400, mean: 0.18, sd: 0.38 }, NOW);
    expect(a.verdict).toBe('loss');
    expect(a.recommendation).toBe('reject');
  });

  it('refuses to trust results when the split is not what was planned', () => {
    const { jobs, assignments } = build(10, 4);
    const skewed = assignments.filter((x) => x.arm === 'treatment').concat(assignments.filter((x) => x.arm === 'control').slice(0, 60));
    const a = analyzeExperiment(config(), jobs, skewed, { n: 400, mean: 0.18, sd: 0.38 }, NOW);
    expect(a.verdict).toBe('invalid');
    expect(a.recommendation).toBe('fix_design');
    expect(a.warnings.join(' ')).toMatch(/mismatch/i);
  });

  it('does not count jobs that are still inside the callback window', () => {
    const { jobs, assignments } = build(10, 4);
    const fresh = jobs.map((j) => (j.is_rework ? j : { ...j, completed_at: daysAgo(3) }));
    const cells = collectCells(config(), 'callback_rate', fresh, assignments, NOW);
    expect(cells.treatment).toHaveLength(0);
    expect(cells.control).toHaveLength(0);
  });
});

describe('guardrails and recommendations', () => {
  const g = (status: GuardrailResult['status']): GuardrailResult => ({ metric: 'sla_met_rate', estimate: null, benefit: null, status, tolerance: 0.02 });

  it('only recommends adoption when the guardrail holds', () => {
    expect(recommend('win', null)).toBe('adopt');
    expect(recommend('win', g('ok'))).toBe('adopt');
    expect(recommend('win', g('watch'))).toBe('adopt_monitor');
    expect(recommend('win', g('breached'))).toBe('iterate');
    expect(recommend('no_effect', null)).toBe('reject');
    expect(recommend('inconclusive', null)).toBe('iterate');
  });

  it('detects a guardrail breach from real data', () => {
    const jobs: ExpJob[] = [];
    const assignments: Assignment[] = [];
    for (let i = 0; i < 300; i++) {
      for (const arm of ['treatment', 'control'] as const) {
        const id = `${arm}-${i}`;
        // SLA met for 95% of control jobs but only 60% of treatment jobs.
        const metSla = arm === 'control' ? i % 20 !== 0 : i % 5 > 1;
        jobs.push(
          job(id, {
            sla_response_hours: 24,
            created_at: daysAgo(41),
            scheduled_datetime: new Date(NOW.getTime() - 41 * DAY + (metSla ? 6 : 60) * 3_600_000).toISOString(),
          }),
        );
        assignments.push({ unit_type: 'job', unit_id: id, arm });
      }
    }
    const a = analyzeExperiment(
      config({ primary_metric: 'completion_rate', guardrail_metric: 'sla_met_rate', guardrail_tolerance: 2, min_detectable_effect: 5 }),
      jobs,
      assignments,
      { n: 600, mean: 0.9, sd: 0.3 },
      NOW,
    );
    expect(a.guardrail?.status).toBe('breached');
  });
});

describe('comparison design', () => {
  it('splits jobs into before and during windows by technician group', () => {
    const cfg = config({ design: 'comparison', primary_metric: 'completion_rate', started_at: daysAgo(30), duration_days: 28 });
    const assignments: Assignment[] = [
      { unit_type: 'technician', unit_id: 'tA', arm: 'treatment' },
      { unit_type: 'technician', unit_id: 'tB', arm: 'control' },
    ];
    const at = (d: number, tech: string, id: string) => job(id, { assigned_technician_id: tech, scheduled_datetime: daysAgo(d), created_at: daysAgo(d + 1) });
    const jobs = [at(10, 'tA', 'a1'), at(40, 'tA', 'a2'), at(10, 'tB', 'b1'), at(45, 'tB', 'b2'), at(70, 'tB', 'b3'), at(10, 'tZ', 'z1')];
    const cells = collectCells(cfg, 'completion_rate', jobs, assignments, NOW);
    expect(cells.treatment).toHaveLength(1);
    expect(cells.treatmentPre).toHaveLength(1);
    expect(cells.control).toHaveLength(1);
    expect(cells.controlPre).toHaveLength(1);
  });
});

describe('enrollment and validation', () => {
  it('enrolls only upcoming, original, in-scope jobs that are not yet enrolled', () => {
    const cfg = config({ service_types: ['ac repair'] });
    const jobs = [
      job('new', { job_status: 'scheduled', completed_at: null }),
      job('enrolled', { job_status: 'scheduled', completed_at: null }),
      job('done'),
      job('rw', { job_status: 'scheduled', completed_at: null, is_rework: true }),
      job('other', { job_status: 'scheduled', completed_at: null, service_type: 'Plumbing' }),
    ];
    expect(enrollmentCandidates(cfg, jobs, new Set(['enrolled'])).map((j) => j.id)).toEqual(['new']);
    expect(enrollmentCandidates(config({ status: 'draft' }), jobs, new Set())).toEqual([]);
  });

  it('builds the rework lookup', () => {
    expect(buildReworkedSet([job('a'), job('b', { rework_of_job_id: 'a', is_rework: true })]).has('a')).toBe(true);
  });

  const valid: DraftInput = {
    title: 'Parts check',
    hypothesis: 'Checking parts first reduces callbacks.',
    intervention: 'Dispatcher confirms parts before each visit.',
    comparison_desc: '',
    design: 'randomized',
    primary_metric: 'callback_rate',
    guardrail_metric: 'sla_met_rate',
    guardrail_tolerance: 2,
    min_detectable_effect: 3,
    duration_days: 28,
    treatment_share: 50,
    maturity_days: 14,
    treatmentTechnicians: [],
    comparisonTechnicians: [],
  };

  it('accepts a complete draft and rejects incomplete ones', () => {
    expect(validateDraft(valid)).toEqual([]);
    expect(validateDraft({ ...valid, title: '' })).toHaveLength(1);
    expect(validateDraft({ ...valid, guardrail_metric: 'callback_rate' })).toHaveLength(1);
    expect(validateDraft({ ...valid, design: 'comparison', treatmentTechnicians: ['a'], comparisonTechnicians: ['a'] })).toHaveLength(1);
    expect(validateDraft({ ...valid, design: 'comparison' })).toHaveLength(1);
  });
});
