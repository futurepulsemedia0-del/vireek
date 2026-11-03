import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDelayedFlag } from './useDelayedFlag';

describe('useDelayedFlag', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays false for fast loads', () => {
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on, 300), { initialProps: { on: true } });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(250); });
    rerender({ on: false });
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current).toBe(false);
  });

  it('turns true after the delay and false as soon as loading ends', () => {
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on, 300), { initialProps: { on: true } });
    act(() => { vi.advanceTimersByTime(301); });
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
  });
});
