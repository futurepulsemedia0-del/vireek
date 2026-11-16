import { describe, expect, it } from 'vitest';
import { BANNER_RESHOW_AFTER_MS, isDismissalActive, scrollRatio } from '@/lib/consent/bannerTiming';

const NOW = 1_800_000_000_000;

describe('scrollRatio', () => {
  it('is 0 when the page does not scroll or input is invalid', () => {
    expect(scrollRatio(100, 700, 800)).toBe(0);
    expect(scrollRatio(Number.NaN, 3000, 800)).toBe(0);
  });
  it('reports the scrolled share and clamps to 1', () => {
    expect(scrollRatio(550, 3000, 800)).toBe(0.25);
    expect(scrollRatio(99999, 3000, 800)).toBe(1);
  });
});

describe('isDismissalActive', () => {
  it('ignores missing, garbage and future timestamps', () => {
    expect(isDismissalActive(null, NOW)).toBe(false);
    expect(isDismissalActive('x', NOW)).toBe(false);
    expect(isDismissalActive(String(NOW + 1000), NOW)).toBe(false);
  });
  it('suppresses for 7 days, then shows again', () => {
    expect(isDismissalActive(String(NOW - BANNER_RESHOW_AFTER_MS + 1), NOW)).toBe(true);
    expect(isDismissalActive(String(NOW - BANNER_RESHOW_AFTER_MS), NOW)).toBe(false);
  });
});
