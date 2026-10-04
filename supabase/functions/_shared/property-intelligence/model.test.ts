import { describe, it, expect } from 'vitest';
import {
  applyCalibration,
  calibrationFactor,
  computePredictions,
  lifecyclePrior,
  MISSION_MIN_PROBABILITY,
  type EquipmentContext,
  type MetricFeature,
} from './model';

const NOW = new Date('2027-01-10T12:00:00Z');
const eq: EquipmentContext = {
  id: 'eq-1', equipment_type: 'HVAC condenser', make: 'Carrier', model: 'X1',
  install_date: '2014-05-01', last_service_date: '2025-01-01',
  expected_lifespan_years: 15, service_interval_months: 12,
};

const feat = (metric: string, over: Partial<MetricFeature> = {}): MetricFeature => ({
  equipment_id: 'eq-1', metric, n_baseline: 400, base_mean: 10, base_std: 0.5,
  n_recent: 60, recent_mean: 10, recent_p95: 10.8, slope_per_day: 0, last_value: 10, last_at: NOW.toISOString(), ...over,
});

describe('property intelligence model', () => {
  it('stays quiet on healthy telemetry', () => {
    const out = computePredictions(eq, [feat('vibration_mm_s'), feat('current_a'), feat('temp_delta_f')], new Map(), NOW);
    expect(out).toHaveLength(0);
  });

  it('flags compressor failure when vibration, current and delta-T all degrade', () => {
    const out = computePredictions(eq, [
      feat('vibration_mm_s', { recent_mean: 15, slope_per_day: 0.5 }),
      feat('current_a', { recent_mean: 13.5, slope_per_day: 0.3 }),
      feat('temp_delta_f', { recent_mean: 6, slope_per_day: -0.4 }),
      feat('discharge_pressure_psi', { recent_mean: 14, slope_per_day: 0.3 }),
    ], new Map(), NOW);
    expect(out[0].failure_mode).toBe('compressor_failure');
    expect(out[0].probability).toBeGreaterThanOrEqual(MISSION_MIN_PROBABILITY);
    expect(out[0].confidence).toBeGreaterThan(0.5);
    expect(out[0].horizon_days_max).toBeGreaterThan(out[0].horizon_days_min);
    expect(out[0].evidence.length).toBeGreaterThanOrEqual(3);
  });

  it('ignores signals with too little data', () => {
    const out = computePredictions(eq, [feat('vibration_mm_s', { recent_mean: 20, n_recent: 3 })], new Map(), NOW);
    expect(out).toHaveLength(0);
  });

  it('does not misfire on a wrong-direction change', () => {
    const out = computePredictions(eq, [feat('temp_delta_f', { recent_mean: 14 })], new Map(), NOW);
    expect(out).toHaveLength(0);
  });

  it('escalates water leaks to critical', () => {
    const heater: EquipmentContext = { ...eq, id: 'eq-1', equipment_type: 'Water heater' };
    const out = computePredictions(heater, [
      feat('water_leak', { base_mean: 0, base_std: 0, recent_mean: 1, recent_p95: 1 }),
      feat('humidity_pct', { base_mean: 45, base_std: 3, recent_mean: 78 }),
    ], new Map(), NOW);
    expect(out[0].failure_mode).toBe('water_leak');
    expect(out[0].severity).toBe('critical');
  });

  it('calibration moves probability in the right direction', () => {
    expect(applyCalibration(0.7, 1.3)).toBeGreaterThan(0.7);
    expect(applyCalibration(0.7, 0.7)).toBeLessThan(0.7);
    expect(calibrationFactor(0, 0)).toBeCloseTo(1, 1);
    expect(calibrationFactor(9, 10)).toBeGreaterThan(1);
    expect(calibrationFactor(1, 10)).toBeLessThan(1);
  });

  it('older, overdue units carry a higher lifecycle prior', () => {
    const young = lifecyclePrior({ ...eq, install_date: '2024-01-01', last_service_date: '2026-12-01' }, NOW);
    expect(lifecyclePrior(eq, NOW)).toBeGreaterThan(young);
  });
});
