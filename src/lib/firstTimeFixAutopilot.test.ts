import { describe, expect, it } from 'vitest';
import type { Job, TeamMember } from '@/lib/supabase';
import type { SkillGraph, SkillNode } from '@/lib/technicianSkillGraph';
import type { StockFitRow } from '@/lib/truckStock';
import {
  buildJobContext,
  buildPrior,
  computeCalibration,
  gateAssignment,
  planAutofix,
  predict,
  rankTechnicians,
  type AutopilotData,
} from '@/lib/firstTimeFixAutopilot';

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
    is_rework: false,
    rework_of_job_id: null,
    technician_diagnosis: null,
    diagnosis_notes: null,
    completed_at: null,
    ...extra,
  }) as unknown as Job;

const node = (technicianId: string, extra: Partial<SkillNode> = {}): SkillNode => ({
  technicianId,
  technicianName: technicianId,
  serviceType: 'AC Repair',
  proficiencyScore: 80,
  level: 'proficient',
  sampleSize: 10,
  firstTimeFixRate: 85,
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

function data(over: Partial<AutopilotData> = {}): AutopilotData {
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

const ctxOf = (d: AutopilotData) => buildJobContext(d, d.jobs[0] as Job);

describe('buildPrior', () => {
  it('falls back to the trade benchmark with no history', () => {
    const p = buildPrior([], 'AC Repair', NOW);
    expect(p.source).toBe('benchmark');
    expect(p.n).toBe(0);
    expect(p.p).toBeGreaterThan(0.7);
    expect(p.p).toBeLessThan(0.9);
  });

  it('learns from history and counts callbacks as failures', () => {
    const hist: Job[] = [];
    for (let i = 0; i < 10; i++) {
      hist.push(job(`h${i}`, { job_status: 'completed', completed_at: daysAgo(10 + i), scheduled_datetime: daysAgo(10 + i) }));
    }
    for (let i = 0; i < 5; i++) hist.push(job(`r${i}`, { is_rework: true, rework_of_job_id: `h${i}`, job_status: 'completed', completed_at: daysAgo(3) }));
    const p = buildPrior(hist, 'AC Repair', NOW);
    expect(p.source).toBe('history');
    expect(p.n).toBe(10);
    expect(p.p).toBeLessThan(buildPrior([], 'AC Repair', NOW).p);
  });
});

describe('predict', () => {
  it('rewards a full truck and penalises missing parts', () => {
    const full = predict(ctxOf(data({ stockFit: { j1: { a: fit('a', 3, 3) } } })), 'a');
    const missing = predict(ctxOf(data({ stockFit: { j1: { a: fit('a', 3, 0) } } })), 'a');
    expect(full.probability).toBeGreaterThan(missing.probability);
    expect(missing.factors.find((f) => f.key === 'parts')?.status).toBe('risk');
  });

  it('penalises a booking that is too short', () => {
    const d = data({ jobs: [job('j1', { duration_minutes: 30 })] });
    const short = predict(ctxOf(d), 'a');
    const okd = data({ jobs: [job('j1', { duration_minutes: 120 })] });
    expect(short.probability).toBeLessThan(predict(ctxOf(okd), 'a').probability);
  });

  it('penalises missing special tools and low diagnosis confidence', () => {
    const base = predict(ctxOf(data()), 'a').probability;
    const noTool = predict(ctxOf(data({ toolRequirements: [{ service_type: 'ac', tool_name: 'Manifold gauge' }] })), 'a').probability;
    const lowDiag = predict(ctxOf(data({ diagnoses: [{ job_id: 'j1', confidence: 0.3, created_at: daysAgo(1) }] })), 'a').probability;
    expect(noTool).toBeLessThan(base);
    expect(lowDiag).toBeLessThan(base);
  });

  it('flags callbacks on the same equipment', () => {
    const d = data({
      jobs: [job('j1', { customer_id: 'c1' }), job('old', { customer_id: 'c1', is_rework: true, job_status: 'completed', completed_at: daysAgo(20), scheduled_datetime: daysAgo(20) })],
      jobEquipment: [
        { job_id: 'j1', equipment_id: 'e1' },
        { job_id: 'old', equipment_id: 'e1' },
      ],
    });
    const eq = predict(ctxOf(d), 'a').factors.find((f) => f.key === 'equipment');
    expect(eq?.impactPts).toBeLessThan(0);
  });

  it('reports low confidence when little data backs the number', () => {
    const p = predict(ctxOf(data({ graph: graphOf([]) })), null);
    expect(p.confidence).toBe('low');
    expect(p.high - p.low).toBeGreaterThan(10);
  });

  it('keeps probability inside 3-97', () => {
    const p = predict(ctxOf(data({ toolRequirements: [{ service_type: 'ac', tool_name: 'A' }, { service_type: 'ac', tool_name: 'B' }], stockFit: { j1: { b: fit('b', 5, 0) } }, diagnoses: [{ job_id: 'j1', confidence: 0.1, created_at: daysAgo(1) }] })), 'b');
    expect(p.probability).toBeGreaterThanOrEqual(3);
  });
});

describe('rankTechnicians', () => {
  it('ranks the stronger technician first and pushes full-capacity ones last', () => {
    const r = rankTechnicians(ctxOf(data()));
    expect(r[0]?.technician.id).toBe('a');

    const busy = data({
      technicians: [tech('a', { max_jobs_per_day: 1 }), tech('b')],
      jobs: [job('j1'), job('x', { assigned_technician_id: 'a' })],
    });
    expect(rankTechnicians(ctxOf(busy))[0]?.technician.id).toBe('b');
  });
});

describe('planAutofix', () => {
  it('lifts a weak plan and reports honest uplift', () => {
    const d = data({
      jobs: [job('j1', { assigned_technician_id: 'b', duration_minutes: 30 })],
      stockFit: { j1: { a: fit('a', 3, 3), b: fit('b', 3, 0) } },
      toolRequirements: [{ service_type: 'ac', tool_name: 'Manifold gauge' }],
      technicianTools: [{ team_member_id: 'a', tool_name: 'manifold gauge' }],
    });
    const ctx = ctxOf(d);
    const plan = planAutofix(ctx, 'b');
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.finalProbability).toBeGreaterThan(plan.startProbability);
    expect(plan.steps[0]?.kind).toBe('reassign');
    expect(plan.steps.every((s) => s.upliftPts >= 1)).toBe(true);
  });

  it('returns no steps when the job already clears the threshold', () => {
    const d = data({ jobs: [job('j1', { assigned_technician_id: 'a' })], stockFit: { j1: { a: fit('a', 2, 2) } } });
    const plan = planAutofix(ctxOf(d), 'a', { threshold: 60 });
    expect(plan.steps).toHaveLength(0);
    expect(plan.reachesThreshold).toBe(true);
  });

  it('marks parts that must be ordered as blocking', () => {
    const d = data({
      technicians: [tech('a')],
      graph: graphOf([node('a')]),
      jobs: [job('j1', { assigned_technician_id: 'a' })],
      stockFit: { j1: { a: fit('a', 2, 0) } },
      sourcing: [{ job_id: 'j1', sourcing_status: 'order_required' } as never],
    });
    const plan = planAutofix(ctxOf(d), 'a');
    expect(plan.steps.find((s) => s.kind === 'order')?.blocking).toBe(true);
  });
});

describe('gateAssignment', () => {
  const low = predict(ctxOf(data({ stockFit: { j1: { b: fit('b', 5, 0) } } })), 'b');
  it('allows when off or above threshold', () => {
    expect(gateAssignment(low, 'off', 75).action).toBe('allow');
    expect(gateAssignment(predict(ctxOf(data()), 'a'), 'hold', 10).action).toBe('allow');
  });
  it('warns or holds below threshold', () => {
    expect(gateAssignment(low, 'warn', 99).action).toBe('warn');
    expect(gateAssignment(low, 'hold', 99).action).toBe(low.verdict === 'hold' ? 'hold' : 'warn');
  });
});

describe('computeCalibration', () => {
  it('scores resolved predictions and ignores unresolved ones', () => {
    const jobs = [
      job('a', { job_status: 'completed', assigned_technician_id: 't', completed_at: daysAgo(30) }),
      job('b', { job_status: 'completed', assigned_technician_id: 't', completed_at: daysAgo(30) }),
      job('rw', { is_rework: true, rework_of_job_id: 'b', job_status: 'completed', completed_at: daysAgo(20) }),
      job('c', { job_status: 'completed', assigned_technician_id: 't', completed_at: daysAgo(2) }),
    ];
    const cal = computeCalibration(
      [
        { job_id: 'a', technician_id: 't', probability: 90, verdict: 'go' },
        { job_id: 'b', technician_id: 't', probability: 40, verdict: 'hold' },
        { job_id: 'c', technician_id: 't', probability: 80, verdict: 'go' },
      ],
      jobs,
      NOW,
    );
    expect(cal.n).toBe(2);
    expect(cal.actualRate).toBe(50);
    expect(cal.brier).toBeLessThan(0.25);
  });
});
