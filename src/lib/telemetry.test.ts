import { describe, expect, it } from 'vitest';
import {
  computeBaseline, detectAnomalies, MIN_BASELINE_N, type Reading,
} from '../../supabase/functions/_shared/telemetry/anomaly';
import {
  applyCalibration, matchParts, scoreFailureModes, type Signal,
} from '../../supabase/functions/_shared/telemetry/failureModes';

// Deterministic pseudo-random noise so the suite is never flaky.
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
const rnd = rng(42);
const noise = (a: number) => (rnd() - 0.5) * 2 * a;

const NORMAL = computeBaseline(Array.from({ length: 400 }, () => 18 + noise(0.8)));
const T0 = Date.UTC(2027, 1, 5) - 24 * 3_600_000;
const series = (f: (i: number) => number, n = 48): Reading[] =>
  Array.from({ length: n }, (_, i) => ({ ts: T0 + i * 30 * 60_000, value: f(i) }));

describe('anomaly detection', () => {
  it('stays quiet on normal behaviour', () => {
    expect(detectAnomalies({ metric: 'delta_t' }, series(() => 18 + noise(0.8)), NORMAL)).toEqual([]);
  });

  it('flags a confirmed spike but ignores a single-sample glitch', () => {
    const spike = detectAnomalies({ metric: 'delta_t' }, series((i) => (i >= 45 ? 5 : 18 + noise(0.8))), NORMAL);
    expect(spike[0]?.kind).toBe('spike');
    expect(spike[0]?.direction).toBe('low');
    const glitch = detectAnomalies({ metric: 'delta_t' }, series((i) => (i === 47 ? 5 : 18 + noise(0.8))), NORMAL);
    expect(glitch.some((a) => a.kind === 'spike')).toBe(false);
  });

  it('reports a sustained shift as drift, not spike', () => {
    const out = detectAnomalies({ metric: 'delta_t' }, series(() => 15 + noise(0.3)), NORMAL);
    expect(out.map((a) => a.kind)).toEqual(['drift']);
  });

  it('detects a frozen sensor', () => {
    const out = detectAnomalies({ metric: 'delta_t' }, series(() => 18), NORMAL);
    expect(out.some((a) => a.kind === 'flatline')).toBe(true);
  });

  it('applies hard limits even before a baseline exists', () => {
    const learning = computeBaseline([1, 2, 3]);
    expect(learning.n).toBeLessThan(MIN_BASELINE_N);
    const out = detectAnomalies({ metric: 'discharge_pressure', maxValid: 30 }, series(() => 40, 3), learning);
    expect(out[0]?.kind).toBe('out_of_range');
    expect(detectAnomalies({ metric: 'delta_t' }, series(() => 5, 3), learning)).toEqual([]);
  });
});

const sig = (metric: Signal['metric'], kind: Signal['kind'], direction: Signal['direction'], zAbs: number): Signal =>
  ({ metric, kind, direction, zAbs, persistenceHours: 12 });

describe('failure probability', () => {
  it('does not alarm on one weak signal', () => {
    expect(scoreFailureModes('Heat pump', [sig('suction_pressure', 'drift', 'low', 4)])).toEqual([]);
  });

  it('ranks low refrigerant charge first when its signature appears', () => {
    const r = scoreFailureModes('Heat pump Carrier', [
      sig('suction_pressure', 'drift', 'low', 6), sig('superheat', 'spike', 'high', 8), sig('delta_t', 'drift', 'low', 5),
    ]);
    expect(r[0].mode.id).toBe('low_refrigerant_charge');
    expect(r[0].probability).toBeGreaterThan(0.6);
    expect(r[0].probability).toBeLessThanOrEqual(0.97);
  });

  it('keeps HVAC failure modes away from unrelated equipment', () => {
    const ids = scoreFailureModes('Garage door opener', [sig('zone_temp', 'spike', 'high', 8), sig('setpoint', 'drift', 'low', 6)]).map((s) => s.mode.id);
    expect(ids).toEqual(['sensor_or_control_fault']);
  });

  it('does not treat a heat pump as a hydronic circulator pump', () => {
    const ids = scoreFailureModes('Heat pump Carrier', [sig('suction_pressure', 'drift', 'low', 6), sig('superheat', 'spike', 'high', 8), sig('delta_t', 'drift', 'low', 5), sig('flow_rate', 'drift', 'low', 6), sig('pump_pressure', 'drift', 'low', 6)]).map((s) => s.mode.id);
    expect(ids).not.toContain('pump_degradation');
    expect(ids).not.toContain('heat_transfer_loss');
  });

  it('calibration boosts reliable modes and damps noisy ones', () => {
    expect(applyCalibration(0.6, 8, 1)).toBeGreaterThan(0.6);
    expect(applyCalibration(0.6, 1, 8)).toBeLessThan(0.6);
    expect(applyCalibration(0.6, 0, 0)).toBeCloseTo(0.6, 2);
  });

  it('matches parts against the account catalogue', () => {
    const [m] = matchParts([{ label: 'Run capacitor', keywords: ['capacitor'], qty: 1 }], [{ id: 'p1', name: '45/5 µF Dual Run Capacitor', part_number: null }]);
    expect(m.part_id).toBe('p1');
  });
});
