import { describe, it, expect } from 'vitest';
import {
  buildPayrollExportRows,
  calculateTieredCommission,
  canTransition,
  dollarsToCents,
  parseRatePercent,
  periodStart,
  resolveCommission,
  summarizeGeneration,
  validateTiers,
  type CommissionTier,
} from './commissionEngine';

const LADDER: CommissionTier[] = [
  { min_cents: 0, rate_percent: 5 },
  { min_cents: 1_000_000, rate_percent: 8 },
  { min_cents: 2_500_000, rate_percent: 12 },
];

describe('calculateTieredCommission', () => {
  it('pays a single tier at its rate', () => {
    const r = calculateTieredCommission({ basisCents: 500_000, cumulativeBeforeCents: 0, tiers: LADDER, mode: 'marginal' });
    expect(r.commissionCents).toBe(25_000);
    expect(r.segments).toHaveLength(1);
  });

  it('splits a job that straddles a threshold (marginal)', () => {
    const r = calculateTieredCommission({ basisCents: 500_000, cumulativeBeforeCents: 800_000, tiers: LADDER, mode: 'marginal' });
    expect(r.commissionCents).toBe(10_000 + 24_000);
    expect(r.segments.map((s) => s.amount_cents)).toEqual([200_000, 300_000]);
    expect(r.effectiveRatePercent).toBe(6.8);
  });

  it('can span three tiers in one job', () => {
    const r = calculateTieredCommission({ basisCents: 3_000_000, cumulativeBeforeCents: 0, tiers: LADDER, mode: 'marginal' });
    expect(r.commissionCents).toBe(50_000 + 120_000 + 60_000);
  });

  it('tier_reached applies the reached tier to the whole job', () => {
    const r = calculateTieredCommission({ basisCents: 500_000, cumulativeBeforeCents: 800_000, tiers: LADDER, mode: 'tier_reached' });
    expect(r.commissionCents).toBe(40_000);
  });

  it('is order-independent for tiers and rounds half up', () => {
    const shuffled = [LADDER[2], LADDER[0], LADDER[1]];
    expect(calculateTieredCommission({ basisCents: 100, cumulativeBeforeCents: 0, tiers: shuffled, mode: 'marginal' }).commissionCents).toBe(5);
    expect(calculateTieredCommission({ basisCents: 100, cumulativeBeforeCents: 0, tiers: [{ min_cents: 0, rate_percent: 0.5 }], mode: 'marginal' }).commissionCents).toBe(1);
  });

  it('returns zero for empty input', () => {
    expect(calculateTieredCommission({ basisCents: 0, cumulativeBeforeCents: 0, tiers: LADDER, mode: 'marginal' }).commissionCents).toBe(0);
    expect(calculateTieredCommission({ basisCents: 1000, cumulativeBeforeCents: 0, tiers: [], mode: 'marginal' }).commissionCents).toBe(0);
  });
});

describe('resolveCommission precedence', () => {
  const base = { basisCents: 10_000, cumulativeBeforeCents: 0 };
  it('excluded override wins over everything', () => {
    const r = resolveCommission({ ...base, override: { type: 'excluded' }, plan: { mode: 'marginal', tiers: LADDER }, employeeRatePercent: 9 });
    expect(r).toEqual({ source: 'excluded', commissionCents: 0, ratePercent: 0 });
  });
  it('rate and flat overrides beat the plan', () => {
    expect(resolveCommission({ ...base, override: { type: 'rate_percent', ratePercent: 10 }, plan: { mode: 'marginal', tiers: LADDER } }).commissionCents).toBe(1_000);
    const flat = resolveCommission({ ...base, override: { type: 'flat_cents', flatCents: 1_234 } });
    expect(flat.commissionCents).toBe(1_234);
    expect(flat.ratePercent).toBe(12.34);
  });
  it('plan beats flat employee rate; flat rate is the fallback; none earns nothing', () => {
    expect(resolveCommission({ ...base, plan: { mode: 'marginal', tiers: LADDER }, employeeRatePercent: 9 }).source).toBe('plan');
    expect(resolveCommission({ ...base, employeeRatePercent: 7.5 })).toMatchObject({ source: 'employee_rate', commissionCents: 750 });
    expect(resolveCommission(base).source).toBe('no_rule');
  });
});

describe('validateTiers', () => {
  it('accepts a valid ladder', () => expect(validateTiers(LADDER)).toBeNull());
  it('rejects bad ladders', () => {
    expect(validateTiers([])).toMatch(/at least one/);
    expect(validateTiers([{ min_cents: 100, rate_percent: 5 }])).toMatch(/\$0/);
    expect(validateTiers([{ min_cents: 0, rate_percent: 5 }, { min_cents: 0, rate_percent: 6 }])).toMatch(/same amount/);
    expect(validateTiers([{ min_cents: 0, rate_percent: 101 }])).toMatch(/between/);
    expect(validateTiers([{ min_cents: 0, rate_percent: 1.234 }])).toMatch(/2 decimal/);
  });
});

describe('parsing helpers', () => {
  it('parses dollars to cents safely', () => {
    expect(dollarsToCents('$1,200.5')).toBe(120_050);
    expect(dollarsToCents('0.07')).toBe(7);
    expect(dollarsToCents('12.345')).toBeNull();
    expect(dollarsToCents('-1')).toBeNull();
    expect(dollarsToCents('')).toBeNull();
  });
  it('parses rates', () => {
    expect(parseRatePercent('7.5%')).toBe(7.5);
    expect(parseRatePercent('101')).toBeNull();
    expect(parseRatePercent('abc')).toBeNull();
  });
  it('finds the period start', () => {
    expect(periodStart('2026-11-15', 'quarterly')).toBe('2026-10-01');
    expect(periodStart('2026-02-03', 'monthly')).toBe('2026-02-01');
    expect(periodStart('2026-12-31', 'yearly')).toBe('2026-01-01');
  });
});

describe('statement workflow + export', () => {
  it('only allows legal transitions', () => {
    expect(canTransition('draft', 'submit')).toBe(true);
    expect(canTransition('draft', 'approve')).toBe(false);
    expect(canTransition('pending_approval', 'approve')).toBe(true);
    expect(canTransition('approved', 'void')).toBe(true);
    expect(canTransition('paid', 'void')).toBe(false);
    expect(canTransition('void', 'submit')).toBe(false);
  });
  it('builds payroll export rows in decimal dollars', () => {
    const [row] = buildPayrollExportRows([
      { id: 's1', employee_name: 'Ana', period_start: '2026-10-01', period_end: '2026-10-31', earned_cents: 123_456, adjustment_cents: -5_000, net_cents: 118_456, status: 'approved' },
    ]);
    expect(row).toMatchObject({ commission_earned: '1234.56', adjustments: '-50.00', net_commission: '1184.56' });
  });
  it('summarizes generation results', () => {
    expect(summarizeGeneration({ created: 1 })).toBe('Created 1 commission.');
    expect(summarizeGeneration({ created: 0, no_rule: 2 })).toContain('2 jobs skipped');
  });
});
