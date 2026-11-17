// Lets the existing /login and /signup flows (with their full OTP /
// email-confirmation steps) send a person back to the invite they started
// from, instead of always landing on /dashboard.
const PENDING_INVITE_KEY = 'vireek_pending_invite_token';

// team_members.invite_token is a uuid (see 20260925000000_team_invite_tokens.sql). Validating the
// shape on write AND read means a tampered sessionStorage value can never become a redirect path.
const INVITE_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidInviteToken(token: string): boolean {
  return INVITE_TOKEN_RE.test(token);
}

export function setPendingInviteToken(token: string): void {
  if (!isValidInviteToken(token)) return;  
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
      if (isValidInviteToken(token)) return `/invite/${token}`;
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
