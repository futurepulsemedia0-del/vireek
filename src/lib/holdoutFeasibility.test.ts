import { describe, expect, it } from 'vitest';
import {
  assessRow,
  baseRate,
  buildFeasibilityReport,
  mdeBinary,
  monthlyVolume,
  requiredMonthlyVolume,
  Z_ALPHA_TWO_SIDED_05,
  Z_POWER_80,
  type FeasibilityInputRow,
} from '@/lib/holdoutFeasibility';

const row = (over: Partial<FeasibilityInputRow> = {}): FeasibilityInputRow => ({
  accountId: 'a1',
  populationSource: 'outbound_sms',
  actionType: 'quote_followup',
  nActions: 1200,
  activeMonths: 12,
  nMatureResolved: 1000,
  nMatureRepeat: 300,
  ...over,
});

describe('basic maths', () => {
  it('monthlyVolume guards zero / NaN months', () => {
    expect(monthlyVolume(120, 12)).toBe(10);
    expect(monthlyVolume(120, 0)).toBe(120);
    expect(monthlyVolume(120, NaN)).toBe(120);
    expect(monthlyVolume(-5, 3)).toBe(0);
  });

  it('baseRate is null when nothing is measurable', () => {
    expect(baseRate(0, 0)).toBeNull();
    expect(baseRate(10, 3)).toBeCloseTo(0.3);
    expect(baseRate(10, 11)).toBeNull();
  });

  it('mdeBinary matches the textbook formula', () => {
    const p = 0.3;
    const expected = (Z_ALPHA_TWO_SIDED_05 + Z_POWER_80) * Math.sqrt(p * (1 - p) * (1 / 1000 + 1 / 1000));
    expect(mdeBinary(p, 1000, 1000)).toBeCloseTo(expected, 12);
    // Known value: ~5.1pp for 1000/arm at p=0.3.
    expect(mdeBinary(p, 1000, 1000)!).toBeCloseTo(0.0575, 3);
  });

  it('mdeBinary is null for degenerate inputs', () => {
    expect(mdeBinary(0, 100, 100)).toBeNull();
    expect(mdeBinary(1, 100, 100)).toBeNull();
    expect(mdeBinary(0.3, 0, 100)).toBeNull();
  });

  it('requiredMonthlyVolume inverts mdeBinary', () => {
    const p = 0.3, h = 0.05, rel = 0.3, T = 12;
    const monthly = requiredMonthlyVolume(p, h, rel, T)!;
    const total = monthly * T;
    const mde = mdeBinary(p, total * (1 - h), total * h)!;
    expect(mde / p).toBeCloseTo(rel, 9);
  });
});

describe('assessRow', () => {
  it('large account is usable at 10% but smaller holdout needs more volume', () => {
    const a = assessRow(row({ nActions: 12000, nMatureResolved: 10000, nMatureRepeat: 3000 }));
    expect(a.scenarios[1].usable).toBe(true);
    expect(a.scenarios[0].nHoldout).toBeLessThan(a.scenarios[1].nHoldout);
  });

  it('small account is not usable alone', () => {
    const a = assessRow(row({ nActions: 120, nMatureResolved: 100, nMatureRepeat: 30 }));
    expect(a.scenarios.every((s) => !s.usable)).toBe(true);
  });

  it('no measurable outcome => never usable', () => {
    const a = assessRow(row({ nMatureResolved: 0, nMatureRepeat: 0 }));
    expect(a.baseRate).toBeNull();
    expect(a.scenarios.every((s) => !s.usable && s.mdeAbs === null)).toBe(true);
  });

  it('flags ineligible action types', () => {
    expect(assessRow(row({ actionType: 'appointment_reminder' })).eligible).toBe(false);
  });
});

describe('buildFeasibilityReport', () => {
  const many = (n: number, over: Partial<FeasibilityInputRow> = {}) =>
    Array.from({ length: n }, (_, i) => row({ accountId: `acc${i}`, ...over }));

  it('not_viable: tiny accounts, even pooled across 5+', () => {
    const rows = many(6, { nActions: 24, nMatureResolved: 20, nMatureRepeat: 6 });
    const r = buildFeasibilityReport(rows);
    expect(r.verdict).toBe('not_viable');
  });

  it('viable_pooled_only: small accounts that pool to usable power', () => {
    const rows = many(10, { nActions: 600, nMatureResolved: 500, nMatureRepeat: 150 });
    const r = buildFeasibilityReport(rows);
    expect(r.verdict).toBe('viable_pooled_only');
    const t = r.byActionType.find((x) => x.actionType === 'quote_followup')!;
    expect(t.accountsUsableAlone[0.1]).toBe(0);
    expect(t.accountsOnlyViaPooling[0.1]).toBe(10);
  });

  it('viable: one big account suffices', () => {
    const rows = [row({ nActions: 20000, nMatureResolved: 18000, nMatureRepeat: 5400 })];
    expect(buildFeasibilityReport(rows).verdict).toBe('viable');
  });

  it('k-anonymity: pool hidden with <5 accounts', () => {
    const rows = many(4, { nActions: 100000, nMatureResolved: 90000, nMatureRepeat: 27000 });
    const t = buildFeasibilityReport(rows).byActionType[0];
    expect(t.pooled).toBeNull();
    expect(t.poolSuppressedForPrivacy).toBe(true);
    expect(t.accountsOnlyViaPooling[0.05]).toBe(0);
  });

  it('k-anonymity: pool exposed at exactly 5 accounts', () => {
    const t = buildFeasibilityReport(many(5)).byActionType[0];
    expect(t.pooled).not.toBeNull();
  });

  it('ineligible types do not drive the verdict', () => {
    const rows = many(6, { actionType: 'appointment_reminder', nActions: 50000, nMatureResolved: 40000, nMatureRepeat: 12000 });
    expect(buildFeasibilityReport(rows).verdict).toBe('no_data');
  });

  it('empty input => no_data', () => {
    expect(buildFeasibilityReport([]).verdict).toBe('no_data');
  });
});
