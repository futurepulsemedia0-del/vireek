import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEAT_INTERVALS,
  HEAT_NOTICE,
  MAX_WATCH_HOURS,
  READING_STALE_MIN,
  heatIndexF,
  isHeatAlertEvent,
  isValidUsZip,
  planHeatActions,
  tierForHeatIndex,
  validateIntervals,
  type HeatAction,
  type HeatWatchState,
} from './heat';

const MIN = 60_000;
const T0 = new Date('2030-07-10T15:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * MIN);

describe('heatIndexF', () => {
  // Reference values from the public NWS heat index chart (rounded to the nearest degree). [VERIFY] against the current
  // chart at weather.gov/safety/heat-index before relying on them; the tolerance is 2°F.
  it.each([
    [80, 40, 80],
    [90, 70, 105],
    [96, 65, 121],
    [100, 50, 118],
  ])('%i°F at %i%% RH is about %i°F', (t, rh, expected) => {
    const hi = heatIndexF(t, rh);
    expect(hi).not.toBeNull();
    expect(Math.abs((hi as number) - expected)).toBeLessThanOrEqual(2);
  });

  it('uses the simple formula in mild weather (close to the air temperature)', () => {
    const hi = heatIndexF(70, 50) as number;
    expect(Math.abs(hi - 70)).toBeLessThan(3);
  });

  it('applies the low-humidity adjustment (drier air feels cooler than the plain regression)', () => {
    const dry = heatIndexF(95, 8) as number;
    const normal = heatIndexF(95, 30) as number;
    expect(dry).toBeLessThan(normal);
  });

  it('is monotonic in humidity at high temperatures', () => {
    let prev = -Infinity;
    for (let rh = 20; rh <= 90; rh += 10) {
      const hi = heatIndexF(95, rh) as number;
      expect(hi).toBeGreaterThanOrEqual(prev);
      prev = hi;
    }
  });

  it('rejects impossible or non-finite input instead of guessing', () => {
    expect(heatIndexF(NaN, 50)).toBeNull();
    expect(heatIndexF(90, -1)).toBeNull();
    expect(heatIndexF(90, 101)).toBeNull();
    expect(heatIndexF(Infinity, 50)).toBeNull();
    expect(heatIndexF(200, 50)).toBeNull();
  });
});

describe('tierForHeatIndex', () => {
  it('maps the band edges', () => {
    expect(tierForHeatIndex(79.9)).toBe('low');
    expect(tierForHeatIndex(80)).toBe('caution');
    expect(tierForHeatIndex(89.9)).toBe('caution');
    expect(tierForHeatIndex(90)).toBe('high');
    expect(tierForHeatIndex(102.9)).toBe('high');
    expect(tierForHeatIndex(103)).toBe('very_high');
    expect(tierForHeatIndex(124.9)).toBe('very_high');
    expect(tierForHeatIndex(125)).toBe('extreme');
  });
  it('treats a missing reading as low, never as a false alarm', () => {
    expect(tierForHeatIndex(null)).toBe('low');
    expect(tierForHeatIndex(NaN)).toBe('low');
  });
});

describe('validateIntervals', () => {
  it('accepts the defaults', () => expect(validateIntervals(DEFAULT_HEAT_INTERVALS)).toBe(true));
  it('rejects missing tiers, fractions, and out-of-range values', () => {
    const bad = (m: Record<string, number>) => validateIntervals({ waterEveryMin: m, restEveryMin: DEFAULT_HEAT_INTERVALS.restEveryMin });
    expect(bad({ low: 0, caution: 60, high: 30, very_high: 20 })).toBe(false);
    expect(bad({ low: 0, caution: 60, high: 30.5, very_high: 20, extreme: 15 })).toBe(false);
    expect(bad({ low: 0, caution: 4, high: 30, very_high: 20, extreme: 15 })).toBe(false);
    expect(bad({ low: 0, caution: 481, high: 30, very_high: 20, extreme: 15 })).toBe(false);
    expect(validateIntervals(null)).toBe(false);
  });
});

function watch(over: Partial<HeatWatchState> = {}): HeatWatchState {
  return { status: 'active', startedAt: T0, tier: 'low', lastWaterAt: T0, lastRestAt: T0, doneKeys: new Set(), ...over };
}
const kinds = (a: HeatAction[]) => a.map((x) => x.kind);

describe('planHeatActions', () => {
  const HOT = { heatIndexF: 95, observedAt: at(0) }; // "high": water every 30, rest every 120
  const MILD = { heatIndexF: 70, observedAt: at(0) };

  it('sends nothing in mild weather', () => {
    expect(planHeatActions(watch(), MILD, DEFAULT_HEAT_INTERVALS, at(10)).actions).toEqual([]);
  });

  it('reports a tier change once and moves the tier', () => {
    const r = planHeatActions(watch(), HOT, DEFAULT_HEAT_INTERVALS, at(1));
    expect(r.tier).toBe('high');
    expect(kinds(r.actions)).toEqual(['tier_change']);
  });

  it('prompts for water exactly when the interval elapses, not before', () => {
    const w = watch({ tier: 'high' });
    expect(kinds(planHeatActions(w, { ...HOT, observedAt: at(29) }, DEFAULT_HEAT_INTERVALS, at(29)).actions)).toEqual([]);
    expect(kinds(planHeatActions(w, { ...HOT, observedAt: at(30) }, DEFAULT_HEAT_INTERVALS, at(30)).actions)).toEqual(['water_prompt']);
  });

  it('prompts for rest on its own, longer interval', () => {
    const w = watch({ tier: 'high', lastWaterAt: at(110) });
    const r = planHeatActions(w, { ...HOT, observedAt: at(120) }, DEFAULT_HEAT_INTERVALS, at(120));
    expect(kinds(r.actions)).toEqual(['rest_prompt']);
  });

  it('is idempotent: a prompt already recorded is not repeated on the next run', () => {
    const w = watch({ tier: 'high' });
    const first = planHeatActions(w, { ...HOT, observedAt: at(31) }, DEFAULT_HEAT_INTERVALS, at(31));
    const again = planHeatActions(watch({ tier: 'high', doneKeys: new Set(first.actions.map((a) => a.key)) }), { ...HOT, observedAt: at(31) }, DEFAULT_HEAT_INTERVALS, at(35));
    expect(again.actions).toEqual([]);
  });

  it('starts a fresh cycle once the technician acknowledges (new lastWaterAt => new key)', () => {
    const a = planHeatActions(watch({ tier: 'high' }), { ...HOT, observedAt: at(31) }, DEFAULT_HEAT_INTERVALS, at(31)).actions[0];
    const b = planHeatActions(watch({ tier: 'high', lastWaterAt: at(32) }), { ...HOT, observedAt: at(62) }, DEFAULT_HEAT_INTERVALS, at(62)).actions[0];
    expect(a?.kind).toBe('water_prompt');
    expect(b?.kind).toBe('water_prompt');
    expect(a?.key).not.toBe(b?.key);
  });

  it('honours a company-disabled reminder (0 minutes = off)', () => {
    const off = { ...DEFAULT_HEAT_INTERVALS, waterEveryMin: { ...DEFAULT_HEAT_INTERVALS.waterEveryMin, high: 0 } };
    expect(kinds(planHeatActions(watch({ tier: 'high' }), { ...HOT, observedAt: at(200) }, off, at(200)).actions)).toEqual(['rest_prompt']);
  });

  it('prompts faster as the tier rises', () => {
    const w = watch({ tier: 'extreme' });
    const r = planHeatActions(w, { heatIndexF: 130, observedAt: at(15) }, DEFAULT_HEAT_INTERVALS, at(15));
    expect(kinds(r.actions)).toEqual(['water_prompt']);
  });

  it('never prompts from a missing reading', () => {
    expect(planHeatActions(watch({ tier: 'high' }), null, DEFAULT_HEAT_INTERVALS, at(500)).actions).toEqual([]);
    expect(planHeatActions(watch({ tier: 'high' }), { heatIndexF: null, observedAt: at(0) }, DEFAULT_HEAT_INTERVALS, at(60)).actions).toEqual([]);
  });

  it('never prompts from a stale reading', () => {
    const r = planHeatActions(watch({ tier: 'high' }), { heatIndexF: 100, observedAt: at(0) }, DEFAULT_HEAT_INTERVALS, at(READING_STALE_MIN + 1));
    expect(r.actions).toEqual([]);
    expect(r.tier).toBe('high'); // keeps the last known tier
  });

  it('closes a watch that has run past the maximum duration, and prompts nothing else', () => {
    const r = planHeatActions(watch({ tier: 'high' }), { ...HOT, observedAt: at(MAX_WATCH_HOURS * 60) }, DEFAULT_HEAT_INTERVALS, at(MAX_WATCH_HOURS * 60));
    expect(kinds(r.actions)).toEqual(['end_watch']);
  });

  it('ignores ended watches', () => {
    expect(planHeatActions(watch({ status: 'ended' }), HOT, DEFAULT_HEAT_INTERVALS, at(60)).actions).toEqual([]);
  });

  it('produces one tier_change record per observation when the tier flaps', () => {
    const up = planHeatActions(watch(), { heatIndexF: 95, observedAt: at(0) }, DEFAULT_HEAT_INTERVALS, at(1)).actions[0];
    const upAgainSameObs = planHeatActions(watch(), { heatIndexF: 95, observedAt: at(0) }, DEFAULT_HEAT_INTERVALS, at(11)).actions[0];
    expect(up?.key).toBe(upAgainSameObs?.key);
  });
});

describe('wording and helpers', () => {
  it('the visible notice makes no medical claim and says emergency services are not contacted', () => {
    expect(HEAT_NOTICE).toMatch(/not medical advice/i);
    expect(HEAT_NOTICE).toMatch(/does not contact emergency services/i);
    expect(HEAT_NOTICE).not.toMatch(/diagnos|prevent|treat|cure|heat stroke|safe to work/i);
  });
  it('recognises current and legacy NWS heat alert names', () => {
    for (const e of ['Extreme Heat Warning', 'Excessive Heat Warning', 'Heat Advisory']) expect(isHeatAlertEvent(e)).toBe(true);
    expect(isHeatAlertEvent('Tornado Warning')).toBe(false);
    expect(isHeatAlertEvent(null)).toBe(false);
  });
  it('validates US ZIPs strictly', () => {
    expect(isValidUsZip('78701')).toBe(true);
    for (const z of ['7870', '787011', 'abcde', '78701-1234', '', ' 78701']) expect(isValidUsZip(z)).toBe(false);
  });
});
