import { describe, expect, it } from 'vitest';
import { requiredPerArm as growthRequiredPerArm } from '@/lib/growth/growthExperiments';
import { srmCheck } from '@/lib/stats/inference';
import {
  alphaSpent,
  binarySample,
  chiSquareSf,
  conditionalPower,
  decideAtLook,
  detectableHarm,
  evaluateGuardrail,
  informationFraction,
  minimumDetectableEffect,
  normalQuantile,
  normalSf,
  rollupGuardrails,
  sampleSize,
  sampleSizeForRule,
  sequentialBoundaries,
  sequentialCrossingProbability,
  sequentialInflation,
  srmCheckArms,
  validatePreRegistration,
  type DecisionRule,
  type PreRegistration,
} from '@/lib/stats/experimentStandards';

const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

describe('normal and chi-square primitives', () => {
  it('quantiles match reference values', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 10);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212335729143, 10);
    expect(normalQuantile(0.995)).toBeCloseTo(2.5758293035489, 10);
    expect(normalQuantile(1e-6)).toBeCloseTo(-4.753424308822899, 9);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 12);
  });
  it('quantile edge cases', () => {
    expect(normalQuantile(0)).toBe(-Infinity);
    expect(normalQuantile(1)).toBe(Infinity);
    expect(normalQuantile(1.5)).toBeNaN();
  });
  it('normalSf inverts normalQuantile in the far tail', () => {
    for (const p of [1e-3, 1e-6, 1e-9]) expect(normalSf(-normalQuantile(p)) / p).toBeCloseTo(1, 6);
    expect(normalSf(0)).toBeCloseTo(0.5, 12);
    expect(normalSf(-1.959963984540054)).toBeCloseTo(0.975, 12);
  });
  it('chi-square survival matches textbook 5% critical values', () => {
    expect(chiSquareSf(3.841458820694124, 1)).toBeCloseTo(0.05, 10);
    expect(chiSquareSf(5.991464547107979, 2)).toBeCloseTo(0.05, 10);
    expect(chiSquareSf(7.814727903251179, 3)).toBeCloseTo(0.05, 10);
    expect(chiSquareSf(18.307038053275146, 10)).toBeCloseTo(0.05, 10);
    expect(chiSquareSf(0, 3)).toBe(1);
  });
});

describe('sampleSize', () => {
  it('binary: 20% baseline, +5pp, 80% power, alpha .05 => 1091 per arm, same as the growth calculator', () => {
    const r = sampleSize({ kind: 'binary', baselineRate: 0.2, mde: 0.05 });
    expect(r).toMatchObject({ ok: true, control: 1091, treatment: 1091, total: 2182 });
    expect(growthRequiredPerArm(0.2, 0.05, 0.05)).toBe(1091);
  });
  it('mean: sd 10, effect 2 => 393 per arm (2 * 7.849 * 100 / 4 = 392.4)', () => {
    expect(sampleSize({ kind: 'mean', sd: 10, mde: 2 })).toMatchObject({ ok: true, control: 393, treatment: 393 });
  });
  it('unequal allocation: 20% to treatment needs more control units and more in total', () => {
    const r = sampleSize({ kind: 'binary', baselineRate: 0.2, mde: 0.05, treatmentShare: 20 });
    expect(r).toMatchObject({ ok: true, control: 2857, treatment: 715 });
    if (r.ok) expect(r.total).toBeGreaterThan(2182);
  });
  it('relative effect equals the matching absolute effect', () => {
    const rel = sampleSize({ kind: 'binary', baselineRate: 0.2, mde: 0.25, relative: true });
    const abs = sampleSize({ kind: 'binary', baselineRate: 0.2, mde: 0.05 });
    expect(rel).toEqual(abs);
  });
  it('higher power, smaller alpha and smaller effect all increase the sample; one-sided decreases it', () => {
    const base = sampleSize({ kind: 'mean', sd: 10, mde: 2 });
    const n = (o: object) => {
      const r = sampleSize({ kind: 'mean', sd: 10, mde: 2, ...o });
      return r.ok ? r.control : NaN;
    };
    const b = base.ok ? base.control : NaN;
    expect(n({ power: 0.9 })).toBeGreaterThan(b);
    expect(n({ alpha: 0.01 })).toBeGreaterThan(b);
    expect(n({ mde: 1 })).toBeGreaterThan(b);
    expect(n({ sides: 1 })).toBeLessThan(b);
  });
  it('turns units per day into whole weeks by default', () => {
    expect(sampleSize({ kind: 'binary', baselineRate: 0.2, mde: 0.05, unitsPerDay: 100 })).toMatchObject({ days: 28 });
    expect(sampleSize({ kind: 'binary', baselineRate: 0.2, mde: 0.05, unitsPerDay: 100, wholeWeeks: false })).toMatchObject({ days: 22 });
  });
  it('a baseline near 1 sizes for the opposite direction instead of failing', () => {
    expect(sampleSize({ kind: 'binary', baselineRate: 0.97, mde: 0.05 }).ok).toBe(true);
    expect(sampleSize({ kind: 'binary', baselineRate: 0.5, mde: 0.6 })).toEqual({ ok: false, error: 'effect_out_of_range' });
  });
  it('rejects bad input with a specific error', () => {
    const e = (o: object) => {
      const r = sampleSize({ kind: 'binary', baselineRate: 0.2, mde: 0.05, ...o });
      return r.ok ? 'ok' : r.error;
    };
    expect(e({ alpha: 0 })).toBe('invalid_alpha');
    expect(e({ power: 1 })).toBe('invalid_power');
    expect(e({ treatmentShare: 100 })).toBe('invalid_share');
    expect(e({ mde: 0 })).toBe('invalid_mde');
    expect(e({ mde: NaN })).toBe('invalid_mde');
    expect(e({ baselineRate: 0 })).toBe('invalid_baseline');
    expect(sampleSize({ kind: 'mean', mde: 1 })).toEqual({ ok: false, error: 'invalid_sd' });
  });
});

describe('minimumDetectableEffect', () => {
  it('is the inverse of sampleSize (binary)', () => {
    const d = minimumDetectableEffect({ kind: 'binary', baselineRate: 0.2 }, 1091);
    expect(d).not.toBeNull();
    expect(d as number).toBeLessThan(0.05 + 1e-9);
    expect(d as number).toBeGreaterThan(0.0498);
  });
  it('mean has a closed form: z * sd * sqrt(2 / n)', () => {
    expect(minimumDetectableEffect({ kind: 'mean', sd: 10 }, 393) as number).toBeCloseTo((1.959963984540054 + 0.8416212335729143) * 10 * Math.sqrt(2 / 393), 9);
  });
  it('returns null for impossible or invalid input', () => {
    expect(minimumDetectableEffect({ kind: 'binary', baselineRate: 0.2 }, 0)).toBeNull();
    expect(minimumDetectableEffect({ kind: 'binary', baselineRate: 0.2 }, 1)).toBeNull();
    expect(minimumDetectableEffect({ kind: 'binary' }, 100)).toBeNull();
  });
});

describe('srmCheckArms', () => {
  it('agrees with the existing two-arm srmCheck', () => {
    for (const [t, c] of [[5200, 4800], [5000, 5000], [5300, 4700]]) {
      const multi = srmCheckArms([c, t], [50, 50]);
      expect(multi.p).toBeCloseTo(srmCheck(t, c, 50).p, 5);
    }
    expect(srmCheckArms([4700, 5300], [50, 50]).status).toBe(srmCheck(5300, 4700, 50).failed ? 'mismatch' : 'ok');
  });
  it('flags a clear mismatch and passes a balanced split', () => {
    expect(srmCheckArms([4700, 5300], [1, 1]).status).toBe('mismatch');
    expect(srmCheckArms([5010, 4990], [1, 1]).status).toBe('ok');
  });
  it('works for three arms with unequal planned shares', () => {
    const ok = srmCheckArms([2500, 2490, 5010], [1, 1, 2]);
    expect(ok).toMatchObject({ status: 'ok', df: 2 });
    expect(srmCheckArms([3000, 2000, 5000], [1, 1, 2]).status).toBe('mismatch');
  });
  it('does not call a verdict on tiny samples', () => {
    expect(srmCheckArms([3, 1], [1, 1]).status).toBe('insufficient_data');
    expect(srmCheckArms([0, 0], [1, 1]).status).toBe('insufficient_data');
  });
  it('rejects malformed input', () => {
    expect(() => srmCheckArms([10], [1])).toThrow();
    expect(() => srmCheckArms([10, 10], [1])).toThrow();
    expect(() => srmCheckArms([-1, 10], [1, 1])).toThrow();
    expect(() => srmCheckArms([10, 10], [1, 0])).toThrow();
  });
});

describe('alpha spending and sequential boundaries', () => {
  it('spends exactly alpha at full information and nothing at zero', () => {
    for (const s of ['obrien_fleming', 'pocock'] as const) {
      expect(alphaSpent(1, 0.05, s)).toBe(0.05);
      expect(alphaSpent(0, 0.05, s)).toBe(0);
      expect(alphaSpent(0.5, 0.05, s)).toBeLessThan(0.05);
    }
    expect(alphaSpent(0.5, 0.05, 'obrien_fleming')).toBeLessThan(alphaSpent(0.5, 0.05, 'pocock'));
  });
  it('single look equals the fixed-horizon critical value', () => {
    expect(sequentialBoundaries([1], 0.05, 'obrien_fleming')[0]).toBeCloseTo(1.959963984540054, 6);
  });
  it('first look matches the spending function exactly', () => {
    const [c1] = sequentialBoundaries([0.5, 1], 0.05, 'obrien_fleming');
    expect(2 * normalSf(c1)).toBeCloseTo(alphaSpent(0.5, 0.05, 'obrien_fleming'), 9);
    expect(c1).toBeCloseTo(2.7718, 3);
  });
  it('total type-I error equals alpha, for planned and for irregular looks', () => {
    for (const looks of [[0.2, 0.4, 0.6, 0.8, 1], [0.3, 0.55, 1], [0.25, 0.5]]) {
      for (const s of ['obrien_fleming', 'pocock'] as const) {
        const b = sequentialBoundaries(looks, 0.05, s);
        const expected = alphaSpent(looks[looks.length - 1], 0.05, s);
        expect(sequentialCrossingProbability(looks, b, 0)).toBeCloseTo(expected, 6);
      }
    }
  });
  it('O\'Brien-Fleming boundaries fall with information, Pocock stays nearly flat', () => {
    const looks = [0.2, 0.4, 0.6, 0.8, 1];
    const obf = sequentialBoundaries(looks, 0.05, 'obrien_fleming');
    const poc = sequentialBoundaries(looks, 0.05, 'pocock');
    for (let i = 1; i < obf.length; i++) expect(obf[i]).toBeLessThan(obf[i - 1]);
    expect(obf[0]).toBeGreaterThan(4);
    expect(obf[4]).toBeLessThan(2.1);
    expect(Math.max(...poc) - Math.min(...poc)).toBeLessThan(0.1);
  });
  it('power at the planned effect is preserved by the inflation factor', () => {
    const looks = [0.2, 0.4, 0.6, 0.8, 1];
    const b = sequentialBoundaries(looks, 0.05, 'obrien_fleming');
    const f = sequentialInflation(looks, 0.05, 'obrien_fleming');
    const theta = (1.959963984540054 + 0.8416212335729143) * Math.sqrt(f);
    expect(sequentialCrossingProbability(looks, b, theta)).toBeCloseTo(0.8, 3);
  });
  it('inflation is ~1 for one look, small for O\'Brien-Fleming, larger for Pocock', () => {
    expect(sequentialInflation([1], 0.05, 'obrien_fleming')).toBeCloseTo(1, 3);
    const looks = [0.2, 0.4, 0.6, 0.8, 1];
    const obf = sequentialInflation(looks, 0.05, 'obrien_fleming');
    const poc = sequentialInflation(looks, 0.05, 'pocock');
    expect(obf).toBeGreaterThan(1);
    expect(obf).toBeLessThan(1.06);
    expect(poc).toBeGreaterThan(1.15);
    expect(poc).toBeLessThan(1.3);
  });
  it('rejects invalid look schedules and alpha', () => {
    expect(() => sequentialBoundaries([], 0.05, 'pocock')).toThrow();
    expect(() => sequentialBoundaries([0.5, 0.5], 0.05, 'pocock')).toThrow();
    expect(() => sequentialBoundaries([0.5, 1.2], 0.05, 'pocock')).toThrow();
    expect(() => sequentialBoundaries([0.5, 1], 0, 'pocock')).toThrow();
  });
});

describe('decision rules', () => {
  const fixed: DecisionRule = { kind: 'fixed_horizon', alpha: 0.05 };
  const seq: DecisionRule = { kind: 'group_sequential', alpha: 0.05, spending: 'obrien_fleming', plannedLooks: [0.25, 0.5, 0.75, 1], futilityConditionalPower: 0.1 };

  it('fixed horizon never decides before the horizon, however extreme the data', () => {
    expect(decideAtLook(fixed, { looksTaken: [0.6], z: 9 })).toMatchObject({ action: 'continue', reason: 'before_horizon' });
  });
  it('fixed horizon decides at the horizon using the plain critical value', () => {
    expect(decideAtLook(fixed, { looksTaken: [1], z: 2.1 })).toMatchObject({ action: 'stop_efficacy', direction: 'positive' });
    expect(decideAtLook(fixed, { looksTaken: [1], z: -2.1 })).toMatchObject({ action: 'stop_efficacy', direction: 'negative' });
    expect(decideAtLook(fixed, { looksTaken: [1], z: 1.5 })).toMatchObject({ action: 'stop_not_significant' });
  });
  it('sequential stops early only on a very strong early signal', () => {
    expect(decideAtLook(seq, { looksTaken: [0.25], z: 2.5 }).action).toBe('continue');
    expect(decideAtLook(seq, { looksTaken: [0.25], z: 4.5 })).toMatchObject({ action: 'stop_efficacy', reason: 'boundary_crossed' });
  });
  it('sequential uses a near-nominal threshold at the end and reports not significant below it', () => {
    const d = decideAtLook(seq, { looksTaken: [0.25, 0.5, 0.75, 1], z: 1.9 });
    expect(d.action).toBe('stop_not_significant');
    expect(d.criticalZ).toBeGreaterThan(1.96);
    expect(d.criticalZ).toBeLessThan(2.1);
  });
  it('advises stopping for futility only from half information and only when conditional power is low', () => {
    expect(decideAtLook(seq, { looksTaken: [0.25], z: 0.1 }).action).toBe('continue');
    expect(decideAtLook(seq, { looksTaken: [0.25, 0.5, 0.75], z: 0.2 })).toMatchObject({ action: 'futility_advised', reason: 'low_conditional_power' });
    expect(decideAtLook(seq, { looksTaken: [0.25, 0.5, 0.75], z: 1.8 }).action).toBe('continue');
  });
  it('conditional power is 50% when the current trend lands exactly on the final boundary', () => {
    expect(conditionalPower(1.959963984540054 * Math.sqrt(0.5), 0.5, 0.05)).toBeCloseTo(0.5, 8);
    expect(conditionalPower(3, 0.5, 0.05)).toBeGreaterThan(conditionalPower(1, 0.5, 0.05));
    expect(conditionalPower(1, 1, 0.05)).toBeNaN();
  });
  it('sample size under a sequential rule is inflated, fixed is not', () => {
    const input = { kind: 'binary', baselineRate: 0.2, mde: 0.05 } as const;
    const base = sampleSize(input);
    expect(sampleSizeForRule(input, fixed)).toEqual(base);
    const s = sampleSizeForRule(input, { ...seq, spending: 'pocock' });
    if (base.ok && s.ok) expect(s.control).toBeGreaterThan(base.control * 1.1);
    else throw new Error('sizing failed');
  });
  it('information fraction is capped and safe on bad input', () => {
    expect(informationFraction(500, 1000)).toBe(0.5);
    expect(informationFraction(2000, 1000)).toBe(1);
    expect(informationFraction(10, 0)).toBe(0);
  });
});

describe('guardrails', () => {
  const spec = { name: 'cancel_rate', harm: 'increase' as const, tolerance: 0.02 };
  it('breached when the worsening is confidently beyond the tolerance', () => {
    const r = evaluateGuardrail(spec, binarySample(150, 1000), binarySample(60, 1000));
    expect(r).toMatchObject({ status: 'breached', reason: 'breach' });
    expect(r.harm).toBeCloseTo(0.09, 10);
  });
  it('ok when the worsening is confidently within the tolerance', () => {
    const r = evaluateGuardrail(spec, binarySample(500, 20000), binarySample(500, 20000));
    expect(r).toMatchObject({ status: 'ok', reason: 'non_inferior' });
  });
  it('watch when neither can be shown', () => {
    expect(evaluateGuardrail(spec, binarySample(70, 1000), binarySample(60, 1000)).status).toBe('watch');
  });
  it('unknown when a group is too small or the input is invalid', () => {
    expect(evaluateGuardrail(spec, binarySample(1, 10), binarySample(1, 10))).toMatchObject({ status: 'unknown', reason: 'insufficient_sample' });
    expect(evaluateGuardrail(spec, { n: NaN, mean: 0, variance: 0 }, binarySample(1, 100)).reason).toBe('invalid_input');
    expect(evaluateGuardrail({ ...spec, tolerance: -1 }, binarySample(5, 100), binarySample(5, 100)).reason).toBe('invalid_input');
  });
  it('a drop in a "decrease is harmful" metric counts as harm', () => {
    const completion = { name: 'completion_rate', harm: 'decrease' as const, tolerance: 0.02 };
    expect(evaluateGuardrail(completion, binarySample(700, 1000), binarySample(800, 1000)).status).toBe('breached');
    expect(evaluateGuardrail(completion, binarySample(850, 1000), binarySample(800, 1000)).status).not.toBe('breached');
  });
  it('binarySample guards impossible counts', () => {
    expect(binarySample(11, 10).n).toBe(0);
    expect(binarySample(3, 10)).toMatchObject({ n: 10, mean: 0.3 });
  });
  it('roll-up: any breach wins, then watch, then unknown, and the false-alarm rate is reported', () => {
    const ev = (name: string, status: 'ok' | 'watch' | 'breached' | 'unknown') => ({ name, status, reason: 'inconclusive' as const, harm: 0, harmLow: 0, harmHigh: 0 });
    expect(rollupGuardrails([ev('a', 'ok'), ev('b', 'breached'), ev('c', 'watch')])).toMatchObject({ status: 'breached', breached: ['b'], action: 'stop_and_investigate' });
    expect(rollupGuardrails([ev('a', 'ok'), ev('c', 'watch'), ev('d', 'unknown')]).status).toBe('watch');
    expect(rollupGuardrails([ev('a', 'ok'), ev('d', 'unknown')]).status).toBe('unknown');
    expect(rollupGuardrails([ev('a', 'ok')])).toMatchObject({ status: 'ok', action: 'clear' });
    expect(rollupGuardrails([ev('a', 'ok'), ev('b', 'ok'), ev('c', 'ok')]).falseBreachProbability).toBeCloseTo(1 - 0.95 ** 3, 12);
  });
  it('detectable harm grows with spread and shrinks with sample', () => {
    const small = detectableHarm(spec, 0.4, 500, 500) as number;
    const large = detectableHarm(spec, 0.4, 5000, 5000) as number;
    expect(small).toBeGreaterThan(large);
    expect(large).toBeGreaterThan(spec.tolerance);
    expect(detectableHarm(spec, 0, 10, 10)).toBeNull();
  });
});

describe('validatePreRegistration', () => {
  const plan = (over: Partial<PreRegistration> = {}): PreRegistration => ({
    experimentKey: 'onb_checklist',
    owner: 'Growth lead',
    registeredAt: '2027-03-01T09:00:00Z',
    startsAt: '2027-03-08T09:00:00Z',
    hypothesis: 'A checklist on first login raises 7-day activation because new owners see the next step.',
    intervention: 'Show a five-step checklist on the dashboard for new accounts.',
    population: 'Accounts created after the start date, all plans.',
    unitOfRandomization: 'account',
    treatmentShare: 50,
    primaryMetric: { name: 'activated_7d', definition: 'Share of accounts completing the first booking within 7 days of signup.', kind: 'binary', baseline: 0.2 },
    mde: { value: 0.05, relative: false },
    alpha: 0.05,
    power: 0.8,
    plannedControl: 1091,
    plannedTreatment: 1091,
    decisionRule: { kind: 'fixed_horizon', alpha: 0.05 },
    guardrails: [{ name: 'cancel_rate', harm: 'increase', tolerance: 0.02 }],
    secondaryMetrics: ['trial_to_paid'],
    srm: { declared: true, alpha: 0.001 },
    maxDays: 28,
    exclusions: 'Internal and test accounts.',
    analysisPlan: 'Two-proportion z-test on all assigned accounts, no outcome-based exclusions.',
    decisions: { win: 'Ship to everyone', noEffect: 'Keep control', loss: 'Revert and review' },
    ...over,
  });

  it('accepts a complete, consistent plan', () => {
    expect(validatePreRegistration(plan())).toEqual({ errors: [], warnings: [] });
  });
  it('requires the narrative fields', () => {
    expect(codes(validatePreRegistration(plan({ hypothesis: 'It will work' })))).toContain('missing_hypothesis');
    expect(codes(validatePreRegistration(plan({ analysisPlan: '' })))).toContain('missing_analysis_plan');
    expect(codes(validatePreRegistration(plan({ decisions: { win: 'Ship', noEffect: '', loss: 'Revert it' } })))).toContain('missing_decisions');
  });
  it('rejects a plan registered after the experiment started', () => {
    expect(codes(validatePreRegistration(plan({ registeredAt: '2027-03-09T00:00:00Z' })))).toContain('registered_after_start');
    expect(codes(validatePreRegistration(plan({ startsAt: null })))).not.toContain('registered_after_start');
  });
  it('rejects a declared sample smaller than the design needs', () => {
    const r = validatePreRegistration(plan({ plannedControl: 800 }));
    expect(codes(r)).toContain('underpowered_plan');
    expect(r.errors.find((e) => e.code === 'underpowered_plan')?.message).toContain('1091');
  });
  it('inflates the required sample for a sequential rule', () => {
    const rule: DecisionRule = { kind: 'group_sequential', alpha: 0.05, spending: 'pocock', plannedLooks: [0.5, 1] };
    expect(codes(validatePreRegistration(plan({ decisionRule: rule })))).toContain('underpowered_plan');
  });
  it('requires a consistent rule', () => {
    expect(codes(validatePreRegistration(plan({ decisionRule: { kind: 'fixed_horizon', alpha: 0.1 } })))).toContain('rule_alpha_mismatch');
    const bad: DecisionRule = { kind: 'group_sequential', alpha: 0.05, spending: 'obrien_fleming', plannedLooks: [0.5, 0.4, 1] };
    expect(codes(validatePreRegistration(plan({ decisionRule: bad })))).toContain('invalid_looks');
    const noEnd: DecisionRule = { kind: 'group_sequential', alpha: 0.05, spending: 'obrien_fleming', plannedLooks: [0.3, 0.6] };
    expect(codes(validatePreRegistration(plan({ decisionRule: noEnd })))).toContain('invalid_looks');
  });
  it('requires guardrails, unique and distinct from the primary metric', () => {
    expect(codes(validatePreRegistration(plan({ guardrails: [] })))).toContain('no_guardrail');
    expect(codes(validatePreRegistration(plan({ guardrails: [{ name: 'activated_7d', harm: 'decrease', tolerance: 0.01 }] })))).toContain('guardrail_is_primary');
    const dup = { name: 'cancel_rate', harm: 'increase' as const, tolerance: 0.02 };
    expect(codes(validatePreRegistration(plan({ guardrails: [dup, dup] })))).toContain('guardrail_duplicate');
    expect(codes(validatePreRegistration(plan({ guardrails: [{ ...dup, tolerance: -1 }] })))).toContain('guardrail_tolerance');
  });
  it('requires a declared SRM check, a strict threshold and whole-week runs', () => {
    expect(codes(validatePreRegistration(plan({ srm: { declared: false, alpha: 0.001 } })))).toContain('srm_not_declared');
    expect(codes(validatePreRegistration(plan({ srm: { declared: true, alpha: 0.05 } })))).toContain('invalid_srm_alpha');
    expect(codes(validatePreRegistration(plan({ maxDays: 5 })))).toContain('run_too_short');
    expect(validatePreRegistration(plan({ maxDays: 30 })).warnings.map((w) => w.code)).toContain('partial_week');
  });
  it('flags statistical settings', () => {
    expect(codes(validatePreRegistration(plan({ alpha: 0.3, decisionRule: { kind: 'fixed_horizon', alpha: 0.3 } })))).toContain('invalid_alpha');
    expect(validatePreRegistration(plan({ power: 0.7 })).warnings.map((w) => w.code)).toContain('low_power');
    expect(codes(validatePreRegistration(plan({ treatmentShare: 0 })))).toContain('invalid_share');
    expect(codes(validatePreRegistration(plan({ mde: { value: 0, relative: false } })))).toContain('invalid_mde');
    expect(codes(validatePreRegistration(plan({ secondaryMetrics: ['activated_7d'] })))).toContain('primary_in_secondary');
  });
  it('mean metrics need a spread; sizing failures are reported, not thrown', () => {
    const mean = plan({ primaryMetric: { name: 'avg_revenue', definition: 'Average invoice amount per completed job in dollars.', kind: 'mean', baseline: 400 } });
    expect(codes(validatePreRegistration(mean))).toContain('sizing_failed');
    const ok = plan({ primaryMetric: { name: 'avg_revenue', definition: 'Average invoice amount per completed job in dollars.', kind: 'mean', baseline: 400, sd: 10 }, mde: { value: 2, relative: false }, plannedControl: 393, plannedTreatment: 393 });
    expect(codes(validatePreRegistration(ok))).toEqual([]);
  });
});
