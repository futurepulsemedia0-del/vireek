import { supabase } from '@/lib/supabase';

// ============================================================
// MFA challenge — pure helpers + Supabase calls for /mfa
//
// TOTP uses Supabase Auth's native MFA (challenge + verify). Recovery
// codes use the `mfa-recovery` edge function (Supabase has none built in).
// ============================================================

export const TOTP_LENGTH = 6;
export const RECOVERY_CODE_LENGTH = 10;
export const MAX_LOCAL_FAILURES = 5;
export const LOCKOUT_SECONDS = 30;
export const MFA_PATH = '/mfa';
export const SECURITY_SETTINGS_PATH = '/dashboard/settings/security';

// Mirrors supabase/functions/_shared/mfa/recoveryCodes.ts (a test fails on drift).
export const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export type MfaGate =
  | { kind: 'no-session' }
  | { kind: 'ok' } // nothing to do: no verified factor, or already AAL2
  | { kind: 'challenge'; factorId: string };

// ---------- pure helpers ----------

/** Keeps digits only, capped at the TOTP length ("123 456" → "123456"). */
export function sanitizeTotp(input: string): string {
  return input.replace(/\D/g, '').slice(0, TOTP_LENGTH);
}

export function isTotpComplete(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** Uppercases and strips everything that isn't a letter or digit. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, RECOVERY_CODE_LENGTH);
}

/** Display form while typing: "abcdefghjk" → "ABCDE-FGHJK". */
export function formatRecoveryInput(input: string): string {
  const n = normalizeRecoveryCode(input);
  return n.length > RECOVERY_CODE_LENGTH / 2 ? `${n.slice(0, RECOVERY_CODE_LENGTH / 2)}-${n.slice(RECOVERY_CODE_LENGTH / 2)}` : n;
}

export function isRecoveryComplete(input: string): boolean {
  const n = normalizeRecoveryCode(input);
  return n.length === RECOVERY_CODE_LENGTH && [...n].every((c) => RECOVERY_ALPHABET.includes(c));
}

/**
 * Only same-site absolute paths are allowed as a post-challenge destination:
 * no protocol-relative ("//evil.com"), no backslashes, and never /mfa itself
 * (which would loop).
 */
export function safeNextPath(candidate: unknown, fallback = '/dashboard'): string {
  if (typeof candidate !== 'string') return fallback;
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return fallback;
  if (/[\u0000-\u001f]/.test(candidate)) return fallback;
  if (candidate === MFA_PATH || candidate.startsWith(`${MFA_PATH}?`) || candidate.startsWith(`${MFA_PATH}/`)) return fallback;
  return candidate;
}

export type MfaErrorKind = 'invalid-code' | 'rate-limited' | 'expired' | 'network' | 'unknown';

export interface FriendlyError {
  kind: MfaErrorKind;
  message: string;
}

/** Turns a Supabase / edge-function error into something a person can act on. */
export function toMfaError(err: unknown, mode: 'totp' | 'recovery'): FriendlyError {
  const e = (err ?? {}) as { code?: string; message?: string; status?: number; name?: string };
  const text = `${e.code ?? ''} ${e.message ?? ''}`.toLowerCase();

  if (e.status === 429 || text.includes('rate') || text.includes('too many')) {
    return { kind: 'rate-limited', message: 'Too many attempts. Please wait a minute and try again.' };
  }
  if (e.name === 'AuthRetryableFetchError' || text.includes('failed to fetch') || text.includes('network')) {
    return { kind: 'network', message: "We couldn't reach the server. Check your connection and try again." };
  }
  if (text.includes('factor') && (text.includes('not found') || text.includes('expired'))) {
    return { kind: 'expired', message: 'This verification expired. Refresh the page and try again.' };
  }
  if (text.includes('challenge') && (text.includes('expired') || text.includes('not found'))) {
    return { kind: 'expired', message: 'This verification expired. Please try again.' };
  }
  if (text.includes('invalid') || text.includes('incorrect') || e.status === 400 || e.status === 422) {
    return {
      kind: 'invalid-code',
      message: mode === 'totp' ? "That code isn't right. Check your authenticator app and try again." : "That recovery code isn't valid or has already been used.",
    };
  }
  return { kind: 'unknown', message: e.message || 'Something went wrong. Please try again.' };
}

// ---------- Supabase calls ----------

/** Decides whether this session still has to pass the second factor. */
export async function getMfaGate(): Promise<MfaGate> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return { kind: 'no-session' };

  const { data: aal, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw error;
  if (!aal || aal.nextLevel !== 'aal2' || aal.currentLevel === 'aal2') return { kind: 'ok' };

  const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError) throw factorsError;
  const factor = (factors?.totp ?? []).find((f) => f.status === 'verified');
  // nextLevel said aal2 but no verified TOTP is listed: nothing to challenge with.
  return factor ? { kind: 'challenge', factorId: factor.id } : { kind: 'ok' };
}

/** Challenge + verify in one go. Throws on failure; on success the client now holds an AAL2 session. */
export async function verifyTotp(factorId: string, code: string): Promise<void> {
  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
  if (challengeError) throw challengeError;
  const { error } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
  if (error) throw error;
}

async function readFunctionError(error: unknown): Promise<{ message: string; status?: number }> {
  const e = error as { message?: string; context?: Response };
  let message = e.message || 'Request failed.';
  const status = e.context?.status;
  if (e.context && typeof e.context.json === 'function') {
    try {
      const body = (await e.context.json()) as { detail?: string; error?: string };
      message = body.detail || body.error || message;
    } catch {
      /* keep generic message */
    }
  }
  return { message, status };
}

/** Redeems a recovery code. On success the server has removed the TOTP factor; the session is refreshed so the client sees it. */
export async function redeemRecoveryCode(code: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('mfa-recovery', { body: { action: 'redeem', code: normalizeRecoveryCode(code) } });
  if (error) {
    const { message, status } = await readFunctionError(error);
    throw Object.assign(new Error(message), { status });
  }
  if (!(data as { ok?: boolean } | null)?.ok) throw new Error('Recovery failed. Please try again.');
  const { error: refreshError } = await supabase.auth.refreshSession();
  if (refreshError) throw refreshError;
}

export async function signOutToLogin(): Promise<void> {
  try {
    await supabase.auth.signOut();
  } catch {
    /* the redirect to /login still happens */
  }
}

// ---------- recovery code management (Security settings) ----------

export async function getRecoveryCodeCount(): Promise<number> {
  const { data, error } = await supabase.functions.invoke('mfa-recovery', { body: { action: 'status' } });
  if (error) throw new Error((await readFunctionError(error)).message);
  return Number((data as { remaining?: number } | null)?.remaining ?? 0);
}

export type GenerateFailure = 'AAL2_REQUIRED' | 'NO_FACTOR' | 'OTHER';

/** Generates a fresh set of codes (replacing any old ones). Plain codes are returned once and never stored. */
export async function generateRecoveryCodes(): Promise<string[]> {
  const { data, error } = await supabase.functions.invoke('mfa-recovery', { body: { action: 'generate' } });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let code: GenerateFailure = 'OTHER';
    let message = (error as Error).message || 'Could not generate recovery codes.';
    if (ctx && typeof ctx.json === 'function') {
      try {
        const body = (await ctx.json()) as { error?: string; detail?: string };
        if (body.error === 'AAL2_REQUIRED' || body.error === 'NO_FACTOR') code = body.error;
        message = body.detail || message;
      } catch {
        /* keep generic message */
      }
    }
    throw Object.assign(new Error(message), { code });
  }
  const codes = (data as { codes?: string[] } | null)?.codes;
  if (!Array.isArray(codes) || codes.length === 0) throw new Error('Could not generate recovery codes.');
  return codes;
}

/** Plain-text file contents for "Download codes". */
export function recoveryCodesFile(codes: string[], email: string | undefined, when: Date = new Date()): string {
  return [
    'Vireek — two-factor recovery codes',
    email ? `Account: ${email}` : '',
    `Generated: ${when.toISOString().slice(0, 10)}`,
    '',
    'Each code works once. Using one turns two-factor authentication off so you can set it up again.',
    'Keep this file somewhere safe (a password manager is ideal).',
    '',
    ...codes,
    '',
  ]
    .filter((line, i, a) => !(line === '' && a[i - 1] === ''))
    .join('\n');
}
