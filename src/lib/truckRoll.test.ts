import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  DEFAULT_TRUCK_ROLL_SETTINGS,
  buildMediaRequestMessage,
  evaluateTruckRolls,
  isEmergency,
  isPlannedWork,
  matchRemotePattern,
  smsHref,
  summarizeTruckRolls,
  weightedReadiness,
} from './truckRoll';
import type { ActionRow, Gate, JobExtra, TruckRollContext } from './truckRoll';
import { DEFAULT_SETTINGS } from './outcomeAssurance';
import type { AssuranceJob, AssuranceTechnician, OutcomeRow } from './outcomeAssurance';

const NOW = new Date('2026-10-01T08:00:00Z').getTime();
const HOUR = 3600000;

function job(id: string, over: Partial<AssuranceJob> = {}): AssuranceJob {
  return {
    id,
    customer_name: `Customer ${id}`,
    service_type: 'AC Repair',
    scheduled_datetime: new Date(NOW + 30 * HOUR).toISOString(),
    duration_minutes: 90,
    assigned_technician_id: 't1',
    job_status: 'scheduled',
    customer_type: 'residential',
    sla_response_hours: null,
    is_rework: false,
    diagnosis_notes: null,
    ...over,
  };
}

function tech(id: string, over: Partial<AssuranceTechnician> = {}): AssuranceTechnician {
  return { id, name: `Tech ${id}`, skills: ['ac repair'], max_jobs_per_day: 6, dispatch_enabled: true, ...over };
}

function outcomes(n: number): OutcomeRow[] {
  return Array.from({ length: n }, (_, i) => ({
    job_id: `o-${i}`,
    job_type_key: 'ac_repair',
    resolution: 'fixed_first_visit',
    duration_minutes: 90,
    is_rework: false,
    caused_callback: false,
    technician_id: 't1',
  }));
}

function extra(id: string, over: Partial<JobExtra> = {}): JobExtra {
  return { id, address: '12 Oak Street', customer_id: 'c1', site_id: null, notes: null, tags: [], ...over };
}

function action(jobId: string, kind: ActionRow['kind'], over: Partial<ActionRow> = {}): ActionRow {
  return { id: `a-${jobId}-${kind}-${Math.random()}`, job_id: jobId, kind, service_type: 'AC Repair', note: null, created_at: new Date(NOW - HOUR).toISOString(), ...over };
}

function ctx(over: Partial<TruckRollContext> = {}, jobs = [job('j1')]): TruckRollContext {
  return {
    assurance: { now: NOW, jobs, technicians: [tech('t1'), tech('t2')], parts: [], briefs: [], outcomes: [], credentials: [], rules: [] },
    extras: Object.fromEntries(jobs.map((j) => [j.id, extra(j.id)])),
    evidence: [],
    sites: [],
    customers: [{ id: 'c1', phone: '+15550001111' }],
    actions: [],
    ...over,
  };
}

function run(c: TruckRollContext, settings = DEFAULT_TRUCK_ROLL_SETTINGS) {
  return evaluateTruckRolls(c, DEFAULT_SETTINGS, settings);
}

/** A job with everything in order: evidence, media, part, access, history. */
function strongCtx(): TruckRollContext {
  const j = job('j1', { diagnosis_notes: 'Carrier 3 ton unit, 8 years old, capacitor bulging and compressor hard-starting.' });
  const c = ctx({}, [j]);
  c.assurance.parts = [{ job_id: 'j1', part_name: 'Capacitor', quantity_required: 1, shortage_quantity: 0, readiness_status: 'ready' }];
  c.assurance.briefs = [{ job_id: 'j1', confidence: 0.92, risk_flag_count: 0, predicted_issue: 'Failed run capacitor' }];
  c.assurance.outcomes = outcomes(40);
  c.evidence = [{ job_id: 'j1', stage: 'evidence', kind: 'media', actor_type: 'customer' }];
  c.actions = [action('j1', 'access_confirmed')];
  return c;
}

describe('classifiers', () => {
  it('detects emergencies but not a chirping detector', () => {
    expect(isEmergency('customer reports a gas smell in the kitchen')).toBe(true);
    expect(isEmergency('burst pipe flooding the basement')).toBe(true);
    expect(isEmergency('smoke detector chirping low battery')).toBe(false);
    expect(isEmergency('regular visit', ['Emergency'])).toBe(true);
  });

  it('treats installs and tune-ups as planned work but repairs never', () => {
    expect(isPlannedWork('AC Tune-up')).toBe(true);
    expect(isPlannedWork('House Cleaning')).toBe(true);
    expect(isPlannedWork('Water heater replacement')).toBe(true);
    expect(isPlannedWork('AC Repair')).toBe(false);
    expect(isPlannedWork('Drain cleaning')).toBe(false);
    expect(isPlannedWork(null)).toBe(false);
  });

  it('matches safe remote patterns', () => {
    expect(matchRemotePattern('thermostat is blank')?.id).toBe('hvac_thermostat');
    expect(matchRemotePattern('toilet keeps running')?.id).toBe('plumb_toilet_run');
    expect(matchRemotePattern('compressor seized')).toBeNull();
  });
});

describe('verdicts', () => {
  it('clears a fully prepared job to dispatch', () => {
    const [row] = run(strongCtx());
    expect(row?.verdict).toBe('dispatch');
    expect(row?.gates.find((g) => g.key === 'evidence')?.status).toBe('pass');
    expect(row?.gates.find((g) => g.key === 'part')?.status).toBe('pass');
    expect(row?.gates.find((g) => g.key === 'access')?.status).toBe('pass');
  });

  it('says DO NOT DISPATCH when evidence, part, access and history are missing', () => {
    const [row] = run(ctx({ customers: [] }));
    expect(row?.verdict).toBe('hold');
    expect(row?.reasons.length).toBeGreaterThan(0);
    expect(row?.avoidableCost).toBeGreaterThan(0);
    expect(row?.gates.find((g) => g.key === 'media')?.status).toBe('fail');
  });

  it('holds a job with no technician', () => {
    const c = strongCtx();
    c.assurance.jobs = [job('j1', { assigned_technician_id: null, diagnosis_notes: c.assurance.jobs[0]?.diagnosis_notes ?? null })];
    const [row] = run(c);
    expect(row?.verdict).toBe('hold');
    expect(row?.gates.find((g) => g.key === 'technician')?.status).toBe('fail');
  });

  it('holds a double-booked technician', () => {
    const c = strongCtx();
    const first = c.assurance.jobs[0] as AssuranceJob;
    c.assurance.jobs = [first, job('j2', { scheduled_datetime: first.scheduled_datetime })];
    c.extras['j2'] = extra('j2');
    const rows = run(c);
    const j1 = rows.find((r) => r.job.id === 'j1');
    expect(j1?.gates.find((g) => g.key === 'technician')?.status).toBe('fail');
  });

  it('recommends remote-first for a blank thermostat when the customer is reachable', () => {
    const [row] = run(ctx({}, [job('j1', { service_type: 'HVAC Repair', diagnosis_notes: 'Thermostat is blank, no display' })]));
    expect(row?.verdict).toBe('remote_first');
    expect(row?.remotePattern?.steps.length).toBeGreaterThan(0);
    expect(row?.actions[0]?.kind).toBe('try_remote');
    expect(row?.avoidableCost).toBeGreaterThan(0);
  });

  it('does not recommend remote when the customer cannot be reached', () => {
    const [row] = run(ctx({ customers: [] }, [job('j1', { service_type: 'HVAC Repair', diagnosis_notes: 'Thermostat is blank, no display' })]));
    expect(row?.verdict).not.toBe('remote_first');
  });

  it('stops recommending remote after a failed attempt', () => {
    const j = job('j1', { service_type: 'HVAC Repair', diagnosis_notes: 'Thermostat is blank, no display' });
    const [row] = run(ctx({ actions: [action('j1', 'remote_failed', { service_type: 'HVAC Repair' })] }, [j]));
    expect(row?.verdict).not.toBe('remote_first');
  });

  it('learns from the business’s own remote results (prior is outweighed)', () => {
    const j = job('j1', { service_type: 'HVAC Repair', diagnosis_notes: 'Thermostat is blank, no display' });
    const failed = Array.from({ length: 10 }, (_, i) => action(`old${i}`, 'remote_failed', { service_type: 'HVAC Repair' }));
    const [row] = run(ctx({ actions: failed }, [j]));
    expect(row?.verdict).not.toBe('remote_first');
    expect(row?.gates.find((g) => g.key === 'remote')?.basis).toBe('measured');
  });

  it('never holds an emergency', () => {
    const [row] = run(ctx({}, [job('j1', { service_type: 'Plumbing', diagnosis_notes: 'Customer smells gas near the water heater' })]));
    expect(row?.verdict).toBe('emergency');
    expect(row?.gates.find((g) => g.key === 'remote')?.status).toBe('na');
  });

  it('never holds an urgent-SLA job, and lists the open items as conditions', () => {
    const [row] = run(ctx({ customers: [] }, [job('j1', { sla_response_hours: 2, customer_type: 'commercial' })]));
    expect(row?.verdict).toBe('dispatch');
    expect(row?.slaPressure).toBe(true);
    expect(row?.conditions.length).toBeGreaterThan(0);
  });

  it('treats planned work as a visit by definition (no remote/evidence/media gates)', () => {
    const c = ctx({}, [job('j1', { service_type: 'AC Tune-up' })]);
    c.actions = [action('j1', 'access_confirmed')];
    c.assurance.outcomes = outcomes(40).map((o) => ({ ...o, job_type_key: 'ac_tune_up' }));
    const [row] = run(c);
    for (const key of ['remote', 'evidence', 'media', 'part'] as const) {
      expect(row?.gates.find((g) => g.key === key)?.status).toBe('na');
    }
    expect(row?.verdict).not.toBe('remote_first');
  });

  it('marks a remotely resolved job as eliminated', () => {
    const [row] = run(ctx({ actions: [action('j1', 'remote_resolved')] }));
    expect(row?.verdict).toBe('eliminated');
  });

  it('respects an owner override and records the reason', () => {
    const [row] = run(ctx({ customers: [], actions: [action('j1', 'override_dispatch', { note: 'Regular customer, tech knows the unit' })] }));
    expect(row?.verdict).toBe('dispatch');
    expect(row?.overridden).toBe(true);
    expect(row?.reasons[0]).toContain('Regular customer');
  });

  it('expires an old override', () => {
    const old = new Date(NOW - 9 * 24 * HOUR).toISOString();
    const [row] = run(ctx({ customers: [], actions: [action('j1', 'override_dispatch', { note: 'Regular customer, tech knows the unit', created_at: old })] }));
    expect(row?.overridden).toBe(false);
    expect(row?.verdict).toBe('hold');
  });

  it('only evaluates scheduled jobs', () => {
    const rows = run(ctx({}, [job('j1'), job('j2', { job_status: 'in_progress' }), job('j3', { job_status: 'en_route' })]));
    expect(rows.map((r) => r.job.id)).toEqual(['j1']);
  });

  it('sorts emergencies first, then holds', () => {
    const jobs = [job('ok'), job('gas', { diagnosis_notes: 'gas leak smell in basement' }), job('bad', { service_type: 'AC Repair' })];
    const c = ctx({}, jobs);
    const rows = run(c);
    expect(rows[0]?.job.id).toBe('gas');
  });
});

describe('media gate', () => {
  it('moves from "can be requested" to "requested" to "received"', () => {
    const j = job('j1');
    const gateOf = (c: TruckRollContext): Gate | undefined => run(c)[0]?.gates.find((g) => g.key === 'media');
    expect(gateOf(ctx({}, [j]))?.answer).toBe('Can be requested');
    expect(gateOf(ctx({ actions: [action('j1', 'request_media')] }, [j]))?.answer).toBe('Requested');
    expect(gateOf(ctx({ actions: [action('j1', 'request_media', { created_at: new Date(NOW - 30 * HOUR).toISOString() })] }, [j]))?.answer).toBe('No reply');
    expect(gateOf(ctx({ actions: [action('j1', 'media_received')] }, [j]))?.status).toBe('pass');
  });
});

describe('numbers', () => {
  it('readiness ignores not-applicable and remote gates', () => {
    const g = (key: Gate['key'], status: Gate['status'], score: number | null): Gate => ({
      key, label: key, question: key, status, score, basis: 'measured', answer: '', detail: '', issues: [], action: null,
    });
    expect(weightedReadiness([g('remote', 'warn', 10), g('part', 'na', null), g('technician', 'pass', 100), g('resolution', 'pass', 100)])).toBe(100);
    expect(weightedReadiness([g('part', 'na', null)])).toBeNull();
  });

  it('summarizes potential and realized savings separately', () => {
    const c = ctx({ customers: [], actions: [action('old', 'remote_resolved'), action('old2', 'remote_resolved')] });
    const rows = run(c);
    const s = summarizeTruckRolls(rows, c.actions, DEFAULT_TRUCK_ROLL_SETTINGS, NOW);
    expect(s.hold).toBe(1);
    expect(s.realizedRolls).toBe(2);
    expect(s.realizedSavings).toBe(2 * DEFAULT_TRUCK_ROLL_SETTINGS.truck_roll_cost);
    expect(s.potentialSavings).toBeGreaterThan(0);
  });

  it('builds a safe media request and sms link', () => {
    const msg = buildMediaRequestMessage('Maria Lopez', 'AC Repair');
    expect(msg).toContain('Hi Maria');
    expect(smsHref('+1 (555) 000-1111', msg).startsWith('sms:+15550001111?body=')).toBe(true);
  });
});
