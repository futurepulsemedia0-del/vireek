// src/lib/reputationCredentials/core.ts
//
// Pure, dependency-free logic for portable reputation credentials (Ed25519-signed, WebCrypto).
// Shared by: the reputation-* edge functions (Deno), the dashboard / public pages (browser) and Vitest (Node 20+).
// No I/O. What a credential may claim, how it is signed, and how its status is decided all live here.

export const REPUTATION_SCHEMA = 'vireek.reputation.v1';
export const REPUTATION_ISSUER = 'vireek';
export const REPUTATION_SCOPES = ['verified_jobs', 'outcomes', 'license_checks'] as const;
export type ReputationScope = (typeof REPUTATION_SCOPES)[number];
export type SubjectType = 'technician' | 'contractor';
export const REPUTATION_MAX_VALID_DAYS = 365;
export const REPUTATION_DEFAULT_VALID_DAYS = 180;
/** Rates are only published from at least this many completed jobs; below it the claim says "insufficient_sample". */
export const REPUTATION_MIN_SAMPLE = 10;

export const SCOPE_LABEL: Record<ReputationScope, string> = {
  verified_jobs: 'Verified jobs',
  outcomes: 'Job outcomes',
  license_checks: 'License checks',
};

export type CredentialStatus = 'valid' | 'expired' | 'revoked' | 'invalid_signature' | 'unknown_key' | 'not_found';

/* ------------------------------ canonical JSON ------------------------------ */

/** Deterministic JSON: sorted keys, no whitespace. Throws on undefined / NaN / Infinity / functions so a signature never covers ambiguous data. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
      const o = value as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => {
        if (o[k] === undefined) throw new Error(`canonicalJson: undefined at "${k}"`);
        return `${JSON.stringify(k)}:${canonicalJson(o[k])}`;
      }).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

/* ------------------------------ envelope ------------------------------ */

export interface CredentialEnvelope {
  v: 1;
  schema: typeof REPUTATION_SCHEMA;
  iss: typeof REPUTATION_ISSUER;
  id: string;
  kid: string;
  sub: { type: SubjectType; name: string; company: string };
  scopes: ReputationScope[];
  claims: Record<string, unknown>;
  iat: number; // epoch seconds
  exp: number; // epoch seconds
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isCredentialId = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Keys that must never appear anywhere in a signed claim set (customer data, personal contact data, credential numbers). */
const FORBIDDEN_KEYS = /(^|_)(customer|client|phone|email|address|ssn|dob|birth|credential_number|license_number|policy_number|notes|comment)(_|$)/i;

/** Returns the JSON paths of forbidden keys. A non-empty result must block signing. */
export function claimsPrivacyViolations(claims: unknown, path = 'claims'): string[] {
  if (Array.isArray(claims)) return claims.flatMap((c, i) => claimsPrivacyViolations(c, `${path}[${i}]`));
  if (claims && typeof claims === 'object') {
    return Object.entries(claims as Record<string, unknown>).flatMap(([k, v]) => [
      ...(FORBIDDEN_KEYS.test(k) ? [`${path}.${k}`] : []),
      ...claimsPrivacyViolations(v, `${path}.${k}`),
    ]);
  }
  return [];
}

export function validateEnvelope(e: unknown): e is CredentialEnvelope {
  const x = e as Partial<CredentialEnvelope> | null;
  return !!x && typeof x === 'object' && x.v === 1 && x.schema === REPUTATION_SCHEMA && x.iss === REPUTATION_ISSUER
    && isCredentialId(x.id) && typeof x.kid === 'string' && x.kid.length > 0 && x.kid.length <= 64
    && !!x.sub && (x.sub.type === 'technician' || x.sub.type === 'contractor') && typeof x.sub.name === 'string' && typeof x.sub.company === 'string'
    && Array.isArray(x.scopes) && x.scopes.length > 0 && x.scopes.every((s) => (REPUTATION_SCOPES as readonly string[]).includes(s))
    && !!x.claims && typeof x.claims === 'object' && !Array.isArray(x.claims)
    && Number.isInteger(x.iat) && Number.isInteger(x.exp) && (x.exp as number) > (x.iat as number)
    && (x.exp as number) - (x.iat as number) <= REPUTATION_MAX_VALID_DAYS * 86_400 + 60;
}

export function validateIssueInput(i: { scopes: unknown; validDays: unknown }): { ok: true; scopes: ReputationScope[]; validDays: number } | { ok: false; error: string } {
  if (!Array.isArray(i.scopes) || i.scopes.length === 0) return { ok: false, error: 'Choose at least one thing to include.' };
  const scopes = [...new Set(i.scopes as unknown[])];
  if (!scopes.every((s) => (REPUTATION_SCOPES as readonly string[]).includes(String(s)))) return { ok: false, error: 'Unknown scope.' };
  const d = Number(i.validDays);
  if (!Number.isInteger(d) || d < 1 || d > REPUTATION_MAX_VALID_DAYS) return { ok: false, error: `Validity must be 1–${REPUTATION_MAX_VALID_DAYS} days.` };
  return { ok: true, scopes: scopes as ReputationScope[], validDays: d };
}

/* ------------------------------ Ed25519 (WebCrypto: Deno, browsers, Node 20+) ------------------------------ */

export interface Ed25519PublicJwk { kty: 'OKP'; crv: 'Ed25519'; x: string }
export interface Ed25519PrivateJwk extends Ed25519PublicJwk { d: string }

const enc = new TextEncoder();
export const b64u = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = (s: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export async function generateSigningKey(kid: string): Promise<{ kid: string; publicJwk: Ed25519PublicJwk; privateJwk: Ed25519PrivateJwk }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return {
    kid,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: String(priv.x) },
    privateJwk: { kty: 'OKP', crv: 'Ed25519', x: String(priv.x), d: String(priv.d) },
  };
}

export async function signEnvelope(privateJwk: Ed25519PrivateJwk, envelope: CredentialEnvelope): Promise<{ payload: string; signature: string }> {
  if (!validateEnvelope(envelope)) throw new Error('invalid credential envelope');
  const bad = claimsPrivacyViolations(envelope.claims);
  if (bad.length) throw new Error(`claims contain forbidden fields: ${bad.join(', ')}`);
  const payload = canonicalJson(envelope);
  const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x, d: privateJwk.d }, { name: 'Ed25519' }, false, ['sign']);
  return { payload, signature: b64u(await crypto.subtle.sign({ name: 'Ed25519' }, key, enc.encode(payload))) };
}

export async function verifySignature(publicJwk: Ed25519PublicJwk, payload: string, signature: string): Promise<boolean> {
  try {
    if (publicJwk?.kty !== 'OKP' || publicJwk.crv !== 'Ed25519') return false;
    const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x }, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, unb64u(signature), enc.encode(payload));
  } catch {
    return false;
  }
}

/* ------------------------------ status ------------------------------ */

export interface VerifyInput {
  payload: string;
  signature: string;
  /** null when the key id is unknown to us */
  publicJwk: Ed25519PublicJwk | null;
  keyStatus: 'active' | 'retired' | 'revoked' | null;
  revokedAt: string | null;
  now: Date;
}
export interface VerifyResult { status: CredentialStatus; envelope: CredentialEnvelope | null }

/**
 * Order matters: a bad signature or untrusted key beats everything (never show claims of a forged credential),
 * then revocation (live, from the database - a signature can never be "unsigned"), then expiry (from the SIGNED exp).
 */
export async function verifyCredential(i: VerifyInput): Promise<VerifyResult> {
  if (!i.publicJwk || i.keyStatus === null || i.keyStatus === 'revoked') return { status: 'unknown_key', envelope: null };
  if (!(await verifySignature(i.publicJwk, i.payload, i.signature))) return { status: 'invalid_signature', envelope: null };
  let envelope: unknown;
  try { envelope = JSON.parse(i.payload); } catch { return { status: 'invalid_signature', envelope: null }; }
  if (!validateEnvelope(envelope) || canonicalJson(envelope) !== i.payload) return { status: 'invalid_signature', envelope: null };
  if (i.revokedAt) return { status: 'revoked', envelope };
  if (i.now.getTime() / 1000 >= envelope.exp) return { status: 'expired', envelope };
  if (envelope.iat > i.now.getTime() / 1000 + 300) return { status: 'invalid_signature', envelope: null }; // issued "in the future"
  return { status: 'valid', envelope };
}

/* ------------------------------ badge (static SVG, no script) ------------------------------ */

export const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const BADGE_STYLE: Record<CredentialStatus, { fill: string; text: string; label: string }> = {
  valid: { fill: '#007C2C', text: '#FFFFFF', label: 'Verified' },
  expired: { fill: '#595852', text: '#FFFFFF', label: 'Expired' },
  revoked: { fill: '#B3261E', text: '#FFFFFF', label: 'Revoked' },
  invalid_signature: { fill: '#B3261E', text: '#FFFFFF', label: 'Invalid' },
  unknown_key: { fill: '#B3261E', text: '#FFFFFF', label: 'Invalid' },
  not_found: { fill: '#595852', text: '#FFFFFF', label: 'Not found' },
};

/** Fixed-size 240x40 badge. Only the status and (when valid) the display name appear; both are XML-escaped and length-capped. */
export function buildBadgeSvg(status: CredentialStatus, name: string | null): string {
  const s = BADGE_STYLE[status];
  const who = status === 'valid' && name ? [...name].slice(0, 26).join('') : 'Vireek reputation credential';
  const title = `Vireek ${s.label.toLowerCase()} reputation credential${status === 'valid' && name ? ` for ${name}` : ''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="40" viewBox="0 0 240 40" role="img" aria-label="${escapeXml(title)}">`
    + `<title>${escapeXml(title)}</title><rect width="240" height="40" rx="8" fill="#FFFFFF" stroke="#DDDCD8"/>`
    + `<rect x="0" y="0" width="84" height="40" rx="8" fill="${s.fill}"/><rect x="70" y="0" width="14" height="40" fill="${s.fill}"/>`
    + `<text x="42" y="25" text-anchor="middle" font-family="system-ui,Segoe UI,Arial,sans-serif" font-size="13" font-weight="600" fill="${s.text}">${escapeXml(s.label)}</text>`
    + `<text x="94" y="25" font-family="system-ui,Segoe UI,Arial,sans-serif" font-size="12" fill="#1C1B15">${escapeXml(who)}</text></svg>`;
}

export function buildEmbedSnippets(o: { appUrl: string; functionsUrl: string; id: string }): { html: string; link: string } {
  if (!isCredentialId(o.id)) throw new Error('bad credential id');
  const link = `${o.appUrl.replace(/\/+$/, '')}/verify/reputation/${o.id}`;
  const img = `${o.functionsUrl.replace(/\/+$/, '')}/reputation-verify?id=${o.id}&format=svg`;
  return { link, html: `<a href="${link}" rel="noopener nofollow" target="_blank"><img src="${img}" width="240" height="40" alt="Vireek verified reputation credential" /></a>` };
}

/** Public JWKS document (public keys only). Revoked keys are omitted: nothing signed by them should be trusted. */
export function buildJwks(keys: { kid: string; publicJwk: Ed25519PublicJwk; status: string }[]) {
  return { keys: keys.filter((k) => k.status !== 'revoked').map((k) => ({ ...k.publicJwk, kid: k.kid, alg: 'EdDSA', use: 'sig' })) };
}
