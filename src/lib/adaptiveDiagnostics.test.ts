import { describe, expect, it } from 'vitest';
import {
  SKIP_ANSWER,
  analyze,
  computePosterior,
  entropyBits,
  informationGain,
  mergeLikelihoodCounts,
  mergePriors,
  type CauseDef,
  type LikelihoodCounts,
  type TestDef,
} from '../../supabase/functions/_shared/adaptive-diagnostics/engine';

const causes: CauseDef[] = [
  { key: 'leak', label: 'Leak', prior: 6, safetyCritical: false },
  { key: 'filter', label: 'Filter', prior: 3, safetyCritical: false },
  { key: 'gas', label: 'Gas leak', prior: 1, safetyCritical: true },
];
const yn = [
  { key: 'yes', label: 'Yes' },
  { key: 'no', label: 'No' },
];
const tests: TestDef[] = [
  {
    key: 'pressure',
    label: 'Pressure',
    question: 'Low?',
    toolNeeded: null,
    effort: 3,
    kind: 'measurement',
    safetyNote: null,
    answers: yn,
  },
  {
    key: 'dirty',
    label: 'Dirty',
    question: 'Dirty?',
    toolNeeded: null,
    effort: 1,
    kind: 'inspection',
    safetyNote: null,
    answers: yn,
  },
  {
    key: 'useless',
    label: 'Useless',
    question: '?',
    toolNeeded: null,
    effort: 1,
    kind: 'question',
    safetyNote: null,
    answers: yn,
  },
  {
    key: 'safety',
    label: 'Safety',
    question: 'Gas?',
    toolNeeded: null,
    effort: 1,
    kind: 'inspection',
    safetyNote: null,
    answers: [
      { key: 'none', label: 'None' },
      { key: 'gas', label: 'Gas odor', hazard: true },
    ],
  },
];
const counts: LikelihoodCounts = {
  pressure: { leak: { yes: 18, no: 2 }, filter: { yes: 3, no: 17 }, gas: { yes: 10, no: 10 } },
  dirty: { leak: { yes: 3, no: 17 }, filter: { yes: 18, no: 2 }, gas: { yes: 10, no: 10 } },
  useless: { leak: { yes: 10, no: 10 }, filter: { yes: 10, no: 10 }, gas: { yes: 10, no: 10 } },
};

describe('posterior', () => {
  it('normalizes and starts at the prior', () => {
    const p = computePosterior(causes, tests, counts, []);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(p[0]).toBeCloseTo(0.6, 6);
  });
  it('moves toward the cause the evidence supports and ignores skipped steps', () => {
    const p = computePosterior(causes, tests, counts, [{ testKey: 'pressure', answerKey: 'no' }]);
    expect(p[1]).toBeGreaterThan(p[0]);
    const q = computePosterior(causes, tests, counts, [
      { testKey: 'pressure', answerKey: SKIP_ANSWER },
    ]);
    expect(q[0]).toBeCloseTo(0.6, 6);
  });
});

describe('information gain', () => {
  it('is zero for an uninformative test and positive for an informative one', () => {
    const p = computePosterior(causes, tests, counts, []);
    expect(informationGain(causes, tests[2], counts, p).gain).toBeLessThan(1e-9);
    expect(informationGain(causes, tests[0], counts, p).gain).toBeGreaterThan(0.2);
  });
  it('never exceeds current entropy', () => {
    const p = computePosterior(causes, tests, counts, []);
    for (const t of tests)
      expect(informationGain(causes, t, counts, p).gain).toBeLessThanOrEqual(entropyBits(p) + 1e-9);
  });
});

describe('analyze', () => {
  it('asks the best effort-adjusted question first and never repeats a test', () => {
    const a = analyze({ causes, tests, counts, steps: [] });
    expect(a.action).toBe('ask');
    expect(['pressure', 'dirty']).toContain(a.next!.test.key);
    const b = analyze({
      causes,
      tests,
      counts,
      steps: [{ testKey: a.next!.test.key, answerKey: 'yes' }],
    });
    if (b.next) expect(b.next.test.key).not.toBe(a.next!.test.key);
  });
  it('concludes when confident after enough answers', () => {
    const a = analyze({
      causes,
      tests,
      counts,
      steps: [
        { testKey: 'pressure', answerKey: 'yes' },
        { testKey: 'dirty', answerKey: 'no' },
      ],
    });
    expect(a.action).toBe('conclude');
    expect(a.stopReason).toBe('confident');
    expect(a.differential[0].causeKey).toBe('leak');
  });
  it('forces safety checks first and stops on a hazard answer', () => {
    const first = analyze({ causes, tests, counts, steps: [], mandatoryTestKeys: ['safety'] });
    expect(first.next!.test.key).toBe('safety');
    expect(first.next!.reason).toBe('safety_check');
    const hz = analyze({
      causes,
      tests,
      counts,
      steps: [{ testKey: 'safety', answerKey: 'gas' }],
      mandatoryTestKeys: ['safety'],
    });
    expect(hz.action).toBe('conclude');
    expect(hz.stopReason).toBe('safety_hazard');
    expect(hz.hazards).toHaveLength(1);
  });
  it('stops at max steps and is deterministic', () => {
    const steps = [{ testKey: 'useless', answerKey: SKIP_ANSWER }];
    const a = analyze({ causes, tests, counts, steps, config: { maxSteps: 1 } });
    expect(a.stopReason).toBe('max_steps');
    expect(JSON.stringify(analyze({ causes, tests, counts, steps: [] }))).toBe(
      JSON.stringify(analyze({ causes, tests, counts, steps: [] })),
    );
  });
});

describe('learning', () => {
  it('verified outcomes shift later behavior', () => {
    const learned = mergeLikelihoodCounts(
      [{ test: 'pressure', cause: 'leak', answer: 'yes', n: 18 }],
      [
        {
          weight: 1.5,
          minSupport: 0,
          rows: [{ test: 'pressure', cause: 'leak', answer: 'yes', n: 40 }],
        },
      ],
    );
    expect(learned.pressure.leak.yes).toBeCloseTo(18 + 60, 6);
  });
  it('network layer below min support is ignored (anonymity guard)', () => {
    const merged = mergeLikelihoodCounts(
      [],
      [{ weight: 1, minSupport: 5, rows: [{ test: 't', cause: 'c', answer: 'a', n: 2 }] }],
    );
    expect(merged).toEqual({});
    const pri = mergePriors(
      { a: 4 },
      [{ weight: 1, minSupport: 5, rows: [{ cause: 'a', n: 3 }] }],
      ['a', 'b'],
    );
    expect(pri).toEqual({ a: 4, b: 0.4 });
  });
  it('priors learned from outcomes raise that cause', () => {
    const pri = mergePriors(
      { a: 4, b: 4 },
      [{ weight: 1.5, minSupport: 0, rows: [{ cause: 'b', n: 10 }] }],
      ['a', 'b'],
    );
    expect(pri.b).toBeCloseTo(19, 6);
  });
});
