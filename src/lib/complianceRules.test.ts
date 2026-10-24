import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import {
  ComplianceError, allowedActions, canManageCompliance, evaluate, fetchCatalog, formToContext, groupCatalog, recordConsent,
  saveProfile, todayKey, toComplianceError, transitionVersion, wallClockToInstant, maskPhone,
  type RuleVersion, type SimulatorForm,
} from '@/lib/complianceRules';

beforeEach(() => rpc.mockReset());

const ver = (over: Partial<RuleVersion> = {}): RuleVersion => ({
  id: 'v1', packSlug: 'us-federal', ruleKey: 'telemarketing-hours', version: 1, jurisdiction: 'US', kind: 'quiet_hours', severity: 'block',
  appliesTo: ['call', 'sms'], title: 'Federal hours', ownerExplanation: 'Plain-language explanation of the rule.',
  params: { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '21:00' }], purposes: ['marketing'] },
  sourceRefs: [{ citation: '47 C.F.R. § 64.1200', type: 'regulation' }], status: 'approved', effectiveFrom: '2026-01-01', effectiveTo: null, ...over,
});

const form = (over: Partial<SimulatorForm> = {}): SimulatorForm => ({
  surface: 'sms', purpose: 'marketing', customerState: 'TX', localHour: '22:00', timezone: 'America/Chicago', weekdayOffset: 0,
  aiVoice: false, disclosureGiven: false, consent: {}, saleLocation: 'customer_home', totalDollars: '', baselineDollars: '',
  emergencyDeclared: false, emergencyRepair: false, waiverSigned: false, licenseShown: false, noticeIncluded: false, ...over,
});

describe('canManageCompliance', () => {
  it('allows the owner and business-profile members only', () => {
    expect(canManageCompliance(true, { can_edit_business_profile: false })).toBe(true);
    expect(canManageCompliance(false, { can_edit_business_profile: true })).toBe(true);
    expect(canManageCompliance(false, { can_edit_business_profile: false })).toBe(false);
  });
});

describe('toComplianceError', () => {
  it('maps database errors to friendly messages', () => {
    expect(toComplianceError({ message: 'compliance_forbidden' }).code).toBe('forbidden');
    expect(toComplianceError({ code: '42501', message: 'x' }).code).toBe('forbidden');
    expect(toComplianceError({ message: 'compliance_self_review: a different reviewer must approve your draft' }).code).toBe('self_review');
    expect(toComplianceError({ message: 'compliance_open_version_exists: finish' }).code).toBe('open_version');
    const inv = toComplianceError({ message: 'compliance_invalid: review notes (min 10 characters) are required' });
    expect(inv.code).toBe('invalid');
    expect(inv.message).toBe('review notes (min 10 characters) are required');
    expect(toComplianceError({ message: 'boom' }).message).toBe('Something went wrong. Please try again.');
  });
});

describe('rpc wrappers', () => {
  it('fetchCatalog returns [] for null and throws a ComplianceError on failure', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await fetchCatalog()).toEqual([]);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'compliance_forbidden' } });
    await expect(fetchCatalog()).rejects.toBeInstanceOf(ComplianceError);
  });
  it('passes trimmed, null-normalised arguments', async () => {
    rpc.mockResolvedValue({ data: 'id', error: null });
    await recordConsent({ type: 'marketing_sms', granted: true, phone: ' 555 ', email: '', notes: '  ' });
    expect(rpc).toHaveBeenCalledWith('compliance_record_consent', expect.objectContaining({ p_phone: '555', p_email: null, p_notes: null, p_source: 'manual' }));
    await saveProfile('TX', [], false);
    expect(rpc).toHaveBeenLastCalledWith('compliance_save_profile', { p_state: 'TX', p_licenses: [], p_acknowledge: false });
    await transitionVersion('v', 'approve', ' ok notes here ', ' Smith LLP ');
    expect(rpc).toHaveBeenLastCalledWith('compliance_staff_transition', { p_version_id: 'v', p_action: 'approve', p_notes: 'ok notes here', p_legal_reviewer: 'Smith LLP' });
  });
});

describe('allowedActions', () => {
  it('lets authors submit/discard their own drafts but not approve', () => {
    expect(allowedActions({ status: 'draft', authoredBy: 'u1' }, 'author', 'u1')).toEqual(['submit', 'discard']);
    expect(allowedActions({ status: 'in_review', authoredBy: 'u1' }, 'author', 'u1')).toEqual(['withdraw']);
  });
  it('blocks reviewers from approving their own work but lets admins', () => {
    expect(allowedActions({ status: 'in_review', authoredBy: 'u1' }, 'reviewer', 'u1')).toEqual(['withdraw', 'reject']);
    expect(allowedActions({ status: 'in_review', authoredBy: 'u1' }, 'admin', 'u1')).toEqual(['withdraw', 'approve', 'reject']);
    expect(allowedActions({ status: 'in_review', authoredBy: 'u2' }, 'reviewer', 'u1')).toEqual(['withdraw', 'approve', 'reject']);
  });
  it('only reviewers can retire; non-staff can do nothing', () => {
    expect(allowedActions({ status: 'approved', authoredBy: null }, 'reviewer', 'u1')).toEqual(['retire']);
    expect(allowedActions({ status: 'approved', authoredBy: null }, 'author', 'u1')).toEqual([]);
    expect(allowedActions({ status: 'draft', authoredBy: null }, null, 'u1')).toEqual([]);
  });
});

describe('groupCatalog', () => {
  it('shows the in-force version as current and lists earlier ones as history', () => {
    const v1 = ver({ id: 'a', version: 1, effectiveTo: '2026-06-01' });
    const v2 = ver({ id: 'b', version: 2, effectiveFrom: '2026-06-01' });
    const g = groupCatalog([v1, v2], '2026-10-01');
    expect(g).toHaveLength(1);
    expect(g[0].current.id).toBe('b');
    expect(g[0].timeline).toBe('active');
    expect(g[0].history.map((h) => h.id)).toEqual(['a']);
  });
  it('sorts in-force rules before upcoming and expired', () => {
    const upcoming = ver({ id: 'u', ruleKey: 'u', effectiveFrom: '2027-01-01' });
    const active = ver({ id: 'a', ruleKey: 'a' });
    expect(groupCatalog([upcoming, active], '2026-10-01').map((g) => g.current.id)).toEqual(['a', 'u']);
  });
});

describe('time helpers', () => {
  it('converts a wall-clock time in a zone to the right instant (DST aware)', () => {
    expect(wallClockToInstant('2026-11-03', 12, 0, 'America/Chicago')?.toISOString()).toBe('2026-11-03T18:00:00.000Z');
    expect(wallClockToInstant('2026-07-03', 12, 0, 'America/Chicago')?.toISOString()).toBe('2026-07-03T17:00:00.000Z');
    expect(wallClockToInstant('2026-07-03', 12, 0, 'Not/AZone')).toBeNull();
  });
  it('todayKey formats in the requested zone', () => {
    expect(todayKey('Pacific/Honolulu', new Date('2026-11-03T05:00:00Z'))).toBe('2026-11-02');
    expect(todayKey('bogus', new Date('2026-11-03T05:00:00Z'))).toBe('2026-11-03');
  });
  it('masks phone numbers', () => {
    expect(maskPhone('+16509106703')).toBe('•••• 6703');
    expect(maskPhone(null)).toBe('—');
  });
});

describe('simulator form → engine', () => {
  it('a 10 p.m. marketing text with no consent is blocked by the federal hours rule', () => {
    const r = evaluate(formToContext(form({ weekdayOffset: 1 }), null), [ver()]);
    expect(r.outcome).toBe('block');
    expect(r.nextAllowedAt).not.toBeNull();
  });
  it('the same text at 10 a.m. is allowed', () => {
    expect(evaluate(formToContext(form({ localHour: '10:00' }), null), [ver()]).outcome).toBe('allow');
  });
  it('parses dollar inputs into cents and tolerates junk', () => {
    const ctx = formToContext(form({ surface: 'quote', totalDollars: '$1,100.50', baselineDollars: 'abc' }), null);
    expect(ctx.document?.totalCents).toBe(110050);
    expect(ctx.document?.baselinePriceCents).toBeUndefined();
  });
});
