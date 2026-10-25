import { describe, it, expect } from 'vitest';
import { TRADE_PACKS } from './index';
import { INDUSTRIES } from '@/lib/industries';

describe('trade packs ↔ marketing industries', () => {
  it('every pack points at an existing industry page', () => {
    for (const p of TRADE_PACKS) expect(INDUSTRIES.some((i) => i.slug === p.industrySlug)).toBe(true);
  });
});
