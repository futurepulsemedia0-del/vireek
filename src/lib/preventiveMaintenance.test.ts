import { describe, expect, it } from 'vitest';
import type { TeamMember } from '@/lib/supabase';
import {
  PM_DEFAULT_SETTINGS,
  addMonthsIso,
  buildCandidates,
  describeAssignment,
  describeScheduleError,
  kitOnTruckByTechnician,
  nextServiceDue,
  normalizeSettings,
  planParts,
  priorityOf,
  rankTechnicians,
  recommendedVisitDate,
  scoreSignals,
  seasonFamily,
  seasonalNeed,
  summarize,
  wantedParts,
  type PmContract,
  type PmEquipment,
  type PmForecast,
  type PmInput,
  type PmLifecycleAlert,
  type PmSignal,
  type PmWorkItem,
} from './preventiveMaintenance';

// Wednesday 7 Oct 2026, local noon (no "Z": the app derives "today" from local date parts).
const NOW = new Date('2026-10-07T12:00:00');

const eq = (over: Partial<PmEquipment> = {}): PmEquipment => ({
  id: 'e1',
  customer_id: 'c1',
  equipment_type: 'Water Heater',
  make: 'Rheem',
  model: 'X1',
  serial_number: null,
  install_date: '2020-01-01',
  warranty_expires_at: null,
  expected_lifespan_years: 12,
  service_interval_months: 12,
  last_service_date: '2025-06-01',
  ...over,
});

const customer = { id: 'c1', name: 'Ada Lovelace', phone: '+15550001111', email: 'ada@example.com', address: '1 Main St', customer_type: 'residential' as const };

const input = (over: Partial<PmInput> = {}): PmInput => ({
  equipment: [eq()],
  customers: [customer],
  alerts: [],
  forecasts: [],
  contracts: [],
  workItems: [],
  settings: PM_DEFAULT_SETTINGS,
  now: NOW,
  ...over,
});

const kinds = (c: { signals: PmSignal[] }) => c.signals.map((s) => s.kind);

const workItem = (over: Partial<PmWorkItem> = {}): PmWorkItem => ({
  id: 'w1',
  equipment_id: 'e1',
  status: 'planned',
  signals: [],
  priority_score: 0,
  due_by: null,
  snoozed_until: null,
  job_id: null,
  technician_id: null,
  scheduled_at: null,
  assignment_status: null,
  parts_status: 'none',
  parts_detail: [],
  notified_at: null,
  notified_channel: null,
  notify_error: null,
  completed_at: null,
  dismissed_at: null,
  ...over,
});

describe('date helpers', () => {
  it('clamps month arithmetic to the last day of the target month', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonthsIso('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonthsIso('garbage', 3)).toBeNull();
  });

  it('computes the next service from last service, else install date', () => {
    expect(nextServiceDue({ last_service_date: '2025-06-01', install_date: '2020-01-01', service_interval_months: 12 })).toBe('2026-06-01');
    expect(nextServiceDue({ last_service_date: null, install_date: '2020-01-01', service_interval_months: 6 })).toBe('2020-07-01');
    expect(nextServiceDue({ last_service_date: null, install_date: null, service_interval_months: 12 })).toBeNull();
  });
});

describe('signal derivation', () => {
  it('flags overdue service and scales weight with lateness', () => {
    const [c] = buildCandidates(input());
    expect(kinds(c)).toEqual(['overdue']);
    expect(c.signals[0].weight).toBe(60);
    expect(c.priority).toBe('high');
    expect(c.daysToDue).toBeLessThan(0);
  });

  it('flags upcoming service inside the due-soon window only', () => {
    const inside = buildCandidates(input({ equipment: [eq({ last_service_date: '2025-11-20' })] }));
    expect(kinds(inside[0])).toEqual(['upcoming']);
    expect(inside[0].priority).toBe('low');
    const outside = buildCandidates(input({ equipment: [eq({ last_service_date: '2026-03-01' })] }));
    expect(outside).toHaveLength(0);
  });

  it('records a data gap instead of guessing when there is no baseline date', () => {
    const none = buildCandidates(input({ equipment: [eq({ last_service_date: null, install_date: null, warranty_expires_at: '2026-11-01' })] }));
    expect(none[0].dataGaps).toHaveLength(1);
    expect(kinds(none[0])).toEqual(['warranty']);
  });

  it('flags a warranty that is about to expire and stays quiet for a distant one', () => {
    const soon = buildCandidates(input({ equipment: [eq({ last_service_date: '2026-09-01', warranty_expires_at: '2026-11-01' })] }));
    expect(kinds(soon[0])).toEqual(['warranty']);
    expect(soon[0].signals[0].weight).toBe(35);
    const far = buildCandidates(input({ equipment: [eq({ last_service_date: '2026-09-01', warranty_expires_at: '2030-01-01' })] }));
    expect(far).toHaveLength(0);
  });

  it('warns when an active warranty coexists with overdue service', () => {
    const [c] = buildCandidates(input({ equipment: [eq({ warranty_expires_at: '2030-01-01' })] }));
    expect(kinds(c)).toContain('warranty');
    expect(kinds(c)).toContain('overdue');
  });

  const contract: PmContract = {
    id: 'k1',
    customer_id: 'c1',
    contract_name: 'Gold Plan',
    contract_type: 'maintenance_contract',
    status: 'active',
    start_date: '2026-01-01',
    end_date: '2026-12-01',
  };

  it('flags a visit owed under a live maintenance contract, urgent near term end', () => {
    const [c] = buildCandidates(input({ equipment: [eq({ last_service_date: '2025-06-01' })], contracts: [contract] }));
    const s = c.signals.find((x) => x.kind === 'contract');
    expect(s?.weight).toBe(45);
    expect(s?.deadline).toBe('2026-12-01');
  });

  it('ignores non-maintenance and other-customer contracts', () => {
    const other = { ...contract, customer_id: 'c2' };
    const msa = { ...contract, contract_type: 'msa' };
    const [c] = buildCandidates(input({ contracts: [other, msa] }));
    expect(kinds(c)).not.toContain('contract');
  });

  it('flags seasonal tune-ups by equipment family and hemisphere', () => {
    expect(seasonFamily('Water Heater')).toBeNull();
    expect(seasonFamily('Furnace')).toBe('heating');
    expect(seasonFamily('AC Condenser')).toBe('cooling');
    expect(seasonFamily('HVAC')).toBe('both');
    expect(seasonFamily('Heat Pump')).toBe('both');

    const north = seasonalNeed({ equipment_type: 'Furnace', last_service_date: null }, '2026-10-07', 'north');
    expect(north?.season).toBe('heating');
    expect(north?.windowEnd).toBe('2026-11-30');
    expect(seasonalNeed({ equipment_type: 'Furnace', last_service_date: null }, '2026-10-07', 'south')).toBeNull();
    expect(seasonalNeed({ equipment_type: 'HVAC', last_service_date: null }, '2026-10-07', 'south')?.season).toBe('cooling');
    expect(seasonalNeed({ equipment_type: 'Furnace', last_service_date: '2026-08-01' }, '2026-10-07', 'north')).toBeNull();
    expect(seasonalNeed({ equipment_type: 'Furnace', last_service_date: null }, '2026-07-07', 'north')).toBeNull();
  });

  it('respects the seasonal switch', () => {
    const e = eq({ equipment_type: 'Furnace', last_service_date: '2026-03-01' });
    expect(kinds(buildCandidates(input({ equipment: [e] }))[0])).toEqual(['seasonal']);
    expect(buildCandidates(input({ equipment: [e], settings: { ...PM_DEFAULT_SETTINGS, seasonal_enabled: false } }))).toHaveLength(0);
  });

  it('flags high failure risk from forecasts and lifecycle alerts', () => {
    const forecast: PmForecast = {
      id: 'f1', equipment_id: 'e1', probability: 0.6, band: 'high', top_mode_label: 'Capacitor failure',
      horizon_days: 90, status: 'open', exposure_cents: 25000, recommended: { label: 'Replace run capacitor', parts: ['Run capacitor'], estMinutes: 45 },
    };
    const highAlert: PmLifecycleAlert = { id: 'a1', equipment_id: 'e1', risk_level: 'high', predicted_issue: 'Past expected life', recommended_action: null, predicted_service_due: null };
    const medAlert: PmLifecycleAlert = { ...highAlert, id: 'a2', risk_level: 'medium', predicted_issue: 'Repairs accelerating' };

    const fresh = eq({ last_service_date: '2026-09-01' });
    const [c] = buildCandidates(input({ equipment: [fresh], forecasts: [forecast], alerts: [highAlert, medAlert] }));
    expect(kinds(c)).toEqual(['high_risk', 'high_risk']);
    expect(c.context).toHaveLength(1);
    expect(c.visitMinutes).toBe(45);

    const belowThreshold = { ...forecast, band: 'low' as const, probability: 0.1 };
    expect(buildCandidates(input({ equipment: [fresh], forecasts: [belowThreshold] }))).toHaveLength(0);
  });
});

describe('scoring and priority', () => {
  const sig = (kind: PmSignal['kind'], weight: number): PmSignal => ({ kind, label: kind, detail: '', weight, deadline: null });

  it('halves each additional signal kind and caps at 100', () => {
    expect(scoreSignals([sig('overdue', 60), sig('contract', 45), sig('warranty', 35)])).toBe(91);
    expect(scoreSignals([sig('overdue', 60), sig('overdue', 55)])).toBe(60);
    expect(scoreSignals([sig('overdue', 100), sig('contract', 100)])).toBe(100);
    expect(scoreSignals([])).toBe(0);
  });

  it('maps score to priority bands', () => {
    expect(priorityOf(75)).toBe('critical');
    expect(priorityOf(74)).toBe('high');
    expect(priorityOf(55)).toBe('high');
    expect(priorityOf(35)).toBe('medium');
    expect(priorityOf(34)).toBe('low');
  });

  it('sorts the queue by score', () => {
    const list = buildCandidates(
      input({
        equipment: [eq({ id: 'low', last_service_date: '2025-11-20' }), eq({ id: 'high' })],
      }),
    );
    expect(list.map((c) => c.equipmentId)).toEqual(['high', 'low']);
  });
});

describe('queue state', () => {
  it('hides recently dismissed units but resurfaces them after 90 days', () => {
    const recent = workItem({ status: 'dismissed', dismissed_at: '2026-09-20T10:00:00Z' });
    const old = workItem({ status: 'dismissed', dismissed_at: '2026-05-01T10:00:00Z' });
    expect(buildCandidates(input({ workItems: [recent] }))).toHaveLength(0);
    expect(buildCandidates(input({ workItems: [old] }))).toHaveLength(1);
  });

  it('hides snoozed units until the snooze date', () => {
    expect(buildCandidates(input({ workItems: [workItem({ status: 'snoozed', snoozed_until: '2026-10-20' })] }))).toHaveLength(0);
    expect(buildCandidates(input({ workItems: [workItem({ status: 'snoozed', snoozed_until: '2026-10-01' })] }))).toHaveLength(1);
  });

  it('keeps scheduled units visible even when no signal remains, and summarizes separately', () => {
    const fresh = eq({ last_service_date: '2026-10-01' });
    const scheduled = workItem({ status: 'scheduled', job_id: 'j1' });
    const list = buildCandidates(input({ equipment: [fresh, eq({ id: 'e2' })], workItems: [scheduled] }));
    expect(list).toHaveLength(2);
    const s = summarize(list);
    expect(s.scheduled).toBe(1);
    expect(s.total).toBe(1);
    expect(s.byKind.overdue).toBe(1);
  });
});

describe('visit date recommendation', () => {
  const base = { signals: [] as PmSignal[], priority: 'low' as const, nextDue: null as string | null, forecast: null };

  it('goes to the next weekday when critical or already past a deadline', () => {
    expect(recommendedVisitDate({ ...base, priority: 'critical' }, '2026-10-07')).toBe('2026-10-08');
    expect(recommendedVisitDate({ ...base, priority: 'critical' }, '2026-10-09')).toBe('2026-10-12'); // Fri -> Mon
    const past: PmSignal = { kind: 'overdue', label: '', detail: '', weight: 40, deadline: '2026-09-01' };
    expect(recommendedVisitDate({ ...base, signals: [past] }, '2026-10-07')).toBe('2026-10-08');
  });

  it('aims a week before the earliest deadline', () => {
    const s: PmSignal = { kind: 'warranty', label: '', detail: '', weight: 25, deadline: '2026-11-20' };
    expect(recommendedVisitDate({ ...base, signals: [s] }, '2026-10-07')).toBe('2026-11-13');
  });

  it('pulls forward for critical failure forecasts', () => {
    const f = { band: 'critical' } as PmForecast;
    expect(recommendedVisitDate({ ...base, forecast: f, nextDue: '2027-03-01' }, '2026-10-07')).toBe('2026-10-14');
  });
});

describe('technician recommendation', () => {
  const tech = (id: string, skills: string[], over: Partial<TeamMember> = {}) =>
    ({ id, role: 'technician', dispatch_enabled: true, member_name: id, skills, service_area: null, max_jobs_per_day: 6, ...over }) as unknown as TeamMember;
  const candidate = { equipment: eq({ equipment_type: 'Heat Pump' }), customer };
  const when = '2026-10-08T09:00:00.000Z';

  it('matches skills fuzzily, rewards continuity and a stocked truck, and respects capacity', () => {
    const full = Array.from({ length: 6 }, () => ({ scheduled_datetime: when }));
    const ranked = rankTechnicians({
      candidate,
      scheduledAtIso: when,
      technicians: [tech('a', ['Plumbing']), tech('b', ['Heat Pump Install']), tech('c', ['Plumbing']), tech('d', ['Heat Pump'])],
      jobsByTechnician: { c: full },
      lastTechnicianId: 'a',
      kitOnTruck: { d: true },
    });
    expect(ranked.map((r) => r.technician.id)).not.toContain('c'); // at capacity
    expect(ranked[0].technician.id).toBe('d');
    const b = ranked.find((r) => r.technician.id === 'b');
    expect(b?.reasons.some((x) => x.startsWith('Skills cover'))).toBe(true);
    const a = ranked.find((r) => r.technician.id === 'a');
    expect(a?.reasons).toContain('Serviced this unit before');
  });
});

describe('parts planning', () => {
  const parts = [
    { id: 'p1', name: 'Air filter 20x25', part_number: 'AF-2025' },
    { id: 'p2', name: 'Water heater anode', part_number: 'AN-1' },
    { id: 'p3', name: 'Run Capacitor 45/5', part_number: 'RC-45' },
  ];
  const kits = [
    { service_type: 'HVAC Tune-Up', part_id: 'p1', quantity: 2 },
    { service_type: 'Water Heater Repair', part_id: 'p2', quantity: 1 },
  ];
  const locations = [
    { id: 'van1', name: 'Van 1', location_type: 'van', assigned_technician_id: 't1' },
    { id: 'wh', name: 'Warehouse', location_type: 'warehouse', assigned_technician_id: null },
  ];

  it('derives wanted parts from matching kits and forecast-recommended names', () => {
    const wanted = wantedParts({ kits, parts, equipmentType: 'HVAC', forecastPartNames: ['Run capacitor'] });
    expect(wanted).toEqual([
      { part_id: 'p1', quantity: 2 },
      { part_id: 'p3', quantity: 1 },
    ]);
  });

  it('prefers the technician truck, then the warehouse, and flags shortages', () => {
    const stock = [
      { part_id: 'p1', location_id: 'van1', location_name: 'Van 1', location_type: 'van', quantity_available: 3 },
      { part_id: 'p3', location_id: 'wh', location_name: 'Warehouse', location_type: 'warehouse', quantity_available: 0 },
    ];
    const wanted = [{ part_id: 'p1', quantity: 2 }, { part_id: 'p3', quantity: 1 }];
    const lines = planParts({ wanted, parts, stock, locations, technicianId: 't1' });
    expect(lines[0].source).toBe('on_truck');
    expect(lines[1].source).toBe('short');
    expect(lines[1].location_id).toBe('wh');

    const noTruck = planParts({ wanted: [{ part_id: 'p1', quantity: 2 }], parts, stock, locations, technicianId: 't2' });
    expect(noTruck[0].source).toBe('other_location'); // only stock is on another technician's truck: needs a transfer

    const stockWh = [{ part_id: 'p1', location_id: 'wh', location_name: 'Warehouse', location_type: 'warehouse', quantity_available: 5 }];
    expect(planParts({ wanted: [{ part_id: 'p1', quantity: 2 }], parts, stock: stockWh, locations, technicianId: 't1' })[0].source).toBe('warehouse');
  });

  it('knows which technicians already carry the whole kit', () => {
    const stock = [{ part_id: 'p1', location_id: 'van1', location_name: 'Van 1', location_type: 'van', quantity_available: 2 }];
    expect(kitOnTruckByTechnician({ wanted: [{ part_id: 'p1', quantity: 2 }], stock, locations })).toEqual({ t1: true });
    expect(kitOnTruckByTechnician({ wanted: [{ part_id: 'p1', quantity: 3 }], stock, locations })).toEqual({ t1: false });
    expect(kitOnTruckByTechnician({ wanted: [], stock, locations })).toEqual({});
  });
});

describe('settings and messages', () => {
  it('clamps settings to the database check ranges', () => {
    const s = normalizeSettings({ due_soon_days: 1000, risk_threshold: 0, default_visit_minutes: 1, hemisphere: 'south' });
    expect(s.due_soon_days).toBe(180);
    expect(s.risk_threshold).toBe(0.05);
    expect(s.default_visit_minutes).toBe(15);
    expect(s.hemisphere).toBe('south');
    expect(normalizeSettings(null)).toEqual(PM_DEFAULT_SETTINGS);
  });

  it('turns database error codes into plain language', () => {
    expect(describeScheduleError(new Error('ALREADY_SCHEDULED'))).toContain('already has an open');
    expect(describeScheduleError({ message: 'CUSTOMER_NOT_FOUND' })).toContain('no customer');
    expect(describeScheduleError(new Error('boom'))).toContain('Could not schedule');
  });

  it('explains assignment outcomes', () => {
    expect(describeAssignment('assigned').ok).toBe(true);
    expect(describeAssignment('at_capacity').ok).toBe(false);
    expect(describeAssignment(undefined).text).toContain('without a technician');
  });
});
