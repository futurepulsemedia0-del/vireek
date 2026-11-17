// Pure sign-up validation. Kept out of the page component so it is unit-testable and
// so SignupPage only exports a component (react-refresh friendly).
//
// Password policy follows NIST SP 800-63B: length over composition (no forced symbols/digits),
// paste allowed, generous maximum so passphrases and password-manager output work.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailProblem = 'required' | 'invalid';
export type PasswordProblem = 'tooShort' | 'tooLong';

export function emailProblem(raw: string): EmailProblem | null {
  const v = raw.trim();
  if (!v) return 'required';
  return EMAIL_REGEX.test(v) ? null : 'invalid';
}

export function passwordProblem(pw: string): PasswordProblem | null {
  if (pw.length < PASSWORD_MIN) return 'tooShort';
  if (pw.length > PASSWORD_MAX) return 'tooLong';
  return null;
}

/** Supabase answers 429 / "rate limit" / "too many requests" when throttling. */
export function isRateLimited(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: number; message?: string };
  return e.status === 429 || /rate limit|too many/i.test(e.message ?? '');
}
