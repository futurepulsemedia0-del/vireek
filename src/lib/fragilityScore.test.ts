import { describe, expect, it } from 'vitest';
import {
  bandOf,
  deriveInputs,
  riskOf,
  scoreFragility,
  type FragilityInputs,
  type RawBusinessData,
} from '@/lib/fragilityScore';

const EMPTY: RawBusinessData = {
  completedJobs: [],
  purchases: [],
  outcomes: [],
  integrationStatuses: [],
  cashBalance: null,
  fixedExpenses: [],
  backupCapacityPct: null,
  manualWorkPct: null,
};

const HEALTHY: FragilityInputs = {
  topTechnicianSharePct: 20,
  topSupplierSharePct: 30,
  topCustomersSharePct: 25,
  cashBufferMonths: 6,
  backupCapacityPct: 20,
  qualitySpreadPts: 3,
  manualWorkPct: 10,
  brokenIntegrationPct: 0,
};

const WORST: FragilityInputs = {
  topTechnicianSharePct: 100,
  topSupplierSharePct: 100,
  topCustomersSharePct: 100,
  cashBufferMonths: 0,
  backupCapacityPct: 0,
  qualitySpreadPts: 50,
  manualWorkPct: 100,
  brokenIntegrationPct: 100,
};

const job = (technician: string | null, customer: string | null = null, revenue = 100) => ({
  technician_id: technician,
  customer_id: customer,
  revenue,
});

describe('riskOf', () => {
  it('maps values to 0–1 in both directions and clamps', () => {
    expect(riskOf(60, 25, 60)).toBe(1);
    expect(riskOf(10, 25, 60)).toBe(0);
    expect(riskOf(1.5, 3, 0.5)).toBeCloseTo(0.6);
    expect(riskOf(0, 15, 0)).toBe(1);
  });
});

describe('bandOf', () => {
  it('uses the documented thresholds', () => {
    expect(bandOf(0)).toBe('resilient');
    expect(bandOf(30)).toBe('exposed');
    expect(bandOf(55)).toBe('fragile');
    expect(bandOf(75)).toBe('critical');
  });
});

describe('deriveInputs', () => {
  it('reports full technician dependence when one technician does every job', () => {
    const jobs = Array.from({ length: 12 }, () => job('t1'));
    expect(deriveInputs({ ...EMPTY, completedJobs: jobs }).topTechnicianSharePct).toBe(100);
  });

  it('refuses to measure technician dependence from too few jobs', () => {
    const jobs = Array.from({ length: 5 }, () => job('t1'));
    expect(deriveInputs({ ...EMPTY, completedJobs: jobs }).topTechnicianSharePct).toBeNull();
  });

  it('converts cash into months of active fixed costs', () => {
    const input = deriveInputs({
      ...EMPTY,
      cashBalance: 9000,
      fixedExpenses: [
        { amount: 3000, frequency: 'monthly', active: true },
        { amount: 500, frequency: 'monthly', active: false },
        { amount: 100, frequency: 'one_time', active: true },
      ],
    });
    expect(input.cashBufferMonths).toBe(3);
  });

  it('measures quality spread only across technicians with enough jobs', () => {
    const outcome = (technician: string, callback: boolean) => ({ technician_id: technician, caused_callback: callback, is_rework: false });
    const outcomes = [
      ...Array.from({ length: 5 }, () => outcome('a', false)),
      ...Array.from({ length: 5 }, () => outcome('b', true)),
    ];
    expect(deriveInputs({ ...EMPTY, outcomes }).qualitySpreadPts).toBe(100);
  });
});

describe('scoreFragility', () => {
  it('scores a well-buffered, diversified business as resilient with full scalability', () => {
    const report = scoreFragility(HEALTHY);
    expect(report.score).toBe(0);
    expect(report.band).toBe('resilient');
    expect(report.scalability).toBe(100);
    expect(report.coverage).toBe(1);
  });

  it('scores the worst case as critical', () => {
    const report = scoreFragility(WORST);
    expect(report.score).toBe(100);
    expect(report.band).toBe('critical');
  });

  it('lands in the exposed band for moderate exposure across the board', () => {
    const report = scoreFragility({
      topTechnicianSharePct: 45,
      topSupplierSharePct: 70,
      topCustomersSharePct: 60,
      cashBufferMonths: 1.5,
      backupCapacityPct: 8,
      qualitySpreadPts: 15,
      manualWorkPct: 50,
      brokenIntegrationPct: 20,
    });
    expect(report.band).toBe('exposed');
    expect(report.score).toBeGreaterThan(40);
    expect(report.score).toBeLessThan(55);
  });

  it('refuses to score when fewer than five dimensions are measurable', () => {
    const report = scoreFragility({ ...WORST, topTechnicianSharePct: null, topSupplierSharePct: null, topCustomersSharePct: null, cashBufferMonths: null, brokenIntegrationPct: null });
    expect(report.score).toBeNull();
    expect(report.band).toBeNull();
    expect(report.coverage).toBe(3 / 8);
  });

  it('ranks the largest contributor first as the weakest link', () => {
    const report = scoreFragility({ ...HEALTHY, topTechnicianSharePct: 100 });
    expect(report.weakestLinks[0].key).toBe('technician');
    expect(report.weakestLinks[0].contribution).toBeCloseTo(15);
  });
});
