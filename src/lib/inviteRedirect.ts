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

const PENDING_PATH_KEY = 'vireek_pending_post_auth_path';

export function setPostAuthPath(path: string): void {
  if (!/^\/talent\/[A-Za-z0-9/_-]*$/.test(path)) return;
  try {
    sessionStorage.setItem(PENDING_PATH_KEY, path);
  } catch {
    // non-fatal
  }
}

export function peekPostAuthPath(): string | null {
  try {
    return sessionStorage.getItem(PENDING_PATH_KEY);
  } catch {
    return null;
  }
}

export function consumePostAuthRedirect(): string {
  try {
    const token = sessionStorage.getItem(PENDING_INVITE_KEY);
    if (token) {
      sessionStorage.removeItem(PENDING_INVITE_KEY);
      return `/invite/${token}`;
    }
    const path = sessionStorage.getItem(PENDING_PATH_KEY);
    if (path) {
      sessionStorage.removeItem(PENDING_PATH_KEY);
      return path;
    }
  } catch {
    // Storage can be unavailable — fall through to the default.
  }
  return '/dashboard';
}
