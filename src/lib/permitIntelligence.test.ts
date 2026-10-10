import { describe, it, expect } from 'vitest';
import type { ComplianceReview } from '@/lib/permitCompliance';
import type { HomePermit } from '@/lib/homeLifetimeGraph';
import {
  buildActions, buildPermitRows, buildReviewRows, filterPermitRows, jobsNeedingReview, summarizeJurisdictions,
  type PermitIntelligenceData, type PiJob,
} from './permitIntelligence';

const NOW = Date.parse('2026-10-05T00:00:00Z');

const permit = (p: Partial<HomePermit>): HomePermit => ({
  id: 'p1', site_id: 's1', job_id: null, contractor_id: null, permit_type: 'mechanical', permit_number: 'M-1',
  jurisdiction: 'Austin, TX', description: null, status: 'issued', applied_on: null, issued_on: '2026-09-20',
  expires_on: null, final_inspection_on: null, cost_cents: null, document_url: null, notes: null,
  created_at: '2026-09-20T00:00:00Z', ...p,
});
const job = (p: Partial<PiJob>): PiJob => ({
  id: 'j1', customer_id: null, customer_name: 'Ann', service_type: 'Furnace install', dispatch_note: null,
  address: null, job_status: 'scheduled', scheduled_datetime: '2026-10-07T12:00:00Z', site_id: null, ...p,
});
const review = (p: Partial<ComplianceReview> = {}): ComplianceReview => ({
  id: 'r1', job_id: 'j1', jurisdiction: { label: 'austin, tx' }, work_types: [], permit_likelihood: 'likely_required',
  summary: null, verify_questions: [], item_progress: {}, ai_status: 'skipped', rules_version: null, model: null,
  generated_at: '2026-10-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z',
  requirements: [{ key: 'k1', category: 'permit', severity: 'blocker', title: 'Mechanical permit', detail: '', authority: null, reference: null, confidence: 'high', source: 'rule' }],
  ...p,
} as unknown as ComplianceReview);
const data = (o: Partial<PermitIntelligenceData>): PermitIntelligenceData => ({
  permits: [], schemaReady: true, sites: {}, reviews: [], jobs: {}, loadedAt: '2026-10-05T00:00:00Z', ...o,
});

describe('buildPermitRows', () => {
  it('flags failed permits as issues and sorts them first', () => {
    const rows = buildPermitRows(data({ permits: [permit({ id: 'ok' }), permit({ id: 'bad', status: 'failed' })] }), NOW);
    expect(rows[0].permit.id).toBe('bad');
    expect(rows[0].issue).not.toBeNull();
    expect(rows[1].issue).toBeNull();
  });
  it('flags open permits expiring within 30 days, not closed ones', () => {
    const rows = buildPermitRows(data({ permits: [
      permit({ id: 'soon', expires_on: '2026-10-15' }),
      permit({ id: 'done', status: 'closed', expires_on: '2026-10-15' }),
    ] }), NOW);
    expect(rows.find((r) => r.permit.id === 'soon')?.expiring).toBe(true);
    expect(rows.find((r) => r.permit.id === 'done')?.expiring).toBe(false);
  });
});

describe('filters', () => {
  it('filters by chip and query', () => {
    const rows = buildPermitRows(data({ permits: [permit({ id: 'a' }), permit({ id: 'b', status: 'closed', permit_number: 'X-9' })] }), NOW);
    expect(filterPermitRows(rows, 'closed', '')).toHaveLength(1);
    expect(filterPermitRows(rows, 'all', 'x-9')).toHaveLength(1);
  });
});

describe('actions', () => {
  it('ranks an upcoming job with blockers as critical and flags a missing permit', () => {
    const d = data({ reviews: [review()], jobs: { j1: job({}) } });
    const actions = buildActions({ permitRows: buildPermitRows(d, NOW), reviewRows: buildReviewRows(d, NOW), needsReview: [], now: NOW });
    expect(actions[0].priority).toBe('critical');
    expect(actions.some((a) => a.id === 'gap-j1')).toBe(true);
  });
  it('does not flag a missing permit when one is linked to the job', () => {
    const d = data({ permits: [permit({ job_id: 'j1' })], reviews: [review()], jobs: { j1: job({}) } });
    const actions = buildActions({ permitRows: buildPermitRows(d, NOW), reviewRows: buildReviewRows(d, NOW), needsReview: [], now: NOW });
    expect(actions.some((a) => a.id === 'gap-j1')).toBe(false);
  });
});

describe('jobsNeedingReview / jurisdictions', () => {
  it('skips reviewed jobs and jobs without scope', () => {
    const d = data({ reviews: [review()], jobs: { j1: job({}), j2: job({ id: 'j2' }), j3: job({ id: 'j3', service_type: null }) } });
    expect(jobsNeedingReview(d).map((j) => j.id)).toEqual(['j2']);
  });
  it('groups jurisdictions case-insensitively', () => {
    const d = data({ permits: [permit({})], reviews: [review()], jobs: { j1: job({}) } });
    const rows = summarizeJurisdictions(buildPermitRows(d, NOW), buildReviewRows(d, NOW));
    expect(rows).toHaveLength(1);
    expect(rows[0].permits).toBe(1);
    expect(rows[0].reviews).toBe(1);
  });
});
