import { describe, expect, it } from 'vitest';
import {
  arbitrate,
  buildChamberCase,
  conflictsOf,
  deriveCampaignSignals,
  tradeoffOf,
  type CampaignSignals,
  type ChamberRaw,
} from '@/lib/agentChamber';

const BASE: CampaignSignals = {
  campaignName: 'Spring tune-up',
  audienceSize: 1000,
  conversionPct: 10,
  avgTicketCents: 20000,
  hoursPerJob: 2,
  freeTechnicianHours: 400,
  technicianCount: 4,
  unassignedSoonJobs: 0,
  marginPct: 40,
  callbackPct: 5,
  constitutionBlocked: false,
};

describe('tradeoffOf', () => {
  it('computes full and capacity-capped numbers', () => {
    const t = tradeoffOf({ ...BASE, freeTechnicianHours: 100 });
    expect(t.fullBookings).toBe(100);
    expect(t.hoursNeeded).toBe(200);
    expect(t.hoursUsable).toBe(90);
    expect(t.cappedBookings).toBe(45);
    expect(t.cappedAudience).toBe(450);
    expect(t.fullRevenueCents).toBe(2_000_000);
  });
});

describe('buildChamberCase positions and conflicts', () => {
  it('has no conflict when every agent supports the campaign', () => {
    const c = buildChamberCase(BASE);
    expect(c.positions.every((p) => p.stance === 'support')).toBe(true);
    expect(c.conflicts).toEqual([]);
  });

  it('surfaces a revenue-versus-dispatch conflict when capacity is short', () => {
    const c = buildChamberCase({ ...BASE, freeTechnicianHours: 100 });
    const dispatch = c.positions.find((p) => p.role === 'dispatch');
    expect(dispatch?.stance).toBe('oppose');
    expect(c.conflicts.some((x) => x.between[0] === 'revenue' && x.between[1] === 'dispatch')).toBe(true);
  });

  it('does not treat conditional positions as conflicts', () => {
    const c = buildChamberCase({ ...BASE, marginPct: null, callbackPct: null });
    expect(c.positions.find((p) => p.role === 'finance')?.stance).toBe('conditional');
    expect(conflictsOf(c.positions)).toEqual([]);
  });
});

describe('arbitrate (CEO rules)', () => {
  it('launches the full campaign when the schedule absorbs it', () => {
    const c = buildChamberCase(BASE);
    expect(c.ceo.action).toBe('launch');
    expect(c.ceo.audienceCap).toBeNull();
    expect(c.ceo.confidence).toBe('high');
  });

  it('launches a capped campaign when most of the revenue still fits', () => {
    const c = buildChamberCase({ ...BASE, freeTechnicianHours: 100 });
    expect(c.ceo.action).toBe('launch_capped');
    expect(c.ceo.audienceCap).toBe(450);
    expect(c.ceo.confidence).toBe('medium');
  });

  it('defers when a capped launch would keep too little revenue', () => {
    const c = buildChamberCase({ ...BASE, freeTechnicianHours: 20 });
    expect(c.ceo.action).toBe('defer');
  });

  it('defers when the constitution blocks the campaign', () => {
    const c = buildChamberCase({ ...BASE, constitutionBlocked: true });
    expect(c.ceo.action).toBe('defer');
    expect(c.ceo.reasons[0]).toContain('constitution');
  });

  it('defers when margin is below the floor', () => {
    const c = buildChamberCase({ ...BASE, marginPct: 10 });
    expect(c.ceo.action).toBe('defer');
    expect(c.ceo.reasons[0]).toContain('margin');
  });

  it('defers when jobs starting soon have no technician', () => {
    const c = buildChamberCase({ ...BASE, unassignedSoonJobs: 2 });
    expect(c.ceo.action).toBe('defer');
  });

  it('lowers confidence as conflicts accumulate', () => {
    const positions = buildChamberCase({ ...BASE, freeTechnicianHours: 100, marginPct: 10 }).positions;
    const conflicts = conflictsOf(positions);
    expect(arbitrate({ ...BASE, marginPct: 10 }, tradeoffOf(BASE), conflicts).confidence).toBe('low');
  });
});

describe('deriveCampaignSignals', () => {
  const now = Date.parse('2026-09-24T00:00:00Z');
  const hourFromNow = (h: number) => new Date(now + h * 3_600_000).toISOString();

  const raw: ChamberRaw = {
    scheduledJobs: [
      ...Array.from({ length: 15 }, () => ({ scheduled_datetime: hourFromNow(24), duration_minutes: 120, assigned_technician_id: 't1' })),
      { scheduled_datetime: hourFromNow(30), duration_minutes: 60, assigned_technician_id: null },
      { scheduled_datetime: hourFromNow(24 * 5), duration_minutes: 60, assigned_technician_id: null },
    ],
    completedJobs: [
      { duration_minutes: 120, invoice_amount: 200 },
      { duration_minutes: 60, invoice_amount: 300 },
    ],
    outcomes: [],
    technicianCount: 2,
    quoteWinRatePct: 30,
  };

  it('computes free hours, ticket and conversion from raw rows', () => {
    const s = deriveCampaignSignals(raw, { campaignName: 'x', audienceSize: 500, conversionPct: null, constitutionBlocked: false }, now);
    // 2 technicians × 40h = 80h, minus 31h booked (15×2h + 1h + 1h) = 49h... plus the 5-day job
    expect(s.freeTechnicianHours).toBe(80 - (30 + 1 + 1));
    expect(s.avgTicketCents).toBe(25000);
    expect(s.conversionPct).toBe(30);
    expect(s.hoursPerJob).toBeCloseTo(1.5);
  });

  it('counts only unassigned jobs starting within 48 hours', () => {
    const s = deriveCampaignSignals(raw, { campaignName: 'x', audienceSize: 500, conversionPct: null, constitutionBlocked: false }, now);
    expect(s.unassignedSoonJobs).toBe(1);
  });
});
