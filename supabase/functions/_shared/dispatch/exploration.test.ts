import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXPLORATION_CONFIG,
  evaluateGuardrail,
  hashUnit,
  looksLikeEmergency,
  selectWithExploration,
  type ExplorationCandidate,
  type ExplorationConfig,
  type ExplorationJobFlags,
  type ExplorationState,
} from './exploration';

const cand = (id: string, score: number, ftf: number | null = 0.9, extra: Partial<ExplorationCandidate> = {}): ExplorationCandidate => ({
  id, name: id.toUpperCase(), score, eligible: true, ftfProb: ftf, ...extra,
});
const ON: ExplorationConfig = { ...DEFAULT_EXPLORATION_CONFIG, enabled: true, budgetPct: 100 * 0.25 };
const FLAGS: ExplorationJobFlags = { isEmergency: false, isVip: false, slaCritical: false, topVerdict: 'none' };
const STATE: ExplorationState = { exploreSharePct: 0, weeklyExposure: {} };
const RANKED = [cand('a', 50), cand('b', 49), cand('c', 48.5)];
const run = (over: Partial<Parameters<typeof selectWithExploration>[0]> = {}) =>
  selectWithExploration({ seed: 'acct:job1', ranked: RANKED, job: FLAGS, config: ON, state: STATE, ...over });

describe('hashUnit', () => {
  it('is deterministic, in [0,1) and roughly uniform', () => {
    expect(hashUnit('x')).toBe(hashUnit('x'));
    expect(hashUnit('x')).not.toBe(hashUnit('y'));
    const n = 20000;
    let sum = 0;
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < n; i++) {
      const u = hashUnit(`seed-${i}`);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      sum += u;
      buckets[Math.floor(u * 10)]++;
    }
    expect(sum / n).toBeGreaterThan(0.49);
    expect(sum / n).toBeLessThan(0.51);
    for (const b of buckets) expect(b / n).toBeGreaterThan(0.09);
  });
});

describe('selectWithExploration — determinism and propensity', () => {
  it('same input + seed => same output; different seed may differ', () => {
    expect(run()).toEqual(run());
    const picks = new Set(Array.from({ length: 200 }, (_, i) => run({ seed: `acct:job${i}` }).chosenId));
    expect(picks.size).toBeGreaterThan(1);
  });

  it('propensities over the set sum to 1 and the chosen propensity matches its member entry', () => {
    for (let i = 0; i < 100; i++) {
      const o = run({ seed: `s${i}` });
      const sum = o.log.members.reduce((s, m) => s + m.p, 0);
      expect(sum).toBeCloseTo(1, 5);
      expect(o.log.members.find((m) => m.id === o.chosenId)!.p).toBeCloseTo(o.propensity, 6);
      expect(o.propensity).toBeGreaterThan(0);
      expect(o.propensity).toBeLessThanOrEqual(1);
    }
  });

  it('picks uniformly inside the set and only inside the set (frequency check)', () => {
    const counts: Record<string, number> = {};
    let explored = 0;
    const n = 6000;
    for (let i = 0; i < n; i++) {
      const o = run({ seed: `u${i}` });
      if (o.arm === 'explore') { explored++; counts[o.chosenId!] = (counts[o.chosenId!] ?? 0) + 1; }
    }
    expect(explored / n).toBeGreaterThan(0.22); // q = 25%
    expect(explored / n).toBeLessThan(0.28);
    for (const id of ['a', 'b', 'c']) expect(counts[id] / explored).toBeGreaterThan(0.29);
  });

  it('not enrolled => deterministic pick with propensity 1 - q + q/k', () => {
    const cfg = { ...ON, budgetPct: 1 };
    const o = selectWithExploration({ seed: 'zzz-not-enrolled', ranked: RANKED, job: FLAGS, config: cfg, state: STATE });
    expect(o.arm).toBe('exploit');
    expect(o.chosenId).toBe('a');
    expect(o.reason).toBe('not_enrolled');
    expect(o.propensity).toBeCloseTo(1 - 0.01 + 0.01 / 3, 5);
  });

  it('exploit always equals the first eligible candidate in engine order (not re-sorted by id)', () => {
    const ranked = [cand('z', 50), cand('a', 50), cand('m', 20)];
    const off = selectWithExploration({ seed: 's', ranked, job: FLAGS, config: { ...ON, enabled: false }, state: STATE });
    expect(off.chosenId).toBe('z');
    for (let i = 0; i < 50; i++) {
      const o = selectWithExploration({ seed: `t${i}`, ranked, job: FLAGS, config: { ...ON, budgetPct: 1 }, state: STATE });
      if (o.arm === 'exploit') expect(o.chosenId).toBe('z');
    }
  });
});

describe('selectWithExploration — hard exclusions (never randomize)', () => {
  const deterministic = (o: ReturnType<typeof run>, reason: string) => {
    expect(o.arm).toBe('exploit');
    expect(o.chosenId).toBe('a');
    expect(o.propensity).toBe(1);
    expect(o.reason).toBe(reason);
  };
  const manySeeds = (over: Partial<Parameters<typeof selectWithExploration>[0]>, reason: string) => {
    for (let i = 0; i < 300; i++) deterministic(run({ seed: `x${i}`, ...over }), reason);
  };

  it('emergency', () => manySeeds({ job: { ...FLAGS, isEmergency: true } }, 'emergency'));
  it('VIP', () => manySeeds({ job: { ...FLAGS, isVip: true } }, 'vip'));
  it('SLA-critical', () => manySeeds({ job: { ...FLAGS, slaCritical: true } }, 'sla_critical'));
  it('autopilot hold / review on the top pick', () => {
    manySeeds({ job: { ...FLAGS, topVerdict: 'hold' } }, 'verdict_blocked');
    manySeeds({ job: { ...FLAGS, topVerdict: 'review' } }, 'verdict_blocked');
  });
  it('verdict lookup failed => fail closed', () => manySeeds({ job: { ...FLAGS, topVerdict: 'error' } }, 'verdict_unavailable'));
  it('feature off, per-account kill switch, auto-disabled', () => {
    manySeeds({ config: { ...ON, enabled: false } }, 'disabled');
    manySeeds({ config: { ...ON, killSwitch: true } }, 'kill_switch');
    manySeeds({ config: { ...ON, autoDisabled: true } }, 'auto_disabled');
  });
  it('budget 0 randomizes nothing', () => manySeeds({ config: { ...ON, budgetPct: 0 } }, 'disabled'));

  it('technicians failing a require rule (eligible=false) are never chosen, even with the best score', () => {
    const ranked = [{ ...cand('x', 99), eligible: false }, cand('a', 50), cand('b', 49)];
    for (let i = 0; i < 500; i++) {
      const o = selectWithExploration({ seed: `e${i}`, ranked, job: FLAGS, config: ON, state: STATE });
      expect(['a', 'b']).toContain(o.chosenId);
      expect(o.log.members.map((m) => m.id)).not.toContain('x');
    }
  });

  it('a member with an autopilot hold/review verdict is dropped from the set', () => {
    const job = { ...FLAGS, memberVerdicts: { b: 'hold' as const, c: 'review' as const } };
    const o = run({ job });
    expect(o.reason).toBe('set_too_small');
    expect(o.chosenId).toBe('a');
  });

  it('nobody eligible => no choice, no crash', () => {
    const o = run({ ranked: [{ ...cand('x', 10), eligible: false }] });
    expect(o).toMatchObject({ chosenId: null, setSize: 0, reason: 'no_candidates', propensity: 1 });
    expect(run({ ranked: [] }).chosenId).toBeNull();
  });
});

describe('selectWithExploration — guardrails', () => {
  it('regret cap: technicians whose FTF is more than the cap below the top are not interchangeable', () => {
    const ranked = [cand('a', 50, 0.95), cand('b', 49, 0.80), cand('c', 49, 0.93)];
    for (let i = 0; i < 300; i++) {
      const o = selectWithExploration({ seed: `r${i}`, ranked, job: FLAGS, config: { ...ON, maxRegretPct: 5 }, state: STATE });
      expect(o.log.members.map((m) => m.id)).not.toContain('b');
    }
  });

  it('unknown FTF is never treated as equal', () => {
    const o = run({ ranked: [cand('a', 50, 0.9), cand('b', 50, null)] });
    expect(o.reason).toBe('set_too_small');
    expect(run({ ranked: [cand('a', 50, null), cand('b', 50, 0.9)] }).reason).toBe('set_too_small');
  });

  it('score window: someone more than delta below the top is outside the set', () => {
    const o = run({ ranked: [cand('a', 50), cand('b', 40)] });
    expect(o.reason).toBe('set_too_small');
  });

  it('per-technician exposure cap removes a technician who already had their share (never the top)', () => {
    const state = { exploreSharePct: 0, weeklyExposure: { b: 3, c: 3, a: 99 } };
    expect(run({ state }).reason).toBe('set_too_small');
    const partial = run({ state: { exploreSharePct: 0, weeklyExposure: { b: 3 } } });
    expect(partial.log.members.map((m) => m.id).sort()).toEqual(['a', 'c']);
  });

  it('budget exhausted => deterministic, even though a set exists', () => {
    const o = run({ state: { exploreSharePct: 25, weeklyExposure: {} } });
    expect(o).toMatchObject({ arm: 'exploit', reason: 'budget_exhausted', propensity: 1, chosenId: 'a' });
    expect(o.setSize).toBe(3);
  });

  it('realised exploration share stays within the budget', () => {
    const cfg = { ...ON, budgetPct: 10 };
    let explored = 0;
    const n = 8000;
    for (let i = 0; i < n; i++) if (selectWithExploration({ seed: `b${i}`, ranked: RANKED, job: FLAGS, config: cfg, state: STATE }).arm === 'explore') explored++;
    expect(explored / n).toBeLessThan(0.115);
    expect(explored / n).toBeGreaterThan(0.085);
  });

  it('never throws: malformed input falls back to the deterministic pick', () => {
    const bad = { ...RANKED[0], score: Number.NaN };
    expect(() => run({ ranked: [bad, RANKED[1]] })).not.toThrow();
    const o = selectWithExploration({ seed: 's', ranked: RANKED, job: FLAGS, config: { ...ON, delta: -5 }, state: STATE });
    expect(o.chosenId).toBe('a');
    expect(o.reason).toBe('error');
    expect(o.arm).toBe('exploit');
  });

  it('logs factor points when provided so factors can be validated later', () => {
    const ranked = [cand('a', 50, 0.9, { factors: { zone: 15 } }), cand('b', 49, 0.9, { factors: { zone: 0 } })];
    const o = selectWithExploration({ seed: 'f', ranked, job: FLAGS, config: { ...ON, budgetPct: 25 }, state: STATE });
    expect(o.log.members[0].f).toEqual({ zone: 15 });
  });
});

describe('evaluateGuardrail', () => {
  const arr = (n: number, rate: number) => Array.from({ length: n }, (_, i) => (i / n < rate ? 1 : 0));
  it('insufficient below the minimum sample', () => {
    expect(evaluateGuardrail({ explore: arr(10, 0.5), control: arr(200, 0.9), tolerancePct: 5 }).status).toBe('insufficient');
  });
  it('ok when exploration is as good as the control', () => {
    expect(evaluateGuardrail({ explore: arr(200, 0.9), control: arr(200, 0.9), tolerancePct: 5 }).status).toBe('ok');
  });
  it('breached on a large, statistically clear drop', () => {
    const r = evaluateGuardrail({ explore: arr(200, 0.7), control: arr(200, 0.9), tolerancePct: 5 });
    expect(r.status).toBe('breached');
    expect(r.dropPp).toBeCloseTo(20, 0);
    expect(r.dropLowerPp!).toBeGreaterThan(0);
  });
  it('watch (not breached) when the drop exceeds tolerance but is within noise', () => {
    const r = evaluateGuardrail({ explore: arr(30, 0.8), control: arr(30, 0.87), tolerancePct: 5, minPerArm: 30 });
    expect(r.status).toBe('watch');
  });
  it('a better explore arm is never a breach', () => {
    expect(evaluateGuardrail({ explore: arr(200, 0.95), control: arr(200, 0.8), tolerancePct: 5 }).status).toBe('ok');
  });
});

describe('looksLikeEmergency', () => {
  it('matches the dispatch plan heuristic', () => {
    expect(looksLikeEmergency('Emergency repair', null)).toBe(true);
    expect(looksLikeEmergency('HVAC', ['EMERGENCY'])).toBe(true);
    expect(looksLikeEmergency('HVAC', ['tune-up'])).toBe(false);
    expect(looksLikeEmergency(null, undefined)).toBe(false);
  });
});
