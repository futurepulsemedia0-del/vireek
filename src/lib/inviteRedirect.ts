// Lets the existing /login and /signup flows (with their full OTP /
// email-confirmation steps) send a person back to the invite they started
// from, instead of always landing on /dashboard.
const PENDING_INVITE_KEY = 'vireek_pending_invite_token';

export function setPendingInviteToken(token: string): void {
  try {
    sessionStorage.setItem(PENDING_INVITE_KEY, token);
  } catch {
    // Storage can be unavailable (private browsing, etc.) — non-fatal.
  }
}

export function consumePostAuthRedirect(): string {
  try {
    const token = sessionStorage.getItem(PENDING_INVITE_KEY);
    if (token) {
      sessionStorage.removeItem(PENDING_INVITE_KEY);
      return `/invite/${token}`;
    }
  } catch {
    // Storage can be unavailable — fall through to the default.
  }
  return '/dashboard';
}
