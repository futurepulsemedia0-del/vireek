import { describe, it, expect } from 'vitest';
import type { Equipment, EquipmentMaintenanceAlert, Job } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';
import type { HierarchySite } from '@/lib/siteHierarchy';
import {
  FINANCE_HORIZON_YEARS,
  computeServiceFinancePlan,
  monthlyPayment,
  normalizeEconomics,
  type FinancePath,
} from './serviceFinance';

const NOW = new Date('2026-06-01T00:00:00Z').getTime();

function yearsAgo(y: number): string {
  return new Date(NOW - y * 365.25 * 24 * 60 * 60 * 1000).toISOString();
}

function eq(over: Partial<Equipment> & { id: string; equipment_type: string }): Equipment {
  return {
    room_id: 'r1',
    user_id: 'u',
    customer_id: 'c',
    make: null,
    model: null,
    serial_number: null,
    install_date: yearsAgo(5),
    install_job_id: null,
    warranty_expires_at: null,
    warranty_notes: null,
    expected_lifespan_years: 15,
    service_interval_months: 12,
    last_service_date: yearsAgo(0.3),
    notes: null,
    status: 'active',
    created_at: '',
    updated_at: '',
    ...over,
  };
}

function twin(equipment: Equipment[], alerts: EquipmentMaintenanceAlert[] = [], jobs: Job[] = []): PropertyTwin {
  return {
    site: { id: 's1', name: 'Home', site_type: 'other', state: 'OH', buildings: [] } as unknown as HierarchySite,
    equipment,
    jobs,
    jobEquipmentLinks: [],
    maintenanceAlerts: alerts,
  };
}

const hvacOld = () => eq({ id: 'h-old', equipment_type: 'HVAC furnace', install_date: yearsAgo(17), last_service_date: yearsAgo(3) });
const hvacNew = () => eq({ id: 'h-new', equipment_type: 'HVAC furnace', install_date: yearsAgo(2) });

describe('monthlyPayment', () => {
  it('matches the standard amortisation formula', () => {
    expect(monthlyPayment(10000, 0.12, 60)).toBeCloseTo(222.44, 1);
  });

  it('handles 0% APR and degenerate input', () => {
    expect(monthlyPayment(1200, 0, 12)).toBeCloseTo(100, 6);
    expect(monthlyPayment(0, 0.1, 12)).toBe(0);
    expect(monthlyPayment(1000, 0.1, 0)).toBe(0);
  });
});

describe('normalizeEconomics', () => {
  it('clamps hostile or malformed input into the valid range', () => {
    const e = normalizeEconomics({
      cashAvailable: -50,
      expectedStayYears: 99,
      discountRate: 7,
      monthlyBudget: Number.NaN,
      creditBand: 'platinum' as never,
      segment: 'weird' as never,
    });
    expect(e.cashAvailable).toBe(0);
    expect(e.expectedStayYears).toBe(FINANCE_HORIZON_YEARS);
    expect(e.discountRate).toBe(0.5);
    expect(e.monthlyBudget).toBeNull();
    expect(e.creditBand).toBe('unknown');
    expect(e.segment).toBe('residential');
  });
});

describe('computeServiceFinancePlan', () => {
  it('is deterministic for the same inputs', () => {
    const t = twin([hvacOld(), hvacNew()]);
    const a = computeServiceFinancePlan(t, { creditBand: 'good' }, { now: NOW });
    const b = computeServiceFinancePlan(t, { creditBand: 'good' }, { now: NOW });
    expect(a).toEqual(b);
  });

  it('returns an empty, low-confidence plan with no equipment', () => {
    const plan = computeServiceFinancePlan(twin([]), undefined, { now: NOW });
    expect(plan.units.length).toBe(0);
    expect(plan.confidence).toBe('low');
    expect(plan.portfolio.unitsAnalyzed).toBe(0);
  });

  it('skips inactive, unclassified and non-financeable units', () => {
    const plan = computeServiceFinancePlan(
      twin([
        eq({ id: 'gone', equipment_type: 'HVAC furnace', status: 'removed' }),
        eq({ id: 'mystery', equipment_type: 'espresso machine' }),
        eq({ id: 'smoke', equipment_type: 'smoke detector' }),
      ]),
      undefined,
      { now: NOW },
    );
    expect(plan.units.length).toBe(0);
  });

  it('recommends replacing an end-of-life, repair-prone unit rather than repair-and-hold', () => {
    const plan = computeServiceFinancePlan(twin([hvacOld()]), { creditBand: 'good' }, { now: NOW });
    const unit = plan.units[0];
    expect(unit.recommended.path.startsWith('replace_')).toBe(true);
    expect(unit.timing).toBe('now');
    expect(unit.savingsVsRepair).toBeGreaterThan(0);
  });

  it('does not push replacement or financing on a young, serviced unit', () => {
    const plan = computeServiceFinancePlan(twin([hvacNew()]), { creditBand: 'good' }, { now: NOW });
    const unit = plan.units[0];
    expect(unit.recommended.path.startsWith('replace_')).toBe(false);
    expect(unit.timing).toBe('monitor');
    expect(plan.portfolio.grossRevenueNow).toBe(0);
  });

  it('ranks every feasible path, with rank 1 on the recommendation and lowest expected cost', () => {
    const unit = computeServiceFinancePlan(twin([hvacOld()]), { creditBand: 'good' }, { now: NOW }).units[0];
    const feasible = unit.paths.filter((p) => p.feasible);
    expect(unit.recommended.rank).toBe(1);
    expect(feasible.map((p) => p.rank)).toEqual(feasible.map((_, i) => i + 1));
    for (let i = 1; i < feasible.length; i++) {
      expect(feasible[i].expectedCost).toBeGreaterThanOrEqual(feasible[i - 1].expectedCost);
    }
    expect(unit.paths.filter((p) => !p.feasible).every((p) => p.rank === 0)).toBe(true);
  });

  it('always keeps the repair path feasible, so a decision always exists', () => {
    const unit = computeServiceFinancePlan(
      twin([hvacOld()]),
      { creditBand: 'poor', cashAvailable: 0, monthlyBudget: 1 },
      { now: NOW },
    ).units[0];
    expect(unit.paths.find((p) => p.path === 'repair')?.feasible).toBe(true);
    expect(unit.recommended.feasible).toBe(true);
  });

  it('switches from cash to financing when the customer cannot pay cash safely', () => {
    const rich = computeServiceFinancePlan(twin([hvacOld()]), { creditBand: 'excellent', cashAvailable: 100000 }, { now: NOW }).units[0];
    const poor = computeServiceFinancePlan(twin([hvacOld()]), { creditBand: 'excellent', cashAvailable: 3000 }, { now: NOW }).units[0];
    expect(rich.paths.find((p) => p.path === 'replace_cash')?.feasible).toBe(true);
    const cash = poor.paths.find((p) => p.path === 'replace_cash');
    expect(cash?.feasible).toBe(false);
    expect(cash?.infeasibleReason).toContain('reserve');
    expect(['replace_loan', 'replace_lease']).toContain(poor.recommended.path);
  });

  it('declines the loan for a poor credit band but still offers lease-to-own', () => {
    const unit = computeServiceFinancePlan(twin([hvacOld()]), { creditBand: 'poor', cashAvailable: 0 }, { now: NOW }).units[0];
    expect(unit.paths.find((p) => p.path === 'replace_loan')?.feasible).toBe(false);
    expect(unit.paths.find((p) => p.path === 'replace_lease')?.feasible).toBe(true);
  });

  it('never offers lease-to-own for systems that are not leasable', () => {
    const roof = eq({ id: 'roof', equipment_type: 'roof shingle', install_date: yearsAgo(26), expected_lifespan_years: 22 });
    const unit = computeServiceFinancePlan(twin([roof]), { creditBand: 'good' }, { now: NOW }).units[0];
    expect(unit.paths.find((p) => p.path === 'replace_lease')?.feasible).toBe(false);
  });

  it('stretches the term to fit a monthly budget, and rejects it when nothing fits', () => {
    const normal = computeServiceFinancePlan(twin([hvacOld()]), { creditBand: 'good', cashAvailable: 0 }, { now: NOW }).units[0];
    expect(normal.paths.find((p) => p.path === 'replace_loan')?.termMonths).toBe(60);

    const fits = computeServiceFinancePlan(twin([hvacOld()]), { creditBand: 'good', cashAvailable: 0, monthlyBudget: 140 }, { now: NOW }).units[0];
    const loan = fits.paths.find((p) => p.path === 'replace_loan');
    expect(loan?.feasible).toBe(true);
    expect(loan?.monthlyPayment).toBeLessThan(140.01);
    expect(loan?.termMonths).toBe(84);

    const tight = computeServiceFinancePlan(twin([hvacOld()]), { creditBand: 'good', cashAvailable: 0, monthlyBudget: 110 }, { now: NOW }).units[0];
    expect(tight.paths.find((p) => p.path === 'replace_loan')?.termMonths).toBe(120);

    const nope = computeServiceFinancePlan(twin([hvacOld()]), { creditBand: 'good', cashAvailable: 0, monthlyBudget: 20 }, { now: NOW }).units[0];
    expect(nope.paths.find((p) => p.path === 'replace_loan')?.feasible).toBe(false);
    expect(nope.flags.join(' ')).toContain('No replacement structure');
  });

  it('computes contractor economics: fee on financed jobs, none on cash', () => {
    const unit = computeServiceFinancePlan(twin([hvacOld()]), { creditBand: 'good', cashAvailable: 0 }, { now: NOW, financingFeePct: { loan: 0.05, lease: 0.1 } }).units[0];
    const loan = unit.paths.find((p) => p.path === 'replace_loan');
    expect(loan?.contractor.grossRevenue).toBe(7500);
    expect(loan?.contractor.financingFee).toBe(375);
    expect(loan?.contractor.netRevenue).toBe(7125);
    const cash = computeServiceFinancePlan(twin([hvacOld()]), { cashAvailable: 100000 }, { now: NOW }).units[0].paths.find((p) => p.path === 'replace_cash');
    expect(cash?.contractor.financingFee).toBe(0);
  });

  it('a lower customer cost of capital favours paying cash over financing', () => {
    const base = { creditBand: 'good' as const, cashAvailable: 100000 };
    const cheapCapital = computeServiceFinancePlan(twin([hvacOld()]), { ...base, discountRate: 0.02 }, { now: NOW }).units[0];
    const cash = cheapCapital.paths.find((p) => p.path === 'replace_cash') as { expectedCost: number };
    const loan = cheapCapital.paths.find((p) => p.path === 'replace_loan') as { expectedCost: number };
    expect(cash.expectedCost).toBeLessThan(loan.expectedCost);
  });

  it('a very high customer cost of capital makes financing beat cash', () => {
    const expensive = computeServiceFinancePlan(twin([hvacOld()]), { creditBand: 'excellent', cashAvailable: 100000, discountRate: 0.4 }, { now: NOW }).units[0];
    const cash = expensive.paths.find((p) => p.path === 'replace_cash') as { expectedCost: number };
    const loan = expensive.paths.find((p) => p.path === 'replace_loan') as { expectedCost: number };
    expect(loan.expectedCost).toBeLessThan(cash.expectedCost);
  });

  it('counts energy savings only on replacement paths, and more for older units', () => {
    const unit = computeServiceFinancePlan(twin([hvacOld()]), { creditBand: 'good', annualEnergyCost: 4000 }, { now: NOW }).units[0];
    expect(unit.paths.find((p) => p.path === 'repair')?.energySavingPerYear).toBe(0);
    const old = unit.paths.find((p) => p.path === 'replace_cash')?.energySavingPerYear ?? 0;
    const young = computeServiceFinancePlan(twin([hvacNew()]), { annualEnergyCost: 4000 }, { now: NOW }).units[0].paths.find((p) => p.path === 'replace_cash')?.energySavingPerYear ?? 0;
    expect(old).toBeGreaterThan(young);
    expect(old).toBeGreaterThan(0);
  });

  it('a shorter expected stay shrinks the horizon and is reported', () => {
    const plan = computeServiceFinancePlan(twin([hvacOld()]), { expectedStayYears: 3 }, { now: NOW });
    expect(plan.horizonYears).toBe(3);
    expect(plan.units[0].flags.join(' ')).toContain('3-year horizon');
  });

  it('active alerts and repair-prone history raise failure risk', () => {
    const base = computeServiceFinancePlan(twin([eq({ id: 'x', equipment_type: 'HVAC furnace', install_date: yearsAgo(12) })]), undefined, { now: NOW }).units[0];
    const alert = {
      id: 'a1', user_id: 'u', equipment_id: 'x', risk_level: 'high', predicted_issue: 'x', recommended_action: null,
      predicted_service_due: null, is_dismissed: false, metric_snapshot: null, created_at: '',
    } as EquipmentMaintenanceAlert;
    const alerted = computeServiceFinancePlan(twin([eq({ id: 'x', equipment_type: 'HVAC furnace', install_date: yearsAgo(12) })], [alert]), undefined, { now: NOW }).units[0];
    expect(alerted.risk5y).toBeGreaterThan(base.risk5y);
    const dismissed = computeServiceFinancePlan(twin([eq({ id: 'x', equipment_type: 'HVAC furnace', install_date: yearsAgo(12) })], [{ ...alert, is_dismissed: true }]), undefined, { now: NOW }).units[0];
    expect(dismissed.risk5y).toBe(base.risk5y);
  });

  it('lowers confidence and flags it when the install date is missing', () => {
    const unit = computeServiceFinancePlan(twin([eq({ id: 'n', equipment_type: 'HVAC furnace', install_date: null })]), undefined, { now: NOW }).units[0];
    expect(unit.ageAssumed).toBe(true);
    expect(unit.confidence).not.toBe('high');
    expect(unit.flags.join(' ')).toContain('age is assumed');
  });

  it('produces a coherent portfolio roll-up', () => {
    const plan = computeServiceFinancePlan(twin([hvacOld(), hvacNew()]), { creditBand: 'good', cashAvailable: 0 }, { now: NOW });
    const p = plan.portfolio;
    expect(p.unitsAnalyzed).toBe(2);
    expect(p.replaceNowCount + p.planCount + p.monitorCount).toBe(2);
    const mixTotal = (Object.values(p.pathMix) as number[]).reduce((a, b) => a + b, 0);
    expect(mixTotal).toBe(2);
    expect(p.netRevenueNow).toBeCloseTo(p.grossRevenueNow - p.financingFeesNow, 2);
    const paths: FinancePath[] = ['replace_loan', 'replace_lease'];
    expect(paths).toContain(plan.units[0].recommended.path);
  });

  it('orders act-now units before monitor units', () => {
    const plan = computeServiceFinancePlan(twin([hvacNew(), hvacOld()]), { creditBand: 'good' }, { now: NOW });
    expect(plan.units[0].equipmentId).toBe('h-old');
  });

  it('commercial segment applies its own defaults and discloses the tax treatment', () => {
    const plan = computeServiceFinancePlan(twin([hvacOld()]), { segment: 'commercial', creditBand: 'good' }, { now: NOW });
    expect(plan.economics.segment).toBe('commercial');
    expect(plan.assumptions.join(' ')).toContain('Commercial tax treatment');
  });

  it('always discloses its assumptions and that it is not a credit decision', () => {
    const plan = computeServiceFinancePlan(twin([hvacOld()]), undefined, { now: NOW });
    expect(plan.assumptions.length).toBeGreaterThan(3);
    expect(plan.assumptions[plan.assumptions.length - 1]).toContain('not a credit decision');
  });

  it('never returns NaN or Infinity in the recommended path', () => {
    const plan = computeServiceFinancePlan(
      twin([hvacOld(), hvacNew(), eq({ id: 'wh', equipment_type: 'water heater', install_date: yearsAgo(14), expected_lifespan_years: 11 })]),
      { creditBand: 'fair', cashAvailable: 500, monthlyBudget: 90, expectedStayYears: 1 },
      { now: NOW },
    );
    for (const u of plan.units) {
      for (const v of [u.recommended.expectedCost, u.recommended.baseCost, u.savingsVsRepair, u.margin, u.risk12m, u.risk5y]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});
