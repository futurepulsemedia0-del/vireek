import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() }, from: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isOwner: true, permissions: {}, profile: null, teamMember: null }) }));

import { NOT_LIVE_VERIFIED_LABEL, NOT_LIVE_VERIFIED_NOTE, readSettings, timeAgo, validateConnectInput, vireekFieldLabel } from './sageIntacct';

describe('sage intacct client helpers', () => {
  it('readSettings falls back to safe defaults for junk', () => {
    expect(readSettings(null).entities.invoice.conflict).toBe('manual');
    expect(readSettings({ entities: { customer: { direction: 'nope' } } }).entities.customer.direction).toBe('both');
    expect(readSettings({ entities: { customer: { enabled: false } } }).entities.customer.enabled).toBe(false);
  });

  it('formats ages', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    expect(timeAgo(null, now)).toBe('Never');
    expect(timeAgo('2026-10-18T11:30:00Z', now)).toBe('30m ago');
    expect(timeAgo('2026-10-16T12:00:00Z', now)).toBe('2d ago');
  });

  it('labels fields', () => {
    expect(vireekFieldLabel('customer', 'address')).toBe('Billing address');
    expect(vireekFieldLabel('account', 'code')).toBe('Account number');
    expect(vireekFieldLabel('customer', 'zzz')).toBe('zzz');
  });

  it('validates the connect form before anything is sent', () => {
    const ok = { companyId: 'ACME-1', userId: 'ws.user', password: 'secret', entityId: '' };
    expect(validateConnectInput(ok)).toBeNull();
    expect(validateConnectInput({ ...ok, companyId: 'bad id<' })).toBeTruthy();
    expect(validateConnectInput({ ...ok, userId: '' })).toBeTruthy();
    expect(validateConnectInput({ ...ok, password: '' })).toBeTruthy();
    expect(validateConnectInput({ ...ok, entityId: 'x y' })).toBeTruthy();
    expect(validateConnectInput({ ...ok, entityId: 'US-East' })).toBeNull();
  });

  it('always carries the not-live-verified label', () => {
    expect(NOT_LIVE_VERIFIED_LABEL).toBe('Not live-verified');
    expect(NOT_LIVE_VERIFIED_NOTE).toContain('simulated');
  });
});
