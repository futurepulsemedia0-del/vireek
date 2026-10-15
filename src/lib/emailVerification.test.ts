import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RESEND_COOLDOWN_SECONDS,
  RESEND_MAX_PER_WINDOW,
  RESEND_WINDOW_MS,
  applyServerBlock,
  describeResendError,
  describeVerifyError,
  emptyThrottle,
  formatWait,
  getInitialResendSeconds,
  getResendStatus,
  isValidEmail,
  isValidOtp,
  loadThrottle,
  normalizeEmail,
  parseRetryAfterSeconds,
  readPendingEmail,
  recordResend,
  resendVerificationEmail,
  safeNextPath,
  saveThrottle,
  verificationRedirectUrl,
  verifyEmailCode,
  writePendingEmail,
  type StorageLike,
  type ThrottleState,
} from '@/lib/emailVerification';

vi.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));

const T0 = 1_800_000_000_000;
const SEC = 1000;

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const okAuth = () => ({
  resend: vi.fn().mockResolvedValue({ error: null }),
  verifyOtp: vi.fn().mockResolvedValue({ error: null }),
});

afterEach(() => vi.unstubAllEnvs());

describe('input helpers', () => {
  it('normalizes and validates emails and codes', () => {
    expect(normalizeEmail('  Maria@Example.COM ')).toBe('maria@example.com');
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@c.com')).toBe(false);
    expect(isValidOtp('123456')).toBe(true);
    expect(isValidOtp('12345')).toBe(false);
    expect(isValidOtp('12345a')).toBe(false);
  });

  it('only allows same-site next paths', () => {
    expect(safeNextPath('/dashboard')).toBe('/dashboard');
    expect(safeNextPath('/invite/abc?x=1')).toBe('/invite/abc?x=1');
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'dashboard', 'javascript:alert(1)', '', null, undefined]) {
      expect(safeNextPath(bad as string | null | undefined)).toBeNull();
    }
  });

  it('formats waits', () => {
    expect(formatWait(0)).toBe('1s');
    expect(formatWait(47)).toBe('47s');
    expect(formatWait(61)).toBe('2 min');
    expect(formatWait(3600)).toBe('60 min');
  });
});

describe('resend throttle', () => {
  it('allows the first send, then enforces the cooldown', () => {
    expect(getResendStatus(emptyThrottle(), T0)).toMatchObject({ canResend: true, waitSeconds: 0, reason: null, remaining: RESEND_MAX_PER_WINDOW });

    const s = recordResend(emptyThrottle(), T0);
    expect(getResendStatus(s, T0 + 10 * SEC)).toMatchObject({ canResend: false, waitSeconds: RESEND_COOLDOWN_SECONDS - 10, reason: 'cooldown', remaining: 4 });
    expect(getResendStatus(s, T0 + 59_500).waitSeconds).toBe(1);
    expect(getResendStatus(s, T0 + RESEND_COOLDOWN_SECONDS * SEC).canResend).toBe(true);
  });

  it('caps resends per rolling hour and frees a slot when the oldest ages out', () => {
    let s: ThrottleState = emptyThrottle();
    for (let i = 0; i < RESEND_MAX_PER_WINDOW; i++) s = recordResend(s, T0 + i * 61 * SEC);
    const afterFifth = T0 + 5 * 61 * SEC;

    const blocked = getResendStatus(s, afterFifth);
    expect(blocked).toMatchObject({ canResend: false, reason: 'limit', remaining: 0 });
    expect(blocked.waitSeconds).toBe(Math.ceil((T0 + RESEND_WINDOW_MS - afterFifth) / SEC));

    expect(getResendStatus(s, T0 + RESEND_WINDOW_MS + SEC)).toMatchObject({ canResend: true, remaining: 1 });
  });

  it('honours a server-imposed block longer than the cooldown, and ignores expired ones', () => {
    const s = applyServerBlock(emptyThrottle(), 120, T0);
    expect(getResendStatus(s, T0 + 30 * SEC)).toMatchObject({ canResend: false, waitSeconds: 90, reason: 'cooldown' });
    expect(getResendStatus(s, T0 + 121 * SEC).canResend).toBe(true);
    // blocks never shrink
    expect(applyServerBlock(s, 10, T0).blockedUntil).toBe(T0 + 120 * SEC);
  });

  it('ignores timestamps from the future (clock tampering)', () => {
    const s: ThrottleState = { sends: [T0 + 10 * 60 * 60 * 1000], blockedUntil: 0 };
    expect(getResendStatus(s, T0).canResend).toBe(true);
  });
});

describe('storage', () => {
  it('round-trips per address, case-insensitively', () => {
    const store = memoryStorage();
    const s = recordResend(emptyThrottle(), T0);
    saveThrottle('Maria@Example.com', s, store);
    expect(loadThrottle('maria@example.com', store)).toEqual(s);
    expect(loadThrottle('other@example.com', store)).toEqual(emptyThrottle());
  });

  it('survives corrupt data and missing storage', () => {
    const store = memoryStorage();
    store.setItem('vireek_verify_resend:a@b.co', '{not json');
    expect(loadThrottle('a@b.co', store)).toEqual(emptyThrottle());
    store.setItem('vireek_verify_resend:a@b.co', JSON.stringify({ sends: ['x', 5, null], blockedUntil: 'no' }));
    expect(loadThrottle('a@b.co', store)).toEqual({ sends: [5], blockedUntil: 0 });
    expect(loadThrottle('a@b.co', null)).toEqual(emptyThrottle());
    expect(() => saveThrottle('a@b.co', emptyThrottle(), null)).not.toThrow();
  });

  it('keeps the pending email only when valid', () => {
    const store = memoryStorage();
    writePendingEmail(' Maria@Example.com ', store);
    expect(readPendingEmail(store)).toBe('maria@example.com');
    writePendingEmail('', store);
    expect(readPendingEmail(store)).toBe('');
    store.setItem('vireek_verify_email', 'garbage');
    expect(readPendingEmail(store)).toBe('');
  });

  it('starts the resend button on a full cooldown when nothing was sent yet', () => {
    const store = memoryStorage();
    expect(getInitialResendSeconds('a@b.co', store, T0)).toBe(RESEND_COOLDOWN_SECONDS);
    expect(getInitialResendSeconds('a@b.co', null, T0)).toBe(RESEND_COOLDOWN_SECONDS);
    saveThrottle('a@b.co', recordResend(emptyThrottle(), T0), store);
    expect(getInitialResendSeconds('a@b.co', store, T0 + 25 * SEC)).toBe(35);
    expect(getInitialResendSeconds('a@b.co', store, T0 + 90 * SEC)).toBe(0);
  });
});

describe('error mapping', () => {
  it('parses Supabase rate-limit answers', () => {
    expect(parseRetryAfterSeconds({ status: 429, message: 'For security purposes, you can only request this after 47 seconds.' })).toBe(47);
    expect(parseRetryAfterSeconds({ code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' })).toBe(RESEND_COOLDOWN_SECONDS);
    expect(parseRetryAfterSeconds({ message: 'Please retry in 2 minutes, too many requests' })).toBe(120);
    expect(parseRetryAfterSeconds({ status: 400, message: 'Token has expired or is invalid' })).toBeNull();
  });

  it('describes verification failures in plain language', () => {
    expect(describeVerifyError({ code: 'otp_expired', message: 'Token has expired or is invalid' })).toMatch(/invalid or has expired/);
    expect(describeVerifyError({ status: 429, message: 'rate limit' })).toMatch(/Too many attempts/);
    expect(describeVerifyError({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' })).toMatch(/reach the server/);
    expect(describeVerifyError({ message: 'boom' })).toMatch(/Something went wrong/);
  });

  it('describes resend failures without leaking raw errors', () => {
    expect(describeResendError({ name: 'AuthRetryableFetchError' })).toMatch(/reach the server/);
    expect(describeResendError({ message: 'User already confirmed' })).toMatch(/already verified/);
    expect(describeResendError({ message: 'smtp exploded: 10.0.0.5' })).toBe('We couldn’t send a new code. Please try again shortly.');
  });
});

describe('verifyEmailCode', () => {
  it('rejects bad input without calling Supabase', async () => {
    const auth = okAuth();
    expect((await verifyEmailCode('nope', '123456', { auth })).success).toBe(false);
    expect((await verifyEmailCode('a@b.co', '12', { auth })).error).toMatch(/all 6 digits/);
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('verifies with the normalized email and maps outcomes', async () => {
    const auth = okAuth();
    expect(await verifyEmailCode(' A@B.co ', '123456', { auth })).toEqual({ success: true });
    expect(auth.verifyOtp).toHaveBeenCalledWith({ email: 'a@b.co', token: '123456', type: 'email' });

    auth.verifyOtp.mockResolvedValueOnce({ error: { code: 'otp_expired', message: 'Token has expired or is invalid' } });
    expect(await verifyEmailCode('a@b.co', '123456', { auth })).toMatchObject({ success: false, error: expect.stringMatching(/invalid or has expired/) });

    auth.verifyOtp.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect((await verifyEmailCode('a@b.co', '123456', { auth })).error).toMatch(/reach the server/);
  });
});

describe('resendVerificationEmail', () => {
  const opts = (auth: ReturnType<typeof okAuth>, storage: StorageLike | null, now: () => number) => ({
    auth,
    storage,
    now,
    redirectTo: 'https://vireek.com/verify-email',
  });

  it('sends a signup confirmation with the redirect and then blocks a rapid second send', async () => {
    const auth = okAuth();
    const store = memoryStorage();
    let now = T0;

    expect(await resendVerificationEmail(' Maria@Example.com ', opts(auth, store, () => now))).toEqual({ success: true });
    expect(auth.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'maria@example.com',
      options: { emailRedirectTo: 'https://vireek.com/verify-email' },
    });

    now = T0 + 20 * SEC;
    const second = await resendVerificationEmail('maria@example.com', opts(auth, store, () => now));
    expect(second).toMatchObject({ success: false, waitSeconds: 40, error: expect.stringMatching(/wait 40s/) });
    expect(auth.resend).toHaveBeenCalledTimes(1);

    now = T0 + 61 * SEC;
    expect((await resendVerificationEmail('maria@example.com', opts(auth, store, () => now))).success).toBe(true);
    expect(auth.resend).toHaveBeenCalledTimes(2);
  });

  it('stops after the hourly cap and tells the person how long to wait', async () => {
    const auth = okAuth();
    const store = memoryStorage();
    let now = T0;
    for (let i = 0; i < RESEND_MAX_PER_WINDOW; i++) {
      now = T0 + i * 61 * SEC;
      expect((await resendVerificationEmail('a@b.co', opts(auth, store, () => now))).success).toBe(true);
    }
    now += 61 * SEC;
    const res = await resendVerificationEmail('a@b.co', opts(auth, store, () => now));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/maximum number of emails/);
    expect(res.waitSeconds).toBeGreaterThan(60);
    expect(auth.resend).toHaveBeenCalledTimes(RESEND_MAX_PER_WINDOW);
  });

  it('persists the server’s wait time when Supabase rate limits, without counting it as a send', async () => {
    const auth = okAuth();
    const store = memoryStorage();
    auth.resend.mockResolvedValueOnce({ error: { status: 429, message: 'For security purposes, you can only request this after 47 seconds.' } });

    const res = await resendVerificationEmail('a@b.co', opts(auth, store, () => T0));
    expect(res).toMatchObject({ success: false, waitSeconds: 47 });
    expect(loadThrottle('a@b.co', store).sends).toEqual([]);

    // a refresh (new call) is still blocked locally — the server isn't hit again
    const again = await resendVerificationEmail('a@b.co', opts(auth, store, () => T0 + 10 * SEC));
    expect(again).toMatchObject({ success: false, waitSeconds: 37 });
    expect(auth.resend).toHaveBeenCalledTimes(1);
  });

  it('reports other failures plainly and does not record a send', async () => {
    const auth = okAuth();
    const store = memoryStorage();
    auth.resend.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect((await resendVerificationEmail('a@b.co', opts(auth, store, () => T0))).error).toMatch(/reach the server/);
    auth.resend.mockResolvedValueOnce({ error: { status: 500, message: 'smtp exploded' } });
    expect((await resendVerificationEmail('a@b.co', opts(auth, store, () => T0))).error).toMatch(/couldn’t send a new code/);
    expect(loadThrottle('a@b.co', store).sends).toEqual([]);
  });

  it('rejects an invalid email and works without storage', async () => {
    const auth = okAuth();
    expect((await resendVerificationEmail('nope', opts(auth, null, () => T0))).success).toBe(false);
    expect(auth.resend).not.toHaveBeenCalled();
    expect((await resendVerificationEmail('a@b.co', opts(auth, null, () => T0))).success).toBe(true);
  });
});

describe('verificationRedirectUrl', () => {
  it('prefers VITE_SITE_URL and trims the trailing slash', () => {
    vi.stubEnv('VITE_SITE_URL', 'https://vireek.com/');
    expect(verificationRedirectUrl()).toBe('https://vireek.com/verify-email');
  });
});
