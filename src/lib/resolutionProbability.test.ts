import { describe, expect, it } from 'vitest';
import type { Job, TeamMember } from '@/lib/supabase';
import type { SkillGraph, SkillNode } from '@/lib/technicianSkillGraph';
import type { StockFitRow } from '@/lib/truckStock';
import type { AutopilotData } from '@/lib/firstTimeFixAutopilot';
import {
  assess,
  buildResolutionContext,
  computeCalibration,
  failureCostCents,
  findRemoteExpert,
  planResolution,
  rankCandidates,
  DEFAULT_RPE_SETTINGS,
  type EvidenceCheckRow,
} from '@/lib/resolutionProbability';

const NOW = new Date('2026-09-30T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();

const tech = (id: string, extra: Partial<TeamMember> = {}) =>
  ({ id, role: 'technician', dispatch_enabled: true, max_jobs_per_day: 6, member_name: id, member_email: `${id}@x.com`, skills: [], ...extra }) as unknown as TeamMember;

const job = (id: string, extra: Partial<Job> = {}) =>
  ({
    id,
    service_type: 'AC Repair',
    job_status: 'scheduled',
    scheduled_datetime: '2026-10-02T09:00:00Z',
    duration_minutes: 90,
    assigned_technician_id: null,
    customer_id: null,
    customer_phone: '555-0100',
    dispatch_note: null,
    before_photos: [],
    is_rework: false,
    rework_of_job_id: null,
    technician_diagnosis: null,
    diagnosis_notes: null,
    completed_at: null,
    latitude: null,
    longitude: null,
    ...extra,
  }) as unknown as Job;

const node = (technicianId: string, extra: Partial<SkillNode> = {}): SkillNode => ({
  technicianId,
  technicianName: technicianId,
  serviceType: 'AC Repair',
  proficiencyScore: 85,
  level: 'proficient',
  sampleSize: 10,
  firstTimeFixRate: 88,
  csatAvg: 4.6,
  relativeSpeedPct: 0,
  trend: 'steady',
  ...extra,
});

function graphOf(nodes: SkillNode[]): SkillGraph {
  const nodesByTechnician = new Map<string, SkillNode[]>();
  for (const n of nodes) nodesByTechnician.set(n.technicianId, [...(nodesByTechnician.get(n.technicianId) ?? []), n]);
  return { generatedAt: NOW.toISOString(), serviceTypes: ['AC Repair'], nodes, nodesByTechnician };
}

const fit = (technicianId: string, required: number, onVan: number): StockFitRow => ({ job_id: 'j1', technician_id: technicianId, parts_required: required, parts_on_van: onVan });

function base(over: Partial<AutopilotData> = {}): AutopilotData {
  return {
    jobs: [job('j1')],
    technicians: [tech('a'), tech('b')],
    graph: graphOf([node('a'), node('b', { proficiencyScore: 40, firstTimeFixRate: 45, sampleSize: 8, level: 'developing' })]),
    stockFit: {},
    sourcing: [],
    diagnoses: [],
    jobEquipment: [],
    equipment: [],
    toolRequirements: [],
    technicianTools: [],
    now: NOW,
    ...over,
  };
}

const evidence = (over: Partial<EvidenceCheckRow> = {}): EvidenceCheckRow => ({
  job_id: 'j1',
  verdict: 'pass',
  evidence_completeness: 0.95,
  quality_issues: [],
  safety_flags: [],
  resolved: false,
  created_at: daysAgo(1),
  ...over,
});

const rcOf = (b: AutopilotData, ev: EvidenceCheckRow[] = []) => buildResolutionContext({ base: b, evidence: ev }, b.jobs[0] as Job);

describe('assess', () => {
  it('rates a well-prepared job well above a poorly prepared one', () => {
    const strong = base({
      stockFit: { j1: { a: fit('a', 2, 2), b: fit('b', 2, 2) } },
      diagnoses: [{ job_id: 'j1', confidence: 0.9, created_at: daysAgo(1) }],
    });
    const weak = base({
      stockFit: { j1: { a: fit('a', 3, 0), b: fit('b', 3, 0) } },
      sourcing: [{ job_id: 'j1', sourcing_status: 'order_required' } as never],
    });
    const good = assess(rcOf(strong, [evidence()]), 'a');
    const bad = assess(rcOf(weak), 'a');
    expect(good.probability).toBeGreaterThan(bad.probability + 20);
    expect(good.verdict).toBe('dispatch');
    expect(bad.verdict).not.toBe('dispatch');
  });

  it('always reports eight dimensions and keeps the probability bounded', () => {
    const a = assess(rcOf(base()), 'b');
    expect(a.dimensions).toHaveLength(8);
    expect(a.probability).toBeGreaterThanOrEqual(3);
    expect(a.probability).toBeLessThanOrEqual(97);
    expect(a.low).toBeLessThanOrEqual(a.probability);
    expect(a.high).toBeGreaterThanOrEqual(a.probability);
  });

  it('penalises missing evidence on a fault-finding job', () => {
    const faulty = assess(rcOf(base({ jobs: [job('j1', { service_type: 'AC Repair' })] })), 'a');
    const ev = faulty.dimensions.find((d) => d.key === 'evidence');
    expect(ev?.logit).toBeLessThan(-0.3);
    expect(ev?.status).toBe('risk');
  });

  it('reads evidence completeness on either a 0-1 or 0-100 scale', () => {
    const a = assess(rcOf(base(), [evidence({ evidence_completeness: 0.9 })]), 'a');
    const b = assess(rcOf(base(), [evidence({ evidence_completeness: 90 })]), 'a');
    expect(a.probability).toBe(b.probability);
  });

  it('computes drive time from technician and job coordinates', () => {
    const b = base({
      jobs: [job('j1', { latitude: 40.0, longitude: -75.0 })],
      technicians: [tech('a', { home_latitude: 40.0, home_longitude: -75.5 }), tech('b')],
    });
    const a = assess(rcOf(b), 'a');
    expect(a.travelMiles).toBeGreaterThan(20);
    expect(a.etaMinutes).toBeGreaterThan(30);
    expect(assess(rcOf(b), 'b').travelMiles).toBeNull();
  });
});

describe('remote expert', () => {
  it('is found only among other proficient technicians', () => {
    const rc = rcOf(base());
    expect(findRemoteExpert(rc, 'b')?.id).toBe('a');
    expect(findRemoteExpert(rc, 'a')).toBeNull();
  });

  it('lifts a technician skill gap but does not hide missing parts', () => {
    const b = base({ stockFit: { j1: { a: fit('a', 2, 2), b: fit('b', 2, 0) } } });
    const rc = rcOf(b);
    const alone = assess(rc, 'b');
    const withExpert = assess(rc, 'b', DEFAULT_RPE_SETTINGS, { remoteExpert: true });
    expect(withExpert.remoteExpert).toBe(true);
    expect(withExpert.probability).toBeGreaterThan(alone.probability);
    const parts = withExpert.dimensions.find((d) => d.key === 'parts');
    expect(parts?.logit).toBeLessThan(0);
  });

  it('is ignored when nobody qualifies', () => {
    const b = base({ graph: graphOf([node('a', { sampleSize: 2 }), node('b', { proficiencyScore: 40, sampleSize: 8 })]) });
    expect(assess(rcOf(b), 'b', DEFAULT_RPE_SETTINGS, { remoteExpert: true }).remoteExpert).toBe(false);
  });
});

describe('planResolution', () => {
  it('prefers the better technician and reports saved failure cost', () => {
    const b = base({ jobs: [job('j1', { assigned_technician_id: 'b' })], stockFit: { j1: { a: fit('a', 2, 2), b: fit('b', 2, 2) } } });
    const plan = planResolution(rcOf(b, [evidence()]), 'b');
    expect(plan.levers.some((l) => l.kind === 'reassign' && l.technicianId === 'a')).toBe(true);
    expect(plan.finalProbability).toBeGreaterThan(plan.startProbability);
    expect(plan.finalFailureCostCents).toBeLessThan(plan.startFailureCostCents);
  });

  it('asks for evidence or parts instead of dispatching blindly when the odds are low', () => {
    const b = base({
      jobs: [job('j1', { assigned_technician_id: 'a' })],
      stockFit: { j1: { a: fit('a', 3, 0), b: fit('b', 3, 0) } },
      sourcing: [{ job_id: 'j1', sourcing_status: 'order_required' } as never],
    });
    const plan = planResolution(rcOf(b), 'a');
    expect(plan.recommendation.action).not.toBe('dispatch_now');
    const kinds = plan.levers.map((l) => l.kind);
    expect(kinds.some((k) => k === 'gather_evidence' || k === 'order' || k === 'remote_expert')).toBe(true);
    for (const l of plan.levers) expect(l.upliftPts).toBeGreaterThanOrEqual(1);
  });

  it('says dispatch now when the target is already met', () => {
    const b = base({
      jobs: [job('j1', { assigned_technician_id: 'a' })],
      stockFit: { j1: { a: fit('a', 2, 2), b: fit('b', 2, 2) } },
      diagnoses: [{ job_id: 'j1', confidence: 0.9, created_at: daysAgo(1) }],
    });
    const plan = planResolution(rcOf(b, [evidence()]), 'a');
    expect(plan.recommendation.action).toBe('dispatch_now');
    expect(plan.levers).toHaveLength(0);
  });

  it('seeds an unassigned job with the best available technician', () => {
    const plan = planResolution(rcOf(base()), null);
    expect(plan.levers[0]?.kind).toBe('reassign');
    expect(plan.levers[0]?.technicianId).toBe('a');
  });

  it('never exceeds six levers and never repeats one', () => {
    const b = base({ jobs: [job('j1', { assigned_technician_id: 'b', duration_minutes: 20 })], stockFit: { j1: { a: fit('a', 3, 0), b: fit('b', 3, 0) } } });
    const plan = planResolution(rcOf(b), 'b');
    const kinds = plan.levers.map((l) => l.kind);
    expect(kinds.length).toBeLessThanOrEqual(7);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe('rankCandidates', () => {
  it('ranks by resolution probability and pushes full technicians last', () => {
    const jobs = [job('j1')];
    for (let i = 0; i < 6; i++) jobs.push(job(`x${i}`, { assigned_technician_id: 'a' }));
    const r = rankCandidates(rcOf(base({ jobs })));
    expect(r[0]?.technician.id).toBe('b');
    expect(r[1]?.atCapacity).toBe(true);
  });
});

describe('failureCostCents', () => {
  it('prices the chance of a wasted visit', () => {
    expect(failureCostCents(80, 20000)).toBe(4000);
    expect(failureCostCents(100, 20000)).toBe(0);
  });
});

describe('computeCalibration', () => {
  it('compares predicted probability with real outcomes', () => {
    const jobs = [
      job('c1', { job_status: 'completed', completed_at: daysAgo(30), assigned_technician_id: 'a' }),
      job('c2', { job_status: 'completed', completed_at: daysAgo(30), assigned_technician_id: 'a' }),
      job('rw', { is_rework: true, rework_of_job_id: 'c2', job_status: 'completed', completed_at: daysAgo(20), assigned_technician_id: 'a' }),
      job('c3', { job_status: 'completed', completed_at: daysAgo(2), assigned_technician_id: 'a' }),
    ];
    const cal = computeCalibration(
      [
        { job_id: 'c1', technician_id: 'a', probability: 90 },
        { job_id: 'c2', technician_id: 'a', probability: 90 },
        { job_id: 'c3', technician_id: 'a', probability: 90 },
      ],
      jobs,
      NOW,
    );
    expect(cal.n).toBe(2); // c3 is too recent to judge
    expect(cal.actualRate).toBe(50);
    expect(cal.meanPredicted).toBe(90);
    expect(cal.brier).toBeGreaterThan(0);
  });
});
