import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const invoke = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), functions: { invoke: (...a: unknown[]) => invoke(...a) } },
}));

import {
  EMPTY_POSTING,
  adverseEligibleOn,
  applyToPosting,
  blockerKeys,
  businessDaysBetween,
  canMoveTo,
  centsToDollars,
  credentialBadge,
  daysUntil,
  dollarsToCents,
  formatPay,
  friendlyError,
  hireApplicant,
  hireGate,
  listOpenPostings,
  locationLabel,
  profileCompleteness,
  ratingDisplay,
  toPostingPayload,
  validateCredential,
  validateDocument,
  validatePosting,
  validateProfile,
  validateReference,
  type Compliance,
  type PostingInput,
  type ProfileInput,
} from './talentNetwork';

const profile = (o: Partial<ProfileInput> = {}): ProfileInput => ({
  display_name: 'Sam Rivera', headline: '', bio: '', phone: '', trades: ['hvac'], experience_years: '8', city: 'Austin', region: 'TX',
  country: 'US', service_radius_miles: '40', open_to: ['gig'], desired_hourly: '38.50', availability: 'open', status: 'active', ...o,
});
const posting = (o: Partial<PostingInput> = {}): PostingInput => ({
  ...EMPTY_POSTING, title: 'HVAC technician', summary: 'Residential service and repair in Austin.',
  description: 'Diagnose and repair residential HVAC systems, with a company van.', city: 'Austin', region: 'TX',
  pay_min: '30', pay_max: '42', ...o,
});
const compliance = (checks: Compliance['checks']): Compliance => ({ checks, blockers: 0, can_hire: true });

beforeEach(() => { rpc.mockReset(); invoke.mockReset(); });

describe('money helpers', () => {
  it('parses dollars to cents strictly', () => {
    expect(dollarsToCents('38.50')).toBe(3850);
    expect(dollarsToCents('$1,200')).toBe(120000);
    expect(dollarsToCents('12.345')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
    expect(dollarsToCents('')).toBeNull();
  });
  it('formats cents for inputs', () => {
    expect(centsToDollars(3850)).toBe('38.50');
    expect(centsToDollars(null)).toBe('');
  });
  it('formats pay ranges by pay type', () => {
    const base = { pay_currency: 'USD', pay_min_cents: 3000, pay_max_cents: 4250 };
    expect(formatPay({ ...base, pay_type: 'hourly' })).toBe('$30–$42.50/hr');
    expect(formatPay({ ...base, pay_type: 'flat', pay_min_cents: 50000, pay_max_cents: 50000 })).toBe('$500 flat');
    expect(formatPay({ ...base, pay_type: 'salary', pay_min_cents: 6000000, pay_max_cents: 7000000 })).toBe('$60,000–$70,000/yr');
    expect(formatPay({ ...base, pay_type: 'hourly', pay_min_cents: null, pay_max_cents: null })).toBe('Pay not listed');
  });
});

describe('labels and dates', () => {
  it('builds a location label', () => {
    expect(locationLabel({ city: 'Austin', region: 'TX' })).toBe('Austin, TX');
    expect(locationLabel({ city: null, region: 'TX' })).toBe('TX');
    expect(locationLabel({})).toBe('Location not listed');
  });
  it('counts calendar days until a date', () => {
    const today = new Date(2027, 0, 10);
    expect(daysUntil('2027-01-10', today)).toBe(0);
    expect(daysUntil('2027-01-25', today)).toBe(15);
    expect(daysUntil('2027-01-09', today)).toBe(-1);
    expect(daysUntil(null, today)).toBeNull();
  });
  it('badges credentials by verification and expiry', () => {
    const today = new Date(2027, 0, 10);
    expect(credentialBadge({ verification_status: 'verified', expires_on: null }, today)).toEqual({ label: 'Verified', tone: 'good' });
    expect(credentialBadge({ verification_status: 'verified', expires_on: '2027-01-20' }, today).tone).toBe('warn');
    expect(credentialBadge({ verification_status: 'verified', expires_on: '2027-01-01' }, today)).toEqual({ label: 'Expired', tone: 'bad' });
    expect(credentialBadge({ verification_status: 'unverified', expires_on: null }, today).tone).toBe('neutral');
    expect(credentialBadge({ verification_status: 'failed', expires_on: null }, today).tone).toBe('bad');
  });
  it('shows ratings only with a meaningful sample', () => {
    expect(ratingDisplay(null, 0)).toBe('New');
    expect(ratingDisplay(5, 2)).toBe('New (2)');
    expect(ratingDisplay(4.666, 3)).toBe('4.7 (3)');
  });
});

describe('profile completeness', () => {
  it('is 0 without a profile and grows with content', () => {
    expect(profileCompleteness(null, 0, 0)).toBe(0);
    const p = { display_name: 'Sam', trades: ['hvac'], city: 'A', region: 'TX', headline: 'h', bio: 'x'.repeat(40), phone: '1' };
    expect(profileCompleteness(p, 0, 0)).toBe(75);
    expect(profileCompleteness(p, 1, 1)).toBe(100);
  });
});

describe('business days and the adverse-action wait', () => {
  it('skips weekends', () => {
    // Fri 2027-01-08 -> Fri 2027-01-15 = 5 business days
    expect(businessDaysBetween(new Date(2027, 0, 8), new Date(2027, 0, 15))).toBe(5);
    // Fri -> Mon = 1
    expect(businessDaysBetween(new Date(2027, 0, 8), new Date(2027, 0, 11))).toBe(1);
    expect(businessDaysBetween(new Date(2027, 0, 8), new Date(2027, 0, 8))).toBe(0);
  });
  it('finds the first eligible date', () => {
    const d = adverseEligibleOn(new Date(2027, 0, 8, 15).toISOString());
    expect(d && [d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2027, 0, 15]);
    expect(adverseEligibleOn(null)).toBeNull();
  });
});

describe('pipeline rules', () => {
  it('allows forward moves and rejection only from open stages', () => {
    expect(canMoveTo('submitted', 'reviewing')).toBe(true);
    expect(canMoveTo('reviewing', 'offer')).toBe(true);
    expect(canMoveTo('offer', 'rejected')).toBe(true);
    expect(canMoveTo('reviewing', 'reviewing')).toBe(false);
    expect(canMoveTo('reviewing', 'submitted')).toBe(false);
    expect(canMoveTo('hired', 'rejected')).toBe(false);
    expect(canMoveTo('withdrawn', 'reviewing')).toBe(false);
  });
});

describe('hire gate', () => {
  it('passes with no blockers', () => {
    expect(hireGate(compliance([{ key: 'licenses', label: 'L', status: 'pass', blocking: true, detail: '' }]))).toEqual({ canHire: true, needsOverride: false, hardBlocked: false });
  });
  it('requires an override for ordinary blockers', () => {
    const c = compliance([{ key: 'references', label: 'R', status: 'fail', blocking: true, detail: '' }]);
    expect(blockerKeys(c)).toEqual(['references']);
    expect(hireGate(c)).toEqual({ canHire: false, needsOverride: true, hardBlocked: false });
  });
  it('never allows overriding the background check', () => {
    const c = compliance([{ key: 'background_check', label: 'B', status: 'pending', blocking: true, detail: '' }]);
    expect(hireGate(c)).toEqual({ canHire: false, needsOverride: false, hardBlocked: true });
  });
  it('ignores non-blocking warnings', () => {
    expect(hireGate(compliance([{ key: 'credential_expiry', label: 'E', status: 'warn', blocking: false, detail: '' }])).canHire).toBe(true);
  });
});

describe('validation', () => {
  it('validates profiles', () => {
    expect(validateProfile(profile())).toBeNull();
    expect(validateProfile(profile({ display_name: 'S' }))).toMatch(/name/);
    expect(validateProfile(profile({ trades: [] }))).toMatch(/trade/);
    expect(validateProfile(profile({ trades: ['witchcraft'] }))).toMatch(/Invalid trade/);
    expect(validateProfile(profile({ open_to: [] }))).toMatch(/type of work/);
    expect(validateProfile(profile({ city: '' }))).toMatch(/city/);
    expect(validateProfile(profile({ experience_years: '61' }))).toMatch(/Experience/);
    expect(validateProfile(profile({ service_radius_miles: '0' }))).toMatch(/radius/);
    expect(validateProfile(profile({ desired_hourly: 'x' }))).toMatch(/hourly/);
  });
  it('validates credentials and references', () => {
    expect(validateCredential({ kind: 'license', name: 'EPA 608', issuing_authority: '', credential_number: '', region: '', issued_on: '2026-02-01', expires_on: '2026-01-01' })).toMatch(/Expiry/);
    expect(validateCredential({ kind: 'license', name: 'EPA 608', issuing_authority: '', credential_number: '', region: '', issued_on: '', expires_on: '' })).toBeNull();
    const ref = { referee_name: 'Pat Lee', referee_email: 'pat@x.com', referee_phone: '', relationship: 'supervisor', company: '', years_known: '' };
    expect(validateReference(ref)).toBeNull();
    expect(validateReference(ref, 'PAT@x.com')).toMatch(/another person/);
    expect(validateReference({ ...ref, referee_email: 'nope' })).toMatch(/email/);
    expect(validateReference({ ...ref, relationship: 'friend' })).toMatch(/know them/);
  });
  it('requires pay transparency, location and dates to publish', () => {
    expect(validatePosting(posting(), true)).toBeNull();
    expect(validatePosting(posting({ pay_min: '', pay_max: '' }), false)).toBeNull();
    expect(validatePosting(posting({ pay_min: '', pay_max: '' }), true)).toMatch(/pay range/);
    expect(validatePosting(posting({ pay_min: '50', pay_max: '40' }), false)).toMatch(/Minimum/);
    expect(validatePosting(posting({ pay_max: '' }), false)).toMatch(/both/);
    expect(validatePosting(posting({ city: '' }), true)).toMatch(/City/);
    expect(validatePosting(posting({ kind: 'gig' }), true)).toMatch(/start and end/);
    expect(validatePosting(posting({ kind: 'gig', starts_on: '2027-02-01', ends_on: '2027-02-10' }), true)).toBeNull();
    expect(validatePosting(posting({ headcount: '0' }), false)).toMatch(/Openings/);
  });
  it('validates documents', () => {
    expect(validateDocument({ size: 1000, type: 'application/pdf' })).toBeNull();
    expect(validateDocument({ size: 1000, type: 'text/html' })).toMatch(/PDF/);
    expect(validateDocument({ size: 11 * 1024 * 1024, type: 'image/png' })).toMatch(/10 MB/);
  });
});

describe('posting payload', () => {
  it('normalizes values and forces contract for gigs', () => {
    const p = toPostingPayload(posting({ kind: 'gig', region: 'tx', requirements: [' EPA 608 ', ''], starts_on: '2027-02-01', ends_on: '2027-02-10' }));
    expect(p.region).toBe('TX');
    expect(p.employment_type).toBe('contract');
    expect(p.requirements).toEqual(['EPA 608']);
    expect(p.pay_min_cents).toBe(3000);
    expect(p.pay_max_cents).toBe(4200);
  });
});

describe('friendlyError', () => {
  it('only exposes validation messages', () => {
    expect(friendlyError({ code: '22023', message: 'Pick a trade.' }, 'x').message).toBe('Pick a trade.');
    expect(friendlyError({ code: 'XX000', message: 'relation does not exist' }, 'Could not save.').message).toBe('Could not save.');
    expect(friendlyError({ code: '42501' }, 'x').message).toMatch(/permission/);
  });
});

describe('API wrappers', () => {
  it('passes filters to the public listing RPC', async () => {
    rpc.mockResolvedValue({ data: [{ id: 'p1' }], error: null });
    await expect(listOpenPostings({ trade: 'hvac', query: 'austin' })).resolves.toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith('talent_list_open_postings', { p_trade: 'hvac', p_kind: null, p_region: null, p_query: 'austin', p_limit: 24, p_offset: 0 });
  });
  it('surfaces database validation messages when applying', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'You have already applied to this posting.' } });
    await expect(applyToPosting('p1', { coverNote: '', expectedRate: '', availabilityNote: '' })).rejects.toThrow('already applied');
  });
  it('rejects a bad expected rate before calling the database', async () => {
    await expect(applyToPosting('p1', { coverNote: '', expectedRate: 'abc', availabilityNote: '' })).rejects.toThrow(/hourly rate/);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('hires, then emails the invite; a mail failure does not undo the hire', async () => {
    rpc.mockResolvedValue({ data: { engagement_id: 'e1', team_member_id: 't1', invite_email: 'a@b.co', member_name: 'Sam' }, error: null });
    invoke.mockResolvedValue({ data: null, error: { message: 'smtp down' } });
    const r = await hireApplicant({ applicationId: 'a1', engagementType: 'w2', startsOn: '2027-02-01', endsOn: '', hourlyRate: '40', overrideReason: '' });
    expect(r.inviteSent).toBe(false);
    expect(rpc).toHaveBeenCalledWith('talent_hire_applicant', expect.objectContaining({ p_hourly_rate_cents: 4000, p_ends_on: null, p_override_reason: null }));
    expect(invoke).toHaveBeenCalledWith('send-team-invite', { body: { memberEmail: 'a@b.co', memberName: 'Sam', role: 'technician' } });
  });
  it('does not email when the hire is refused', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'The background-check requirement is not satisfied.' } });
    await expect(hireApplicant({ applicationId: 'a1', engagementType: '1099', startsOn: '2027-02-01', endsOn: '', hourlyRate: '40', overrideReason: '' })).rejects.toThrow(/background/);
    expect(invoke).not.toHaveBeenCalled();
  });
});
