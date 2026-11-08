import { describe, it, expect } from 'vitest';
import {
  GUEST_MAX_DAYS,
  GUEST_MAX_SCOPES,
  constantTimeEqual,
  generateGuestToken,
  guestCan,
  guestStatus,
  hashGuestToken,
  validateGuestInvite,
  watermarkText,
  type GuestInvite,
  type GuestScope,
} from './guestAccess';

const NOW = '2026-11-05T09:00:00.000Z';
const day = (n: number): string => new Date(Date.parse(NOW) + n * 86_400_000).toISOString();
const JOB = '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b';
const scope = (over: Partial<GuestScope> = {}): GuestScope => ({ resource: 'jobs', recordId: JOB, actions: ['view'], ...over });
const invite = (over: Partial<GuestInvite> = {}): GuestInvite => ({
  id: 'i1', tenantId: 't1', email: 'gc@example.com', label: 'GC', scopes: [scope()], expiresAt: day(30),
  revokedAt: null, redeemedBy: 'guest1', redeemedAt: NOW, requireMfa: true, watermark: true, ...over,
});

describe('validateGuestInvite', () => {
  const ok = { email: 'a@b.co', scopes: [scope()], expiresAt: day(7) };
  it('accepts a minimal valid invite', () => expect(validateGuestInvite(ok, NOW)).toBeNull());
  it('rejects bad email, empty/oversized scopes, wildcards and malformed ids', () => {
    expect(validateGuestInvite({ ...ok, email: 'nope' }, NOW)).toBe('invalid_email');
    expect(validateGuestInvite({ ...ok, scopes: [] }, NOW)).toBe('no_scopes');
    expect(validateGuestInvite({ ...ok, scopes: Array.from({ length: GUEST_MAX_SCOPES + 1 }, () => scope()) }, NOW)).toBe('too_many_scopes');
    expect(validateGuestInvite({ ...ok, scopes: [scope({ recordId: '*' })] }, NOW)).toBe('invalid_scope');
    expect(validateGuestInvite({ ...ok, scopes: [scope({ resource: '*' })] }, NOW)).toBe('invalid_scope');
    expect(validateGuestInvite({ ...ok, scopes: [scope({ resource: 'jobs; drop table' })] }, NOW)).toBe('invalid_scope');
    expect(validateGuestInvite({ ...ok, scopes: [scope({ actions: [] })] }, NOW)).toBe('invalid_action');
    expect(validateGuestInvite({ ...ok, scopes: [scope({ actions: ['delete' as 'view'] })] }, NOW)).toBe('invalid_action');
  });
  it('bounds expiry between now and the maximum window', () => {
    expect(validateGuestInvite({ ...ok, expiresAt: day(-1) }, NOW)).toBe('expiry_in_past');
    expect(validateGuestInvite({ ...ok, expiresAt: 'garbage' }, NOW)).toBe('expiry_in_past');
    expect(validateGuestInvite({ ...ok, expiresAt: day(GUEST_MAX_DAYS) }, NOW)).toBeNull();
    expect(validateGuestInvite({ ...ok, expiresAt: day(GUEST_MAX_DAYS + 1) }, NOW)).toBe('expiry_too_far');
  });
});

describe('status and guestCan', () => {
  it('derives status', () => {
    expect(guestStatus(invite({ redeemedBy: null, redeemedAt: null }), NOW)).toBe('invited');
    expect(guestStatus(invite(), NOW)).toBe('active');
    expect(guestStatus(invite({ expiresAt: day(-1) }), NOW)).toBe('expired');
    expect(guestStatus(invite({ revokedAt: NOW }), NOW)).toBe('revoked');
  });
  it('allows only the redeeming user, within scope, with MFA', () => {
    const inv = invite();
    expect(guestCan(inv, 'guest1', 'jobs', JOB, 'view', NOW, true)).toBe(true);
    expect(guestCan(inv, 'guest2', 'jobs', JOB, 'view', NOW, true)).toBe(false);
    expect(guestCan(inv, 'guest1', 'jobs', JOB, 'view', NOW, false)).toBe(false);
    expect(guestCan({ ...inv, requireMfa: false }, 'guest1', 'jobs', JOB, 'view', NOW, false)).toBe(true);
  });
  it('denies other records, other resources, unscoped actions, and unredeemed, expired or revoked invites', () => {
    const inv = invite();
    expect(guestCan(inv, 'guest1', 'jobs', '00000000-0000-4000-8000-000000000000', 'view', NOW, true)).toBe(false);
    expect(guestCan(inv, 'guest1', 'quotes', JOB, 'view', NOW, true)).toBe(false);
    expect(guestCan(inv, 'guest1', 'jobs', JOB, 'upload', NOW, true)).toBe(false);
    expect(guestCan(invite({ redeemedBy: null }), 'guest1', 'jobs', JOB, 'view', NOW, true)).toBe(false);
    expect(guestCan(invite({ expiresAt: day(-1) }), 'guest1', 'jobs', JOB, 'view', NOW, true)).toBe(false);
    expect(guestCan(invite({ revokedAt: NOW }), 'guest1', 'jobs', JOB, 'view', NOW, true)).toBe(false);
  });
  it('revocation applies at its timestamp, not before', () => {
    const inv = invite({ revokedAt: day(1) });
    expect(guestCan(inv, 'guest1', 'jobs', JOB, 'view', NOW, true)).toBe(true);
    expect(guestCan(inv, 'guest1', 'jobs', JOB, 'view', day(1), true)).toBe(false);
  });
});

describe('watermark and tokens', () => {
  it('identifies guest and expiry', () => {
    expect(watermarkText({ email: 'gc@example.com', expiresAt: day(30) }, NOW)).toBe('gc@example.com · 2026-11-05 · expires 2026-12-05');
  });
  it('generates distinct 256-bit base64url tokens', () => {
    const a = generateGuestToken();
    const b = generateGuestToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('hashes with SHA-256 (known vector) and compares in constant time', async () => {
    expect(await hashGuestToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});
