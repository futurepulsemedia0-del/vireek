import { describe, expect, it } from 'vitest';
import {
  assessLifecycle,
  parseSignals,
  type LifecycleEquipment,
  type PassportSignals,
} from '../../supabase/functions/_shared/equipment-lifecycle/score';

const NOW = new Date('2026-10-01T12:00:00Z');
const yearsAgo = (y: number) => new Date(NOW.getTime() - y * 365.25 * 86_400_000).toISOString().slice(0, 10);
const monthsAgo = (m: number) => new Date(NOW.getTime() - m * 30.4 * 86_400_000).toISOString().slice(0, 10);

const eq = (over: Partial<LifecycleEquipment> = {}): LifecycleEquipment => ({
  equipment_type: 'Furnace',
  make: 'Carrier',
  model: 'X1',
  install_date: yearsAgo(5),
  last_service_date: monthsAgo(3),
  expected_lifespan_years: 15,
  service_interval_months: 12,
  ...over,
});

const sig = (over: Partial<PassportSignals> = {}): PassportSignals => ({
  total_events: 5,
  repair_12m: 0,
  repair_6m: 0,
  repair_prev_6m: 0,
  callbacks_12m: 0,
  contractors_24m: 1,
  warranty_claims_24m: 0,
  last_service_at: null,
  last_service_by_other: false,
  repeat_part: null,
  repeat_part_count: 0,
  ...over,
});

describe('legacy behaviour (no passport)', () => {
  it('healthy unit is low risk', () => {
    expect(assessLifecycle(eq(), NOW, 0, null).riskLevel).toBe('low');
  });
  it('past lifespan is high', () => {
    const a = assessLifecycle(eq({ install_date: yearsAgo(16) }), NOW, 0, null);
    expect(a.riskLevel).toBe('high');
    expect(a.predictedIssue).toMatch(/passed its expected 15-year lifespan/);
  });
  it('3 repairs in 12 months is high, 2 is medium', () => {
    expect(assessLifecycle(eq(), NOW, 3, null).riskLevel).toBe('high');
    const m = assessLifecycle(eq(), NOW, 2, null);
    expect(m.riskLevel).toBe('medium');
    expect(m.predictedIssue).toMatch(/2 repair visits/);
  });
  it('overdue service is medium', () => {
    const a = assessLifecycle(eq({ last_service_date: monthsAgo(20) }), NOW, 0, null);
    expect(a.riskLevel).toBe('medium');
    expect(a.predictedIssue).toMatch(/overdue/);
  });
  it('no install date and no history is low, never throws', () => {
    const a = assessLifecycle(eq({ install_date: null, last_service_date: null }), NOW, 0, null);
    expect(a.riskLevel).toBe('low');
    expect(a.predictedServiceDue).toBeNull();
  });
});

describe('passport signals (multi-contractor history)', () => {
  it('another company recently serviced the unit -> not overdue', () => {
    const base = eq({ last_service_date: monthsAgo(20) });
    expect(assessLifecycle(base, NOW, 0, null).riskLevel).toBe('medium');
    const a = assessLifecycle(base, NOW, 0, sig({ last_service_at: monthsAgo(2), last_service_by_other: true }));
    expect(a.riskLevel).toBe('low');
  });

  it('repairs across companies are counted and named', () => {
    const a = assessLifecycle(eq(), NOW, 0, sig({ repair_12m: 3, contractors_24m: 3 }));
    expect(a.riskLevel).toBe('high');
    expect(a.predictedIssue).toMatch(/3 repair visits.*3 service companies/);
  });

  it('passport repair count replaces the account-only count (maintenance excluded)', () => {
    const a = assessLifecycle(eq(), NOW, 5, sig({ repair_12m: 0 }));
    expect(a.riskLevel).toBe('low');
  });

  it('repeat failures after repair are high', () => {
    const a = assessLifecycle(eq(), NOW, 0, sig({ callbacks_12m: 2 }));
    expect(a.riskLevel).toBe('high');
    expect(a.recommendedAction).toMatch(/root-cause/);
  });

  it('same part replaced 3x is high, 2x is medium', () => {
    expect(assessLifecycle(eq(), NOW, 0, sig({ repeat_part: 'capacitor', repeat_part_count: 3 })).riskLevel).toBe('high');
    const m = assessLifecycle(eq(), NOW, 0, sig({ repeat_part: 'capacitor', repeat_part_count: 2 }));
    expect(m.riskLevel).toBe('medium');
    expect(m.predictedIssue).toMatch(/capacitor/);
  });

  it('accelerating repairs: medium when young, high when old', () => {
    const s = sig({ repair_12m: 2, repair_6m: 2, repair_prev_6m: 0 });
    expect(assessLifecycle(eq(), NOW, 0, s).riskLevel).toBe('medium');
    expect(assessLifecycle(eq({ install_date: yearsAgo(12) }), NOW, 0, s).riskLevel).toBe('high');
  });

  it('many companies, no owner of the root cause', () => {
    const a = assessLifecycle(eq(), NOW, 0, sig({ repair_12m: 2, contractors_24m: 3 }));
    expect(a.riskLevel).toBe('medium');
    expect(a.reasons.some((r) => /nobody owns the root cause/.test(r))).toBe(true);
  });

  it('repeated warranty claims are medium', () => {
    expect(assessLifecycle(eq(), NOW, 0, sig({ warranty_claims_24m: 2 })).riskLevel).toBe('medium');
  });

  it('highest severity wins and all reasons are kept', () => {
    const a = assessLifecycle(eq({ install_date: yearsAgo(12) }), NOW, 0, sig({ repair_12m: 3, warranty_claims_24m: 2 }));
    expect(a.riskLevel).toBe('high');
    expect(a.reasons.length).toBeGreaterThanOrEqual(3);
    expect(a.snapshot.passport).not.toBeNull();
  });

  it('works with no install date when passport history exists', () => {
    const a = assessLifecycle(eq({ install_date: null, last_service_date: null }), NOW, 0, sig({ repair_12m: 3 }));
    expect(a.riskLevel).toBe('high');
  });
});

describe('parseSignals', () => {
  it('rejects junk and coerces numbers safely', () => {
    expect(parseSignals(null)).toBeNull();
    expect(parseSignals('x')).toBeNull();
    const s = parseSignals({ repair_12m: '3', callbacks_12m: -4, repeat_part: ' Capacitor ', repeat_part_count: 2, last_service_at: 'nope' });
    expect(s?.repair_12m).toBe(3);
    expect(s?.callbacks_12m).toBe(0);
    expect(s?.repeat_part).toBe('Capacitor');
    expect(s?.last_service_at).toBeNull();
  });
});
