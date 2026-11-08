/**
 * Guest / external collaborators (pure domain logic + token helpers).
 *
 * Accountants, GCs, inspectors, suppliers get scoped, time-limited access to
 * specific records only. Rules mirrored in SQL (`authz_guest_*`):
 *  - no wildcard scopes, max 50 scopes, max 90 days, MFA required to redeem and use
 *  - tokens are random, shown once, stored only as SHA-256
 *  - redeem failures are indistinguishable (unknown / expired / revoked / reused),
 *    so a guest cannot enumerate invites or the organization behind them
 */

export type GuestAction = 'view' | 'comment' | 'upload';

export interface GuestScope {
  resource: string;
  recordId: string;
  actions: readonly GuestAction[];
}

export interface GuestInvite {
  id: string;
  tenantId: string;
  email: string;
  label: string;
  scopes: readonly GuestScope[];
  expiresAt: string;
  revokedAt: string | null;
  redeemedBy: string | null;
  redeemedAt: string | null;
  requireMfa: boolean;
  watermark: boolean;
}

export const GUEST_MAX_DAYS = 90;
export const GUEST_MAX_SCOPES = 50;
const ALLOWED_ACTIONS: readonly GuestAction[] = ['view', 'comment', 'upload'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_RE = /^[a-z][a-z0-9_]{1,62}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type GuestInviteError =
  | 'invalid_email'
  | 'no_scopes'
  | 'too_many_scopes'
  | 'invalid_scope'
  | 'invalid_action'
  | 'expiry_in_past'
  | 'expiry_too_far';

export function validateGuestInvite(
  input: { email: string; scopes: readonly GuestScope[]; expiresAt: string },
  now: string,
): GuestInviteError | null {
  if (!EMAIL_RE.test(input.email.trim())) return 'invalid_email';
  if (input.scopes.length === 0) return 'no_scopes';
  if (input.scopes.length > GUEST_MAX_SCOPES) return 'too_many_scopes';
  for (const s of input.scopes) {
    if (!RESOURCE_RE.test(s.resource) || !UUID_RE.test(s.recordId)) return 'invalid_scope';
    if (s.actions.length === 0 || s.actions.some((a) => !ALLOWED_ACTIONS.includes(a))) return 'invalid_action';
  }
  const exp = Date.parse(input.expiresAt);
  const t = Date.parse(now);
  if (!Number.isFinite(exp) || exp <= t) return 'expiry_in_past';
  if (exp > t + GUEST_MAX_DAYS * 86_400_000) return 'expiry_too_far';
  return null;
}

export type GuestStatus = 'invited' | 'active' | 'expired' | 'revoked';

export function guestStatus(inv: GuestInvite, now: string): GuestStatus {
  const t = Date.parse(now);
  if (inv.revokedAt !== null && Date.parse(inv.revokedAt) <= t) return 'revoked';
  if (Date.parse(inv.expiresAt) <= t) return 'expired';
  return inv.redeemedBy === null ? 'invited' : 'active';
}

/** Single authorization check: scoped, unexpired, redeemed by this user, MFA satisfied. */
export function guestCan(
  inv: GuestInvite,
  userId: string,
  resource: string,
  recordId: string,
  action: GuestAction,
  now: string,
  mfaVerified: boolean,
): boolean {
  if (guestStatus(inv, now) !== 'active' || inv.redeemedBy !== userId) return false;
  if (inv.requireMfa && !mfaVerified) return false;
  return inv.scopes.some((s) => s.resource === resource && s.recordId === recordId && s.actions.includes(action));
}

/** Text to tile across guest-visible pages and exports; identifies who and until when. */
export function watermarkText(inv: Pick<GuestInvite, 'email' | 'expiresAt'>, now: string): string {
  return `${inv.email} · ${now.slice(0, 10)} · expires ${inv.expiresAt.slice(0, 10)}`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 256-bit random token, base64url. Shown to the inviter once; only its hash is stored. */
export function generateGuestToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashGuestToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
