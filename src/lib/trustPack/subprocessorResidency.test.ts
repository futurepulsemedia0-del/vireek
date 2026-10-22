import { describe, it, expect } from 'vitest';
import { SUBPROCESSOR_CATEGORIES } from '@/lib/subprocessors';
import { PROCESSOR_RESIDENCY, classifyProcessor, residencyImpact } from './subprocessorResidency';

const all = SUBPROCESSOR_CATEGORIES.flatMap((c) => c.processors);

describe('sub-processor residency classification', () => {
  it('classifies EVERY processor in subprocessors.ts (add a vendor => classify it here)', () => {
    expect(all.filter((p) => classifyProcessor(p) === null).map((p) => p.name)).toEqual([]);
  });
  it('has no stale entries for vendors that were removed', () => {
    const names = new Set(all.map((p) => p.name));
    expect(Object.keys(PROCESSOR_RESIDENCY).filter((n) => !names.has(n))).toEqual([]);
  });
  it('flags US-only AI/voice processors for EU and CA tenants but not US tenants', () => {
    const eu = residencyImpact('eu');
    expect(eu.outsideRegion.map((p) => p.name)).toContain('Vapi Inc.');
    expect(eu.inRegion.map((p) => p.name)).toEqual(['Supabase, Inc.']);
    expect(residencyImpact('ca').outsideRegion.length).toBe(eu.outsideRegion.length);
    const us = residencyImpact('us');
    expect(us.outsideRegion).toEqual([]);
    expect(us.inRegion.map((p) => p.name)).toContain('Vapi Inc.');
  });
  it('separates optional and no-content vendors and leaves nothing unclassified', () => {
    const r = residencyImpact('eu');
    expect(r.customerOptional.length).toBe(3);
    expect(r.noCustomerContent.map((p) => p.name)).toContain('Vercel Inc.');
    expect(r.unclassified).toEqual([]);
  });
});
