// NOT LIVE-VERIFIED: client helper tests only (no network).
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() }, from: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isOwner: true, permissions: {}, profile: null, teamMember: null }) }));

import { OAUTH_REASONS, readSettings, refreshDaysLeft, timeAgo, vireekFieldLabel } from './xero';

describe('xero client helpers', () => {
  it('readSettings falls back to safe defaults for junk', () => {
    expect(readSettings(null).entities.invoice.conflict).toBe('manual');
    expect(readSettings({ entities: { contact: { direction: 'nope' } } }).entities.contact.direction).toBe('both');
    expect(readSettings({ entities: { contact: { enabled: false } } }).entities.contact.enabled).toBe(false);
    expect(readSettings({ defaults: { foreignCurrency: 'skip' } }).defaults.foreignCurrency).toBe('skip');
  });

  it('formats ages and token expiry', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    expect(timeAgo(null, now)).toBe('Never');
    expect(timeAgo('2026-10-28T11:30:00Z', now)).toBe('30m ago');
    expect(timeAgo('2026-10-26T12:00:00Z', now)).toBe('2d ago');
    expect(refreshDaysLeft('2026-11-07T12:00:00Z', now)).toBe(10);
    expect(refreshDaysLeft(null, now)).toBeNull();
  });

  it('labels fields and explains every OAuth failure the callback can send', () => {
    expect(vireekFieldLabel('contact', 'address')).toBe('Street address');
    expect(vireekFieldLabel('contact', 'zzz')).toBe('zzz');
    for (const r of ['access_denied', 'invalid_state', 'missing_code', 'not_configured', 'no_refresh_token', 'multiple_orgs', 'no_org', 'org_in_use', 'exchange_failed']) {
      expect(OAUTH_REASONS[r]).toBeTruthy();
    }
  });
});
