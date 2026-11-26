import { describe, expect, it } from 'vitest';
import { wouldExceedQuota } from './queueLimits';

describe('wouldExceedQuota', () => {
  it('allows when the quota is unknown', () => {
    expect(wouldExceedQuota(1e9, undefined)).toBe(false);
    expect(wouldExceedQuota(1e9, {})).toBe(false);
    expect(wouldExceedQuota(1e9, { usage: 1, quota: 0 })).toBe(false);
  });
  it('allows below 90 % and blocks above', () => {
    expect(wouldExceedQuota(100, { usage: 800, quota: 1000 })).toBe(false);
    expect(wouldExceedQuota(101, { usage: 800, quota: 1000 })).toBe(true);
  });
  it('ignores negative sizes', () => expect(wouldExceedQuota(-5, { usage: 900, quota: 1000 })).toBe(false));
});
