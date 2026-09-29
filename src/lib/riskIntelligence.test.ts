import { describe, expect, it } from 'vitest';
import {
  computeJobRisk,
  DEFAULT_RISK_POLICY,
  hazardTierFor,
  levelOf,
  type RiskInputs,
} from '@/lib/riskIntelligence';

function clean(): RiskInputs {
  return {
    policy: { ...DEFAULT_RISK_POLICY },
    property: { hasAddress: true, commercial: false, equipment: [], priorClaims36m: 0, openClaim: false, customerReworkCount: 0 },
    technician: {
      assigned: true,
      blockingGaps: [],
      advisoryGaps: [],
      expiringSoon: [],
      reworkRatePct: 2,
      outcomesCount: 40,
      completedSameService: 25,
    },
    liability: { hazardTier: 0, valueCents: 45_000, afterHours: false, commercial: false, hasSla: false },
    parts: { total: 0, backordered: 0, needed: 0, hoursUntilStart: 24 },
    warranty: {
      warrantyEquipmentCount: 0,
      activeWarrantyCount: 0,
      expiredWarrantyCount: 0,
      soonestExpiryDays: null,
      docs: { serialOnFile: true, installDateOnFile: true, diagnosisNotes: true, beforePhotos: 2, evidenceVerdict: 'pass' },
      claim: null,
    },
    unavailableSources: [],
  };
}

describe('levelOf', () => {
  it('maps score bands to levels', () => {
    expect(levelOf(0)).toBe('low');
    expect(levelOf(33)).toBe('low');
    expect(levelOf(34)).toBe('medium');
    expect(levelOf(66)).toBe('medium');
    expect(levelOf(67)).toBe('high');
    expect(levelOf(100)).toBe('high');
  });
});

describe('hazardTierFor', () => {
  it('uses built-in keywords and account policy', () => {
    expect(hazardTierFor('Gas line repair', DEFAULT_RISK_POLICY)).toBe(2);
    expect(hazardTierFor('Water heater install', DEFAULT_RISK_POLICY)).toBe(1);
    expect(hazardTierFor('Duct cleaning', DEFAULT_RISK_POLICY)).toBe(0);
    expect(hazardTierFor('Duct cleaning', { ...DEFAULT_RISK_POLICY, highRiskServiceTypes: ['duct'] })).toBe(2);
    expect(hazardTierFor(null, DEFAULT_RISK_POLICY)).toBe(0);
  });
});

describe('computeJobRisk', () => {
  it('rates a routine, well-documented job as low and clear', () => {
    const r = computeJobRisk(clean());
    expect(r.overallLevel).toBe('low');
    expect(r.coverage.decision).toBe('clear');
    expect(r.coverage.requiresAck).toBe(false);
    expect(r.flags).toHaveLength(0);
    expect(r.dataCoverage).toBe(1);
  });

  it('holds the job when the technician lacks a blocking certification', () => {
    const i = clean();
    i.technician.blockingGaps = ['EPA 608'];
    const r = computeJobRisk(i);
    expect(r.dimensions.technician.level).toBe('high');
    expect(r.coverage.decision).toBe('hold');
    expect(r.coverage.requiresAck).toBe(true);
    expect(r.flags.some((f) => f.code === 'technician_missing_certification')).toBe(true);
  });

  it('refers to the insurer when value exceeds the liability limit', () => {
    const i = clean();
    i.policy.liabilityLimitCents = 500_000;
    i.liability.valueCents = 900_000;
    const r = computeJobRisk(i);
    expect(r.flags.some((f) => f.code === 'liability_exceeds_limit')).toBe(true);
    expect(r.coverage.decision).toBe('refer_to_insurer');
  });

  it('flags insufficient warranty documentation', () => {
    const i = clean();
    i.warranty.warrantyEquipmentCount = 1;
    i.warranty.activeWarrantyCount = 1;
    i.warranty.soonestExpiryDays = 200;
    i.warranty.docs = { serialOnFile: false, installDateOnFile: false, diagnosisNotes: false, beforePhotos: 0, evidenceVerdict: null };
    const r = computeJobRisk(i);
    expect(r.dimensions.warranty.level).toBe('high');
    expect(r.flags.some((f) => f.code === 'warranty_documentation_incomplete')).toBe(true);
  });

  it('treats out-of-warranty equipment as a paid-repair warning, not a documentation gap', () => {
    const i = clean();
    i.warranty.warrantyEquipmentCount = 1;
    i.warranty.expiredWarrantyCount = 1;
    const r = computeJobRisk(i);
    expect(r.flags.some((f) => f.code === 'warranty_expired')).toBe(true);
    expect(r.flags.some((f) => f.code === 'warranty_documentation_incomplete')).toBe(false);
  });

  it('marks parts and warranty as not applicable when nothing applies', () => {
    const r = computeJobRisk(clean());
    expect(r.dimensions.parts.applicable).toBe(false);
    expect(r.dimensions.warranty.applicable).toBe(false);
  });

  it('scores backordered parts by share of the order', () => {
    const i = clean();
    i.parts = { total: 2, backordered: 2, needed: 0, hoursUntilStart: 100 };
    const r = computeJobRisk(i);
    expect(r.dimensions.parts.level).toBe('high');
    expect(r.flags.some((f) => f.code === 'parts_backordered' && f.severity === 'high')).toBe(true);
  });

  it('does not treat an unassigned technician as safe', () => {
    const i = clean();
    i.technician = { ...i.technician, assigned: false };
    const r = computeJobRisk(i);
    expect(r.dimensions.technician.level).toBe('medium');
    expect(r.dimensions.technician.known).toBe(false);
    expect(r.dataGaps).toContain('Technician not assigned');
    expect(r.dataCoverage).toBeLessThan(1);
  });

  it('lowers data coverage when a source is unavailable', () => {
    const i = clean();
    i.unavailableSources = ['insurance_claims'];
    const r = computeJobRisk(i);
    expect(r.dataCoverage).toBeLessThan(1);
    expect(r.dataGaps.some((g) => g.includes('insurance_claims'))).toBe(true);
  });

  it('does not let one severe dimension get diluted by healthy ones', () => {
    const i = clean();
    i.technician.blockingGaps = ['Gas fitter licence'];
    const r = computeJobRisk(i);
    expect(r.overallLevel).not.toBe('low');
  });

  it('keeps every score inside 0–100 under worst-case input', () => {
    const i = clean();
    i.property = { hasAddress: false, commercial: true, equipment: [{ ageYears: 40, lifespanYears: 15 }, { ageYears: 30, lifespanYears: 15 }], priorClaims36m: 5, openClaim: true, customerReworkCount: 6 };
    i.technician = { assigned: true, blockingGaps: ['A', 'B'], advisoryGaps: ['C', 'D', 'E'], expiringSoon: [{ label: 'X', days: 3 }, { label: 'Y', days: 5 }, { label: 'Z', days: 7 }], reworkRatePct: 60, outcomesCount: 50, completedSameService: 0 };
    i.liability = { hazardTier: 2, valueCents: 99_000_000, afterHours: true, commercial: true, hasSla: true };
    i.policy.liabilityLimitCents = 100_000;
    i.parts = { total: 3, backordered: 3, needed: 3, hoursUntilStart: 1 };
    i.warranty = { warrantyEquipmentCount: 1, activeWarrantyCount: 1, expiredWarrantyCount: 0, soonestExpiryDays: 2, docs: { serialOnFile: false, installDateOnFile: false, diagnosisNotes: false, beforePhotos: 0, evidenceVerdict: 'fail' }, claim: { deadlineDays: -10 } };
    const r = computeJobRisk(i);
    for (const d of Object.values(r.dimensions)) {
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(100);
    }
    expect(r.overallScore).toBeLessThanOrEqual(100);
    expect(r.coverage.decision).toBe('hold');
  });

  it('is deterministic and produces a stable signature', () => {
    const a = computeJobRisk(clean());
    const b = computeJobRisk(clean());
    expect(a.signature).toBe(b.signature);
  });
});
