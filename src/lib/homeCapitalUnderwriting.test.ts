import { describe, it, expect } from 'vitest';
import type { Equipment, EquipmentMaintenanceAlert } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';
import { computeHomeIntelligenceGraph } from '@/lib/homeIntelligenceGraph';
import {
  CAPITAL_HORIZON_YEARS,
  computeHomeCapitalUnderwriting,
  replacementPolicy,
  steadyStatePolicy,
  type CapitalItem,
} from './homeCapitalUnderwriting';

const NOW = new Date('2026-10-05T00:00:00Z').getTime();

const equipment = (over: Partial<Equipment>): Equipment => ({
  id: 'e1', user_id: 'u', customer_id: 'c', room_id: 'r', equipment_type: 'HVAC split system', make: 'Carrier', model: '24ACC',
  serial_number: null, install_date: '2011-05-01', install_job_id: null, warranty_expires_at: null, warranty_notes: null,
  expected_lifespan_years: 15, service_interval_months: 12, last_service_date: '2026-01-10', notes: null, status: 'active',
  created_at: '2011-05-01T00:00:00Z', updated_at: '2011-05-01T00:00:00Z', ...over,
});

const alert = (over: Partial<EquipmentMaintenanceAlert>): EquipmentMaintenanceAlert => ({
  id: 'a1', user_id: 'u', equipment_id: 'hvac', risk_level: 'high', predicted_issue: 'Compressor amp draw trending up',
  recommended_action: 'Test capacitor and compressor', predicted_service_due: null, is_dismissed: false, metric_snapshot: null,
  created_at: '2026-09-01T00:00:00Z', ...over,
});

function twin(equip: Equipment[], alerts: EquipmentMaintenanceAlert[] = [], state = 'TX'): PropertyTwin {
  return { site: { state, site_type: 'other' } as unknown as PropertyTwin['site'], equipment: equip, jobs: [], jobEquipmentLinks: [], maintenanceAlerts: alerts };
}

const oldHvac = equipment({ id: 'hvac', install_date: '2011-05-01' });
const newHvac = equipment({ id: 'hvac', install_date: '2025-09-01', last_service_date: '2026-06-01' });
const waterHeater = equipment({ id: 'wh', equipment_type: 'Water heater', make: 'Rheem', model: null, install_date: '2016-03-01', expected_lifespan_years: 11, last_service_date: '2026-03-01' });

const run = (t: PropertyTwin, extra: Parameters<typeof computeHomeCapitalUnderwriting>[0] extends infer I ? Partial<I> : never = {}, opts = {}) =>
  computeHomeCapitalUnderwriting({ twin: t, yearBuilt: null, ...extra }, { now: NOW, ...opts });

const item = (items: CapitalItem[], key: string) => items.find((i) => i.key === key);

describe('computeHomeCapitalUnderwriting', () => {
  it('returns null when there is nothing to underwrite', () => {
    expect(run(twin([]))).toBeNull();
  });

  it('estimates from home age when no equipment is on record, and never marks estimates actionable for replacement', () => {
    const r = run(twin([]), { yearBuilt: 1985 });
    expect(r).not.toBeNull();
    const replaces = r!.items.filter((i) => i.action === 'replace');
    expect(replaces.every((i) => i.basis === 'home_age' && !i.actionable)).toBeTruthy();
    expect(r!.items.some((i) => i.categoryKey === 'electrical' && i.action === 'replace')).toBeFalsy();
  });

  it('agrees with the Home Intelligence Graph on 12-month risk (one story everywhere)', () => {
    const t = twin([oldHvac, waterHeater], [alert({})]);
    const r = run(t)!;
    const g = computeHomeIntelligenceGraph(t, { now: NOW })!;
    for (const e of ['hvac', 'wh']) {
      const node = g.nodes.find((n) => n.id === `eq:${e}`)!;
      const replace = item(r.items, `eq:${e}:replace`)!;
      expect(replace.risk12mBefore).toBeCloseTo(node.risk12m, 3);
    }
  });

  it('plans a replacement within a year for an old unit with an open alert, and none for a new unit', () => {
    const old = run(twin([oldHvac], [alert({})]))!;
    const replace = item(old.items, 'eq:hvac:replace')!;
    expect(replace.timing.targetMonths).toBeLessThanOrEqual(12);
    expect(item(old.items, 'eq:hvac:repair')).toBeDefined();
    expect(['critical', 'high']).toContain(replace.urgency);
    expect(replace.riskReduction).toBeGreaterThan(0.3);

    const fresh = run(twin([newHvac]))!;
    expect(item(fresh.items, 'eq:hvac:replace')).toBeUndefined();
    expect(fresh.summary.grade < old.summary.grade).toBeTruthy();
  });

  it('does not recommend servicing or repairing a unit that is being replaced within 3 months', () => {
    const r = run(twin([oldHvac], [alert({})]))!;
    const replace = item(r.items, 'eq:hvac:replace')!;
    if (replace.timing.targetMonths <= 3) {
      expect(item(r.items, 'eq:hvac:repair')).toBeUndefined();
      expect(item(r.items, 'eq:hvac:maintain')).toBeUndefined();
    }
  });

  it('proposes a repair for a high alert on a mid-life unit, and routes warranty claims correctly', () => {
    const mid = equipment({ id: 'hvac', install_date: '2020-01-01', warranty_expires_at: '2029-01-01' });
    const r = run(twin([mid], [alert({})]))!;
    const repair = item(r.items, 'eq:hvac:repair')!;
    expect(repair).toBeDefined();
    expect(repair.timing.targetMonths).toBe(0);
    expect(repair.warranty.claimEligible).toBeTruthy();
    expect(repair.funding.method).toBe('warranty');
    expect(repair.outOfPocketMid).toBeLessThan(repair.costMid);

    const claimed = run(twin([mid], [alert({})]), { warrantyClaims: [{ equipment_id: 'hvac', status: 'submitted', credit_received_cents: null }] })!;
    expect(item(claimed.items, 'eq:hvac:repair')!.warranty.claimEligible).toBeFalsy();
    expect(item(claimed.items, 'eq:hvac:repair')!.warranty.openClaim).toBeTruthy();
  });

  it('lets a higher risk tolerance push planned replacements later, never earlier', () => {
    const t = twin([equipment({ id: 'hvac', install_date: '2014-05-01' })]);
    const strict = item(run(t, {}, { riskTolerance: 0.15 })!.items, 'eq:hvac:replace')!;
    const loose = item(run(t, {}, { riskTolerance: 0.5 })!.items, 'eq:hvac:replace');
    expect(strict).toBeDefined();
    if (loose) expect(loose.timing.targetMonths).toBeGreaterThanOrEqual(strict.timing.targetMonths);
  });

  it('clamps an out-of-range risk tolerance', () => {
    const r = run(twin([oldHvac]), {}, { riskTolerance: 9 })!;
    expect(r.riskTolerance).toBe(0.6);
    expect(run(twin([oldHvac]), {}, { riskTolerance: Number.NaN })!.riskTolerance).toBe(0.3);
  });

  it('honours price-book overrides', () => {
    const r = run(twin([oldHvac]), {}, { costs: { hvac: { replacement: 10000 } } })!;
    expect(item(r.items, 'eq:hvac:replace')!.costMid).toBe(10000);
    expect(item(r.items, 'eq:hvac:replace')!.connect.quoteLine.unit_price_cents).toBe(1000000);
  });

  it('funds from cash when the customer can absorb it, and finances when they cannot', () => {
    const rich = run(twin([oldHvac]), { economics: { cashAvailable: 200000, creditBand: 'excellent' } })!;
    expect(item(rich.items, 'eq:hvac:replace')!.funding.method).toBe('cash');
    const tight = run(twin([oldHvac]), { economics: { cashAvailable: 1000, creditBand: 'good' } })!;
    const f = item(tight.items, 'eq:hvac:replace')!.funding;
    expect(['loan', 'lease']).toContain(f.method);
    expect(f.monthlyPayment).toBeGreaterThan(0);
    expect(f.termMonths).not.toBeNull();
  });

  it('recommends protection only when one failure can exceed capacity and loss is material', () => {
    const tight = run(twin([oldHvac, waterHeater]), { economics: { cashAvailable: 2000 } })!;
    expect(tight.summary.protection.recommended).toBeTruthy();
    expect(item(tight.items, 'portfolio:insure')).toBeDefined();
    const rich = run(twin([oldHvac, waterHeater]), { economics: { cashAvailable: 500000 } })!;
    expect(rich.summary.protection.recommended).toBeFalsy();
    expect(item(rich.items, 'portfolio:insure')).toBeUndefined();
  });

  it('keeps the 10-year plan arithmetic exact and the reserve deficit-free', () => {
    const r = run(twin([oldHvac, waterHeater], [alert({})]), { yearBuilt: 1990, economics: { cashAvailable: 1500 } }, { annualReserve: 2000 })!;
    expect(r.years).toHaveLength(CAPITAL_HORIZON_YEARS);
    let cumulative = 0;
    for (const y of r.years) {
      expect(y.total).toBeCloseTo(y.replacements + y.maintenance + y.inspections + y.contingency, 1);
      expect(y.cashOut).toBeCloseTo(y.total - y.financedPrincipal + y.debtService, 1);
      cumulative += y.cashOut;
      expect(y.cumulativeCashOut).toBeCloseTo(cumulative, 0);
      expect(r.summary.reserve.suggestedMonthly * 12 * y.year).toBeGreaterThanOrEqual(y.cumulativeCashOut - 0.01);
    }
    expect(r.summary.capital.tenYear).toBeCloseTo(r.years.reduce((a, y) => a + y.total, 0), 0);
    expect(r.summary.reserve.fundingGap).not.toBeNull();
  });

  it('reports no funding gap when no reserve is provided', () => {
    expect(run(twin([oldHvac]))!.summary.reserve.fundingGap).toBeNull();
  });

  it('keeps score, band, counts and ordering coherent', () => {
    const r = run(twin([oldHvac, waterHeater], [alert({})]), { yearBuilt: 1990 })!;
    const s = r.summary;
    expect(s.riskIndex).toBeGreaterThanOrEqual(0);
    expect(s.riskIndex).toBeLessThanOrEqual(100);
    expect(s.riskIndexLow).toBeLessThanOrEqual(s.riskIndex);
    expect(s.riskIndexHigh).toBeGreaterThanOrEqual(s.riskIndex);
    expect(Math.round(s.components.reduce((a, c) => a + c.weight, 0) * 100)).toBe(100);
    expect(s.riskAfter12m).toBeLessThanOrEqual(s.risk12m);
    expect(s.counts.replace + s.counts.repair + s.counts.maintain + s.counts.inspect + s.counts.insure).toBe(r.items.length);
    for (let i = 1; i < r.items.length; i++) expect(r.items[i - 1].urgencyScore).toBeGreaterThanOrEqual(r.items[i].urgencyScore);
    expect(new Set(r.items.map((i) => i.key)).size).toBe(r.items.length);
    for (const it of r.items) {
      expect(it.timing.target).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(it.costLow).toBeLessThanOrEqual(it.costMid);
      expect(it.costMid).toBeLessThanOrEqual(it.costHigh);
      expect(it.riskReduction).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic', () => {
    const t = twin([oldHvac, waterHeater], [alert({})]);
    expect(JSON.stringify(run(t, { yearBuilt: 1990 }))).toBe(JSON.stringify(run(t, { yearBuilt: 1990 })));
  });

  it('uses elevated energy use as a weak HVAC signal', () => {
    const t = twin([equipment({ id: 'hvac', install_date: '2014-05-01' })]);
    const readings = [
      ...[7, 8, 9].map((m) => ({ period_start: `2026-0${m}-01`, energy_kwh: 1300, cost_usd: null })),
      ...[7, 8, 9].map((m) => ({ period_start: `2025-0${m}-01`, energy_kwh: 1000, cost_usd: null })),
    ];
    const base = run(t)!;
    const energy = run(t, { energyReadings: readings })!;
    expect(energy.energy.state).not.toBe('normal');
    expect(energy.summary.risk12m).toBeGreaterThan(base.summary.risk12m);
  });
});

describe('replacement policy', () => {
  it('steady-state optimum for a fresh unit lies inside its life, and running to failure wins when emergencies are free', () => {
    const p = steadyStatePolicy(15, 4, 1, 7500, 8650);
    expect(p.years).not.toBeNull();
    expect(p.years as number).toBeGreaterThan(5);
    expect(p.years as number).toBeLessThan(20);
    expect(steadyStatePolicy(15, 4, 1, 7500, 7500).years).toBeNull();
  });

  it('replaces an aged unit sooner than a young one, and saving is largest near the optimum', () => {
    const steady = steadyStatePolicy(15, 4, 1, 7500, 8650);
    const old = replacementPolicy(16, 15, 4, 1.2, 7500, 8650, steady.rate, 0.3);
    const young = replacementPolicy(3, 15, 4, 1.2, 7500, 8650, steady.rate, 0.3);
    expect(old.economicYears === null ? 0 : old.economicYears).toBeLessThan(young.economicYears === null ? 99 : young.economicYears);
    expect(old.toleranceYears).toBeLessThan(young.toleranceYears);
    if (old.economicYears !== null) expect(old.savingAt(old.economicYears)).toBeGreaterThanOrEqual(old.savingAt(old.economicYears + 3) - 1e-6);
  });
});
