import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() }, from: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isOwner: true, permissions: {}, profile: null, teamMember: null }) }));

import { ACCT_PROVIDERS, OAUTH_REASONS, PROVIDER_SLUG, fieldLabel, providerFromSlug, readSettings, refreshDaysLeft, timeAgo } from './accounting';

describe('accounting client helpers', () => {
  it('maps every provider to a URL slug and back', () => {
    for (const p of ACCT_PROVIDERS) expect(providerFromSlug(PROVIDER_SLUG[p])).toBe(p);
    expect(providerFromSlug('zoho-books')).toBe('zoho_books');
    expect(providerFromSlug('quickbooks')).toBeNull();
    expect(providerFromSlug(undefined)).toBeNull();
  });

  it('readSettings falls back to safe defaults for junk, per provider', () => {
    expect(readSettings('xero', null).entities.invoice.conflict).toBe('manual');
    expect(readSettings('xero', { entities: { customer: { direction: 'nope' } } }).entities.customer.direction).toBe('both');
    expect(readSettings('netsuite', {}).entities.item.direction).toBe('from_ext');
    expect(readSettings('zoho_books', { entities: { customer: { enabled: false } } }).entities.customer.enabled).toBe(false);
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
    expect(fieldLabel('xero', 'customer', 'address')).toBe('Billing address');
    expect(fieldLabel('xero', 'customer', 'zzz')).toBe('zzz');
    for (const r of ['access_denied', 'invalid_state', 'missing_code', 'not_configured', 'no_refresh_token', 'no_organisation', 'tenant_in_use', 'exchange_failed']) {
      expect(OAUTH_REASONS[r]).toBeTruthy();
    }
  });
});
