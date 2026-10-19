import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() }, from: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isOwner: true, permissions: {}, profile: null, teamMember: null }) }));

import { OAUTH_REASONS, readSettings, refreshDaysLeft, timeAgo, vireekFieldLabel } from './quickbooks';

describe('quickbooks client helpers', () => {
  it('readSettings falls back to safe defaults for junk', () => {
    expect(readSettings(null).entities.invoice.conflict).toBe('manual');
    expect(readSettings({ entities: { customer: { direction: 'nope' } } }).entities.customer.direction).toBe('both');
    expect(readSettings({ entities: { customer: { enabled: false } } }).entities.customer.enabled).toBe(false);
  });

  it('formats ages and token expiry', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    expect(timeAgo(null, now)).toBe('Never');
    expect(timeAgo('2026-10-18T11:30:00Z', now)).toBe('30m ago');
    expect(timeAgo('2026-10-16T12:00:00Z', now)).toBe('2d ago');
    expect(refreshDaysLeft('2026-10-28T12:00:00Z', now)).toBe(10);
    expect(refreshDaysLeft(null, now)).toBeNull();
  });

  it('labels fields and explains every OAuth failure the callback can send', () => {
    expect(vireekFieldLabel('customer', 'address')).toBe('Billing address');
    expect(vireekFieldLabel('customer', 'zzz')).toBe('zzz');
    for (const r of ['access_denied', 'invalid_state', 'missing_code', 'missing_realm', 'not_configured', 'no_refresh_token', 'realm_in_use', 'exchange_failed']) {
      expect(OAUTH_REASONS[r]).toBeTruthy();
    }
  });
});
