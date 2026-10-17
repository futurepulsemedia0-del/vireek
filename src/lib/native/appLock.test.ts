import { describe, expect, it } from 'vitest';
import { RELOCK_AFTER_MS, shouldRelock } from './appLock';

describe('shouldRelock', () => {
  it('does not relock without a background event', () => {
    expect(shouldRelock(null, 1_000_000)).toBe(false);
  });

  it('keeps quick app switches unlocked', () => {
    expect(shouldRelock(1_000, 1_000 + RELOCK_AFTER_MS - 1)).toBe(false);
  });

  it('relocks after the grace period', () => {
    expect(shouldRelock(1_000, 1_000 + RELOCK_AFTER_MS)).toBe(true);
  });
});
