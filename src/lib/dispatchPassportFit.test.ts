import { describe, it, expect } from 'vitest';
import {
  buildPassportFitMap,
  passportFitBonus,
  passportFitHeadline,
  passportFitReasons,
  type PassportFitRow,
} from './dispatchPassportFit';

function row(o: Partial<PassportFitRow> = {}): PassportFitRow {
  return {
    job_id: 'j1',
    technician_id: 't1',
    service_key: 'furnace repair',
    service_confidence: null,
    service_jobs: null,
    equipment_key: null,
    equipment_confidence: null,
    equipment_jobs: null,
    ...o,
  };
}

describe('passportFitBonus', () => {
  it('is 0 without evidence', () => {
    expect(passportFitBonus(undefined)).toBe(0);
    expect(passportFitBonus(row())).toBe(0);
  });

  it('rewards proven high confidence', () => {
    expect(passportFitBonus(row({ service_confidence: 100, service_jobs: 20 }))).toBe(12);
    expect(passportFitBonus(row({ service_confidence: 90, service_jobs: 20, equipment_confidence: 90, equipment_jobs: 20 }))).toBe(10 + 6);
  });

  it('discounts small samples', () => {
    const full = passportFitBonus(row({ service_confidence: 90, service_jobs: 20 }));
    const few = passportFitBonus(row({ service_confidence: 90, service_jobs: 2 }));
    expect(few).toBeLessThan(full);
    expect(few).toBeGreaterThan(0);
  });

  it('bounds the penalty for low confidence', () => {
    expect(passportFitBonus(row({ service_confidence: 0, service_jobs: 30 }))).toBe(-6);
  });
});

describe('helpers', () => {
  it('builds a job -> technician map', () => {
    const map = buildPassportFitMap([row({ technician_id: 'a' }), row({ technician_id: 'b' })]);
    expect(Object.keys(map.j1)).toEqual(['a', 'b']);
  });

  it('prefers equipment confidence for the headline', () => {
    expect(passportFitHeadline(row({ service_confidence: 70, service_jobs: 9, equipment_confidence: 91, equipment_jobs: 4 }))).toBe(91);
    expect(passportFitHeadline(row({ service_confidence: 70, service_jobs: 9 }))).toBe(70);
    expect(passportFitHeadline(row())).toBeNull();
  });

  it('explains the fit, flagging provisional data', () => {
    const r = passportFitReasons(row({ service_confidence: 94, service_jobs: 38, equipment_key: 'Carrier furnace', equipment_confidence: 71, equipment_jobs: 3 }));
    expect(r).toHaveLength(2);
    expect(r[0]).toContain('94%');
    expect(r[1]).toContain('provisional');
  });
});
