import { describe, expect, it } from 'vitest';
import {
  buildPolicyCsv,
  isNewerVersion,
  isSelfApproval,
  latestKnownVersion,
  parseVersion,
  pendingAcknowledgements,
  sortPolicies,
  suggestNextVersion,
  summarizePolicies,
  validateSubmit,
  type PolicyOverview,
  type PolicyRow,
} from '@/lib/compliance/policyApproval';

const row = (over: Partial<PolicyRow>): PolicyRow => ({
  slug: 'p', title: 'P', source_path: 'docs/compliance/policies/p.md', control_ids: ['GOV-01'], review_frequency_days: 365, requires_acknowledgement: true,
  repo_synced: true, review_state: 'never_approved', current: null, pending: null, ...over,
});
const current = (over: Partial<NonNullable<PolicyRow['current']>> = {}): NonNullable<PolicyRow['current']> => ({
  version_id: 'v', version: '1.0', approved_at: '2026-11-01T00:00:00Z', effective_on: '2026-11-01', next_review_due: '2027-11-01', approver_id: 'a', approver_email: 'a@x.test', self_approved: false, ack_count: 1, i_acknowledged: false, ...over,
});

describe('versions', () => {
  it('parses and compares numerically, not lexically', () => {
    expect(parseVersion('1.10')).toEqual([1, 10]);
    expect(parseVersion('v1')).toBeNull();
    expect(isNewerVersion('1.10', '1.9')).toBe(true);
    expect(isNewerVersion('1.0', '1.0')).toBe(false);
    expect(isNewerVersion('2.0', null)).toBe(true);
  });
  it('suggests the next minor version', () => {
    expect(suggestNextVersion(null)).toBe('1.0');
    expect(suggestNextVersion('1.9')).toBe('1.10');
  });
  it('finds the latest known of current and pending', () => {
    expect(latestKnownVersion({ current: current({ version: '1.2' }), pending: { version_id: 'n', version: '1.3', submitted_at: '', submitted_by: 'u', change_summary: null, hash_matches_repo: true } })).toBe('1.3');
    expect(latestKnownVersion({ current: null, pending: null })).toBeNull();
  });
});

describe('submit validation', () => {
  it('accepts a first version', () => expect(validateSubmit({ version: '1.0', changeSummary: '' }, row({}), null)).toEqual([]));
  it('reports every problem', () => {
    expect(validateSubmit({ version: 'x', changeSummary: 'a'.repeat(301) }, row({ repo_synced: false }), null)).toEqual(['version_format', 'summary_too_long', 'hash_not_synced']);
    expect(validateSubmit({ version: '1.0', changeSummary: '' }, row({}), '1.0')).toEqual(['version_not_newer']);
  });
});

describe('approval semantics', () => {
  it('flags self-approval', () => {
    expect(isSelfApproval({ submitted_by: 'me' }, 'me')).toBe(true);
    expect(isSelfApproval({ submitted_by: 'x' }, 'me')).toBe(false);
  });
  it('counts pending acknowledgements only for approved, acknowledgement-requiring policies', () => {
    expect(pendingAcknowledgements(row({}), 3)).toBe(0);
    expect(pendingAcknowledgements(row({ current: current({ ack_count: 1 }) }), 3)).toBe(2);
    expect(pendingAcknowledgements(row({ current: current({ ack_count: 5 }) }), 3)).toBe(0);
    expect(pendingAcknowledgements(row({ current: current(), requires_acknowledgement: false }), 3)).toBe(0);
  });
});

describe('overview', () => {
  const o: PolicyOverview = {
    generated_at: '', active_staff: 2, me: 'me',
    policies: [
      row({ slug: 'b', review_state: 'current', current: current({ self_approved: true, ack_count: 2 }) }),
      row({ slug: 'a', review_state: 'content_changed', current: current() }),
      row({ slug: 'c' }),
    ],
  };
  it('summarises', () => {
    expect(summarizePolicies(o)).toMatchObject({ total: 3, selfApproved: 1, pendingAcknowledgements: 1, inReview: 0 });
  });
  it('puts problems first', () => expect(sortPolicies(o.policies).map((p) => p.slug)).toEqual(['a', 'c', 'b']));
  it('exports CSV without formula injection', () => {
    const csv = buildPolicyCsv({ ...o, policies: [row({ slug: 'x', review_state: 'current', current: current({ approver_email: '=cmd@x.test' }) })] });
    expect(csv).toContain("'=cmd@x.test");
  });
});
