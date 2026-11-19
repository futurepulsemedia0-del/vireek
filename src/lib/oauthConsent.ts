// src/lib/oauthConsent.ts
//
// Pure helpers for the MCP OAuth consent screen (/oauth/authorize): parsing the authorization request,
// building the redirect back to the client, and carrying the request across the login / MFA detour.
// Nothing here talks to the network; the page calls the mcp_oauth_authorize_* RPCs.

import {
  DEFAULT_SCOPES, HIGH_RISK_SCOPES, canonicalResource, parseScopeParam, redirectWithParams, resourceMatches, type OAuthScope,
} from '../../supabase/functions/_shared/mcp-oauth/core';

export { HIGH_RISK_SCOPES, DEFAULT_SCOPES };
export type { OAuthScope };

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string | null;
  scopes: OAuthScope[];            // what the client asked for (DEFAULT_SCOPES when it asked for none)
  scopeWasDefaulted: boolean;
  resource: string;
  codeChallenge: string;
  method: string;
}
export type ParseFailure = 'missing_params' | 'duplicate_params' | 'unsupported_response_type' | 'state_too_long' | 'invalid_scope';
export type ParseResult = { ok: true; request: AuthorizeRequest } | { ok: false; reason: ParseFailure };

const SINGLE = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource'] as const;

export function parseAuthorizeParams(search: string | URLSearchParams): ParseResult {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search;
  for (const k of SINGLE) if (p.getAll(k).length > 1) return { ok: false, reason: 'duplicate_params' };
  const clientId = p.get('client_id') ?? '', redirectUri = p.get('redirect_uri') ?? '', challenge = p.get('code_challenge') ?? '', resource = p.get('resource') ?? '';
  if (!clientId || !redirectUri || !challenge || !resource) return { ok: false, reason: 'missing_params' };
  if (p.get('response_type') !== 'code') return { ok: false, reason: 'unsupported_response_type' };
  const state = p.get('state');
  if (state !== null && state.length > 512) return { ok: false, reason: 'state_too_long' };
  const rawScope = p.get('scope');
  const parsed = parseScopeParam(rawScope);
  if (rawScope && rawScope.trim() !== '' && parsed.scopes.length === 0) return { ok: false, reason: 'invalid_scope' };
  return {
    ok: true,
    request: {
      clientId, redirectUri, state, resource, codeChallenge: challenge, method: p.get('code_challenge_method') ?? '',
      scopes: parsed.scopes.length ? parsed.scopes : [...DEFAULT_SCOPES], scopeWasDefaulted: parsed.scopes.length === 0,
    },
  };
}

/** The resource must be this project's MCP server (audience binding). */
export function resourceIsOurs(resource: string, supabaseUrl: string): boolean {
  return canonicalResource(resource) !== null && resourceMatches(resource, `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/mcp-server`);
}

/** RFC 6749 §4.1.2.1 error redirect with RFC 9207 `iss`. Only call for a redirect URI the server has validated. */
export function errorRedirect(req: Pick<AuthorizeRequest, 'redirectUri' | 'state'>, error: string, issuer: string, description?: string): string {
  return redirectWithParams(req.redirectUri, { error, error_description: description?.slice(0, 200), state: req.state ?? undefined, iss: issuer });
}
export function successRedirect(req: Pick<AuthorizeRequest, 'redirectUri' | 'state'>, code: string, issuer: string): string {
  return redirectWithParams(req.redirectUri, { code, state: req.state ?? undefined, iss: issuer });
}

/** What to show the owner as "where this app will be sent back to": host for web URIs, scheme for app schemes. */
export function describeRedirect(uri: string): string {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : `${u.protocol}//`;
  } catch { return ''; }
}

export const isHighRisk = (s: OAuthScope): boolean => (HIGH_RISK_SCOPES as readonly string[]).includes(s);

// ---- carrying the request across /login (ProtectedRoute drops the query string) ----
export const PENDING_KEY = 'vrk_oauth_pending';
const PENDING_TTL_MS = 15 * 60 * 1000;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function savePending(search: string, store: Store, now = Date.now()): void {
  if (!search || search.length > 4096) return;
  try { store.setItem(PENDING_KEY, JSON.stringify({ search, at: now })); } catch { /* storage unavailable: user can restart from the client */ }
}
/** Reads the saved request. Pass consume=false while rendering (React may render twice); clear it with clearPending() when done. */
export function takePending(store: Store, now = Date.now(), consume = true): string | null {
  try {
    const raw = store.getItem(PENDING_KEY);
    if (consume) store.removeItem(PENDING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { search?: unknown; at?: unknown };
    return typeof v.search === 'string' && typeof v.at === 'number' && now - v.at <= PENDING_TTL_MS ? v.search : null;
  } catch { return null; }
}

export function clearPending(store: Store): void { try { store.removeItem(PENDING_KEY); } catch { /* ignore */ } }
