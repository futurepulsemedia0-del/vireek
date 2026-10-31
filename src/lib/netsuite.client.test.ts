import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() }, from: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isOwner: true, permissions: {}, profile: null, teamMember: null }) }));

import { supabase } from '@/lib/supabase';
import { NS_VERIFICATION, connectNetSuite, readSettings, timeAgo, validateCredentials, vireekFieldLabel } from './netsuite';

const good = { accountId: '1234567_sb1', consumerKey: 'a'.repeat(64), consumerSecret: 'b'.repeat(64), tokenId: 'c'.repeat(64), tokenSecret: 'd'.repeat(64) };

describe('netsuite client helpers', () => {
  it('is labelled not live-verified', () => {
    expect(NS_VERIFICATION.liveVerified).toBe(false);
    expect(NS_VERIFICATION.label).toBe('Not live-verified');
  });

  it('readSettings falls back to safe defaults for junk', () => {
    expect(readSettings(null).entities.invoice.conflict).toBe('manual');
    expect(readSettings({ entities: { customer: { direction: 'nope' } } }).entities.customer.direction).toBe('both');
    expect(readSettings({ entities: { customer: { enabled: false } } }).entities.customer.enabled).toBe(false);
  });

  it('formats ages and labels fields', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    expect(timeAgo(null, now)).toBe('Never');
    expect(timeAgo('2026-10-18T11:30:00Z', now)).toBe('30m ago');
    expect(vireekFieldLabel('customer', 'phone')).toBe('Phone');
    expect(vireekFieldLabel('customer', 'zzz')).toBe('zzz');
  });

  it('validates credentials locally before anything is sent', async () => {
    expect(validateCredentials(good).ok).toBe(true);
    await expect(connectNetSuite({ ...good, accountId: 'bad id!' })).rejects.toThrow(/Account ID/);
    await expect(connectNetSuite({ ...good, tokenSecret: 'x' })).rejects.toThrow(/Token secret/);
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it('sends normalised credentials to ns-connect', async () => {
    (supabase.functions.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { ok: true, connection_id: 'x', company_name: null }, error: null });
    await connectNetSuite(good);
    const [fn, opts] = (supabase.functions.invoke as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fn).toBe('ns-connect');
    expect(opts.body.account_id).toBe('1234567_SB1');
  });
});
