import { describe, it, expect } from 'vitest';
import type { Equipment, EquipmentMaintenanceAlert, Job } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';
import { climateForState, computeHomeBudget, formatBudgetUsd } from './homeBudget';

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

function twin(equipment: Equipment[], extra: Partial<PropertyTwin> = {}): PropertyTwin {
  return { site: null, equipment, jobs: [], jobEquipmentLinks: [], maintenanceAlerts: [], ...extra };
}

function job(over: Partial<Job> & { id: string }): Job {
  return {
    site_id: 's',
    job_status: 'completed',
    service_type: 'repair',
    scheduled_datetime: yearsAgo(0.5),
    invoice_amount: null,
    invoice_currency: null,
    ...over,
  } as unknown as Job;
}

const budget = (t: PropertyTwin) => {
  const b = computeHomeBudget(t, { now: NOW });
  if (!b) throw new Error('expected a budget');
  return b;
};

describe('climateForState', () => {
  it('maps codes and names, and never guesses', () => {
    expect(climateForState('TX')).toBe('hot');
    expect(climateForState('minnesota')).toBe('cold');
    expect(climateForState('CA')).toBe('mild');
    expect(climateForState('OH')).toBe('mixed');
    expect(climateForState('Ontario')).toBe('unknown');
    expect(climateForState(null)).toBe('unknown');
  });
});

describe('computeHomeBudget', () => {
  it('returns null when nothing can be scored', () => {
    expect(computeHomeBudget(twin([]), { now: NOW })).toBeNull();
    expect(computeHomeBudget(twin([eq({ id: 'x', equipment_type: 'Espresso machine' })]), { now: NOW })).toBeNull();
  });

  it('is deterministic and internally consistent', () => {
    const t = twin([eq({ id: 'a', equipment_type: 'Furnace' }), eq({ id: 'b', equipment_type: 'Water heater', expected_lifespan_years: 11 })]);
    const one = budget(t);
    expect(budget(t)).toEqual(one);
    expect(one.years).toHaveLength(5);
    expect(one.annual).toBe(one.years[0].total);
    expect(Math.abs(one.fiveYear - one.years.reduce((s, y) => s + y.total, 0))).toBeLessThan(0.02);
    expect(one.annualLow).toBeLessThan(one.annual);
    expect(one.annualHigh).toBeGreaterThan(one.annual);
  });

  it('costs more as equipment ages', () => {
    const young = budget(twin([eq({ id: 'a', equipment_type: 'Furnace', install_date: yearsAgo(2) })]));
    const old = budget(twin([eq({ id: 'a', equipment_type: 'Furnace', install_date: yearsAgo(16) })]));
    expect(old.annual).toBeGreaterThan(young.annual);
    expect(old.fiveYear).toBeGreaterThan(young.fiveYear);
  });

  it('applies climate only when the state is known', () => {
    const units = [eq({ id: 'a', equipment_type: 'Furnace', install_date: yearsAgo(12) })];
    const site = (state: string | null) => ({ id: 's', name: 'Home', site_type: 'other', state } as unknown as PropertyTwin['site']);
    const hot = budget(twin(units, { site: site('TX') }));
    const unknown = budget(twin(units, { site: site(null) }));
    expect(hot.fiveYear).toBeGreaterThan(unknown.fiveYear);
    expect(unknown.assumptions.some((a) => a.includes('climate'))).toBe(true);
  });

  it('recommends overdue maintenance with a positive net saving, and lowers risk', () => {
    const overdue = eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(13), last_service_date: yearsAgo(3) });
    const b = budget(twin([overdue]));
    const rec = b.recommendations.find((r) => r.categoryKey === 'hvac');
    expect(rec).toBeDefined();
    expect(rec!.netSaving5y).toBeGreaterThan(0);
    expect(rec!.riskAfter).toBeLessThan(rec!.riskBefore);
    expect(b.withPlan.fiveYear).toBeLessThan(b.fiveYear);
  });

  it('does not recommend service for units already on schedule', () => {
    const b = budget(twin([eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(6), last_service_date: yearsAgo(0.2) })]));
    expect(b.recommendations).toHaveLength(0);
    expect(b.withPlan.fiveYear).toBeCloseTo(b.fiveYear, 1);
  });

  it('active manufacturer warranty lowers the budget', () => {
    const base = eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(12) });
    const plain = budget(twin([base]));
    const covered = budget(twin([{ ...base, warranty_expires_at: new Date(NOW + 10 * 365.25 * 24 * 3600 * 1000).toISOString() }]));
    expect(covered.fiveYear).toBeLessThan(plain.fiveYear);
    expect(covered.drivers.find((d) => d.key === 'warranty')!.fiveYearImpact).toBeLessThan(0);
  });

  it('calibrates repair cost with real invoices and counts repair history', () => {
    const unit = eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(12) });
    const plain = budget(twin([unit]));
    const jobs = [job({ id: 'j1', invoice_amount: 2400 }), job({ id: 'j2', invoice_amount: 2600 })];
    const links = jobs.map((j) => ({ job_id: j.id, equipment_id: 'h', service_type: 'repair' }));
    const withHistory = budget(twin([unit], { jobs, jobEquipmentLinks: links }));
    expect(withHistory.fiveYear).toBeGreaterThan(plain.fiveYear);
    expect(withHistory.drivers.find((d) => d.key === 'history')!.fiveYearImpact).toBeGreaterThan(0);
  });

  it('ignores maintenance visits, cancelled jobs and non-USD invoices', () => {
    const unit = eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(12) });
    const plain = budget(twin([unit]));
    const jobs = [
      job({ id: 'j1', service_type: 'Annual tune-up', invoice_amount: 9000 }),
      job({ id: 'j2', job_status: 'cancelled', invoice_amount: 9000 }),
      job({ id: 'j3', invoice_amount: 9000, invoice_currency: 'EUR' }),
    ];
    const links = jobs.map((j) => ({ job_id: j.id, equipment_id: 'h', service_type: null }));
    const b = budget(twin([unit], { jobs, jobEquipmentLinks: links }));
    // Only the EUR job counts as a repair visit (no cost calibration): a single visit → mild history factor.
    expect(b.fiveYear).toBeGreaterThan(plain.fiveYear);
    expect(b.fiveYear).toBeLessThan(plain.fiveYear * 1.3);
  });

  it('skips replaced equipment and flags uncovered systems', () => {
    const b = budget(twin([eq({ id: 'a', equipment_type: 'Furnace' }), eq({ id: 'old', equipment_type: 'Furnace', status: 'replaced' })]));
    expect(b.scoredEquipmentCount).toBe(1);
    expect(b.uncoveredCategories).toContain('roof');
    expect(b.categories.map((c) => c.key)).toEqual(['hvac']);
  });

  it('open predictive alerts raise cost and are resolved by the service scenario', () => {
    const unit = eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(12) });
    const alert = { id: 'al', user_id: 'u', equipment_id: 'h', risk_level: 'high', predicted_issue: 'x', recommended_action: null, predicted_service_due: null, is_dismissed: false, metric_snapshot: null, created_at: '' } as EquipmentMaintenanceAlert;
    const plain = budget(twin([unit]));
    const alerted = budget(twin([unit], { maintenanceAlerts: [alert] }));
    expect(alerted.fiveYear).toBeGreaterThan(plain.fiveYear);
    expect(alerted.recommendations[0].netSaving5y).toBeGreaterThan(0);
  });
});

describe('formatBudgetUsd', () => {
  it('rounds to honest precision', () => {
    expect(formatBudgetUsd(4873.4)).toBe('$4,870');
    expect(formatBudgetUsd(23412)).toBe('$23,400');
  });
});
