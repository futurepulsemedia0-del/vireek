import { describe, expect, it } from 'vitest';
import {
  bandFor,
  clearingErrorMessage,
  evaluateSpec,
  formatRemaining,
  parseNumber,
  settleGate,
  slugifyMetric,
  validateMeasurement,
  type ClearingRecord,
  type MeasurementInput,
} from './outcomeClearinghouse';

const NOW = Date.parse('2027-04-15T12:00:00Z');

function rec(over: Partial<ClearingRecord>): ClearingRecord {
  return {
    id: 'r1', job_id: 'j1', technician_id: null, outcome_type: 'repair_restored', claim_statement: 'x',
    status: 'verified', status_before_dispute: null, confidence: 90, confidence_band: 'high', assessment: {},
    assessed_at: null, evidence_head_hash: null, evidence_entries: 0, verified_at: null,
    dispute_window_ends_at: '2027-04-10T00:00:00Z', settled_at: null, settle_override_note: null, void_reason: null,
    customer_confirmed_at: null, public_enabled: false, created_at: '', updated_at: '', ...over,
  };
}

const input = (over: Partial<MeasurementInput> = {}): MeasurementInput => ({
  metricKey: '', label: 'Supply air temp', unit: 'F', phase: 'after', value: '55', expectedMin: '50', expectedMax: '60',
  source: 'technician', deviceRef: '', ...over,
});

describe('bandFor', () => {
  it('maps confidence to bands at the exact thresholds', () => {
    expect(bandFor(100)).toBe('high');
    expect(bandFor(85)).toBe('high');
    expect(bandFor(84)).toBe('moderate');
    expect(bandFor(70)).toBe('moderate');
    expect(bandFor(69)).toBe('low');
    expect(bandFor(40)).toBe('low');
    expect(bandFor(39)).toBe('insufficient');
    expect(bandFor(0)).toBe('insufficient');
  });
});

describe('evaluateSpec', () => {
  it('is inclusive on both bounds', () => {
    expect(evaluateSpec(50, 50, 60)).toBe(true);
    expect(evaluateSpec(60, 50, 60)).toBe(true);
    expect(evaluateSpec(49.99, 50, 60)).toBe(false);
    expect(evaluateSpec(60.01, 50, 60)).toBe(false);
  });
  it('supports one-sided ranges and returns null without a range or with a bad value', () => {
    expect(evaluateSpec(5, null, 10)).toBe(true);
    expect(evaluateSpec(15, null, 10)).toBe(false);
    expect(evaluateSpec(15, 10, null)).toBe(true);
    expect(evaluateSpec(15, null, null)).toBeNull();
    expect(evaluateSpec(Number.NaN, 1, 2)).toBeNull();
  });
});

describe('parseNumber', () => {
  it('accepts comma decimals and rejects junk', () => {
    expect(parseNumber('12,5')).toBe(12.5);
    expect(parseNumber(' -3 ')).toBe(-3);
    expect(parseNumber('.5')).toBe(0.5);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('1e5')).toBeNull();
    expect(parseNumber('1.2.3')).toBeNull();
  });
});

describe('slugifyMetric', () => {
  it('produces a valid server key', () => {
    expect(slugifyMetric('Supply air temp (°F)')).toBe('supply_air_temp_f');
    expect(slugifyMetric('  --  ')).toBe('');
  });
});

describe('validateMeasurement', () => {
  it('accepts a valid reading and derives the key', () => {
    const v = validateMeasurement(input());
    expect(v.ok).toBe(true);
    expect(v.key).toBe('supply_air_temp');
    expect(v.value).toBe(55);
    expect(v.min).toBe(50);
    expect(v.max).toBe(60);
  });
  it('rejects inverted ranges, bad numbers and unnamed instruments', () => {
    expect(validateMeasurement(input({ expectedMin: '70' })).ok).toBe(false);
    expect(validateMeasurement(input({ value: 'x' })).ok).toBe(false);
    expect(validateMeasurement(input({ expectedMax: 'x' })).ok).toBe(false);
    expect(validateMeasurement(input({ source: 'device', deviceRef: ' ' })).ok).toBe(false);
    expect(validateMeasurement(input({ source: 'device', deviceRef: 'Testo 550 #123' })).ok).toBe(true);
    expect(validateMeasurement(input({ label: '' })).ok).toBe(false);
    expect(validateMeasurement(input({ metricKey: 'A' })).ok).toBe(false);
  });
  it('allows a reading without a range', () => {
    const v = validateMeasurement(input({ expectedMin: '', expectedMax: '' }));
    expect(v.ok).toBe(true);
    expect(v.min).toBeNull();
    expect(v.max).toBeNull();
  });
});

describe('settleGate', () => {
  it('allows a verified outcome once the dispute window has passed', () => {
    expect(settleGate(rec({}), NOW).allowed).toBe(true);
  });
  it('blocks while the window is open but allows an override', () => {
    const g = settleGate(rec({ dispute_window_ends_at: '2027-04-20T00:00:00Z' }), NOW);
    expect(g.allowed).toBe(false);
    expect(g.needsOverride).toBe(true);
  });
  it('blocks disputed, voided, settled and unverified outcomes without override', () => {
    for (const status of ['disputed', 'voided', 'settled', 'unverified', 'claimed'] as const) {
      const g = settleGate(rec({ status }), NOW);
      expect(g.allowed).toBe(false);
      expect(g.needsOverride).toBe(false);
    }
  });
  it('lets a manager override a partially verified outcome', () => {
    const g = settleGate(rec({ status: 'partially_verified' }), NOW);
    expect(g.allowed).toBe(false);
    expect(g.needsOverride).toBe(true);
  });
});

describe('formatRemaining', () => {
  it('formats minutes, hours and days', () => {
    expect(formatRemaining(0)).toBe('closed');
    expect(formatRemaining(30 * 60_000)).toBe('30 min left');
    expect(formatRemaining(5 * 3_600_000)).toBe('5 h left');
    expect(formatRemaining(72 * 3_600_000)).toBe('3 days left');
  });
});

describe('clearingErrorMessage', () => {
  it('extracts the server detail', () => {
    const msg = clearingErrorMessage({ message: 'OUTCOME_CLEARING_INVALID: metric key must be 2-48 characters' });
    expect(msg).toBe('Metric key must be 2-48 characters');
  });
  it('falls back for unknown errors', () => {
    expect(clearingErrorMessage({ message: 'permission denied' })).toBe('Something went wrong. Please try again.');
    expect(clearingErrorMessage(null, 'x')).toBe('x');
  });
});
