import { describe, it, expect } from 'vitest';
import { createHealthReporter, p95, type HealthSample } from './healthReporter.ts';

describe('p95', () => {
  it('returns 0 for empty and the 95th percentile otherwise', () => {
    expect(p95([])).toBe(0);
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  });
});

describe('health reporter', () => {
  it('flushes once a batch is full with correct counts', async () => {
    const out: HealthSample[] = [];
    const r = createHealthReporter({ flush: async (s) => { out.push(s); }, maxBatch: 4 });
    for (let i = 0; i < 4; i += 1) await r.recordRequest('f', 'canary', { ok: i !== 0, latencyMs: 100 * (i + 1) });
    expect(out).toHaveLength(1);
    expect(out[0].requests).toBe(4);
    expect(out[0].errors).toBe(1);
    expect(out[0].p95Ms).toBe(400);
  });
  it('flushes by age and keeps cohorts separate', async () => {
    let t = 0;
    const out: HealthSample[] = [];
    const r = createHealthReporter({ flush: async (s) => { out.push(s); }, now: () => t, maxAgeMs: 1000 });
    await r.recordRequest('f', 'baseline', { ok: true, latencyMs: 10 });
    await r.recordRequest('f', 'canary', { ok: true, latencyMs: 10 });
    t = 2000;
    await r.recordRequest('f', 'canary', { ok: true, latencyMs: 10 });
    expect(out).toHaveLength(1);
    expect(out[0].cohort).toBe('canary');
  });
  it('tracks call answers and flushAll drains the rest', async () => {
    const out: HealthSample[] = [];
    const r = createHealthReporter({ flush: async (s) => { out.push(s); } });
    await r.recordCall('f', 'canary', true);
    await r.recordCall('f', 'canary', false);
    await r.flushAll();
    expect(out[0].callsOffered).toBe(2);
    expect(out[0].callsAnswered).toBe(1);
  });
  it('never throws when the flush fails', async () => {
    const r = createHealthReporter({ flush: async () => { throw new Error('db'); }, maxBatch: 1 });
    await r.recordRequest('f', 'canary', { ok: true, latencyMs: 1 });
    expect(true).toBe(true);
  });
});
