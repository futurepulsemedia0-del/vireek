// Pure session helpers (no supabase import so they are unit-testable).

export type AuthEventKind = 'none' | 'expired' | 'signed-out-elsewhere';

/** True when a JWT should be refreshed now: expires within `leewayMs` (or already expired). */
export function needsRefresh(expiresAtSec: number | null | undefined, nowMs: number, leewayMs = 60_000): boolean {
  if (!expiresAtSec) return false;
  return expiresAtSec * 1000 - nowMs <= leewayMs;
}

/** SIGNED_OUT that the user did not ask for (while a session existed) means expiry/revocation. */
export function classifySignOut(event: string, hadSession: boolean, intentional: boolean): AuthEventKind {
  if (event !== 'SIGNED_OUT' || !hadSession || intentional) return 'none';
  return 'expired';
}

const EXPIRED_RE = /jwt expired|invalid jwt|jwt is expired|token is expired|invalid refresh token|refresh token not found|session.*(expired|missing)/i;

export function isAuthExpiredMessage(message: string | undefined | null, code?: string | number | null): boolean {
  if (code === 'PGRST301' || code === 'PGRST303') return true;
  return Boolean(message && EXPIRED_RE.test(message));
}

/** Refresh errors that mean "re-authenticate", as opposed to transient network failures. */
export function isTerminalRefreshError(err: { status?: number; name?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.name === 'AuthRetryableFetchError') return false;
  if (err.status === 400 || err.status === 401 || err.status === 403) return true;
  return isAuthExpiredMessage(err.message);
}
