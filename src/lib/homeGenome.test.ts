import { describe, it, expect } from 'vitest';
import type { Equipment, EquipmentMaintenanceAlert, Job } from '@/lib/supabase';
import type { PropertyTwin, PropertyTwinJobLink } from '@/lib/propertyTwin';
import type { HierarchySite } from '@/lib/siteHierarchy';
import type { EnergyReading } from '@/lib/homeIntelligenceGraph';
import { classifyJobKind, computeHomeGenome, detectComponent, validateGenomeEventInput, type ManualGenomeEvent } from './homeGenome';

const NOW = new Date('2026-06-15T12:00:00Z').getTime();
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const yearsAgo = (y: number) => new Date(NOW - y * YEAR_MS).toISOString();

function eq(over: Partial<Equipment> & { id: string; equipment_type: string }): Equipment {
  return {
    room_id: 'r1',
    user_id: 'u',
    customer_id: 'c',
    make: null,
    model: null,
    serial_number: null,
    install_date: '2018-05-01',
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

function job(id: string, date: string, serviceType: string, extra: Record<string, unknown> = {}): Job {
  return { id, job_status: 'completed', service_type: serviceType, scheduled_datetime: date, invoice_amount: null, diagnosis_notes: null, work_performed_notes: null, ...extra } as unknown as Job;
}

const link = (jobId: string, equipmentId: string): PropertyTwinJobLink => ({ job_id: jobId, equipment_id: equipmentId, service_type: null });

function twin(equipment: Equipment[] = [], extra: Partial<PropertyTwin> = {}): PropertyTwin {
  return {
    site: { id: 's1', name: 'Maple House', site_type: 'other', state: 'OH', buildings: [] } as unknown as HierarchySite,
    equipment,
    jobs: [],
    jobEquipmentLinks: [],
    maintenanceAlerts: [],
    ...extra,
  };
}

function energySeries(recent: number, prior: number, months = 3): EnergyReading[] {
  const out: EnergyReading[] = [];
  for (let i = 1; i <= months; i++) {
    out.push({ period_start: new Date(Date.UTC(2026, 5 - i, 1)).toISOString().slice(0, 10), energy_kwh: recent });
    out.push({ period_start: new Date(Date.UTC(2025, 5 - i, 1)).toISOString().slice(0, 10), energy_kwh: prior });
  }
  return out;
}

/** The example from the product brief: HVAC installed 2018, capacitor failure 2022, refrigerant issue 2024, repair 2025, abnormal energy 2026. */
function briefHome() {
  const hvac = eq({ id: 'hvac1', equipment_type: 'HVAC', make: 'Carrier', model: 'X1' });
  const jobs = [
    job('j1', '2022-03-10T15:00:00Z', 'Capacitor failure — no cooling', { invoice_amount: 320 }),
    job('j2', '2024-06-20T15:00:00Z', 'AC repair', { diagnosis_notes: 'Refrigerant leak at the service valve', invoice_amount: 540 }),
    job('j3', '2025-04-02T15:00:00Z', 'AC repair', { invoice_amount: 260 }),
    job('j4', '2023-04-01T15:00:00Z', 'Spring tune-up', { invoice_amount: 140 }),
  ];
  return twin([hvac], { jobs, jobEquipmentLinks: jobs.map((j) => link(j.id, 'hvac1')) });
}

describe('classifyJobKind', () => {
  it.each([
    ['Furnace replacement', '', 'replacement'],
    ['Water heater replacement', '', 'replacement'],
    ['Capacitor replacement', '', 'repair'],
    ['Replace air filter', '', 'maintenance'],
    ['New AC install', '', 'install'],
    ['Install smart thermostat', '', 'upgrade'],
    ['AC repair', '', 'repair'],
    ['AC repair', 'refrigerant leak found', 'failure'],
    ['No cooling emergency call', '', 'failure'],
    ['Annual maintenance', 'leak? none found', 'maintenance'],
    ['Safety inspection', '', 'inspection'],
    ['Service call', '', 'repair'],
    ['Service call', 'unit burst a line', 'failure'],
  ])('%s + "%s" → %s', (service, problem, expected) => {
    expect(classifyJobKind(service, problem)).toBe(expected);
  });

  it('never lets a part change reset the age of the whole unit', () => {
    const hv = eq({ id: 'h', equipment_type: 'HVAC', install_date: '2012-05-01' });
    const jobs = [job('a', '2026-03-01T12:00:00Z', 'Install smart thermostat'), job('b', '2026-04-01T12:00:00Z', 'Capacitor replacement')];
    const s = computeHomeGenome(twin([hv], { jobs, jobEquipmentLinks: jobs.map((j) => link(j.id, 'h')) }), { now: NOW })!.systems[0];
    expect(s.ageYears).toBeGreaterThan(14);
    expect(s.ageNote).toBeNull();
  });

  it('names the failing part when one is recognisable', () => {
    expect(detectComponent('Replaced start capacitor')).toBe('capacitor');
    expect(detectComponent('low charge, topped up R-410A')).toBe('refrigerant');
    expect(detectComponent('general check')).toBeNull();
  });
});

describe('computeHomeGenome — basics', () => {
  it('returns null without a property', () => {
    expect(computeHomeGenome({ ...twin(), site: null }, { now: NOW })).toBeNull();
  });

  it('gives an honest, empty genome for a property with no records', () => {
    const g = computeHomeGenome(twin(), { now: NOW })!;
    expect(g.systems).toEqual([]);
    expect(g.events).toEqual([]);
    expect(g.insights).toEqual([]);
    expect(g.depth.tier).toBe('seed');
    expect(g.depth.score).toBe(0);
    expect(g.layers.map((l) => l.key)).toEqual(['property', 'construction', 'systems', 'equipment', 'repairs', 'failures', 'maintenance', 'replacement', 'energy', 'cost', 'future_risk']);
    expect(g.future).toBeNull();
  });

  it('adds construction from a valid year built and ignores an invalid one', () => {
    const ok = computeHomeGenome(twin(), { now: NOW, yearBuilt: 1998 })!;
    expect(ok.events.map((e) => e.kind)).toEqual(['construction']);
    expect(ok.homeAgeYears).toBe(28);
    expect(computeHomeGenome(twin(), { now: NOW, yearBuilt: 1200 })!.events).toEqual([]);
  });

  it('is deterministic', () => {
    const t = briefHome();
    const opts = { now: NOW, yearBuilt: 2004, energyReadings: energySeries(1200, 1000) };
    expect(computeHomeGenome(t, opts)).toEqual(computeHomeGenome(t, opts));
  });
});

describe('computeHomeGenome — the brief’s HVAC story', () => {
  const g = computeHomeGenome(briefHome(), { now: NOW, yearBuilt: 2004, energyReadings: energySeries(1200, 1000) })!;
  const hvac = g.systems.find((s) => s.key === 'hvac')!;

  it('orders the history oldest first with the right kinds', () => {
    expect(hvac.events.map((e) => `${e.date.slice(0, 4)}:${e.kind}`)).toEqual(['2018:install', '2022:failure', '2023:maintenance', '2024:failure', '2025:repair', '2026:alert']);
    expect(hvac.counts).toMatchObject({ install: 1, failure: 2, repair: 1, maintenance: 1 });
  });

  it('recognises the failing parts', () => {
    expect(hvac.events.find((e) => e.date.startsWith('2022'))?.component).toBe('capacitor');
    expect(hvac.events.find((e) => e.date.startsWith('2024'))?.component).toBe('refrigerant');
  });

  it('notices repairs getting closer together and rising energy use', () => {
    expect(hvac.trend).toBe('accelerating');
    expect(hvac.signals.map((s) => s.key).sort()).toEqual(['accelerating_repairs', 'energy']);
    expect(hvac.status).toBe('watch');
  });

  it('concludes the system is nearing the end of its lifecycle although it is only about 8 years old', () => {
    expect(hvac.ageYears).toBeGreaterThan(8);
    expect(hvac.ageYears).toBeLessThan(8.2);
    expect(hvac.lifeUsed).toBeLessThan(0.6);
    expect(hvac.behaviorLifeUsed).toBeGreaterThanOrEqual(0.6);
    expect(hvac.effectiveAgeYears).toBeGreaterThan(hvac.ageYears as number);
    expect(hvac.endOfLife).toBe('approaching');
    expect(hvac.headline).toMatch(/approaching the end of its lifecycle/);
    expect(g.insights[0]).toMatchObject({ systemKey: 'hvac', severity: 'medium' });
    expect(g.totals.systemsNearingEnd).toBe(1);
  });

  it('tells the story as a chain ending in the verdict', () => {
    expect(hvac.storyline.map((s) => s.label)).toEqual(['Installed', 'Failure (capacitor)', 'Failure (refrigerant)', 'Repair', 'Abnormal behaviour', 'Nearing end of lifecycle']);
    expect(hvac.storyline.at(-1)?.year).toBeNull();
  });

  it('adds up what was spent and carries the graph’s forward-looking risk', () => {
    expect(hvac.lifetimeCost).toBe(1260);
    expect(hvac.future).not.toBeNull();
    expect(hvac.future!.risk12m).toBeGreaterThan(0);
    expect(g.future!.risk12m).toBeGreaterThan(0);
    expect(g.layers.find((l) => l.key === 'cost')?.value).toBe('$1,260');
  });

  it('is much calmer for the same unit with a clean record', () => {
    const calm = computeHomeGenome(twin([eq({ id: 'hvac1', equipment_type: 'HVAC' })]), { now: NOW })!.systems[0];
    expect(calm.status).toBe('normal');
    expect(calm.endOfLife).toBe('none');
    expect(calm.signals).toEqual([]);
  });
});

describe('computeHomeGenome — lifecycle rules', () => {
  it('flags a unit beyond its expected life', () => {
    const s = computeHomeGenome(twin([eq({ id: 'h', equipment_type: 'Furnace', install_date: yearsAgo(17) })]), { now: NOW })!.systems[0];
    expect(s.endOfLife).toBe('past');
    expect(s.phase).toBe('past_life');
    expect(s.signals.some((x) => x.key === 'past_life')).toBe(true);
  });

  it('does not judge age when the install date is only assumed', () => {
    const s = computeHomeGenome(twin([eq({ id: 'h', equipment_type: 'Furnace', install_date: null })]), { now: NOW })!.systems[0];
    expect(s.ageAssumed).toBe(true);
    expect(s.lifeUsed).toBeNull();
    expect(s.phase).toBe('unknown');
    expect(s.endOfLife).toBe('none');
    expect(s.ageNote).toMatch(/not used/);
  });

  it('counts age from a later recorded replacement instead of the old equipment record', () => {
    const manual: ManualGenomeEvent[] = [
      { id: 'm1', system_key: 'hvac', equipment_id: null, event_kind: 'replacement', occurred_on: '2023-06-15', title: 'New condenser and coil', note: null, cost_usd: 6200 },
    ];
    const s = computeHomeGenome(twin([eq({ id: 'h', equipment_type: 'HVAC', install_date: '2008-01-01' })]), { now: NOW, manualEvents: manual })!.systems[0];
    expect(s.ageYears).toBeCloseTo(3, 0);
    expect(s.ageNote).toMatch(/replacement recorded on 2023-06-15/);
    expect(s.endOfLife).toBe('none');
  });

  it('applies the repair-versus-replace rule', () => {
    const wh = eq({ id: 'w', equipment_type: 'Water heater', install_date: yearsAgo(7), expected_lifespan_years: 11 });
    const jobs = [job('a', yearsAgo(1), 'Water heater repair', { invoice_amount: 500 }), job('b', yearsAgo(0.5), 'Water heater repair', { invoice_amount: 500 })];
    const s = computeHomeGenome(twin([wh], { jobs, jobEquipmentLinks: jobs.map((j) => link(j.id, 'w')) }), { now: NOW })!.systems[0];
    expect(s.repairSpend36m).toBe(1000);
    expect(s.signals.some((x) => x.key === 'repair_vs_replace')).toBe(true);
    expect(s.endOfLife).not.toBe('none');
  });

  it('flags a repeating part', () => {
    const hv = eq({ id: 'h', equipment_type: 'HVAC' });
    const jobs = [job('a', '2024-01-10T12:00:00Z', 'Capacitor replacement repair'), job('b', '2025-01-10T12:00:00Z', 'AC repair — bad capacitor')];
    const s = computeHomeGenome(twin([hv], { jobs, jobEquipmentLinks: jobs.map((j) => link(j.id, 'h')) }), { now: NOW })!.systems[0];
    expect(s.signals.find((x) => x.key === 'repeat_component')?.title).toMatch(/capacitor/);
  });
});

describe('computeHomeGenome — data handling', () => {
  it('ignores cancelled, unscheduled and future jobs', () => {
    const hv = eq({ id: 'h', equipment_type: 'HVAC' });
    const jobs = [
      job('a', '2025-01-10T12:00:00Z', 'AC repair', { job_status: 'cancelled' }),
      job('b', null as unknown as string, 'AC repair'),
      job('c', '2027-01-10T12:00:00Z', 'AC repair'),
      job('d', '2025-02-10T12:00:00Z', 'AC repair'),
    ];
    const s = computeHomeGenome(twin([hv], { jobs, jobEquipmentLinks: jobs.map((j) => link(j.id, 'h')) }), { now: NOW })!.systems[0];
    expect(s.events.filter((e) => e.source === 'job').map((e) => e.id)).toEqual(['job:d:hvac']);
  });

  it('splits one invoice across the systems a job touched', () => {
    const jobs = [job('a', '2025-02-10T12:00:00Z', 'Maintenance visit', { invoice_amount: 200 })];
    const t = twin([eq({ id: 'h', equipment_type: 'HVAC' }), eq({ id: 'w', equipment_type: 'Water heater' })], { jobs, jobEquipmentLinks: [link('a', 'h'), link('a', 'w')] });
    const g = computeHomeGenome(t, { now: NOW })!;
    expect(g.systems.map((s) => s.lifetimeCost)).toEqual([100, 100]);
    expect(g.totals.lifetimeCost).toBe(200);
    expect(g.totals.jobsContributing).toBe(1);
  });

  it('puts unclassifiable work on the whole home', () => {
    const g = computeHomeGenome(twin([], { jobs: [job('a', '2025-02-10T12:00:00Z', 'Handyman visit')] }), { now: NOW })!;
    expect(g.homeEvents).toHaveLength(1);
    expect(g.systems).toEqual([]);
  });

  it('keeps one install when the equipment record and a recorded install describe the same unit', () => {
    const manual: ManualGenomeEvent[] = [{ id: 'm', system_key: 'hvac', equipment_id: 'h', event_kind: 'install', occurred_on: '2018-05-10', title: 'Installed by Acme', note: null, cost_usd: 7200 }];
    const s = computeHomeGenome(twin([eq({ id: 'h', equipment_type: 'HVAC', install_date: '2018-05-01' })]), { now: NOW, manualEvents: manual })!.systems[0];
    const installs = s.events.filter((e) => e.kind === 'install');
    expect(installs).toHaveLength(1);
    expect(installs[0].source).toBe('manual');
    expect(s.lifetimeCost).toBe(7200);
  });

  it('keeps a recorded event for a system that has no equipment record', () => {
    const manual: ManualGenomeEvent[] = [{ id: 'm', system_key: 'roof', equipment_id: null, event_kind: 'repair', occurred_on: '2020-03-01', title: 'Storm damage patched', note: null, cost_usd: 900 }];
    const g = computeHomeGenome(twin(), { now: NOW, manualEvents: manual })!;
    expect(g.systems.map((s) => s.key)).toEqual(['roof']);
    expect(g.systems[0].future).toBeNull();
  });

  it('lists upcoming warranty ends and replacement windows', () => {
    const hv = eq({ id: 'h', equipment_type: 'HVAC', install_date: yearsAgo(13), warranty_expires_at: new Date(NOW + 6 * 30.4375 * 24 * 3600 * 1000).toISOString() });
    const g = computeHomeGenome(twin([hv]), { now: NOW })!;
    expect(g.forecast.map((f) => f.kind)).toContain('warranty_end');
    expect(g.forecast.map((f) => f.kind)).toContain('replacement_window');
    expect([...g.forecast].sort((a, b) => a.inMonths - b.inMonths)).toEqual(g.forecast);
  });

  it('turns open alerts into warning signs and ignores dismissed ones', () => {
    const hv = eq({ id: 'h', equipment_type: 'HVAC' });
    const mk = (id: string, dismissed: boolean): EquipmentMaintenanceAlert => ({
      id,
      user_id: 'u',
      equipment_id: 'h',
      risk_level: 'high',
      predicted_issue: 'Compressor amperage trending up',
      recommended_action: 'Inspect the compressor.',
      predicted_service_due: null,
      is_dismissed: dismissed,
      metric_snapshot: null,
      created_at: '2026-05-01T00:00:00Z',
    });
    const s = computeHomeGenome(twin([hv], { maintenanceAlerts: [mk('a1', false), mk('a2', true)] }), { now: NOW })!.systems[0];
    expect(s.events.filter((e) => e.kind === 'alert')).toHaveLength(1);
    expect(s.signals.find((x) => x.key === 'open_alerts')?.severity).toBe('high');
    expect(s.status).toBe('abnormal');
  });
});

describe('genome depth — the data moat', () => {
  it('grows as the home’s record grows', () => {
    const bare = computeHomeGenome(twin([eq({ id: 'h', equipment_type: 'HVAC' })]), { now: NOW })!.depth.score;
    const withHistory = computeHomeGenome(briefHome(), { now: NOW, yearBuilt: 2004 })!.depth.score;
    const withEnergy = computeHomeGenome(briefHome(), { now: NOW, yearBuilt: 2004, energyReadings: energySeries(1000, 1000, 6) })!.depth.score;
    expect(withHistory).toBeGreaterThan(bare);
    expect(withEnergy).toBeGreaterThan(withHistory);
    expect(withEnergy).toBeLessThanOrEqual(100);
  });

  it('says what to record next, biggest gap first', () => {
    const d = computeHomeGenome(twin([eq({ id: 'h', equipment_type: 'HVAC', install_date: null })]), { now: NOW })!.depth;
    expect(d.nextSteps.length).toBeGreaterThan(0);
    expect(d.nextSteps.length).toBeLessThanOrEqual(3);
    expect(d.parts.reduce((a, p) => a + p.score, 0)).toBe(d.score);
  });
});

describe('validateGenomeEventInput', () => {
  const units = [{ id: 'h', equipment_type: 'HVAC', make: null, model: null }];
  const ok = { target: 'eq:h', kind: 'repair', date: '2024-05-05', title: 'Capacitor replaced', note: '', cost: '' };

  it('accepts a unit-level event and derives its system', () => {
    const r = validateGenomeEventInput(ok, units, NOW);
    expect(r).toEqual({ ok: true, value: { system_key: 'hvac', equipment_id: 'h', event_kind: 'repair', occurred_on: '2024-05-05', title: 'Capacitor replaced', note: null, cost_usd: null } });
  });

  it('accepts a system-level or whole-home event with a cost', () => {
    const r = validateGenomeEventInput({ ...ok, target: 'sys:roof', cost: '1250.456' }, units, NOW);
    expect(r.ok && r.value).toMatchObject({ system_key: 'roof', equipment_id: null, cost_usd: 1250.46 });
    expect(validateGenomeEventInput({ ...ok, target: 'sys:home' }, units, NOW).ok).toBe(true);
  });

  it.each([
    [{ target: 'eq:other' }, 'target'],
    [{ target: 'sys:garage' }, 'target'],
    [{ target: '' }, 'target'],
    [{ kind: 'explosion' }, 'kind'],
    [{ date: '' }, 'date'],
    [{ date: '2026-02-30' }, 'date'],
    [{ date: '2026-12-31' }, 'date'],
    [{ date: '1850-01-01' }, 'date'],
    [{ title: ' a ' }, 'title'],
    [{ title: 'x'.repeat(121) }, 'title'],
    [{ note: 'x'.repeat(1001) }, 'note'],
    [{ cost: '-5' }, 'cost'],
    [{ cost: 'abc' }, 'cost'],
  ])('rejects %j', (patch, field) => {
    const r = validateGenomeEventInput({ ...ok, ...patch }, units, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe(field);
  });
});
