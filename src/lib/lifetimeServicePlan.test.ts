import { describe, it, expect } from 'vitest';
import type { Equipment, EquipmentMaintenanceAlert, Job } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';
import type { HierarchySite } from '@/lib/siteHierarchy';
import {
  PLAN_HORIZON_YEARS,
  computeLifetimeServicePlan,
  failureProbability,
  formatMonths,
  formatWindow,
  homeAgeFromYearBuilt,
  isValidYearBuilt,
  yearsToQuantile,
} from './lifetimeServicePlan';

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

function twin(equipment: Equipment[] = [], state: string | null = 'OH', alerts: EquipmentMaintenanceAlert[] = [], jobs: Job[] = []): PropertyTwin {
  return {
    site: { id: 's1', name: 'Home', site_type: 'other', state, buildings: [] } as unknown as HierarchySite,
    equipment,
    jobs,
    jobEquipmentLinks: [],
    maintenanceAlerts: alerts,
  };
}

describe('hazard math', () => {
  it('older units fail sooner than newer ones', () => {
    const young = yearsToQuantile(3, 15, 4, 0.5, 1);
    const old = yearsToQuantile(14, 15, 4, 0.5, 1);
    expect(old).toBeLessThan(young);
  });

  it('a higher hazard multiplier brings failure forward', () => {
    expect(yearsToQuantile(8, 15, 4, 0.5, 1.5)).toBeLessThan(yearsToQuantile(8, 15, 4, 0.5, 1));
  });

  it('quantiles are ordered and never negative', () => {
    const q20 = yearsToQuantile(20, 15, 4, 0.2, 1);
    const q80 = yearsToQuantile(20, 15, 4, 0.8, 1);
    expect(q20).toBeGreaterThanOrEqual(0);
    expect(q80).toBeGreaterThan(q20);
  });

  it('failure probability rises with age and stays below 1', () => {
    const p = failureProbability(5, 15, 4, 1, 5);
    const pOld = failureProbability(16, 15, 4, 1, 5);
    expect(pOld).toBeGreaterThan(p);
    expect(pOld).toBeLessThanOrEqual(0.95);
  });
});

describe('year built', () => {
  it('validates whole years in range', () => {
    expect(isValidYearBuilt(1990, NOW)).toBe(true);
    expect(isValidYearBuilt(1650, NOW)).toBe(false);
    expect(isValidYearBuilt(2099, NOW)).toBe(false);
    expect(isValidYearBuilt(1990.5, NOW)).toBe(false);
  });

  it('derives home age', () => {
    expect(homeAgeFromYearBuilt(2008, NOW)).toBe(18);
    expect(homeAgeFromYearBuilt(null, NOW)).toBeNull();
    expect(homeAgeFromYearBuilt(1200, NOW)).toBeNull();
  });
});

describe('formatting', () => {
  it('formats windows', () => {
    expect(formatWindow({ fromYears: 1, toYears: 3, fromMonths: 14 })).toBe('1–3 years');
    expect(formatWindow({ fromYears: 0, toYears: 1, fromMonths: 2 })).toBe('Within 12 months');
    expect(formatWindow({ fromYears: 0, toYears: 3, fromMonths: 0 })).toBe('Now–3 years');
    expect(formatWindow({ fromYears: 11, toYears: 14, fromMonths: 140 })).toBe('10+ years');
  });

  it('formats months', () => {
    expect(formatMonths(0)).toBe('now');
    expect(formatMonths(1)).toBe('1 month');
    expect(formatMonths(8)).toBe('8 months');
    expect(formatMonths(36)).toBe('3 years');
  });
});

describe('computeLifetimeServicePlan', () => {
  it('returns null with no equipment and no year built', () => {
    expect(computeLifetimeServicePlan(twin(), null, { now: NOW })).toBeNull();
  });

  it('ignores an invalid year built', () => {
    expect(computeLifetimeServicePlan(twin(), 1200, { now: NOW })).toBeNull();
  });

  it('is deterministic', () => {
    const t = twin([eq({ id: 'a', equipment_type: 'Furnace' })]);
    expect(computeLifetimeServicePlan(t, 2008, { now: NOW })).toEqual(computeLifetimeServicePlan(t, 2008, { now: NOW }));
  });

  it('estimates estimable systems from home age alone, never safety', () => {
    const plan = computeLifetimeServicePlan(twin(), 2008, { now: NOW })!;
    const keys = plan.systems.map((s) => s.categoryKey).sort();
    expect(keys).toEqual(['electrical', 'hvac', 'plumbing', 'roof', 'water_heater']);
    expect(plan.systems.every((s) => s.basis === 'home_age')).toBe(true);
    expect(plan.homeAgeYears).toBe(18);
    expect(plan.confidence).not.toBe('high');
  });

  it('never schedules replacement for home-age electrical or plumbing, only inspections', () => {
    const plan = computeLifetimeServicePlan(twin(), 2008, { now: NOW })!;
    const events = plan.roadmap.flatMap((y) => y.events);
    expect(events.some((e) => e.kind === 'replacement' && (e.categoryKey === 'electrical' || e.categoryKey === 'plumbing'))).toBe(false);
    expect(events.some((e) => e.kind === 'inspection' && e.categoryKey === 'electrical')).toBe(true);
    const electrical = plan.systems.find((s) => s.categoryKey === 'electrical')!;
    expect(electrical.replacement).toBeNull();
    expect(electrical.inspectionInMonths).not.toBeNull();
  });

  it('uses real equipment over the home-age estimate', () => {
    const plan = computeLifetimeServicePlan(twin([eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(14) })]), 2008, { now: NOW })!;
    const hvac = plan.systems.find((s) => s.categoryKey === 'hvac')!;
    expect(hvac.basis).toBe('equipment');
    expect(hvac.unitCount).toBe(1);
    expect(hvac.replacement).not.toBeNull();
    expect(hvac.replacement!.fromYears).toBeLessThanOrEqual(1);
    expect(hvac.risk).toBe('high');
  });

  it('brings replacement forward for a unit past its expected life', () => {
    const plan = computeLifetimeServicePlan(twin([eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(20) })]), null, { now: NOW })!;
    const hvac = plan.systems[0];
    expect(hvac.replacement!.fromYears).toBe(0);
    expect(plan.nextActions.some((a) => a.categoryKey === 'hvac')).toBe(true);
    expect(plan.roadmap[0].replacements + plan.roadmap[1].replacements).toBeGreaterThan(0);
  });

  it('a recurring short-life system can be replaced more than once in ten years', () => {
    const plan = computeLifetimeServicePlan(twin([eq({ id: 'w', equipment_type: 'Water heater', install_date: yearsAgo(8), expected_lifespan_years: 8 })]), null, { now: NOW })!;
    const count = plan.roadmap.flatMap((y) => y.events).filter((e) => e.kind === 'replacement').length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('halves the event cost while a manufacturer warranty is active', () => {
    const base = eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(14) });
    const covered = { ...base, warranty_expires_at: new Date(NOW + 5 * 365.25 * 24 * 60 * 60 * 1000).toISOString() };
    const a = computeLifetimeServicePlan(twin([base]), null, { now: NOW })!;
    const b = computeLifetimeServicePlan(twin([covered]), null, { now: NOW })!;
    expect(b.tenYearReplacements).toBeLessThan(a.tenYearReplacements);
  });

  it('overdue service and open alerts raise risk and shorten remaining life', () => {
    const onSchedule = twin([eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(10) })]);
    const neglected = twin(
      [eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(10), last_service_date: yearsAgo(3) })],
      'OH',
      [{ id: 'al', user_id: 'u', equipment_id: 'h', risk_level: 'high', predicted_issue: 'x', recommended_action: null, predicted_service_due: null, is_dismissed: false } as EquipmentMaintenanceAlert],
    );
    const a = computeLifetimeServicePlan(onSchedule, null, { now: NOW })!.systems[0];
    const b = computeLifetimeServicePlan(neglected, null, { now: NOW })!.systems[0];
    expect(b.risk5y).toBeGreaterThan(a.risk5y);
    expect(b.serviceGainYears).toBeGreaterThan(a.serviceGainYears);
  });

  it('marks assumed ages and widens the confidence caveats', () => {
    const plan = computeLifetimeServicePlan(twin([eq({ id: 'h', equipment_type: 'Furnace', install_date: null })]), null, { now: NOW })!;
    expect(plan.systems[0].ageAssumed).toBe(true);
    expect(plan.assumptions.some((a) => a.includes('no install date'))).toBe(true);
  });

  it('keeps roadmap totals internally consistent', () => {
    const plan = computeLifetimeServicePlan(
      twin([eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(13) }), eq({ id: 'w', equipment_type: 'Water heater', install_date: yearsAgo(9), expected_lifespan_years: 11 })]),
      2008,
      { now: NOW },
    )!;
    expect(plan.roadmap).toHaveLength(PLAN_HORIZON_YEARS);
    const sumYears = plan.roadmap.reduce((s, y) => s + y.total, 0);
    expect(Math.abs(sumYears - plan.tenYearTotal)).toBeLessThan(0.05);
    expect(Math.abs(plan.tenYearReplacements + plan.tenYearMaintenance - plan.tenYearTotal)).toBeLessThan(0.05);
    expect(plan.suggestedMonthlyReserve).toBeCloseTo(plan.tenYearReplacements / 120, 1);
    for (const y of plan.roadmap) {
      const fromEvents = y.events.reduce((s, e) => s + e.cost, 0);
      expect(Math.abs(fromEvents - (y.replacements + y.inspections))).toBeLessThan(0.05);
    }
    expect(plan.roadmap[0].calendarYear).toBe(2026);
    expect(plan.roadmap[9].calendarYear).toBe(2035);
  });

  it('respects cost overrides', () => {
    const t = twin([eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(14) })]);
    const cheap = computeLifetimeServicePlan(t, null, { now: NOW, costs: { hvac: { replacement: 1000 } } })!;
    const dear = computeLifetimeServicePlan(t, null, { now: NOW, costs: { hvac: { replacement: 20000 } } })!;
    expect(dear.tenYearReplacements).toBeGreaterThan(cheap.tenYearReplacements);
  });

  it('skips replaced and removed equipment', () => {
    const plan = computeLifetimeServicePlan(twin([eq({ id: 'old', equipment_type: 'Furnace', status: 'replaced' })]), null, { now: NOW });
    expect(plan).toBeNull();
  });
});
