import { describe, it, expect } from 'vitest';
import {
  blendedPrior,
  bandOf,
  decide,
  evidenceCompleteness,
  mergeStepResults,
  normalizeCategory,
  normalizeHypotheses,
  normalizeQuestion,
  normalizeSteps,
  safetyGuidance,
  scoreCase,
  screenSafety,
  validReading,
  type Hypothesis,
  type ScoreInput,
} from './score';

const fixable: Hypothesis = {
  cause: 'Clogged air filter restricting airflow',
  likelihood: 0.7,
  remote_fixable: true,
  needs_parts: false,
  evidence_for: ['Filter looks grey in photo'],
  evidence_against: [],
};
const parts: Hypothesis = { ...fixable, cause: 'Failed capacitor', likelihood: 0.3, remote_fixable: false, needs_parts: true };
const fullCounts = { answers: 6, photos: 1, audio: 1, sensors: 1, history: 1 };

const base = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  category: 'hvac_cooling',
  hypotheses: [fixable, parts],
  counts: fullCounts,
  conflicts: 0,
  failedSteps: 0,
  previousProbability: null,
  safetyHold: false,
  ...over,
});

describe('screenSafety', () => {
  it('holds on a gas smell and on burning smell', () => {
    expect(screenSafety(['I think I smell gas near the furnace']).reasons).toContain('gas');
    expect(screenSafety(['there is a burning smell from the unit']).reasons).toContain('electrical_hazard');
  });
  it('does not hold when the hazard is negated', () => {
    expect(screenSafety(['no gas smell, AC just is not cooling']).hold).toBe(false);
    expect(screenSafety(["I don't smell gas"]).hold).toBe(false);
  });
  it('detects vulnerable occupants with no heat/cooling', () => {
    expect(screenSafety(['we have a baby at home and no heat']).reasons).toContain('vulnerable_extreme_temp');
  });
  it('detects non-English hazards', () => {
    expect(screenSafety(['بوی گاز میاد']).reasons).toContain('gas');
  });
  it('is safe for ordinary text and tolerates junk input', () => {
    expect(screenSafety(['AC is blowing warm air', null, undefined, '']).hold).toBe(false);
  });
  it('returns guidance for each reason', () => {
    expect(safetyGuidance(['gas', 'flooding'])).toHaveLength(2);
  });
});

describe('scoreCase', () => {
  it('scores a likely customer-fixable case high when evidence is complete', () => {
    const r = scoreCase(base({ hypotheses: [{ ...fixable, likelihood: 0.9 }, { ...parts, likelihood: 0.1 }] }));
    expect(r.probability).toBeGreaterThanOrEqual(75);
    expect(r.band).toBe('high');
  });
  it('scores a parts-needed case low', () => {
    const r = scoreCase(base({ hypotheses: [{ ...parts, likelihood: 0.9 }, { ...fixable, likelihood: 0.1 }] }));
    expect(r.probability).toBeLessThan(45);
    expect(r.band).toBe('low');
  });
  it('is 0 under a safety hold', () => {
    expect(scoreCase(base({ safetyHold: true })).probability).toBe(0);
  });
  it('never exceeds 95 or drops below 1', () => {
    const hi = scoreCase(base({ hypotheses: [{ ...fixable, likelihood: 1 }] }));
    const lo = scoreCase(base({ hypotheses: [], counts: { answers: 0, photos: 0, audio: 0, sensors: 0, history: 0 } }));
    expect(hi.probability).toBeLessThanOrEqual(95);
    expect(lo.probability).toBeGreaterThanOrEqual(1);
  });
  it('trusts the prior more when evidence is thin', () => {
    const thin = scoreCase(base({ counts: { answers: 1, photos: 0, audio: 0, sensors: 0, history: 0 }, hypotheses: [{ ...fixable, likelihood: 1 }] }));
    const full = scoreCase(base({ hypotheses: [{ ...fixable, likelihood: 1 }] }));
    expect(thin.probability).toBeLessThan(full.probability);
  });
  it('lowers the probability after failed steps and never raises it', () => {
    const before = scoreCase(base({ hypotheses: [{ ...fixable, likelihood: 0.9 }] }));
    const after = scoreCase(base({ hypotheses: [{ ...fixable, likelihood: 0.9 }], failedSteps: 2, previousProbability: before.probability }));
    expect(after.probability).toBeLessThan(before.probability);
  });
  it('penalises conflicting signals', () => {
    const a = scoreCase(base());
    const b = scoreCase(base({ conflicts: 3 }));
    expect(b.probability).toBeLessThan(a.probability);
  });
  it('handles zero total likelihood without NaN', () => {
    const r = scoreCase(base({ hypotheses: [{ ...fixable, likelihood: 0 }, { ...parts, likelihood: 0 }] }));
    expect(Number.isFinite(r.probability)).toBe(true);
  });
  it('always explains itself', () => {
    expect(scoreCase(base()).factors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('priors and bands', () => {
  it('uses the default prior with no account data', () => {
    expect(blendedPrior('hvac_cooling')).toBeCloseTo(0.28, 5);
    expect(blendedPrior('not_a_category')).toBeCloseTo(0.12, 5);
  });
  it('shifts toward the account rate as cases accumulate', () => {
    const few = blendedPrior('hvac_cooling', { rate: 0.6, n: 5 });
    const many = blendedPrior('hvac_cooling', { rate: 0.6, n: 200 });
    expect(few).toBeGreaterThan(0.28);
    expect(many).toBeGreaterThan(few);
    expect(many).toBeLessThan(0.6);
  });
  it('maps probability to bands', () => {
    expect(bandOf(80)).toBe('high');
    expect(bandOf(50)).toBe('medium');
    expect(bandOf(10)).toBe('low');
  });
  it('caps completeness at 1', () => {
    expect(evidenceCompleteness({ answers: 99, photos: 9, audio: 9, sensors: 9, history: 9 })).toBe(1);
  });
});

describe('decide', () => {
  const d = { probability: 80, threshold: 55, completeness: 0.8, turns: 3, hasNextQuestion: true, hasSteps: true, failedSteps: 0, remainingSteps: 3, safetyHold: false };
  it('troubleshoots when probability clears the threshold and steps exist', () => {
    expect(decide(d)).toEqual({ action: 'troubleshoot' });
  });
  it('dispatches on safety regardless of probability', () => {
    expect(decide({ ...d, safetyHold: true })).toEqual({ action: 'dispatch', reason: 'safety' });
  });
  it('asks more in the gray zone when evidence is thin', () => {
    expect(decide({ ...d, probability: 40, completeness: 0.3 })).toEqual({ action: 'ask' });
  });
  it('dispatches when probability is low and evidence is already good', () => {
    expect(decide({ ...d, probability: 40, completeness: 0.9 })).toEqual({ action: 'dispatch', reason: 'low_probability' });
  });
  it('dispatches far below the threshold even with thin evidence', () => {
    expect(decide({ ...d, probability: 10, completeness: 0.2 })).toEqual({ action: 'dispatch', reason: 'low_probability' });
  });
  it('dispatches once steps are exhausted', () => {
    expect(decide({ ...d, failedSteps: 2, remainingSteps: 0 })).toEqual({ action: 'dispatch', reason: 'steps_exhausted' });
  });
  it('dispatches after the turn limit', () => {
    expect(decide({ ...d, turns: 12 })).toEqual({ action: 'dispatch', reason: 'insufficient_evidence' });
  });
  it('dispatches when likely fixable but no safe step exists and nothing left to ask', () => {
    expect(decide({ ...d, hasSteps: false, hasNextQuestion: false })).toEqual({ action: 'dispatch', reason: 'no_safe_steps' });
  });
});

describe('sanitisers', () => {
  const step = { title: 'Replace the filter', instructions: 'Slide out the old filter and slide in a new one with the arrow pointing at the unit.', safe_for_homeowner: true };
  it('keeps safe steps and drops unsafe ones', () => {
    const out = normalizeSteps([
      step,
      { ...step, title: 'Check refrigerant', instructions: 'Connect gauges and check the refrigerant pressure.' },
      { ...step, title: 'Open panel', instructions: 'Open the panel and inspect the capacitor for bulging.' },
      { ...step, safe_for_homeowner: false, title: 'Flag only', instructions: 'This step is not flagged safe by the model.' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('s1');
    expect(out[0].result).toBeNull();
  });
  it('caps steps at 6', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...step, title: `Step number ${i}` }));
    expect(normalizeSteps(many)).toHaveLength(6);
  });
  it('turns a one-option choice into a text question and de-duplicates ids', () => {
    const q = normalizeQuestion({ id: 'q1', text: 'Is the outdoor unit running?', type: 'choice', options: ['Yes'] }, new Set(['q1']));
    expect(q?.type).toBe('text');
    expect(q?.id).not.toBe('q1');
  });
  it('rejects empty questions', () => {
    expect(normalizeQuestion({ text: 'x' }, new Set())).toBeNull();
    expect(normalizeQuestion(null, new Set())).toBeNull();
  });
  it('clamps hypotheses', () => {
    const h = normalizeHypotheses([{ cause: 'Thermostat batteries dead', likelihood: 7, remote_fixable: true }, { cause: '' }, 'junk']);
    expect(h).toHaveLength(1);
    expect(h[0].likelihood).toBe(1);
    expect(h[0].needs_parts).toBe(false);
  });
  it('falls back to unknown for bad categories', () => {
    expect(normalizeCategory('HVAC_COOLING')).toBe('hvac_cooling');
    expect(normalizeCategory('rocket_science')).toBe('unknown');
  });
  it('never drops a step the customer already performed', () => {
    const mk = (id: string, result: null | 'no_change') => ({ id, title: id, instructions: id, expected: '', safety_note: '', minutes: 1, result });
    const merged = mergeStepResults([mk('s1', 'no_change'), mk('s2', null)], [mk('s1', null), mk('s9', null)]);
    expect(merged.find((s) => s.id === 's1')?.result).toBe('no_change');
    expect(merged.some((s) => s.id === 's9')).toBe(true);
  });
});

describe('validReading', () => {
  it('accepts in-range known metrics and rejects the rest', () => {
    expect(validReading('supply_air_temp_f', 55)).toBe(true);
    expect(validReading('supply_air_temp_f', 900)).toBe(false);
    expect(validReading('made_up_metric', 1)).toBe(false);
    expect(validReading('humidity_pct', Number.NaN)).toBe(false);
  });
});
