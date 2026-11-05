import { describe, it, expect } from 'vitest';
import {
  buildIndifferenceSet,
  candidatesFromExplanation,
  summarizeFeasibility,
  VIABILITY_THRESHOLD,
  type IndifferenceCandidate as C,
} from './indifferenceSet';

const c = (id: string, score: number, extra: Partial<C> = {}): C => ({ id, score, eligible: true, ...extra });

describe('buildIndifferenceSet', () => {
  it('returns an empty set when nobody is eligible', () => {
    const r = buildIndifferenceSet([{ ...c('a', 90), eligible: false }]);
    expect(r).toEqual({ top: null, members: [], size: 0 });
    expect(buildIndifferenceSet([]).size).toBe(0);
  });

  it('size 1 when the runner-up is more than delta below', () => {
    const r = buildIndifferenceSet([c('a', 50), c('b', 46.9)]);
    expect(r.size).toBe(1);
    expect(r.top?.id).toBe('a');
  });

  it('includes a candidate exactly delta below (boundary is inclusive)', () => {
    expect(buildIndifferenceSet([c('a', 50), c('b', 47)]).size).toBe(2);
    // 0.1-rounded scores: 50.3 - 47.3 is 3.0000000000000036 in floats and must still count
    expect(buildIndifferenceSet([c('a', 50.3), c('b', 47.3)]).size).toBe(2);
  });

  it('ties: equal scores are all in the set, ordered deterministically by id', () => {
    const r = buildIndifferenceSet([c('z', 40), c('m', 40), c('a', 40)]);
    expect(r.members.map((m) => m.id)).toEqual(['a', 'm', 'z']);
    expect(r.top?.id).toBe('a');
  });

  it('never admits ineligible technicians, even with a top score', () => {
    const r = buildIndifferenceSet([{ ...c('x', 99), eligible: false }, c('a', 50), c('b', 49)]);
    expect(r.members.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('is independent of input order', () => {
    const list = [c('a', 50), c('b', 49), c('c', 10)];
    expect(buildIndifferenceSet([...list].reverse())).toEqual(buildIndifferenceSet(list));
  });

  it('delta is configurable and validated', () => {
    expect(buildIndifferenceSet([c('a', 50), c('b', 45)], { delta: 5 }).size).toBe(2);
    expect(buildIndifferenceSet([c('a', 50), c('b', 50)], { delta: 0 }).size).toBe(2);
    expect(() => buildIndifferenceSet([], { delta: -1 })).toThrow(RangeError);
    expect(() => buildIndifferenceSet([], { delta: NaN })).toThrow(RangeError);
  });

  it('topId anchors the set on the engine pick (score ties broken elsewhere)', () => {
    const r = buildIndifferenceSet([c('a', 50), c('z', 50), c('m', 48)], { topId: 'z' });
    expect(r.top?.id).toBe('z');
    expect(r.members.map((m) => m.id)).toEqual(['z', 'a', 'm']);
    // unknown / ineligible topId falls back to the default anchor
    expect(buildIndifferenceSet([c('a', 50), c('b', 49)], { topId: 'nope' }).top?.id).toBe('a');
  });

  it('FTF non-inferiority: drops candidates worse than the top by more than epsilon', () => {
    const list = [c('a', 50, { ftfProb: 0.9 }), c('b', 49, { ftfProb: 0.88 }), c('c', 49, { ftfProb: 0.7 })];
    expect(buildIndifferenceSet(list, { ftfEpsilon: 0.05 }).members.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('duration non-inferiority uses the upper bound', () => {
    const list = [c('a', 50, { durationUpper: 90 }), c('b', 49, { durationUpper: 100 }), c('c', 49, { durationUpper: 140 })];
    expect(buildIndifferenceSet(list, { durationEpsilonMinutes: 15 }).members.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('a candidate may beat the top on FTF/duration and still qualifies', () => {
    const list = [c('a', 50, { ftfProb: 0.8, durationUpper: 100 }), c('b', 49, { ftfProb: 0.95, durationUpper: 60 })];
    expect(buildIndifferenceSet(list, { ftfEpsilon: 0, durationEpsilonMinutes: 0 }).size).toBe(2);
  });

  it('missing evidence is not assumed equal: unverifiable candidates are excluded when a check is on', () => {
    const list = [c('a', 50, { ftfProb: 0.9 }), c('b', 49)];
    expect(buildIndifferenceSet(list, { ftfEpsilon: 0.05 }).size).toBe(1);
    // ...but ignored when the check is off
    expect(buildIndifferenceSet(list).size).toBe(2);
    // missing evidence on the TOP also blocks (cannot prove non-inferiority)
    expect(buildIndifferenceSet([c('a', 50), c('b', 49, { ftfProb: 0.9 })], { ftfEpsilon: 0.05 }).size).toBe(1);
  });
});

describe('summarizeFeasibility', () => {
  it('computes the size distribution and share over decisions with an eligible tech', () => {
    const decisions = [
      [c('a', 50), c('b', 49)],                    // size 2
      [c('a', 50), c('b', 49), c('c', 48)],        // size 3
      [c('a', 50), c('b', 10)],                    // size 1
      [{ ...c('a', 50), eligible: false }],        // size 0 (not in denominator)
    ];
    const r = summarizeFeasibility(decisions);
    expect(r.decisions).toBe(4);
    expect(r.withEligible).toBe(3);
    expect(r.sizeDistribution).toEqual({ 0: 1, 1: 1, 2: 1, 3: 1 });
    expect(r.qualifying).toBe(2);
    expect(r.qualifyingShare).toBeCloseTo(2 / 3);
    expect(r.viable).toBe(true);
  });

  it('flags the idea as not viable below the 10% threshold, and null with no data', () => {
    const lonely = Array.from({ length: 20 }, () => [c('a', 50), c('b', 10)]);
    const one = [[c('a', 50), c('b', 49)]];
    const r = summarizeFeasibility([...lonely, ...one]); // 1/21 ≈ 4.8%
    expect(r.qualifyingShare).toBeLessThan(VIABILITY_THRESHOLD);
    expect(r.viable).toBe(false);
    expect(summarizeFeasibility([])).toMatchObject({ qualifyingShare: null, viable: null });
  });
});

describe('candidatesFromExplanation', () => {
  it('reads snapshotForAudit output and tolerates junk', () => {
    const ex = { candidates: [{ technician_id: 't1', score: 12.5, eligible: true }, { technician_id: 't2', score: 3, eligible: false }, { nope: 1 }, null] };
    expect(candidatesFromExplanation(ex)).toEqual([
      { id: 't1', score: 12.5, eligible: true },
      { id: 't2', score: 3, eligible: false },
    ]);
    expect(candidatesFromExplanation(null)).toEqual([]);
    expect(candidatesFromExplanation({})).toEqual([]);
    expect(candidatesFromExplanation({ candidates: 'x' })).toEqual([]);
  });
});
