// supabase/functions/_shared/mcp-oauth/core.ts
//
// Pure OAuth 2.1 helpers for the MCP server (no imports, no I/O; runs in Deno, Vitest and the browser).
// Follows the MCP authorization spec (revision 2026-07-28, verified 2026-11-19 against modelcontextprotocol.io):
//   * RFC 9728 protected-resource metadata + `WWW-Authenticate: Bearer resource_metadata=...`
//   * RFC 8414 authorization-server metadata, RFC 9207 `iss`, RFC 8707 `resource`, PKCE S256 only
//   * public clients only (token_endpoint_auth_method = none); exact-match redirect URIs
// Not implemented: Client ID Metadata Documents (needs an SSRF-safe fetcher). Dynamic Client Registration
// (deprecated in the spec, kept for compatibility) is the registration path.

export const OAUTH_SCOPES = [
  'customers:read', 'equipment:read', 'jobs:read', 'schedule:read', 'inventory:read',
  'quotes:create', 'dispatch:assign', 'messages:send', 'payments:collect',
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];
/** Granted when a client asks for no scope: least privilege, read-only. */
export const DEFAULT_SCOPES: OAuthScope[] = ['customers:read', 'equipment:read', 'jobs:read', 'schedule:read', 'inventory:read'];
/** Scopes whose tools change data or money. Governed by the Agent Governance policies. */
export const HIGH_RISK_SCOPES: OAuthScope[] = ['quotes:create', 'dispatch:assign', 'messages:send', 'payments:collect'];

export const ACCESS_TOKEN_TTL_S = 3600;
export const REFRESH_TOKEN_TTL_S = 30 * 86400;
export const GRANT_MAX_LIFETIME_S = 90 * 86400;
export const CODE_TTL_S = 120;
export const ACCESS_PREFIX = 'vrk_oat_';
export const REFRESH_PREFIX = 'vrk_ort_';
export const CLIENT_PREFIX = 'vrk_oc_';

// ---------------------------------------------------------------- scopes

export function parseScopeParam(raw: unknown): { scopes: OAuthScope[]; unknown: string[] } {
  if (typeof raw !== 'string' || raw.trim() === '') return { scopes: [], unknown: [] };
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const s of raw.trim().split(/\s+/).slice(0, 40)) {
    if ((OAUTH_SCOPES as readonly string[]).includes(s)) seen.add(s); else if (s !== 'offline_access') unknown.push(s.slice(0, 64));
  }
  return { scopes: OAUTH_SCOPES.filter((s) => seen.has(s)), unknown };
}

// ---------------------------------------------------------------- redirect URIs & resources

const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'ftp', 'ws', 'wss', 'chrome', 'view-source']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** https, loopback http (RFC 8252), or a private-use app scheme. No fragment, no userinfo, no wildcard. */
export function validateRedirectUri(uri: unknown): { ok: true; uri: string } | { ok: false; reason: string } {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 512 || /[\s\u0000-\u001f<>"\\^`{|}*]/.test(uri)) return { ok: false, reason: 'malformed' };
  let u: URL;
  try { u = new URL(uri); } catch { return { ok: false, reason: 'malformed' }; }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (u.hash || uri.includes('#')) return { ok: false, reason: 'fragment' };
  if (u.username || u.password) return { ok: false, reason: 'userinfo' };
  if (BLOCKED_SCHEMES.has(scheme)) return { ok: false, reason: 'scheme' };
  if (scheme === 'https') return u.hostname ? { ok: true, uri } : { ok: false, reason: 'host' };
  if (scheme === 'http') return LOOPBACK_HOSTS.has(u.hostname) ? { ok: true, uri } : { ok: false, reason: 'http_not_loopback' };
  return /^[a-z][a-z0-9+.-]{1,40}$/.test(scheme) ? { ok: true, uri } : { ok: false, reason: 'scheme' };
}

/** RFC 8707 canonical form: absolute https (or loopback http) URL, no fragment/query, lower-case origin, no trailing slash. */
export function canonicalResource(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.hash || u.search || u.username || u.password) return null;
  const secure = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname));
  if (!secure) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
}

/** The MCP endpoint is served at `<root>` and `<root>/mcp`; a token bound to either is valid for both. */
export function resourceMatches(tokenResource: unknown, serverRoot: string): boolean {
  const tr = canonicalResource(tokenResource);
  const root = canonicalResource(serverRoot);
  if (!tr || !root) return false;
  return tr === root || tr === `${root}/mcp`;
}

// ---------------------------------------------------------------- PKCE

const B64URL = /^[A-Za-z0-9_-]+$/;
export const isCodeChallenge = (v: unknown): v is string => typeof v === 'string' && v.length === 43 && B64URL.test(v);
export const isCodeVerifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(v);

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function sha256Hex(input: string): Promise<string> {
  const dig = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(dig)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
export async function verifyPkceS256(verifier: unknown, challenge: unknown): Promise<boolean> {
  if (!isCodeVerifier(verifier) || !isCodeChallenge(challenge)) return false;
  const dig = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return timingSafeEqual(base64url(dig), challenge);
}

export function newOpaqueToken(prefix: string): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

// ---------------------------------------------------------------- dynamic client registration (RFC 7591)

export interface RegistrationOk { ok: true; clientName: string; redirectUris: string[] }
export interface RegistrationErr { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string }

export function validateRegistration(body: unknown): RegistrationOk | RegistrationErr {
  const bad = (error: RegistrationErr['error'], description: string): RegistrationErr => ({ ok: false, error, description });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('invalid_client_metadata', 'Body must be a JSON object.');
  const b = body as Record<string, unknown>;
  const name = typeof b.client_name === 'string' ? b.client_name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200b-\u200f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  if (!name) return bad('invalid_client_metadata', 'client_name is required.');
  if (!Array.isArray(b.redirect_uris) || b.redirect_uris.length < 1 || b.redirect_uris.length > 5) return bad('invalid_redirect_uri', 'Provide 1 to 5 redirect_uris.');
  const uris: string[] = [];
  for (const u of b.redirect_uris) {
    const v = validateRedirectUri(u);
    if (!v.ok) return bad('invalid_redirect_uri', `Redirect URI rejected (${v.reason}).`);
    if (!uris.includes(v.uri)) uris.push(v.uri);
  }
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') return bad('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported.');
  if (b.grant_types !== undefined && (!Array.isArray(b.grant_types) || b.grant_types.some((g) => g !== 'authorization_code' && g !== 'refresh_token'))) return bad('invalid_client_metadata', 'Supported grant_types: authorization_code, refresh_token.');
  if (b.response_types !== undefined && (!Array.isArray(b.response_types) || b.response_types.some((r) => r !== 'code'))) return bad('invalid_client_metadata', 'Supported response_types: code.');
  return { ok: true, clientName: name, redirectUris: uris };
}

// ---------------------------------------------------------------- metadata documents & challenges

export interface Endpoints { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string; revocationEndpoint: string }

export function protectedResourceMetadata(resource: string, issuer: string, docsUrl?: string) {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Vireek Agent Network (MCP)',
    ...(docsUrl ? { resource_documentation: docsUrl } : {}),
  };
}

export function authorizationServerMetadata(e: Endpoints) {
  return {
    issuer: e.issuer,
    authorization_endpoint: e.authorizationEndpoint,
    token_endpoint: e.tokenEndpoint,
    registration_endpoint: e.registrationEndpoint,
    revocation_endpoint: e.revocationEndpoint,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  };
}

const q = (s: string) => `"${s.replace(/[\\"]/g, '').replace(/[\r\n]+/g, ' ')}"`;
/** RFC 6750 §3 challenge. `scope` is space-separated; values are stripped of quotes and line breaks. */
export function wwwAuthenticate(o: { resourceMetadataUrl: string; error?: 'invalid_token' | 'insufficient_scope'; scope?: string[]; description?: string }): string {
  const parts = [`Bearer realm="vireek-agent-network"`, `resource_metadata=${q(o.resourceMetadataUrl)}`];
  if (o.error) parts.push(`error=${q(o.error)}`);
  if (o.scope?.length) parts.push(`scope=${q(o.scope.join(' '))}`);
  if (o.description) parts.push(`error_description=${q(o.description)}`);
  return parts.join(', ');
}

/** Appends OAuth response parameters (code/state/iss/error) to a validated redirect URI. */
export function redirectWithParams(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
