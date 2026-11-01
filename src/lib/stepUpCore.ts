// Pure helpers for step-up re-authentication. No network, no React: unit-tested.
// The server is the authority (public.has_recent_auth() in the DB); this only decides when to ASK.

export type StepUpMethod = 'password' | 'totp' | 'emailCode';

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const parsed: unknown = JSON.parse(atob(b64));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Newest `amr[].timestamp` (seconds since epoch) in the access token, or null. */
export function latestAuthAt(token: string): number | null {
  const amr = decodeJwtPayload(token)?.amr;
  if (!Array.isArray(amr)) return null;
  let best: number | null = null;
  for (const entry of amr) {
    const ts = entry && typeof entry === 'object' ? (entry as { timestamp?: unknown }).timestamp : undefined;
    if (typeof ts === 'number' && Number.isFinite(ts) && (best === null || ts > best)) best = ts;
  }
  return best;
}

export function isRecentlyAuthenticated(token: string, nowMs: number, maxAgeSec = 600): boolean {
  const at = latestAuthAt(token);
  return at !== null && at >= Math.floor(nowMs / 1000) - maxAgeSec;
}

/** True for the error the DB raises (REAUTH_REQUIRED) however PostgREST/supabase-js wraps it. */
export function isReauthRequiredError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { message?: unknown; details?: unknown; hint?: unknown };
  return [o.message, o.details, o.hint].some((v) => typeof v === 'string' && v.includes('REAUTH_REQUIRED'));
}

export class StepUpCancelledError extends Error {
  constructor() {
    super('STEP_UP_CANCELLED');
    this.name = 'StepUpCancelledError';
  }
}

/** Which ways this person can prove it's them. Email code is the universal fallback (needs an email). */
export function availableMethods(input: { providers: string[]; hasVerifiedTotp: boolean; email: string | null }): StepUpMethod[] {
  const out: StepUpMethod[] = [];
  if (input.hasVerifiedTotp) out.push('totp');
  if (input.providers.includes('email')) out.push('password');
  if (input.email) out.push('emailCode');
  return out;
}
