import { describe, expect, it, vi } from 'vitest';
import {
  canTransition,
  inferPermitTypes,
  isFollowUpDue,
  missingInputs,
  nextActions,
  readinessScore,
  safeHttpUrl,
  suggestAuthority,
  type PermitAuthority,
  type PermitStatus,
} from '@/lib/permitTransactions';

const authority = (over: Partial<PermitAuthority>): PermitAuthority => ({
  id: 'a1',
  name: 'Office',
  state: 'TX',
  city: 'Austin',
  county: null,
  portal_system: 'other',
  submission_method: 'portal',
  portal_url: null,
  phone: null,
  email: null,
  typical_turnaround_days: null,
  fee_notes: null,
  notes: null,
  verified: false,
  verified_at: null,
  ...over,
});

// Pure-logic tests: keep the real Supabase client (and its env requirements) out of the unit run.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

describe('state machine', () => {
  it('allows the happy path', () => {
    const path: PermitStatus[] = [
      'draft',
      'ready_to_file',
      'submitted',
      'in_review',
      'issued',
      'in_inspection',
      'passed',
      'closed',
    ];
    for (let i = 0; i < path.length - 1; i++)
      expect(canTransition(path[i], path[i + 1])).toBe(true);
  });

  it('blocks skipping stages and leaving terminal states', () => {
    expect(canTransition('draft', 'issued')).toBe(false);
    expect(canTransition('submitted', 'closed')).toBe(false);
    expect(canTransition('closed', 'draft')).toBe(false);
    expect(canTransition('withdrawn', 'submitted')).toBe(false);
  });

  it('supports the corrections loop and re-filing', () => {
    expect(canTransition('in_review', 'corrections_required')).toBe(true);
    expect(canTransition('corrections_required', 'submitted')).toBe(true);
    expect(canTransition('rejected', 'draft')).toBe(true);
    expect(canTransition('expired', 'ready_to_file')).toBe(true);
  });

  it('never offers in_inspection as a manual action (it is entered by adding an inspection)', () => {
    expect(nextActions('issued').some((a) => a.to === 'in_inspection')).toBe(false);
  });

  it('labels re-filing actions clearly and puts primary actions first', () => {
    const actions = nextActions('corrections_required');
    expect(actions[0]).toMatchObject({ to: 'submitted', label: 'Resubmit', tone: 'primary' });
  });
});

describe('readiness', () => {
  const base = { authority_id: null, scope_description: null, application_data: {} };

  it('lists every missing input on an empty application', () => {
    expect(missingInputs(base, '')).toEqual([
      'authority',
      'scope',
      'address',
      'owner_name',
      'contractor_license',
      'job_valuation',
    ]);
    expect(readinessScore(6)).toBe(0);
  });

  it('is complete when every input is present', () => {
    const m = missingInputs(
      {
        authority_id: 'a1',
        scope_description: 'Replace the 3-ton condenser and air handler.',
        application_data: { owner_name: 'Jo', contractor_license: 'TX-123', job_valuation: '8500' },
      },
      '1 Main St',
    );
    expect(m).toEqual([]);
    expect(readinessScore(m.length)).toBe(100);
  });

  it('treats a too-short scope and whitespace values as missing', () => {
    const m = missingInputs(
      { authority_id: 'a1', scope_description: 'short', application_data: { owner_name: '  ' } },
      '1 Main St',
    );
    expect(m).toContain('scope');
    expect(m).toContain('owner_name');
  });
});

describe('inferPermitTypes', () => {
  it('maps detected work types only when a permit is plausibly needed', () => {
    const likely = {
      work_types: ['ev_charger', 'hvac_replace', 'maintenance'],
      permit_likelihood: 'likely_required' as const,
    };
    expect(inferPermitTypes(likely, null).sort()).toEqual(['electrical', 'mechanical']);
    expect(inferPermitTypes({ ...likely, permit_likelihood: 'unlikely' }, null)).toEqual([]);
  });

  it('detects roofing from the service text', () => {
    expect(inferPermitTypes(null, 'Full roof replacement')).toEqual(['roofing']);
    expect(inferPermitTypes(null, 'Proofing the walls')).toEqual([]);
  });
});

describe('suggestAuthority', () => {
  it('prefers an exact city match and ignores other cities', () => {
    const austin = authority({ id: 'austin', city: 'Austin' });
    const dallas = authority({ id: 'dallas', city: 'Dallas' });
    expect(suggestAuthority([dallas, austin], { city: 'austin', state: 'tx' })?.id).toBe('austin');
    expect(suggestAuthority([dallas], { city: 'Austin', state: 'TX' })).toBeNull();
  });

  it('falls back to a state-wide office and never crosses states', () => {
    const state = authority({ id: 'state', city: null });
    const ca = authority({ id: 'ca', state: 'CA', city: null });
    expect(suggestAuthority([ca, state], { city: 'Austin', state: 'TX' })?.id).toBe('state');
    expect(suggestAuthority([ca], { city: 'Austin', state: 'TX' })).toBeNull();
  });

  it('returns null with no jurisdiction', () => {
    expect(suggestAuthority([authority({})], null)).toBeNull();
  });
});

describe('safeHttpUrl', () => {
  it('only allows http(s)', () => {
    expect(safeHttpUrl('https://example.gov/permits')).toBe('https://example.gov/permits');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe('isFollowUpDue', () => {
  const now = new Date('2027-04-20T12:00:00Z').getTime();
  const app = (over: object) => ({
    status: 'submitted' as PermitStatus,
    submitted_at: '2027-04-01T12:00:00Z',
    updated_at: '2027-04-01T12:00:00Z',
    next_follow_up_at: null,
    ...over,
  });

  it('flags filed permits older than the typical turnaround (default 10 days)', () => {
    expect(isFollowUpDue(app({}), null, now)).toBe(true);
    expect(isFollowUpDue(app({}), 30, now)).toBe(false);
  });

  it('ignores other statuses and honours an explicit follow-up date', () => {
    expect(isFollowUpDue(app({ status: 'issued' }), null, now)).toBe(false);
    expect(isFollowUpDue(app({ next_follow_up_at: '2027-04-25' }), null, now)).toBe(false);
    expect(isFollowUpDue(app({ next_follow_up_at: '2027-04-10' }), 90, now)).toBe(true);
  });
});
