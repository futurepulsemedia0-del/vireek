import { beforeEach, describe, expect, it, vi } from 'vitest';

const signInWithOtp = vi.fn();
const verifyOtp = vi.fn();
const maybeSingle = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOtp: (...a: unknown[]) => signInWithOtp(...a),
      verifyOtp: (...a: unknown[]) => verifyOtp(...a),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => maybeSingle() }) }) }),
  },
}));

import { requestPhoneSignInCode, verifyPhoneSignInCode } from './phoneAuth';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requestPhoneSignInCode', () => {
  it('never creates users from the business sign-in page', async () => {
    signInWithOtp.mockResolvedValue({ error: null });
    const res = await requestPhoneSignInCode('+15551234567');
    expect(res).toEqual({ ok: true });
    expect(signInWithOtp).toHaveBeenCalledWith({ phone: '+15551234567', options: { shouldCreateUser: false } });
  });
  it('maps unknown numbers to no_account', async () => {
    signInWithOtp.mockResolvedValue({ error: { message: 'Signups not allowed for otp', code: 'otp_disabled', status: 400 } });
    expect(await requestPhoneSignInCode('+15551234567')).toMatchObject({ ok: false, reason: 'no_account' });
  });
  it('maps rate limits', async () => {
    signInWithOtp.mockResolvedValue({ error: { message: 'rate limit', status: 429 } });
    expect(await requestPhoneSignInCode('+15551234567')).toMatchObject({ ok: false, reason: 'rate_limited' });
  });
  it('maps unexpected failures and thrown errors', async () => {
    signInWithOtp.mockResolvedValue({ error: { message: 'sms provider down', status: 500 } });
    expect(await requestPhoneSignInCode('+15551234567')).toMatchObject({ ok: false, reason: 'failed' });
    signInWithOtp.mockRejectedValue(new Error('network'));
    expect(await requestPhoneSignInCode('+15551234567')).toMatchObject({ ok: false, reason: 'failed' });
  });
});

describe('verifyPhoneSignInCode', () => {
  it('sends business accounts (with a profile) to the dashboard', async () => {
    verifyOtp.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    maybeSingle.mockResolvedValue({ data: { id: 'u1' }, error: null });
    expect(await verifyPhoneSignInCode('+15551234567', '123456')).toEqual({ ok: true, destination: 'business' });
    expect(verifyOtp).toHaveBeenCalledWith({ phone: '+15551234567', token: '123456', type: 'sms' });
  });
  it('sends phone-only accounts (no profile) to Vireek Home', async () => {
    verifyOtp.mockResolvedValue({ data: { user: { id: 'u2' } }, error: null });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await verifyPhoneSignInCode('+15551234567', '123456')).toEqual({ ok: true, destination: 'home' });
  });
  it('keeps the business path if the profile lookup fails', async () => {
    verifyOtp.mockResolvedValue({ data: { user: { id: 'u3' } }, error: null });
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await verifyPhoneSignInCode('+15551234567', '123456')).toEqual({ ok: true, destination: 'business' });
  });
  it('returns a friendly message for a bad code', async () => {
    verifyOtp.mockResolvedValue({ data: {}, error: { message: 'Token has expired or is invalid' } });
    expect(await verifyPhoneSignInCode('+15551234567', '000000')).toMatchObject({ ok: false });
  });
});
