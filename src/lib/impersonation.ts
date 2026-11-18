// Client-side view of a Vireek Support ("sign in as customer") session.
// The `imp` claim is written by the Postgres access-token hook (supabase/migrations/20290306000100_impersonation_limits.sql).
// This is for DISPLAY only (banner, countdown). Enforcement is server-side: the database and edge functions
// re-check the session row, so a tampered client can hide the banner but cannot gain or keep access.

export interface ImpersonationClaim {
  sid: string;
  staff: string;
  /** Unix seconds at which the support session expires. */
  exp: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseImpersonationClaim(accessToken: string | null | undefined): ImpersonationClaim | null {
  if (!accessToken) return null;
  try {
    const part = accessToken.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const payload = JSON.parse(atob(b64)) as { imp?: { sid?: unknown; staff?: unknown; exp?: unknown } | null };
    const imp = payload.imp;
    if (!imp || typeof imp !== 'object') return null;
    if (typeof imp.sid !== 'string' || !UUID.test(imp.sid)) return null;
    if (typeof imp.exp !== 'number' || !Number.isFinite(imp.exp)) return null;
    return { sid: imp.sid, staff: typeof imp.staff === 'string' ? imp.staff : '', exp: imp.exp };
  } catch {
    return null;
  }
}

/** Whole seconds left (never negative). */
export function secondsRemaining(claim: ImpersonationClaim, nowMs: number = Date.now()): number {
  return Math.max(0, Math.floor(claim.exp - nowMs / 1000));
}

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Last five minutes: the banner switches to an urgent style. */
export const IMPERSONATION_WARN_SECONDS = 300;
