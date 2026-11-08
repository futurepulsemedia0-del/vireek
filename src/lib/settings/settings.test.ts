import { describe, expect, it } from 'vitest';
import { SETTINGS_REGISTRY, SETTINGS_GROUPS, validateRegistry, getEntryForPath, isSettingsPath, breadcrumbs, deepLink } from './registry';
import { resolveAccess, isStaffAdmin } from './access';
import { searchSettings } from './search';
import { computeDiff, gateForRisk, REDACTED } from './diff';
import { evaluateHealth } from './health';

const owner = { isOwner: true, permissions: {} };
const manager = { isOwner: false, permissions: { can_edit_business_profile: true, can_manage_team: true } };
const technician = { isOwner: false, permissions: { can_view_all_jobs: true } };
const byId = (id: string) => SETTINGS_REGISTRY.find((x) => x.id === id)!;

describe('registry', () => {
  it('is valid', () => expect(validateRegistry()).toEqual([]));
  it('uses only declared groups and has entries in each', () => {
    for (const g of SETTINGS_GROUPS) expect(SETTINGS_REGISTRY.some((x) => x.group === g.id)).toBe(true);
  });
  it('rejects duplicates and emoji', () => {
    const a = SETTINGS_REGISTRY[0];
    expect(validateRegistry([a, a]).join()).toMatch(/duplicate id/);
    expect(validateRegistry([{ ...a, description: 'Rocket launch. 🚀' }]).join()).toMatch(/emoji/);
  });
  it('resolves paths by longest prefix and builds breadcrumbs', () => {
    expect(getEntryForPath('/dashboard/team/org-chart')?.id).toBe('team');
    expect(breadcrumbs('/dashboard/settings/security').map((c) => c.label)).toEqual(['Settings', 'Security and compliance', 'Security']);
    expect(deepLink('security')).toBe('/dashboard/settings/security');
    expect(deepLink('nope')).toBeUndefined();
  });
  it('active state: email no longer needs a special case', () => {
    expect(isSettingsPath('/dashboard/settings')).toBe(true);
    expect(isSettingsPath('/dashboard/settings/email')).toBe(true);
    expect(isSettingsPath('/dashboard/jobs')).toBe(false);
  });
});

describe('access', () => {
  it('owner can open everything', () => {
    for (const x of SETTINGS_REGISTRY) expect(resolveAccess(x, owner).state).toBe('allowed');
  });
  it('manager: allowed with permission, locked for owner-only, with reason', () => {
    expect(resolveAccess(byId('branding'), manager).state).toBe('allowed');
    expect(resolveAccess(byId('api-keys'), manager)).toMatchObject({ state: 'locked', reason: 'owner', message: 'Only Owners can change this.' });
    expect(resolveAccess(byId('billing'), manager)).toMatchObject({ state: 'locked', reason: 'permission' });
  });
  it('technician: personal allowed, organization hidden', () => {
    expect(isStaffAdmin(technician)).toBe(false);
    expect(resolveAccess(byId('sessions'), technician).state).toBe('allowed');
    expect(resolveAccess(byId('branding'), technician).state).toBe('hidden');
    expect(resolveAccess(byId('security'), technician).state).toBe('hidden');
  });
  it('explicit false never grants', () => {
    expect(resolveAccess(byId('branding'), { isOwner: false, permissions: { can_edit_business_profile: false, can_manage_team: true } }).state).toBe('locked');
  });
});

describe('search ranking', () => {
  const top = (q: string) => searchSettings(q, SETTINGS_REGISTRY)[0]?.entry.id;
  const cases: [string, string][] = [
    ['password', 'security'], ['two factor', 'security'], ['2fa', 'security'], ['passkey', 'security'], ['mfa', 'security'],
    ['sso', 'enterprise-security'], ['ip allowlist', 'enterprise-security'], ['audit', 'audit-log'], ['who changed', 'audit-log'],
    ['api key', 'api-keys'], ['token', 'api-keys'], ['invoice', 'billing'], ['subscription', 'billing'], ['payment method', 'billing'],
    ['smtp', 'email'], ['dkim', 'email'], ['signature', 'email'], ['10dlc', 'sms-compliance'], ['opt out', 'sms-compliance'],
    ['slack', 'slack-teams'], ['logo', 'branding'], ['hours', 'business-profile'], ['branches', 'locations'], ['gdpr', 'data-governance'],
    ['retention', 'data-governance'], ['sarah', 'assistant'], ['clone', 'voice-studio'], ['siem', 'siem-streaming'], ['quota', 'api-usage'],
    ['live chat', 'chat-widget'], ['embed', 'website-widgets'], ['arrival window', 'booking'], ['invite', 'team'], ['roles', 'team'],
    ['devices', 'sessions'], ['language', 'account'], ['quiet hours', 'account'], ['tracking', 'call-tracking'], ['surcharge', 'payment-pricing'],
  ];
  it.each(cases)('"%s" -> %s', (q, id) => expect(top(q)).toBe(id));
  it('tolerates a typo', () => expect(top('pasword')).toBe('security'));
  it('billing contact finds Billing or Email', () => {
    const ids = searchSettings('billing contact', SETTINGS_REGISTRY).map((h) => h.entry.id);
    expect(ids).toEqual(expect.arrayContaining(['billing', 'email']));
  });
  it('empty and nonsense return nothing', () => {
    expect(searchSettings('   ', SETTINGS_REGISTRY)).toEqual([]);
    expect(searchSettings('zzqxv', SETTINGS_REGISTRY)).toEqual([]);
  });
  it('returns label highlight ranges', () => {
    const h = searchSettings('security', SETTINGS_REGISTRY)[0];
    expect(h.labelRanges.length).toBeGreaterThan(0);
  });
});

describe('diff and gating', () => {
  it('diffs nested values and redacts secrets', () => {
    const d = computeDiff({ a: 1, n: { x: 'a', apiKey: 'k1' } }, { a: 2, n: { x: 'a', apiKey: 'k2' }, z: true });
    expect(d).toEqual([
      { path: 'a', before: 1, after: 2 },
      { path: 'n.apiKey', before: REDACTED, after: REDACTED },
      { path: 'z', before: undefined, after: true },
    ]);
  });
  it('no changes -> empty', () => expect(computeDiff({ a: [1] }, { a: [1] })).toEqual([]));
  it('risk gates; two-person only with flag', () => {
    expect(gateForRisk('low')).toEqual({ requiresDiffReview: false, requiresStepUp: false, requiresTwoPerson: false });
    expect(gateForRisk('high').requiresTwoPerson).toBe(false);
    expect(gateForRisk('high', { twoPersonApproval: true })).toMatchObject({ requiresStepUp: true, requiresTwoPerson: true });
  });
});

describe('health', () => {
  const now = new Date('2026-11-06T00:00:00Z');
  it('unmeasured signals produce nothing', () => expect(evaluateHealth({ now })).toEqual([]));
  it('reports evidence-based gaps and honors dismissal', () => {
    const r = evaluateHealth({ hasBackupEmergencyContact: false, mfaOrPasskeyEnabled: false, notificationChannelsEnabled: 0, now });
    expect(r.map((x) => x.id)).toEqual(['no-backup-contact', 'no-mfa', 'all-notifications-off']);
    expect(evaluateHealth({ mfaOrPasskeyEnabled: false, now }, new Set(['no-mfa']))).toEqual([]);
  });
  it('flags stale or unused keys only', () => {
    const r = evaluateHealth({ now, apiKeys: [
      { id: 'a', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: '2026-11-01T00:00:00Z' },
      { id: 'b', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null },
    ] });
    expect(r.map((x) => x.id)).toEqual(['stale-key-b']);
  });
});
