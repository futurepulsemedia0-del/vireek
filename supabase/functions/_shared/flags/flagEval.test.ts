import { describe, it, expect } from 'vitest';
import { createFlagEvaluator } from './flagEval.ts';

function setup(results: Array<boolean | 'error' | 'bad' | 'throw'>) {
  let t = 0;
  let calls = 0;
  const rpc = async () => {
    const r = results[Math.min(calls, results.length - 1)];
    calls += 1;
    if (r === 'throw') throw new Error('network');
    if (r === 'error') return { data: null, error: { message: 'x' } };
    if (r === 'bad') return { data: 'yes', error: null };
    return { data: r, error: null };
  };
  return { ev: createFlagEvaluator({ rpc, now: () => t, ttlMs: 1000, maxStaleMs: 5000 }), advance: (ms: number) => { t += ms; }, calls: () => calls };
}

describe('flag evaluator', () => {
  it('returns the evaluated value and caches it for the ttl', async () => {
    const h = setup([true]);
    expect(await h.ev.isOn('f', 't1')).toBe(true);
    expect(await h.ev.isOn('f', 't1')).toBe(true);
    expect(h.calls()).toBe(1);
    h.advance(1500);
    await h.ev.isOn('f', 't1');
    expect(h.calls()).toBe(2);
  });
  it('caches per tenant', async () => {
    const h = setup([true, false]);
    expect(await h.ev.isOn('f', 't1')).toBe(true);
    expect(await h.ev.isOn('f', 't2')).toBe(false);
  });
  it('defaults to OFF when the service fails and nothing is cached', async () => {
    for (const mode of ['error', 'bad', 'throw'] as const) {
      expect(await setup([mode]).ev.isOn('f', 't1')).toBe(false);
    }
    expect(await setup(['error']).ev.isOn('f', 't1', true)).toBe(true); // explicit fallback
  });
  it('serves the last known value during a blip, then falls back once too stale', async () => {
    const h = setup([true, 'error']);
    expect(await h.ev.isOn('f', 't1')).toBe(true);
    h.advance(2000);
    expect(await h.ev.isOn('f', 't1')).toBe(true);
    h.advance(5000);
    expect(await h.ev.isOn('f', 't1')).toBe(false);
  });
  it('shares one request across concurrent callers', async () => {
    const h = setup([true]);
    await Promise.all([h.ev.isOn('f', 't1'), h.ev.isOn('f', 't1'), h.ev.isOn('f', 't1')]);
    expect(h.calls()).toBe(1);
  });
});
