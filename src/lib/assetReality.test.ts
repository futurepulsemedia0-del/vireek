import { describe, it, expect } from 'vitest';
import {
  normalizeMeasurement, adaptRrReading, adaptTelemetryReading, adaptJobFormField, splitLegacyMetric,
  deriveDeltaT, deriveSuperheat, deriveSubcooling, deriveAmpRatio, CANONICAL_KINDS, KIND_DIMENSION, PHYSICAL_RANGE,
} from '../../supabase/functions/_shared/asset-reality/measurement';
import { METRIC_KINDS } from '../../supabase/functions/_shared/telemetry/anomaly';

const NOW = new Date('2026-11-07T12:00:00Z');
const AT = '2026-11-07T11:59:00Z';

describe('canonical measurement', () => {
  it('is a superset of telemetry METRIC_KINDS and has range+dimension for every kind', () => {
    for (const k of METRIC_KINDS) expect(CANONICAL_KINDS).toContain(k);
    for (const k of CANONICAL_KINDS) { expect(KIND_DIMENSION[k]).toBeTruthy(); expect(PHYSICAL_RANGE[k]).toHaveLength(2); }
  });
  it.each([
    [32, 'degF', 0], [212, 'degF', 100], [273.15, 'K', 0], [20, 'degC', 20],
  ])('converts temperature %s %s -> %s C', (v, u, exp) => {
    const r = normalizeMeasurement({ kind: 'zone_temp', value: v, unit: u, measured_at: AT, method: 'manual' }, NOW);
    expect(r.ok && r.measurement.value).toBeCloseTo(exp, 6);
  });
  it('temperature DIFFERENCE has no offset (delta_t 18 dF = 10 K)', () => {
    const r = normalizeMeasurement({ kind: 'delta_t', value: 18, unit: 'dF', measured_at: AT, method: 'instrument' }, NOW);
    expect(r.ok && r.measurement.value).toBeCloseTo(10, 6);
  });
  it('rejects absolute-temperature unit for a difference kind', () => {
    const r = normalizeMeasurement({ kind: 'delta_t', value: 18, unit: 'degF', measured_at: AT, method: 'instrument' }, NOW);
    expect(r).toEqual({ ok: false, reason: 'unit_dimension_mismatch' });
  });
  it('psig adds standard atmosphere and flags it; psia does not', () => {
    const g = normalizeMeasurement({ kind: 'suction_pressure', value: 118, unit: 'psig', measured_at: AT, method: 'instrument', instrument: { calibrated_on: '2026-06-01' } }, NOW);
    const a = normalizeMeasurement({ kind: 'suction_pressure', value: 118, unit: 'psia', measured_at: AT, method: 'instrument', instrument: { calibrated_on: '2026-06-01' } }, NOW);
    expect(g.ok && g.measurement.value).toBeCloseTo(118 * 6.894757293168 + 101.325, 3);
    expect(g.ok && g.measurement.quality).toContain('gauge_pressure_assumed_std_atm');
    expect(a.ok && a.measurement.value).toBeCloseTo(118 * 6.894757293168, 3);
  });
  it('converts cfm, gpm, inWC', () => {
    const f = normalizeMeasurement({ kind: 'flow_rate', value: 400, unit: 'cfm', measured_at: AT, method: 'sensor' }, NOW);
    expect(f.ok && f.measurement.value).toBeCloseTo(188.779, 2);
    const s = normalizeMeasurement({ kind: 'static_pressure', value: 0.5, unit: 'inWC', measured_at: AT, method: 'instrument' }, NOW);
    expect(s.ok && s.measurement.value).toBeCloseTo(124.544, 2);
  });
  it.each([
    ['unknown kind', { kind: 'nope', value: 1, measured_at: AT, method: 'manual' }, 'invalid_kind'],
    ['NaN', { kind: 'zone_temp', value: NaN, measured_at: AT, method: 'manual' }, 'invalid_value'],
    ['unknown unit', { kind: 'zone_temp', value: 1, unit: 'rankine', measured_at: AT, method: 'manual' }, 'unknown_unit'],
    ['spoofed range', { kind: 'zone_temp', value: 900, unit: 'degC', measured_at: AT, method: 'sensor' }, 'out_of_physical_range'],
    ['future', { kind: 'zone_temp', value: 20, measured_at: '2026-11-08T00:00:00Z', method: 'sensor' }, 'measured_in_future'],
    ['too old', { kind: 'zone_temp', value: 20, measured_at: '2024-01-01T00:00:00Z', method: 'sensor' }, 'measured_too_old'],
    ['bad digest', { kind: 'zone_temp', value: 20, measured_at: AT, method: 'ocr', evidence_digest: 'xyz' }, 'invalid_evidence_digest'],
    ['derived w/o inputs', { kind: 'delta_t', value: 5, measured_at: AT, method: 'derived' }, 'derived_requires_inputs'],
  ])('rejects %s', (_n, input, reason) => {
    expect(normalizeMeasurement(input as never, NOW)).toEqual({ ok: false, reason });
  });
  it('keeps measured_at distinct from received_at and never invents uncertainty', () => {
    const r = normalizeMeasurement({ kind: 'zone_temp', value: 21, measured_at: AT, method: 'instrument' }, NOW);
    expect(r.ok && r.measurement.measured_at).toBe('2026-11-07T11:59:00.000Z');
    expect(r.ok && r.measurement.received_at).toBe(NOW.toISOString());
    expect(r.ok && r.measurement.uncertainty).toBeNull();
    expect(r.ok && r.measurement.quality).toContain('uncalibrated');
  });
  it('flags expired calibration, manual and unconfirmed OCR', () => {
    const e = normalizeMeasurement({ kind: 'zone_temp', value: 21, measured_at: AT, method: 'instrument', instrument: { calibrated_on: '2024-01-01', tolerance: 0.5 } }, NOW);
    expect(e.ok && e.measurement.quality).toContain('calibration_expired');
    expect(e.ok && e.measurement.uncertainty).toBe(0.5);
    const o = normalizeMeasurement({ kind: 'line_voltage', value: 240, measured_at: AT, method: 'ocr' }, NOW);
    expect(o.ok && o.measurement.quality).toContain('ocr_unconfirmed');
  });
});

describe('adapters', () => {
  it('splits legacy rr metric names and converts', () => {
    expect(splitLegacyMetric('supply_air_temp_f')).toEqual({ kind: 'supply_air_temp', unit: 'degF' });
    const r = normalizeMeasurement(adaptRrReading({ metric: 'supply_air_temp_f', value: 55.4, observed_at: AT }, 'eq1', 'dev1'), NOW);
    expect(r.ok && r.measurement.value).toBeCloseTo(13, 1);
    expect(r.ok && r.measurement.equipment_id).toBe('eq1');
  });
  it('telemetry free-text unit: unknown unit rejected, not guessed', () => {
    const p = { metric: 'zone_temp', unit: 'celsius?', equipment_id: null, gateway_id: 'g1' };
    expect(normalizeMeasurement(adaptTelemetryReading(p, { ts: AT, value: 20 }), NOW)).toEqual({ ok: false, reason: 'unknown_unit' });
    expect(normalizeMeasurement(adaptTelemetryReading({ ...p, unit: 'C' }, { ts: AT, value: 20 }), NOW).ok).toBe(true);
  });
  it('job-form bluetooth => instrument, manual => manual', () => {
    const b = normalizeMeasurement(adaptJobFormField({ kind: 'compressor_current', value: 14.2, unit: 'A', at: AT, source: 'bluetooth', instrumentId: 'clamp-1' }), NOW);
    const m = normalizeMeasurement(adaptJobFormField({ kind: 'compressor_current', value: 14.2, unit: 'A', at: AT, source: 'manual' }), NOW);
    expect(b.ok && b.measurement.method).toBe('instrument');
    expect(m.ok && m.measurement.method).toBe('manual');
  });
});

describe('derivations', () => {
  it('delta-T, superheat, subcooling, amp ratio are deterministic with recorded inputs', () => {
    expect(deriveDeltaT(24, 13)).toMatchObject({ value: 11, kind: 'delta_t', inputs: { returnAirC: 24, supplyAirC: 13 } });
    expect(deriveSuperheat(12, 4)?.value).toBe(8);
    expect(deriveSubcooling(46, 40)?.value).toBe(6);
    expect(deriveAmpRatio(12, 15)?.value).toBe(0.8);
  });
  it('missing/invalid input => null (unknown), never a guess', () => {
    expect(deriveDeltaT(NaN, 1)).toBeNull();
    expect(deriveAmpRatio(10, 0)).toBeNull();
    expect(deriveAmpRatio(-1, 10)).toBeNull();
  });
});

describe('regression: kelvin interval default', () => {
  it('delta_t with no unit or "K" is a K interval, not an absolute temperature', () => {
    for (const unit of [undefined, 'K']) {
      const r = normalizeMeasurement({ kind: 'delta_t', value: 10, unit, measured_at: AT, method: 'instrument' }, NOW);
      expect(r.ok && r.measurement.value).toBe(10);
    }
  });
});
