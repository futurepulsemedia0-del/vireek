import { supabase } from '@/lib/supabase';
import { API_SCOPES, SCOPE_LABELS, type ApiScope } from '@/lib/apiKeys';

/**
 * OAuth app registry — apps an account owner registers so third parties can
 * request scoped access. Every query is explicitly scoped to `accountOwnerId`
 * (defence in depth on top of RLS). The raw client secret is generated and
 * hashed client-side with Web Crypto and returned ONCE, exactly like API keys.
 */

export { API_SCOPES as OAUTH_SCOPES, SCOPE_LABELS as OAUTH_SCOPE_LABELS };
export type OAuthScope = ApiScope;

export const MAX_REDIRECT_URIS = 10;
export const NAME_MIN = 2;
export const NAME_MAX = 60;
export const DESCRIPTION_MAX = 280;

export interface OAuthAppRow {
  id: string;
  name: string;
  description: string;
  homepage_url: string | null;
  privacy_url: string | null;
  terms_url: string | null;
  redirect_uris: string[];
  scopes: OAuthScope[];
  client_id: string;
  client_secret_prefix: string;
  secret_rotated_at: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OAuthGrantRow {
  id: string;
  app_id: string;
  scopes: OAuthScope[];
  token_prefix: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface OAuthAppInput {
  name: string;
  description: string;
  homepage_url: string;
  privacy_url: string;
  terms_url: string;
  redirect_uris: string[];
  scopes: OAuthScope[];
}

export type OAuthAppErrors = Partial<Record<keyof OAuthAppInput, string>>;
export type GrantStatus = 'active' | 'expired' | 'revoked';

const APP_COLUMNS =
  'id, name, description, homepage_url, privacy_url, terms_url, redirect_uris, scopes, client_id, client_secret_prefix, secret_rotated_at, disabled_at, created_at, updated_at';
const GRANT_COLUMNS = 'id, app_id, scopes, token_prefix, last_used_at, expires_at, revoked_at, created_at';

// ---------------------------------------------------------------------------
// Validation (pure — unit tested)
// ---------------------------------------------------------------------------

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Returns an error message, or null when the redirect URI is acceptable. */
export function validateRedirectUri(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Enter a redirect URI.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Not a valid URL.';
  }
  if (url.hash) return 'Redirect URIs cannot contain a fragment (#).';
  if (value.includes('*')) return 'Wildcards are not allowed in redirect URIs.';
  if (url.username || url.password) return 'Redirect URIs cannot contain credentials.';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return null;
  return 'Use https:// (http:// is only allowed for localhost).';
}

/** Optional metadata URL: empty is fine, otherwise must be https. */
export function validateOptionalUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? null : 'Must start with https://';
  } catch {
    return 'Not a valid URL.';
  }
}

export function validateAppInput(input: OAuthAppInput): OAuthAppErrors {
  const errors: OAuthAppErrors = {};
  const name = input.name.trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    errors.name = `Name must be ${NAME_MIN}–${NAME_MAX} characters.`;
  }
  if (input.description.length > DESCRIPTION_MAX) {
    errors.description = `Keep the description under ${DESCRIPTION_MAX} characters.`;
  }
  const homepage = validateOptionalUrl(input.homepage_url);
  if (homepage) errors.homepage_url = homepage;
  const privacy = validateOptionalUrl(input.privacy_url);
  if (privacy) errors.privacy_url = privacy;
  const terms = validateOptionalUrl(input.terms_url);
  if (terms) errors.terms_url = terms;

  const uris = input.redirect_uris.map((u) => u.trim()).filter(Boolean);
  if (uris.length === 0) {
    errors.redirect_uris = 'Add at least one redirect URI.';
  } else if (uris.length > MAX_REDIRECT_URIS) {
    errors.redirect_uris = `At most ${MAX_REDIRECT_URIS} redirect URIs.`;
  } else if (new Set(uris).size !== uris.length) {
    errors.redirect_uris = 'Redirect URIs must be unique.';
  } else {
    const bad = uris.map(validateRedirectUri).find(Boolean);
    if (bad) errors.redirect_uris = bad;
  }

  if (input.scopes.length === 0) {
    errors.scopes = 'Select at least one scope.';
  } else if (input.scopes.some((s) => !(API_SCOPES as readonly string[]).includes(s))) {
    errors.scopes = 'Unknown scope selected.';
  }
  return errors;
}

export function hasErrors(errors: OAuthAppErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Normalises form input into the exact shape written to the database. */
export function normalizeAppInput(input: OAuthAppInput) {
  const nullable = (v: string) => (v.trim() ? v.trim() : null);
  return {
    name: input.name.trim(),
    description: input.description.trim(),
    homepage_url: nullable(input.homepage_url),
    privacy_url: nullable(input.privacy_url),
    terms_url: nullable(input.terms_url),
    redirect_uris: [...new Set(input.redirect_uris.map((u) => u.trim()).filter(Boolean))],
    scopes: [...new Set(input.scopes)],
  };
}

export function grantStatus(grant: Pick<OAuthGrantRow, 'revoked_at' | 'expires_at'>, now = Date.now()): GrantStatus {
  if (grant.revoked_at) return 'revoked';
  if (grant.expires_at && new Date(grant.expires_at).getTime() <= now) return 'expired';
  return 'active';
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(digest);
}

async function newSecret() {
  const rawSecret = `vrk_secret_${randomHex(32)}`;
  return {
    rawSecret,
    client_secret_prefix: rawSecret.slice(0, 15), // "vrk_secret_" + 4 chars
    client_secret_hash: await sha256Hex(rawSecret),
  };
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

export async function listOAuthApps(accountOwnerId: string): Promise<OAuthAppRow[]> {
  const { data, error } = await supabase
    .from('oauth_apps')
    .select(APP_COLUMNS)
    .eq('user_id', accountOwnerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as OAuthAppRow[];
}

export async function listOAuthGrants(accountOwnerId: string): Promise<OAuthGrantRow[]> {
  const { data, error } = await supabase
    .from('oauth_grants')
    .select(GRANT_COLUMNS)
    .eq('user_id', accountOwnerId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as OAuthGrantRow[];
}

/** Registers an app. Returns the ONE-TIME raw client secret. */
export async function createOAuthApp(
  accountOwnerId: string,
  input: OAuthAppInput,
): Promise<{ app: OAuthAppRow; rawSecret: string }> {
  const errors = validateAppInput(input);
  if (hasErrors(errors)) throw new Error('Invalid OAuth app input');

  const { rawSecret, client_secret_prefix, client_secret_hash } = await newSecret();
  const { data, error } = await supabase
    .from('oauth_apps')
    .insert({
      user_id: accountOwnerId,
      ...normalizeAppInput(input),
      client_id: `vrk_app_${randomHex(12)}`,
      client_secret_prefix,
      client_secret_hash,
    })
    .select(APP_COLUMNS)
    .single();
  if (error) throw error;
  return { app: data as OAuthAppRow, rawSecret };
}

export async function updateOAuthApp(accountOwnerId: string, id: string, input: OAuthAppInput): Promise<OAuthAppRow> {
  const errors = validateAppInput(input);
  if (hasErrors(errors)) throw new Error('Invalid OAuth app input');

  const { data, error } = await supabase
    .from('oauth_apps')
    .update(normalizeAppInput(input))
    .eq('id', id)
    .eq('user_id', accountOwnerId)
    .select(APP_COLUMNS)
    .single();
  if (error) throw error;
  return data as OAuthAppRow;
}

/** Issues a fresh secret; the previous one stops verifying immediately. */
export async function rotateOAuthSecret(accountOwnerId: string, id: string): Promise<string> {
  const { rawSecret, client_secret_prefix, client_secret_hash } = await newSecret();
  const { error } = await supabase
    .from('oauth_apps')
    .update({ client_secret_prefix, client_secret_hash })
    .eq('id', id)
    .eq('user_id', accountOwnerId);
  if (error) throw error;
  return rawSecret;
}

/** Disables (true) or re-enables (false) an app. Disabling revokes all its tokens server-side. */
export async function setOAuthAppDisabled(accountOwnerId: string, id: string, disabled: boolean): Promise<void> {
  const { error } = await supabase
    .from('oauth_apps')
    .update({ disabled_at: disabled ? new Date().toISOString() : null })
    .eq('id', id)
    .eq('user_id', accountOwnerId);
  if (error) throw error;
}

export async function deleteOAuthApp(accountOwnerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('oauth_apps').delete().eq('id', id).eq('user_id', accountOwnerId);
  if (error) throw error;
}

export async function revokeOAuthGrant(accountOwnerId: string, id: string): Promise<void> {
  const { error } = await supabase
    .from('oauth_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', accountOwnerId)
    .is('revoked_at', null);
  if (error) throw error;
}

/** Revokes every live token for one app (the "Revoke all tokens" action). */
export async function revokeAllGrantsForApp(accountOwnerId: string, appId: string): Promise<void> {
  const { error } = await supabase
    .from('oauth_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('app_id', appId)
    .eq('user_id', accountOwnerId)
    .is('revoked_at', null);
  if (error) throw error;
}
