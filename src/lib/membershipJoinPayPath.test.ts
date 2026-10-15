import { describe, it, expect, beforeEach, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn(), functions: { invoke } } }));

import { isSafePayPath, startMembershipCheckout } from './membershipJoin';

const TOKEN = 'a'.repeat(64);
const VALID = { name: 'Dana Smith', email: 'dana@example.com', phone: '' };

describe('isSafePayPath', () => {
  it('accepts only our own /pay/<64-hex token> path', () => {
    expect(isSafePayPath(`/pay/${TOKEN}`)).toBe(true);
  });

  it('rejects open-redirect and malformed values', () => {
    expect(isSafePayPath(`//evil.com/pay/${TOKEN}`)).toBe(false);
    expect(isSafePayPath(`https://evil.com/pay/${TOKEN}`)).toBe(false);
    expect(isSafePayPath(`/pay/${TOKEN}/extra`)).toBe(false);
    expect(isSafePayPath(`/pay/${TOKEN}?next=https://evil.com`)).toBe(false);
    expect(isSafePayPath('/pay/short')).toBe(false);
    expect(isSafePayPath(`/pay/${'A'.repeat(64)}`)).toBe(false);
    expect(isSafePayPath('')).toBe(false);
    expect(isSafePayPath(null)).toBe(false);
    expect(isSafePayPath(undefined)).toBe(false);
  });
});

describe('startMembershipCheckout (Payment Element flow)', () => {
  beforeEach(() => invoke.mockReset());

  it('sends the customer to our own payment page, where Apple Pay / Google Pay are offered', async () => {
    invoke.mockResolvedValue({ data: { pay_path: `/pay/${TOKEN}` }, error: null });
    expect(await startMembershipCheckout('annual-maintenance-a1b2', VALID)).toEqual({ ok: true, url: `/pay/${TOKEN}` });
  });

  it('prefers pay_path over a legacy hosted checkout url', async () => {
    invoke.mockResolvedValue({ data: { pay_path: `/pay/${TOKEN}`, checkout_url: 'https://checkout.stripe.com/c/pay/x' }, error: null });
    expect(await startMembershipCheckout('annual-maintenance-a1b2', VALID)).toEqual({ ok: true, url: `/pay/${TOKEN}` });
  });

  it('refuses an unsafe pay_path from the server', async () => {
    invoke.mockResolvedValue({ data: { pay_path: 'https://evil.com/pay' }, error: null });
    expect(await startMembershipCheckout('annual-maintenance-a1b2', VALID)).toEqual({ ok: false, reason: 'error' });
  });
});
