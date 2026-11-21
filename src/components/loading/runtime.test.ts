import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_MIN_VISIBLE_MS,
  BOOT_SHOW_AFTER_MS,
  bootDismissPlan,
  dismissBootLoader,
} from '@/components/loading/runtime';
import { MIN_VISIBLE_MS, SHOW_AFTER_MS } from '@/components/loading/delayedVisibility';

describe('boot timing constants', () => {
  it('stay in step with the shared loader rules (250ms delay, 500ms minimum)', () => {
    expect(BOOT_SHOW_AFTER_MS).toBe(SHOW_AFTER_MS);
    expect(BOOT_MIN_VISIBLE_MS).toBe(MIN_VISIBLE_MS);
    expect(SHOW_AFTER_MS).toBe(250);
    expect(MIN_VISIBLE_MS).toBe(500);
  });
});

describe('bootDismissPlan', () => {
  it('removes silently when the content never appeared', () => {
    expect(bootDismissPlan(-120)).toEqual({ instant: true, waitMs: 0 });
    expect(bootDismissPlan(0)).toEqual({ instant: true, waitMs: 0 });
    expect(bootDismissPlan(Number.NaN)).toEqual({ instant: true, waitMs: 0 });
  });
  it('holds the remainder of the 500ms minimum, never more', () => {
    expect(bootDismissPlan(100)).toEqual({ instant: false, waitMs: 400 });
    expect(bootDismissPlan(499)).toEqual({ instant: false, waitMs: 1 });
    expect(bootDismissPlan(500)).toEqual({ instant: false, waitMs: 0 });
    expect(bootDismissPlan(4000)).toEqual({ instant: false, waitMs: 0 });
  });
});

describe('dismissBootLoader', () => {
  const mount = () => {
    const el = document.createElement('div');
    el.id = 'vrk-boot';
    document.body.appendChild(el);
    return el;
  };
  // jsdom has no navigation entry, so responseStart is 0 and visible time = performance.now() - 250.
  const at = (now: number) => vi.spyOn(performance, 'now').mockReturnValue(now);

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.getElementById('vrk-boot')?.remove();
  });

  it('fast load (before the content appears): removed at once, no fade', () => {
    at(120);
    const el = mount();
    dismissBootLoader();
    expect(el.isConnected).toBe(false);
  });

  it('visible for only 200ms: stays 300 more ms, then fades and is removed', () => {
    at(450);
    const el = mount();
    dismissBootLoader();
    vi.advanceTimersByTime(299);
    expect(el.isConnected).toBe(true);
    expect(el).not.toHaveClass('o');
    vi.advanceTimersByTime(1);
    expect(el).toHaveClass('o');
    vi.advanceTimersByTime(540);
    expect(el.isConnected).toBe(false);
  });

  it('visible for 500ms or more: fades immediately', () => {
    at(2000);
    const el = mount();
    dismissBootLoader();
    expect(el).toHaveClass('o');
    vi.advanceTimersByTime(540);
    expect(el.isConnected).toBe(false);
  });

  it('is idempotent and safe when the element is already gone', () => {
    at(450);
    const el = mount();
    dismissBootLoader();
    dismissBootLoader();
    vi.advanceTimersByTime(300);
    expect(el).toHaveClass('o');
    vi.advanceTimersByTime(540);
    expect(() => dismissBootLoader()).not.toThrow();
  });
});
