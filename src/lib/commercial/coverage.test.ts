import { describe, it, expect } from 'vitest';
import { checkVisitCoverage, type CoverageContract, type CoveredAsset, type EntitlementState } from './coverage';

const active: CoverageContract = { status: 'active', startDate: '2027-01-01', endDate: '2027-12-31' };
const ent = (over: Partial<EntitlementState> = {}): EntitlementState[] => [{ kind: 'service_call', included: 4, used: 1, overageRateCents: 9_500, ...over }];
const q = { onDate: '2027-06-07', kind: 'service_call' as const };

describe('checkVisitCoverage', () => {
  it('covers an in-term, in-scope visit with entitlement left', () => {
    const v = checkVisitCoverage(active, [], ent(), q);
    expect(v.verdict).toBe('covered');
    expect(v.remainingAfter).toBe(2);
    expect(v.reasons).toEqual(['whole_customer_scope']);
  });
  it('rejects inactive contracts and visits outside the term (inclusive bounds)', () => {
    expect(checkVisitCoverage({ ...active, status: 'expired' }, [], ent(), q).reasons).toEqual(['contract_inactive']);
    expect(checkVisitCoverage(active, [], ent(), { ...q, onDate: '2026-12-31' }).reasons).toEqual(['outside_term']);
    expect(checkVisitCoverage(active, [], ent(), { ...q, onDate: '2028-01-01' }).verdict).toBe('not_covered');
    expect(checkVisitCoverage(active, [], ent(), { ...q, onDate: '2027-12-31' }).verdict).toBe('covered');
  });
  it('matches the specific equipment row before the site row', () => {
    const assets: CoveredAsset[] = [
      { siteId: 's1', equipmentId: null, level: 'full' },
      { siteId: 's1', equipmentId: 'e9', level: 'excluded' },
    ];
    expect(checkVisitCoverage(active, assets, ent(), { ...q, siteId: 's1', equipmentId: 'e9' }).reasons).toEqual(['asset_excluded']);
    expect(checkVisitCoverage(active, assets, ent(), { ...q, siteId: 's1', equipmentId: 'e1' }).verdict).toBe('covered');
    expect(checkVisitCoverage(active, assets, ent(), { ...q, siteId: 's2' }).reasons).toEqual(['asset_not_in_scope']);
  });
  it('applies coverage level to labor / parts', () => {
    const v = checkVisitCoverage(active, [{ siteId: 's1', equipmentId: null, level: 'labor_only' }], ent(), { ...q, siteId: 's1' });
    expect([v.laborCovered, v.partsCovered, v.reasons]).toEqual([true, false, ['parts_not_covered']]);
  });
  it('bills overage when entitlement is exhausted and a rate exists', () => {
    const v = checkVisitCoverage(active, [], ent({ used: 4 }), q);
    expect(v.verdict).toBe('covered_overage');
    expect(v.overageCents).toBe(9_500);
    expect(v.laborCovered).toBe(false);
  });
  it('is not covered when exhausted with no overage rate, or when the kind is not in the agreement', () => {
    expect(checkVisitCoverage(active, [], ent({ used: 4, overageRateCents: null }), q).reasons).toEqual(['whole_customer_scope', 'entitlement_exhausted']);
    expect(checkVisitCoverage(active, [], [], q).reasons).toEqual(['whole_customer_scope', 'kind_not_included']);
  });
  it('splits a multi-unit request across entitlement and overage', () => {
    const v = checkVisitCoverage(active, [], [{ kind: 'labor_hours', included: 10, used: 8, overageRateCents: 12_000 }], { onDate: '2027-06-07', kind: 'labor_hours', quantity: 3.5 });
    expect([v.verdict, v.coveredQuantity, v.overageQuantity, v.overageCents]).toEqual(['covered_overage', 2, 1.5, 18_000]);
  });
  it('rejects non-positive quantities', () => expect(() => checkVisitCoverage(active, [], ent(), { ...q, quantity: 0 })).toThrow(RangeError));
});
