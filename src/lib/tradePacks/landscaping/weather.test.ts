import { describe, it, expect } from 'vitest';
import { evaluateWeather, makeupDate, MockWeatherAdapter, NullWeatherAdapter, decideForDate, snowEventTriggered, validateWeatherPolicy, type WeatherPolicy, type DailyForecast } from './weather.ts';
import { buildHolidayLookup } from './calendar.ts';

const fc = (o: Partial<DailyForecast>): DailyForecast => ({ date: '2027-06-01', precipProbPct: null, precipMm: null, snowCm: null, windKph: null, tempMinC: null, tempMaxC: null, alerts: [], source: 't', ...o });
const policy: WeatherPolicy = { rules: [{ kind: 'rain_prob_pct', threshold: 70 }, { kind: 'wind_kph', threshold: 60 }, { kind: 'alert_keyword', keywords: ['flood'] }], makeup: 'next_workday' };

describe('landscaping weather rules', () => {
  it('skips when a rule fires and reports reasons', () => {
    expect(evaluateWeather(policy, fc({ precipProbPct: 80, windKph: 10 }))).toEqual({ decision: 'skip', reasons: ['Rain chance 80%'] });
    expect(evaluateWeather(policy, fc({ precipProbPct: 10, alerts: ['Flood Watch'] })).decision).toBe('skip');
  });
  it('threshold is inclusive; below it proceeds', () => {
    expect(evaluateWeather(policy, fc({ precipProbPct: 70 })).decision).toBe('skip');
    expect(evaluateWeather(policy, fc({ precipProbPct: 69, windKph: 59 })).decision).toBe('proceed');
  });
  it('unknown data never skips', () => {
    expect(evaluateWeather(policy, null).decision).toBe('unknown');
    expect(evaluateWeather({ rules: [{ kind: 'freeze_c', threshold: 0 }], makeup: 'none' }, fc({ precipProbPct: 99 })).decision).toBe('unknown');
    expect(evaluateWeather({ rules: [], makeup: 'none' }, null).decision).toBe('proceed');
  });
  it('freeze / heat / snow rules', () => {
    expect(evaluateWeather({ rules: [{ kind: 'freeze_c', threshold: 0 }], makeup: 'none' }, fc({ tempMinC: -2 })).decision).toBe('skip');
    expect(evaluateWeather({ rules: [{ kind: 'heat_c', threshold: 38 }], makeup: 'none' }, fc({ tempMaxC: 35 })).decision).toBe('proceed');
    expect(snowEventTriggered(fc({ snowCm: 6 }), 5)).toBe(true);
    expect(snowEventTriggered(fc({ snowCm: 4 }), 5)).toBe(false);
    expect(snowEventTriggered(null, 5)).toBe(false);
  });
  it('validates policies', () => {
    expect(validateWeatherPolicy(policy)).toEqual([]);
    expect(validateWeatherPolicy({ rules: [{ kind: 'rain_prob_pct', threshold: 120 }], makeup: 'none' }).length).toBe(1);
    expect(validateWeatherPolicy({ rules: [{ kind: 'alert_keyword', keywords: [] }], makeup: 'none' }).length).toBe(1);
  });
});

describe('landscaping weather: make-up dates', () => {
  const hol = buildHolidayLookup('2027-05-01', '2027-07-01', 'us_core');
  it('next working day, skipping weekends, holidays and occupied days', () => {
    expect(makeupDate('2027-05-28', 'next_workday', [1, 2, 3, 4, 5], hol)).toBe('2027-06-01'); // Fri → Mon is Memorial Day → Tue
    expect(makeupDate('2027-06-07', 'next_workday', [1, 2, 3, 4, 5], hol, new Set(['2027-06-08']))).toBe('2027-06-09');
    expect(makeupDate('2027-06-07', 'none', [1, 2, 3, 4, 5], hol)).toBeNull();
  });
});

describe('landscaping weather: adapter boundary', () => {
  it('shares one provider call per ~1 km cell and keeps visits when the provider throws', async () => {
    const a = new MockWeatherAdapter({ '2027-06-01': { precipProbPct: 90 } });
    const items = [
      { id: 'a', point: { lat: 41.1001, lng: -87.2 }, policy },
      { id: 'b', point: { lat: 41.1002, lng: -87.2001 }, policy },
      { id: 'c', point: null, policy },
    ];
    const r = await decideForDate(a, '2027-06-01', items);
    expect(a.calls.length).toBe(1);
    expect(r.map((x) => x.decision.decision)).toEqual(['skip', 'skip', 'unknown']);
    const boom = { id: 'x', getDailyForecast: async () => { throw new Error('down'); } };
    expect((await decideForDate(boom, '2027-06-01', items))[0].decision.decision).toBe('unknown');
    expect((await decideForDate(new NullWeatherAdapter(), '2027-06-01', items))[0].decision.decision).toBe('unknown');
  });
});
