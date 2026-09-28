import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

import {
  badgeCount,
  isTrustedService,
  missingSignals,
  summarizeTrust,
  tierFromScore,
  type JobTrustScore,
  type TrustBadges,
} from './jobTrustLayer';

const allBadges: TrustBadges = {
  technician_verified: true,
  price_locked: true,
  parts_verified: true,
  work_documented: true,
  warranty_active: true,
};

const row = (over: Partial<JobTrustScore>): JobTrustScore => ({
  job_id: 'j1', user_id: 'u1', trust_score: 92, tier: 'excellent', coverage: 90,
  dimensions: [{ signal: 'eta_accuracy', weight: 12, score: 92, verified: true }],
  badges: allBadges, updated_at: '2026-01-01T00:00:00Z', job: null, ...over,
});

describe('tierFromScore', () => {
  it('maps scores to tiers', () => {
    expect(tierFromScore(95, 100)).toBe('excellent');
    expect(tierFromScore(80, 100)).toBe('good');
    expect(tierFromScore(65, 100)).toBe('fair');
    expect(tierFromScore(40, 100)).toBe('at_risk');
  });
  it('never finalizes a score with thin evidence', () => {
    expect(tierFromScore(99, 30)).toBe('pending');
    expect(tierFromScore(null, 100)).toBe('pending');
  });
});

describe('isTrustedService', () => {
  it('requires excellent tier, 80% coverage and all five badges', () => {
    expect(isTrustedService({ tier: 'excellent', coverage: 90, badges: allBadges })).toBe(true);
    expect(isTrustedService({ tier: 'excellent', coverage: 70, badges: allBadges })).toBe(false);
    expect(isTrustedService({ tier: 'good', coverage: 90, badges: allBadges })).toBe(false);
    expect(isTrustedService({ tier: 'excellent', coverage: 90, badges: { ...allBadges, warranty_active: false } })).toBe(false);
  });
  it('counts badges', () => {
    expect(badgeCount({ price_locked: true })).toBe(1);
  });
});

describe('missingSignals', () => {
  it('lists signals without evidence', () => {
    const missing = missingSignals([{ signal: 'eta_accuracy' }, { signal: 'warranty' }]);
    expect(missing).not.toContain('eta_accuracy');
    expect(missing).toContain('work_evidence');
    expect(missing).toHaveLength(8);
  });
});

describe('summarizeTrust', () => {
  it('ignores pending rows and finds the weakest signal', () => {
    const s = summarizeTrust([
      row({}),
      row({ job_id: 'j2', trust_score: 50, tier: 'at_risk', badges: {}, dimensions: [{ signal: 'eta_accuracy', weight: 12, score: 50, verified: true }, { signal: 'warranty', weight: 8, score: 30, verified: false }] }),
      row({ job_id: 'j3', trust_score: null, tier: 'pending', coverage: 0, dimensions: [] }),
    ]);
    expect(s.total).toBe(3);
    expect(s.scored).toBe(2);
    expect(s.avgScore).toBe(71);
    expect(s.atRisk).toBe(1);
    expect(s.trusted).toBe(1);
    expect(s.weakest?.signal).toBe('warranty');
  });
  it('handles empty input', () => {
    expect(summarizeTrust([]).avgScore).toBeNull();
  });
});
