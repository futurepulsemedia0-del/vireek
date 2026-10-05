import { describe, expect, it } from 'vitest';
import {
  calibrate,
  classifyFamily,
  learnedFactor,
  predictUnit,
  shouldIssue,
  weibullConditionalProbability,
  type Learning,
  type ModeDef,
  type UnitInput,
} from '../../supabase/functions/_shared/predictive-failure/engine';

const NOW = new Date('2026-10-04T00:00:00Z');
const yearsAgo = (y: number) => new Date(NOW.getTime() - y * 365.25 * 86_400_000).toISOString().slice(0, 10);

const CATALOG: ModeDef[] = [
  {
    key: 'capacitor_failure', label: 'Capacitor failure', families: ['hvac_cooling'], shape: 2, scaleMonths: 96,
    aliases: ['bad_capacitor'], partKeywords: ['capacitor'], maintenanceSensitive: true, runtimeDriven: false,
    seasonal: 'cooling', safetyCritical: false, typicalCostCents: 25_000,
    intervention: { key: 'rc', label: 'Test and replace the run capacitor', kind: 'preventive_repair', parts: ['Run capacitor'], estMinutes: 45 },
  },
  {
    key: 'compressor_failure', label: 'Compressor failure', families: ['hvac_cooling'], shape: 3, scaleMonths: 180,
    aliases: [], partKeywords: ['compressor'], maintenanceSensitive: true, runtimeDriven: true,
    seasonal: 'cooling', safetyCritical: false, typicalCostCents: 250_000,
    intervention: { key: 'ci', label: 'Compressor health check', kind: 'inspection', parts: [], estMinutes: 60 },
  },
  {
    key: 'end_of_life_wearout', label: 'End-of-life wear-out', families: ['hvac_cooling', 'generic'], shape: 4, scaleMonths: null,
    aliases: [], partKeywords: [], maintenanceSensitive: false, runtimeDriven: false,
    seasonal: 'none', safetyCritical: false, typicalCostCents: 350_000,
    intervention: { key: 'rp', label: 'Plan a replacement', kind: 'replacement_planning', parts: [], estMinutes: 240 },
  },
];

const LEARNING: Learning = { modeStats: {}, bins: null, resolvedCount: 0, costByMode: {} };

function unit(over: Partial<UnitInput> = {}): UnitInput {
  return {
    equipmentId: 'e1', customerId: 'c1', equipmentType: 'Central AC', make: 'Carrier', model: '24ACC',
    installDate: yearsAgo(10), lastServiceDate: yearsAgo(0.5), expectedLifespanYears: 15, serviceIntervalMonths: 12,
    customerType: 'residential', profile: null,
    history: {
      events: [], repairs12m: 0, repairs6m: 0, repairsPrev6m: 0, callbacks12m: 0, companies24m: 0,
      repeatPart: null, repeatPartCount: 0, lastServiceAt: null, crossCompany: false,
    },
    atlas: [], weather: { heat30d: 0, cold30d: 0 },
    ...over,
  };
}

const opts = { now: NOW, horizonDays: 90 };

describe('weibullConditionalProbability', () => {
  it('is near zero for a brand-new component and grows with age', () => {
    const young = weibullConditionalProbability(0, 3, 2, 96);
    const old = weibullConditionalProbability(120, 3, 2, 96);
    expect(young).toBeLessThan(0.01);
    expect(old).toBeGreaterThan(young);
  });
  it('scales with the hazard ratio and stays below 1', () => {
    const base = weibullConditionalProbability(90, 3, 2, 96, 1);
    const stressed = weibullConditionalProbability(90, 3, 2, 96, 3);
    expect(stressed).toBeGreaterThan(base);
    expect(stressed).toBeLessThan(1);
  });
  it('returns 0 for invalid parameters', () => {
    expect(weibullConditionalProbability(10, 3, 2, 0)).toBe(0);
    expect(weibullConditionalProbability(10, 0, 2, 96)).toBe(0);
  });
});

describe('classifyFamily', () => {
  it('maps common equipment names', () => {
    expect(classifyFamily('Central AC')).toBe('hvac_cooling');
    expect(classifyFamily('Gas Furnace')).toBe('hvac_heating');
    expect(classifyFamily('Water Heater')).toBe('water_heater');
    expect(classifyFamily('Sump Pump')).toBe('plumbing');
    expect(classifyFamily('Mystery Box')).toBe('generic');
  });
});

describe('predictUnit', () => {
  it('refuses to forecast without any age evidence', () => {
    expect(predictUnit(unit({ installDate: null }), CATALOG, LEARNING, opts)).toBeNull();
  });

  it('ranks an old, overdue, repeatedly repaired unit above a healthy one', () => {
    const healthy = predictUnit(unit(), CATALOG, LEARNING, opts);
    const bad = predictUnit(
      unit({
        installDate: yearsAgo(14), lastServiceDate: yearsAgo(4),
        history: {
          events: [], repairs12m: 3, repairs6m: 2, repairsPrev6m: 1, callbacks12m: 2, companies24m: 2,
          repeatPart: 'run capacitor', repeatPartCount: 3, lastServiceAt: null, crossCompany: true,
        },
        weather: { heat30d: 3, cold30d: 0 },
      }),
      CATALOG, LEARNING, opts,
    );
    expect(healthy).not.toBeNull();
    expect(bad).not.toBeNull();
    expect((bad?.probability ?? 0)).toBeGreaterThan((healthy?.probability ?? 1));
    expect(bad?.topMode).toBe('capacitor_failure');
  });

  it('resets the component clock after a documented part replacement', () => {
    const replaced = predictUnit(
      unit({
        history: {
          ...unit().history,
          events: [{ at: new Date(NOW.getTime() - 365 * 86_400_000).toISOString(), type: 'repair', rootCause: 'capacitor_failure', parts: ['Dual run capacitor 45/5'], callback: false, single: true }],
        },
      }),
      CATALOG, LEARNING, opts,
    );
    const cap = replaced?.modes.find((m) => m.mode === 'capacitor_failure');
    const fresh = predictUnit(unit(), CATALOG, LEARNING, opts)?.modes.find((m) => m.mode === 'capacitor_failure');
    expect(cap?.ageSource).toBe('component_replaced');
    expect((cap?.probability ?? 1)).toBeLessThan((fresh?.probability ?? 0));
  });

  it('keeps probabilities inside (0, 1) and orders modes by risk', () => {
    const f = predictUnit(unit({ installDate: yearsAgo(30) }), CATALOG, LEARNING, opts);
    expect(f).not.toBeNull();
    expect((f?.probability ?? 2)).toBeLessThan(1);
    const probs = (f?.modes ?? []).map((m) => m.rawProbability);
    expect(probs.every((p, i) => i === 0 || probs[i - 1] >= p)).toBe(true);
  });

  it('recommends replacement planning only when past lifespan AND risk is real', () => {
    const f = predictUnit(unit({ installDate: yearsAgo(18), lastServiceDate: yearsAgo(5) }), CATALOG, LEARNING, opts);
    expect(f?.recommended?.kind).toBe('replacement_planning');
    const young = predictUnit(unit({ installDate: yearsAgo(4) }), CATALOG, LEARNING, opts);
    expect(young?.recommended?.kind).not.toBe('replacement_planning');
  });

  it('blends network evidence into the characteristic life and flags it', () => {
    const f = predictUnit(
      unit({ atlas: [{ failureMode: 'capacitor_failure', unitsObserved: 200, failureRatePct: 22, medianAgeMonths: 60, p25AgeMonths: 40, p75AgeMonths: 90, contributorCount: 30 }] }),
      CATALOG, LEARNING, opts,
    );
    const cap = f?.modes.find((m) => m.mode === 'capacitor_failure');
    expect(cap?.etaSource).toBe('blended_with_network');
    expect(cap?.network?.contributors).toBe(30);
  });

  it('never labels a forecast calibrated without enough resolved outcomes', () => {
    const f = predictUnit(unit(), CATALOG, { ...LEARNING, bins: Array.from({ length: 10 }, () => ({ n: 1, pos: 0 })) }, opts);
    expect(f?.calibrated).toBe(false);
  });
});

describe('calibrate', () => {
  it('returns null with no or too little data', () => {
    expect(calibrate(0.3, null)).toBeNull();
    expect(calibrate(0.3, Array.from({ length: 10 }, () => ({ n: 1, pos: 0 })))).toBeNull();
  });
  it('pulls an over-confident model back toward observed frequency', () => {
    const bins = Array.from({ length: 10 }, (_, b) => ({ n: 20, pos: Math.round(20 * ((b + 0.5) / 10) * 0.5) }));
    const c = calibrate(0.6, bins);
    expect(c).not.toBeNull();
    expect((c ?? 1)).toBeLessThan(0.6);
  });
});

describe('learnedFactor', () => {
  it('ignores thin evidence and is bounded', () => {
    expect(learnedFactor(undefined)).toBe(1);
    expect(learnedFactor({ expected: 1, observed: 1, n: 3 })).toBe(1);
    expect(learnedFactor({ expected: 1, observed: 100, n: 50 })).toBe(1.8);
    expect(learnedFactor({ expected: 100, observed: 0, n: 50 })).toBe(0.6);
  });
});

describe('shouldIssue', () => {
  const prev = { probability: 0.3, band: 'elevated' as const, issued_at: '2026-09-20T00:00:00Z' };
  it('issues when there is no previous forecast', () => {
    expect(shouldIssue(null, { probability: 0.1, band: 'low' }, NOW)).toBe(true);
  });
  it('keeps the stored forecast when nothing material changed', () => {
    expect(shouldIssue(prev, { probability: 0.32, band: 'elevated' }, NOW)).toBe(false);
  });
  it('re-issues when risk jumps, the band changes, or it is 30+ days old', () => {
    expect(shouldIssue(prev, { probability: 0.5, band: 'high' }, NOW)).toBe(true);
    expect(shouldIssue({ ...prev, issued_at: '2026-08-01T00:00:00Z' }, { probability: 0.31, band: 'elevated' }, NOW)).toBe(true);
  });
});
