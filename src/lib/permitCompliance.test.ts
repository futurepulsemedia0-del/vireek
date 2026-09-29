import { describe, expect, it, vi } from 'vitest';
import {
  complianceCounts,
  hasReviewableScope,
  unresolvedBlockers,
  type ComplianceItem,
  type ItemProgress,
} from '@/lib/permitCompliance';

const item = (key: string, severity: ComplianceItem['severity']): ComplianceItem => ({
  key,
  category: 'permit',
  severity,
  title: key,
  detail: '',
  authority: null,
  reference: null,
  confidence: 'medium',
  source: 'rule',
});
const prog = (status: ItemProgress['status']): ItemProgress => ({
  status,
  permit_number: null,
  note: null,
  updated_by: null,
  updated_at: null,
});

// Pure-helper tests: no Supabase client or env needed.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

describe('permitCompliance helpers', () => {
  const requirements = [
    item('a', 'blocker'),
    item('b', 'blocker'),
    item('c', 'warning'),
    item('d', 'info'),
  ];

  it('counts unresolved by severity and tracks resolved', () => {
    const review = {
      requirements,
      item_progress: { a: prog('satisfied'), c: prog('not_applicable') },
    };
    expect(complianceCounts(review)).toEqual({
      blockers: 1,
      warnings: 0,
      info: 1,
      resolved: 2,
      total: 4,
    });
  });

  it('only counts unresolved blockers, like the SQL helper', () => {
    const review = {
      requirements,
      item_progress: { a: prog('in_progress'), b: prog('satisfied') },
    };
    expect(unresolvedBlockers(review).map((r) => r.key)).toEqual(['a']);
  });

  it('treats missing progress as open', () => {
    expect(unresolvedBlockers({ requirements, item_progress: {} })).toHaveLength(2);
  });

  it('needs a service type or dispatch note to review', () => {
    expect(hasReviewableScope({ service_type: null, dispatch_note: '  ' })).toBe(false);
    expect(hasReviewableScope({ service_type: 'Panel upgrade', dispatch_note: null })).toBe(true);
    expect(hasReviewableScope({ service_type: '', dispatch_note: 'Replace water heater' })).toBe(
      true,
    );
  });
});
