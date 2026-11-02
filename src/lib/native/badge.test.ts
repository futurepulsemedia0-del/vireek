import { describe, expect, it } from 'vitest';
import { normalizeBadgeCount } from './badge';

describe('normalizeBadgeCount', () => {
  it('floors and clamps', () => {
    expect(normalizeBadgeCount(3.9)).toBe(3);
    expect(normalizeBadgeCount(-1)).toBe(0);
    expect(normalizeBadgeCount(1e9)).toBe(99999);
    expect(normalizeBadgeCount('x')).toBe(0);
  });
});
