/**
 * Email verification — client library for /verify-email.
 *
 * Supabase Auth already rate limits confirmation emails server-side (roughly
 * one per 60 s per address, plus project-wide caps). This layer adds the
 * client half so people get a clear, honest experience instead of dead
 * buttons and raw error strings:
 *
 *   - a 60 s cooldown that SURVIVES refreshes and other tabs (localStorage),
 *   - a cap of 5 resends per rolling hour per address,
 *   - the server's own "wait N seconds" answer is honoured and persisted,
 *   - every Supabase error becomes a short, human message.
 *
 * Everything above `// ACTIONS` is pure and unit-tested; the actions take
 * their auth client, storage and clock as injectable options.
 */

import { supabase } from '@/lib/supabase';

export const OTP_LENGTH = 6;
export const RESEND_COOLDOWN_SECONDS = 60;
export const RESEND_MAX_PER_WINDOW = 5;
export const RESEND_WINDOW_MS = 60 * 60 * 1000;

const THROTTLE_PREFIX = 'vireek_verify_resend:';
const PENDING_EMAIL_KEY = 'vireek_verify_email';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthErrorLike {
  status?: number;
  code?: string;
  name?: string;
  message?: string;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  /** Seconds until another email may be requested (set when throttled). */
  waitSeconds?: number;
}

// ============================================================
// INPUT HELPERS
// ============================================================

export const normalizeEmail = (s: string): string => s.trim().toLowerCase();

export function isValidEmail(s: string): boolean {
  const v = s.trim();
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function isValidOtp(code: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code);
}

/** Only same-site absolute paths. Blocks `//evil.com`, `/\evil.com` and full URLs. */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return /^\/(?![/\\])[^\s\\]*$/.test(raw) ? raw : null;
}

export function formatWait(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  return s < 60 ? `${s}s` : `${Math.ceil(s / 60)} min`;
}

// ============================================================
// THROTTLE (pure)
// ============================================================

export interface ThrottleState {
  /** Timestamps (ms) of emails we sent for this address, newest last. */
  sends: number[];
  /** Server-imposed "do not send before" time (ms). 0 = none. */
  blockedUntil: number;
}

export type ThrottleReason = 'cooldown' | 'limit' | null;

export interface ResendStatus {
  canResend: boolean;
  waitSeconds: number;
  reason: ThrottleReason;
  /** Resends still available in the current rolling hour. */
  remaining: number;
}

export const emptyThrottle = (): ThrottleState => ({ sends: [], blockedUntil: 0 });

function prune(state: ThrottleState, now: number): ThrottleState {
  return {
    sends: state.sends.filter((t) => now - t < RESEND_WINDOW_MS && t <= now + 1000),
    blockedUntil: state.blockedUntil > now ? state.blockedUntil : 0,
  };
}

export function getResendStatus(state: ThrottleState, now: number): ResendStatus {
  const s = prune(state, now);
  const remaining = Math.max(0, RESEND_MAX_PER_WINDOW - s.sends.length);
  const last = s.sends.length ? s.sends[s.sends.length - 1] : 0;

  let until = 0;
  let reason: ThrottleReason = null;

  if (remaining === 0) {
    until = Math.max(s.sends[0] + RESEND_WINDOW_MS, s.blockedUntil);
    reason = 'limit';
  } else {
    const cooldownEnd = last ? last + RESEND_COOLDOWN_SECONDS * 1000 : 0;
    until = Math.max(cooldownEnd, s.blockedUntil);
    if (until > now) reason = 'cooldown';
  }

  const waitMs = Math.max(0, until - now);
  return { canResend: waitMs === 0, waitSeconds: Math.ceil(waitMs / 1000), reason: waitMs > 0 ? reason : null, remaining };
}

export function recordResend(state: ThrottleState, now: number): ThrottleState {
  const s = prune(state, now);
  return { sends: [...s.sends, now], blockedUntil: s.blockedUntil };
}

export function applyServerBlock(state: ThrottleState, seconds: number, now: number): ThrottleState {
  const s = prune(state, now);
  return { sends: s.sends, blockedUntil: Math.max(s.blockedUntil, now + Math.max(1, seconds) * 1000) };
}

// ============================================================
// STORAGE
// ============================================================

export function browserStorage(kind: 'local' | 'session' = 'local'): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null; // blocked (private mode, embedded browsers)
  }
}

export function loadThrottle(email: string, storage: StorageLike | null): ThrottleState {
  if (!storage) return emptyThrottle();
  try {
    const raw = storage.getItem(THROTTLE_PREFIX + normalizeEmail(email));
    if (!raw) return emptyThrottle();
    const parsed = JSON.parse(raw) as Partial<ThrottleState>;
    const sends = Array.isArray(parsed.sends) ? parsed.sends.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : [];
    const blockedUntil = typeof parsed.blockedUntil === 'number' && Number.isFinite(parsed.blockedUntil) ? parsed.blockedUntil : 0;
    return { sends: sends.slice(-RESEND_MAX_PER_WINDOW), blockedUntil };
  } catch {
    return emptyThrottle();
  }
}

export function saveThrottle(email: string, state: ThrottleState, storage: StorageLike | null): void {
  if (!storage) return;
  try {
    storage.setItem(THROTTLE_PREFIX + normalizeEmail(email), JSON.stringify(state));
  } catch {
    /* quota / blocked — the server-side limit still applies */
  }
}

export function readPendingEmail(storage: StorageLike | null = browserStorage('session')): string {
  try {
    const v = storage?.getItem(PENDING_EMAIL_KEY) ?? '';
    return isValidEmail(v) ? normalizeEmail(v) : '';
  } catch {
    return '';
  }
}

export function writePendingEmail(email: string, storage: StorageLike | null = browserStorage('session')): void {
  try {
    if (!storage) return;
    if (isValidEmail(email)) storage.setItem(PENDING_EMAIL_KEY, normalizeEmail(email));
    else storage.removeItem(PENDING_EMAIL_KEY);
  } catch {
    /* non-fatal */
  }
}

/**
 * Seconds the resend button should start disabled for when the screen opens.
 * No record at all means we got here straight after signup/login, which just
 * sent an email — so assume one is in flight and wait a full cooldown.
 */
export function getInitialResendSeconds(email: string, storage: StorageLike | null, now: number): number {
  const state = loadThrottle(email, storage);
  if (state.sends.length === 0 && state.blockedUntil <= now) return RESEND_COOLDOWN_SECONDS;
  return getResendStatus(state, now).waitSeconds;
}

// ============================================================
// ERROR MAPPING (pure)
// ============================================================

const NETWORK_MESSAGE = 'We couldn’t reach the server. Check your connection and try again.';

const isNetworkError = (e: AuthErrorLike): boolean =>
  e.name === 'AuthRetryableFetchError' || e.status === 0 || /failed to fetch|network|load failed/i.test(e.message ?? '');

/** Seconds to wait if this error is a rate limit, otherwise null. */
export function parseRetryAfterSeconds(e: AuthErrorLike): number | null {
  const msg = e.message ?? '';
  const limited =
    e.status === 429 ||
    e.code === 'over_email_send_rate_limit' ||
    e.code === 'over_request_rate_limit' ||
    /security purposes|rate limit|too many/i.test(msg);
  if (!limited) return null;
  const m = msg.match(/(\d+)\s*(second|sec|minute|min)/i);
  if (!m) return RESEND_COOLDOWN_SECONDS;
  const n = Number(m[1]);
  return /^min/i.test(m[2]) ? n * 60 : n;
}

export function describeVerifyError(e: AuthErrorLike): string {
  if (parseRetryAfterSeconds(e) !== null) return 'Too many attempts. Wait a minute, then try again.';
  if (isNetworkError(e)) return NETWORK_MESSAGE;
  if (e.code === 'otp_expired' || /expired|invalid/i.test(e.message ?? '')) {
    return 'That code is invalid or has expired. Check the digits, or send a new code.';
  }
  return 'Something went wrong verifying that code. Please try again.';
}

export function describeResendError(e: AuthErrorLike): string {
  if (isNetworkError(e)) return NETWORK_MESSAGE;
  if (/already.*(confirmed|verified|registered)/i.test(e.message ?? '')) return 'This email is already verified. Sign in to continue.';
  return 'We couldn’t send a new code. Please try again shortly.';
}

function throttledMessage(status: ResendStatus): string {
  return status.reason === 'limit'
    ? `You’ve requested the maximum number of emails for now. Try again in ${formatWait(status.waitSeconds)}.`
    : `Please wait ${formatWait(status.waitSeconds)} before requesting another code.`;
}

// ============================================================
// ACTIONS
// ============================================================

interface AuthClientLike {
  verifyOtp(args: { email: string; token: string; type: 'email' }): Promise<{ error: AuthErrorLike | null }>;
  resend(args: { type: 'signup'; email: string; options?: { emailRedirectTo?: string } }): Promise<{ error: AuthErrorLike | null }>;
}

export interface ActionOptions {
  auth?: AuthClientLike;
  storage?: StorageLike | null;
  now?: () => number;
  /** Where the confirmation link in the email sends the person. */
  redirectTo?: string;
}

export function verificationRedirectUrl(): string {
  const base = (import.meta.env.VITE_SITE_URL as string | undefined) || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base.replace(/\/$/, '')}/verify-email`;
}

export async function verifyEmailCode(email: string, code: string, opts: ActionOptions = {}): Promise<ActionResult> {
  if (!isValidEmail(email)) return { success: false, error: 'Enter a valid email address first.' };
  if (!isValidOtp(code)) return { success: false, error: `Enter all ${OTP_LENGTH} digits of the code.` };
  const auth = opts.auth ?? (supabase.auth as unknown as AuthClientLike);
  try {
    const { error } = await auth.verifyOtp({ email: normalizeEmail(email), token: code, type: 'email' });
    if (error) return { success: false, error: describeVerifyError(error) };
    return { success: true };
  } catch (e) {
    return { success: false, error: describeVerifyError(e as AuthErrorLike) };
  }
}

export async function resendVerificationEmail(email: string, opts: ActionOptions = {}): Promise<ActionResult> {
  if (!isValidEmail(email)) return { success: false, error: 'Enter a valid email address.' };

  const auth = opts.auth ?? (supabase.auth as unknown as AuthClientLike);
  const storage = opts.storage === undefined ? browserStorage('local') : opts.storage;
  const now = opts.now ?? Date.now;
  const normalized = normalizeEmail(email);

  const before = getResendStatus(loadThrottle(normalized, storage), now());
  if (!before.canResend) return { success: false, error: throttledMessage(before), waitSeconds: before.waitSeconds };

  try {
    const { error } = await auth.resend({
      type: 'signup',
      email: normalized,
      options: { emailRedirectTo: opts.redirectTo ?? verificationRedirectUrl() },
    });

    if (error) {
      const retry = parseRetryAfterSeconds(error);
      if (retry !== null) {
        // Re-read: another tab may have written since the check above.
        const blocked = applyServerBlock(loadThrottle(normalized, storage), retry, now());
        saveThrottle(normalized, blocked, storage);
        return {
          success: false,
          error: `Please wait ${formatWait(retry)} before requesting another code.`,
          waitSeconds: retry,
        };
      }
      return { success: false, error: describeResendError(error) };
    }

    saveThrottle(normalized, recordResend(loadThrottle(normalized, storage), now()), storage);
    return { success: true };
  } catch (e) {
    return { success: false, error: describeResendError(e as AuthErrorLike) };
  }
}
