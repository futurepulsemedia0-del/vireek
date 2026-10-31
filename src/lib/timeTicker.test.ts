import { afterEach, describe, expect, it, vi } from 'vitest';
import { TICK_MS, getTickerNow, subscribeTicker, tickerSubscriberCount } from './timeTicker';

afterEach(() => vi.useRealTimers());

describe('timeTicker', () => {
  it('runs ONE interval for many subscribers and stops when the last leaves', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeTicker(a);
    const offB = subscribeTicker(b);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TICK_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
    expect(tickerSubscriberCount()).toBe(0);
    vi.advanceTimersByTime(TICK_MS * 3);
    expect(a).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('advances getTickerNow on each tick', () => {
    vi.useFakeTimers();
    const off = subscribeTicker(() => undefined);
    const first = getTickerNow();
    vi.advanceTimersByTime(TICK_MS);
    expect(getTickerNow() - first).toBeGreaterThanOrEqual(TICK_MS);
    off();
  });
});
