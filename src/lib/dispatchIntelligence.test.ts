import { describe, expect, it } from 'vitest';
import {
  dateKeyOf,
  estimateTravelMinutes,
  liveEtaMinutes,
  planDispatch,
  type DispatchJob,
  type DispatchTech,
  type PlanInput,
} from '@/lib/dispatchIntelligence';

// A fixed "now": 09:00 local on a fixed day, so results never depend on the clock.
const NOW = new Date(2026, 5, 10, 9, 0, 0).getTime();
const TODAY = dateKeyOf(NOW);
const at = (h: number, m = 0): string => new Date(2026, 5, 10, h, m, 0).toISOString();

// ~1 degree of latitude ≈ 69 miles, so 0.05° ≈ 3.5 miles.
const DOWNTOWN = { lat: 40.0, lng: -74.0 };
const NEAR = { lat: 40.03, lng: -74.0 };
const FAR = { lat: 40.6, lng: -74.0 };

function tech(over: Partial<DispatchTech> & { id: string }): DispatchTech {
  return {
    name: over.id,
    skills: ['HVAC'],
    serviceArea: null,
    maxJobsPerDay: 6,
    dispatchEnabled: true,
    home: DOWNTOWN,
    current: null,
    currentAt: null,
    firstTimeFixRate: null,
    ...over,
  };
}

function job(over: Partial<DispatchJob> & { id: string }): DispatchJob {
  return {
    customerName: 'Customer',
    serviceType: 'HVAC',
    address: '1 Main St',
    point: NEAR,
    scheduledAt: null,
    durationMinutes: 60,
    assignedTechnicianId: null,
    status: 'scheduled',
    createdAt: at(8, 0),
    slaResponseHours: null,
    emergency: false,
    ...over,
  };
}

function plan(over: Partial<PlanInput> & Pick<PlanInput, 'technicians' | 'jobs'>) {
  return planDispatch({ nowMs: NOW, ...over });
}

describe('estimateTravelMinutes', () => {
  it('returns null when a point is missing', () => {
    expect(estimateTravelMinutes(null, NEAR)).toBeNull();
    expect(estimateTravelMinutes(NEAR, { lat: NaN, lng: 0 })).toBeNull();
  });
  it('scales with distance and is zero for the same spot', () => {
    expect(estimateTravelMinutes(NEAR, NEAR)?.minutes).toBe(0);
    const short = estimateTravelMinutes(DOWNTOWN, NEAR)!.minutes;
    const long = estimateTravelMinutes(DOWNTOWN, FAR)!.minutes;
    expect(long).toBeGreaterThan(short);
  });
});

describe('planDispatch — technician choice', () => {
  it('prefers the closer technician when everything else is equal', () => {
    const p = plan({
      technicians: [tech({ id: 'far', home: FAR }), tech({ id: 'near', home: DOWNTOWN })],
      jobs: [job({ id: 'j1' })],
    });
    expect(p.jobs[0].recommended?.technicianId).toBe('near');
  });

  it('prefers the skilled technician over a closer unskilled one', () => {
    const p = plan({
      technicians: [
        tech({ id: 'unskilled', skills: ['Plumbing'], home: DOWNTOWN }),
        tech({ id: 'skilled', skills: ['HVAC'], home: { lat: 40.12, lng: -74.0 } }),
      ],
      jobs: [job({ id: 'j1' })],
    });
    expect(p.jobs[0].recommended?.technicianId).toBe('skilled');
  });

  it('hard-blocks disabled technicians and those at capacity', () => {
    const jobs = [
      job({ id: 'busy1', assignedTechnicianId: 'full', scheduledAt: at(10), point: NEAR }),
      job({ id: 'busy2', assignedTechnicianId: 'full', scheduledAt: at(13), point: NEAR }),
      job({ id: 'new', scheduledAt: at(16) }),
    ];
    const p = plan({
      technicians: [tech({ id: 'full', maxJobsPerDay: 2 }), tech({ id: 'off', dispatchEnabled: false }), tech({ id: 'ok', home: FAR })],
      jobs,
    });
    const jp = p.jobs[0];
    expect(jp.recommended?.technicianId).toBe('ok');
    const reasons = jp.blocked.flatMap((b) => b.blockers).join(' | ');
    expect(reasons).toContain('At capacity');
    expect(reasons).toContain('Dispatch is turned off');
  });

  it('blocks a technician missing a required credential', () => {
    const p = plan({
      technicians: [tech({ id: 'uncertified' }), tech({ id: 'certified', home: FAR })],
      jobs: [job({ id: 'j1', serviceType: 'HVAC' })],
      blockingGaps: (id) => (id === 'uncertified' ? ['EPA 608'] : []),
    });
    expect(p.jobs[0].recommended?.technicianId).toBe('certified');
    expect(p.jobs[0].blocked[0].blockers[0]).toContain('EPA 608');
  });

  it('reports no recommendation when nobody can take the job', () => {
    const p = plan({
      technicians: [tech({ id: 'a', dispatchEnabled: false })],
      jobs: [job({ id: 'j1' })],
    });
    expect(p.jobs[0].recommended).toBeNull();
    expect(p.summary.unassignable).toBe(1);
  });
});

describe('planDispatch — time windows', () => {
  it('rejects a technician who cannot reach an appointment in time', () => {
    // Existing job ends 10:00 far away; new appointment at 10:05 is ~40+ minutes away.
    const jobs = [
      job({ id: 'existing', assignedTechnicianId: 'a', scheduledAt: at(9), durationMinutes: 60, point: FAR }),
      job({ id: 'new', scheduledAt: at(10, 5), point: DOWNTOWN }),
    ];
    const p = plan({ technicians: [tech({ id: 'a', home: FAR }), tech({ id: 'b', home: DOWNTOWN })], jobs });
    const jp = p.jobs[0];
    expect(jp.recommended?.technicianId).toBe('b');
    expect(jp.blocked.find((x) => x.technicianId === 'a')?.blockers[0]).toContain('late');
  });

  it('never makes the next appointment late', () => {
    const jobs = [
      job({ id: 'next', assignedTechnicianId: 'a', scheduledAt: at(11), point: FAR }),
      job({ id: 'new', scheduledAt: at(10, 30), durationMinutes: 60, point: DOWNTOWN }),
    ];
    const p = plan({ technicians: [tech({ id: 'a', home: DOWNTOWN })], jobs });
    expect(p.jobs[0].recommended).toBeNull();
    expect(p.jobs[0].blocked[0].blockers[0]).toContain('next job late');
  });

  it('places a flexible job in the gap that adds the least driving', () => {
    const jobs = [
      job({ id: 'morning', assignedTechnicianId: 'a', scheduledAt: at(9), durationMinutes: 60, point: DOWNTOWN }),
      job({ id: 'afternoon', assignedTechnicianId: 'a', scheduledAt: at(15), durationMinutes: 60, point: NEAR }),
      job({ id: 'flex', scheduledAt: null, durationMinutes: 60, point: DOWNTOWN }),
    ];
    const p = plan({ technicians: [tech({ id: 'a', home: DOWNTOWN })], jobs });
    const rec = p.jobs[0].recommended!;
    expect(rec.technicianId).toBe('a');
    // Same spot as the 9:00 job → inserted straight after it, before the afternoon job.
    expect(rec.insertIndex).toBe(1);
    expect(rec.plannedArrivalMs!).toBeLessThan(new Date(2026, 5, 10, 15).getTime());
    const route = p.routes.find((r) => r.technicianId === 'a' && r.dateKey === TODAY)!;
    expect(route.stops.map((s) => s.jobId)).toEqual(['morning', 'flex', 'afternoon']);
    expect(route.stops[1].planned).toBe(true);
  });
});

describe('planDispatch — SLA and urgency', () => {
  it('plans emergencies first so they get the best technician', () => {
    const p = plan({
      technicians: [tech({ id: 'best', home: DOWNTOWN }), tech({ id: 'other', home: FAR })],
      jobs: [job({ id: 'routine', point: NEAR }), job({ id: 'urgent', point: NEAR, emergency: true })],
    });
    expect(p.jobs[0].jobId).toBe('urgent');
    expect(p.jobs[0].recommended?.technicianId).toBe('best');
  });

  it('flags a recommendation that will miss its SLA', () => {
    const p = plan({
      technicians: [tech({ id: 'far', home: FAR })],
      jobs: [job({ id: 'j1', createdAt: at(8, 0), slaResponseHours: 1, point: DOWNTOWN })],
    });
    const rec = p.jobs[0].recommended!;
    expect(rec.slaBreach).toBe(true);
    expect(p.summary.slaAtRisk).toBe(1);
  });

  it('spreads load: a second job goes to the other technician once the first is busy', () => {
    const p = plan({
      technicians: [tech({ id: 'a', maxJobsPerDay: 1 }), tech({ id: 'b', home: FAR, maxJobsPerDay: 1 })],
      jobs: [job({ id: 'j1', scheduledAt: at(10) }), job({ id: 'j2', scheduledAt: at(14) })],
    });
    const picks = p.jobs.map((x) => x.recommended?.technicianId).sort();
    expect(picks).toEqual(['a', 'b']);
  });
});

describe('planDispatch — data quality', () => {
  it('still plans when locations are unknown, with lower confidence', () => {
    const p = plan({
      technicians: [tech({ id: 'a', home: null })],
      jobs: [job({ id: 'j1', point: null })],
    });
    const rec = p.jobs[0].recommended!;
    expect(rec.travelKnown).toBe(false);
    expect(rec.confidence).toBeLessThan(1);
  });

  it('keeps every score within 0–100', () => {
    const p = plan({
      technicians: [tech({ id: 'a', firstTimeFixRate: 250 }), tech({ id: 'b', firstTimeFixRate: -10 })],
      jobs: [job({ id: 'j1', createdAt: at(1), slaResponseHours: 1 })],
    });
    for (const c of [p.jobs[0].recommended!, ...p.jobs[0].alternatives]) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
    }
  });

  it('is deterministic', () => {
    const input = {
      technicians: [tech({ id: 'a' }), tech({ id: 'b', home: FAR })],
      jobs: [job({ id: 'j1' }), job({ id: 'j2', point: FAR })],
    };
    expect(JSON.stringify(plan(input))).toBe(JSON.stringify(plan(input)));
  });
});

describe('liveEtaMinutes', () => {
  it('computes an ETA from a fresh position', () => {
    const eta = liveEtaMinutes(DOWNTOWN, NEAR, at(8, 58), NOW);
    expect(eta).not.toBeNull();
    expect(eta!.minutes).toBeGreaterThan(0);
  });
  it('returns null for stale or missing positions', () => {
    expect(liveEtaMinutes(DOWNTOWN, NEAR, at(8, 0), NOW)).toBeNull();
    expect(liveEtaMinutes(null, NEAR, at(8, 59), NOW)).toBeNull();
    expect(liveEtaMinutes(DOWNTOWN, NEAR, null, NOW)).toBeNull();
  });
});
