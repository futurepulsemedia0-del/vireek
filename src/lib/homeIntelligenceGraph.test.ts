import { describe, it, expect } from 'vitest';
import type { Equipment, EquipmentMaintenanceAlert, Job } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';
import type { HierarchySite } from '@/lib/siteHierarchy';
import {
  GRAPH_RISK_HIGH_12M,
  analyzeEnergy,
  childrenOf,
  computeHomeIntelligenceGraph,
  validateEnergyInput,
  type EnergyReading,
} from './homeIntelligenceGraph';

const NOW = new Date('2026-06-15T00:00:00Z').getTime();
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const yearsAgo = (y: number) => new Date(NOW - y * YEAR_MS).toISOString();
const yearsAhead = (y: number) => new Date(NOW + y * YEAR_MS).toISOString();

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

function alert(equipmentId: string, risk: 'low' | 'medium' | 'high'): EquipmentMaintenanceAlert {
  return {
    id: `a-${equipmentId}`,
    user_id: 'u',
    equipment_id: equipmentId,
    risk_level: risk,
    predicted_issue: 'Compressor amperage trending up',
    recommended_action: 'Inspect the compressor and capacitor.',
    predicted_service_due: null,
    is_dismissed: false,
    metric_snapshot: null,
    created_at: '',
  };
}

function job(id: string, status = 'completed'): Job {
  return { id, job_status: status, service_type: 'repair', scheduled_datetime: yearsAgo(0.4), invoice_amount: 300 } as unknown as Job;
}

function twin(equipment: Equipment[] = [], extra: Partial<PropertyTwin> = {}, state: string | null = 'OH'): PropertyTwin {
  return {
    site: { id: 's1', name: 'Maple House', site_type: 'other', state, buildings: [] } as unknown as HierarchySite,
    equipment,
    jobs: [],
    jobEquipmentLinks: [],
    maintenanceAlerts: [],
    ...extra,
  };
}

/** Readings for the last `months` months, each `recent` kWh, and the same months a year earlier at `prior` kWh. */
function energySeries(recent: number, prior: number, months = 3): EnergyReading[] {
  const out: EnergyReading[] = [];
  for (let i = 1; i <= months; i++) {
    const d = new Date(Date.UTC(2026, 5 - i, 1));
    const p = new Date(Date.UTC(2025, 5 - i, 1));
    out.push({ period_start: d.toISOString().slice(0, 10), energy_kwh: recent });
    out.push({ period_start: p.toISOString().slice(0, 10), energy_kwh: prior });
  }
  return out;
}

const agingHvac = () => eq({ id: 'hvac1', equipment_type: 'HVAC', make: 'Carrier', model: 'X1', install_date: yearsAgo(13), last_service_date: yearsAgo(2.5), service_interval_months: 12 });

describe('computeHomeIntelligenceGraph — coverage', () => {
  it('returns null when nothing can be modelled', () => {
    expect(computeHomeIntelligenceGraph(twin(), { now: NOW })).toBeNull();
    expect(computeHomeIntelligenceGraph(twin([eq({ id: 'x', equipment_type: 'Mystery gadget' })]), { now: NOW })).toBeNull();
  });

  it('builds low-confidence, home-age estimates from the year built alone', () => {
    const g = computeHomeIntelligenceGraph(twin(), { now: NOW, yearBuilt: 1995 });
    expect(g).not.toBeNull();
    const systems = g!.nodes.filter((n) => n.kind === 'system');
    expect(systems.length).toBeGreaterThanOrEqual(3);
    expect(systems.every((s) => s.basis === 'home_age' && s.confidence === 'low')).toBe(true);
    expect(g!.nodes.some((n) => n.kind === 'component')).toBe(false);
    expect(g!.homeAgeYears).toBe(31);
    // Nothing is service-fixable without equipment records, so nothing is promised.
    expect(g!.actNow).toBeNull();
  });

  it('ignores an invalid year built', () => {
    expect(computeHomeIntelligenceGraph(twin(), { now: NOW, yearBuilt: 1200 })).toBeNull();
  });
});

describe('computeHomeIntelligenceGraph — structure and invariants', () => {
  const g = computeHomeIntelligenceGraph(twin([agingHvac(), eq({ id: 'wh1', equipment_type: 'Water heater', expected_lifespan_years: 11 })]), { now: NOW, yearBuilt: 2004 })!;

  it('forms a tree whose edges reference real nodes', () => {
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.size).toBe(g.nodes.length);
    for (const e of g.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
    const home = g.nodes.find((n) => n.kind === 'home')!;
    expect(home.parentId).toBeNull();
    expect(childrenOf(g, 'home').every((n) => n.kind === 'system')).toBe(true);
    expect(childrenOf(g, 'sys:hvac').map((n) => n.id)).toEqual(['eq:hvac1']);
  });

  it('keeps probabilities ordered and bounded', () => {
    for (const n of g.nodes) {
      expect(n.risk6m).toBeGreaterThanOrEqual(0);
      expect(n.risk6m).toBeLessThanOrEqual(n.risk12m);
      expect(n.risk12m).toBeLessThan(1);
    }
    const systems = g.nodes.filter((n) => n.kind === 'system');
    expect(g.risk12m).toBeGreaterThanOrEqual(Math.max(...systems.map((s) => s.risk12m)));
  });

  it('is deterministic', () => {
    const again = computeHomeIntelligenceGraph(twin([agingHvac(), eq({ id: 'wh1', equipment_type: 'Water heater', expected_lifespan_years: 11 })]), { now: NOW, yearBuilt: 2004 })!;
    expect(again).toEqual(g);
  });
});

describe('computeHomeIntelligenceGraph — what happens if you act now', () => {
  const t = twin([agingHvac()], { maintenanceAlerts: [alert('hvac1', 'high')], jobs: [job('j1'), job('j2')], jobEquipmentLinks: [{ job_id: 'j1', equipment_id: 'hvac1', service_type: 'repair' }, { job_id: 'j2', equipment_id: 'hvac1', service_type: 'repair' }] });
  const g = computeHomeIntelligenceGraph(t, { now: NOW })!;
  const hvac = g.nodes.find((n) => n.id === 'sys:hvac')!;

  it('flags a neglected aging HVAC as high risk, above its typical-for-age baseline', () => {
    expect(hvac.level).toBe('high');
    expect(hvac.risk12m).toBeGreaterThanOrEqual(GRAPH_RISK_HIGH_12M);
    expect(hvac.risk12m).toBeGreaterThan(hvac.baselineRisk12m);
    expect(hvac.riskNextYear).toBeGreaterThan(hvac.risk12m);
  });

  it('explains the risk with ranked drivers', () => {
    const keys = hvac.drivers.map((d) => d.key);
    expect(keys).toContain('alerts');
    expect(keys).toContain('maintenance');
    expect(keys).toContain('repairs');
    const impacts = hvac.drivers.map((d) => d.impact);
    expect(impacts).toEqual([...impacts].sort((a, b) => b - a));
  });

  it('shows service reducing risk and cost, with an honest net figure', () => {
    const w = hvac.maintenance!;
    expect(w.riskAfter12m).toBeLessThan(w.riskBefore12m);
    expect(w.riskReduction).toBeCloseTo(w.riskBefore12m - w.riskAfter12m, 3);
    expect(w.expectedAvoided).toBeGreaterThan(0);
    expect(w.netBenefit).toBeCloseTo(w.expectedAvoided - w.serviceCost, 1);
    expect(w.recommended).toBe(true);
    expect(g.actNow).not.toBeNull();
    expect(g.actNow!.riskAfter12m).toBeLessThan(g.actNow!.riskBefore12m);
    expect(g.actions[0].nodeId).toBe('sys:hvac');
  });

  it('never assumes age or repair history away', () => {
    expect(hvac.maintenance!.riskAfter12m).toBeGreaterThan(hvac.baselineRisk12m * 0.99);
  });

  it('writes insights a homeowner can act on', () => {
    expect(g.insights.length).toBeGreaterThan(0);
    expect(g.insights[0].nodeId).toBe('sys:hvac');
    expect(g.insights[0].body).toContain('%');
  });
});

describe('computeHomeIntelligenceGraph — healthy and modelled-away cases', () => {
  it('offers no service promise for a young, serviced unit', () => {
    const g = computeHomeIntelligenceGraph(twin([eq({ id: 'h2', equipment_type: 'HVAC', install_date: yearsAgo(2), last_service_date: yearsAgo(0.2) })]), { now: NOW })!;
    const hvac = g.nodes.find((n) => n.id === 'sys:hvac')!;
    expect(hvac.level).toBe('low');
    expect(hvac.maintenance).toBeNull();
    expect(g.actNow).toBeNull();
  });

  it('lowers expected cost while a manufacturer warranty is active', () => {
    const base = { install_date: yearsAgo(13), last_service_date: yearsAgo(2.5) };
    const without = computeHomeIntelligenceGraph(twin([eq({ id: 'h', equipment_type: 'HVAC', ...base })]), { now: NOW })!;
    const withWarranty = computeHomeIntelligenceGraph(twin([eq({ id: 'h', equipment_type: 'HVAC', ...base, warranty_expires_at: yearsAhead(3) })]), { now: NOW })!;
    const a = without.nodes.find((n) => n.id === 'sys:hvac')!;
    const b = withWarranty.nodes.find((n) => n.id === 'sys:hvac')!;
    expect(b.risk12m).toBe(a.risk12m);
    expect(b.expectedLoss12m).toBeLessThan(a.expectedLoss12m);
    expect(b.warranty?.active).toBe(true);
    expect(a.warranty).toBeNull();
  });

  it('ignores replaced and removed units', () => {
    const g = computeHomeIntelligenceGraph(twin([agingHvac(), eq({ id: 'old', equipment_type: 'Furnace', status: 'replaced' })]), { now: NOW });
    expect(g!.nodes.some((n) => n.id === 'eq:old')).toBe(false);
  });
});

describe('energy behaviour', () => {
  it('reports no data, then insufficient data', () => {
    expect(analyzeEnergy([], NOW).state).toBe('none');
    const few = analyzeEnergy([{ period_start: '2026-05-01', energy_kwh: 900 }], NOW);
    expect(few.state).toBe('insufficient');
    expect(few.hvacMultiplier).toBe(1);
  });

  it('classifies year-over-year change', () => {
    expect(analyzeEnergy(energySeries(1000, 1000), NOW).state).toBe('normal');
    expect(analyzeEnergy(energySeries(1150, 1000), NOW).state).toBe('elevated');
    const high = analyzeEnergy(energySeries(1400, 1000), NOW);
    expect(high.state).toBe('high');
    expect(high.yoyChange).toBeCloseTo(0.4, 3);
    expect(high.hvacMultiplier).toBeGreaterThan(1);
  });

  it('ignores stale and future readings', () => {
    const stale = energySeries(1400, 1000).map((r) => ({ ...r, period_start: r.period_start.replace('2026-0', '2025-0').replace('2025-0', '2024-0') }));
    expect(analyzeEnergy(stale, NOW).hvacMultiplier).toBe(1);
    expect(analyzeEnergy([{ period_start: '2027-01-01', energy_kwh: 500 }], NOW).state).toBe('none');
  });

  it('raises HVAC risk only, and shows up as a driver', () => {
    const t = () => twin([agingHvac(), eq({ id: 'wh1', equipment_type: 'Water heater', expected_lifespan_years: 11 })]);
    const calm = computeHomeIntelligenceGraph(t(), { now: NOW })!;
    const hot = computeHomeIntelligenceGraph(t(), { now: NOW, energyReadings: energySeries(1400, 1000) })!;
    expect(hot.nodes.find((n) => n.id === 'sys:hvac')!.risk12m).toBeGreaterThan(calm.nodes.find((n) => n.id === 'sys:hvac')!.risk12m);
    expect(hot.nodes.find((n) => n.id === 'sys:water_heater')!.risk12m).toBe(calm.nodes.find((n) => n.id === 'sys:water_heater')!.risk12m);
    expect(hot.nodes.find((n) => n.id === 'sys:hvac')!.drivers.map((d) => d.key)).toContain('energy');
  });

  it('validates the add-a-reading form', () => {
    expect(validateEnergyInput('2026-05', '812.5', '', NOW)).toEqual({ ok: true, periodStart: '2026-05-01', energyKwh: 812.5, costUsd: null });
    expect(validateEnergyInput('2026-05', '812', '120.456', NOW)).toMatchObject({ ok: true, costUsd: 120.46 });
    expect(validateEnergyInput('', '812', '', NOW).ok).toBe(false);
    expect(validateEnergyInput('2026-13', '812', '', NOW).ok).toBe(false);
    expect(validateEnergyInput('2027-01', '812', '', NOW).ok).toBe(false);
    expect(validateEnergyInput('2026-05', '-5', '', NOW).ok).toBe(false);
    expect(validateEnergyInput('2026-05', 'abc', '', NOW).ok).toBe(false);
    expect(validateEnergyInput('2026-05', '812', '-1', NOW).ok).toBe(false);
  });
});

describe('data coverage', () => {
  it('is honest about missing inputs and improves as data is connected', () => {
    const sparse = computeHomeIntelligenceGraph(twin([eq({ id: 'h', equipment_type: 'HVAC', install_date: null, last_service_date: null })], {}, null), { now: NOW })!;
    const rich = computeHomeIntelligenceGraph(
      twin([agingHvac()], { jobs: [job('j1')], jobEquipmentLinks: [{ job_id: 'j1', equipment_id: 'hvac1', service_type: 'repair' }] }),
      { now: NOW, yearBuilt: 2004, energyReadings: energySeries(1000, 1000) },
    )!;
    expect(sparse.signals).toHaveLength(9);
    expect(sparse.signals.find((s) => s.key === 'equipment_age')!.state).toBe('missing');
    expect(sparse.signals.find((s) => s.key === 'home_age')!.improve).not.toBeNull();
    expect(rich.completenessPct).toBeGreaterThan(sparse.completenessPct);
    expect(rich.signals.find((s) => s.key === 'energy')!.state).toBe('connected');
    expect(rich.signals.find((s) => s.key === 'home_age')!.improve).toBeNull();
    expect(sparse.confidence).toBe('low');
  });
});
