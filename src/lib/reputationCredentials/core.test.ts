// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  REPUTATION_SCHEMA, buildBadgeSvg, buildEmbedSnippets, buildJwks, canonicalJson, claimsPrivacyViolations, escapeXml,
  generateSigningKey, signEnvelope, validateEnvelope, validateIssueInput, verifyCredential, verifySignature,
  type CredentialEnvelope,
} from './core';

const ID = '3f2b8c1e-7a4d-4e0b-9c55-0a1b2c3d4e5f';
const NOW = new Date('2026-11-23T12:00:00Z');
const iat = Math.floor(NOW.getTime() / 1000) - 3600;
const envelope = (over: Partial<CredentialEnvelope> = {}): CredentialEnvelope => ({
  v: 1, schema: REPUTATION_SCHEMA, iss: 'vireek', id: ID, kid: 'k1',
  sub: { type: 'technician', name: 'Sam <Tech> & "Co"', company: 'Acme HVAC' },
  scopes: ['verified_jobs', 'outcomes'],
  claims: { verified_jobs: { window_days: 365, jobs_completed: 42, verified_jobs: 40 }, outcomes: { insufficient_sample: false, first_time_fix_rate: 93.5 } },
  iat, exp: iat + 180 * 86_400, ...over,
});
async function setup() {
  const key = await generateSigningKey('k1');
  const signed = await signEnvelope(key.privateJwk, envelope());
  return { key, ...signed };
}

describe('canonicalJson', () => {
  it('sorts keys and is stable', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
  it('rejects ambiguous values', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: NaN })).toThrow();
  });
});

describe('signature', () => {
  it('verifies a freshly signed credential', async () => {
    const { key, payload, signature } = await setup();
    expect(await verifySignature(key.publicJwk, payload, signature)).toBe(true);
    const r = await verifyCredential({ payload, signature, publicJwk: key.publicJwk, keyStatus: 'active', revokedAt: null, now: NOW });
    expect(r.status).toBe('valid');
    expect(r.envelope?.id).toBe(ID);
  });
  it('rejects a tampered payload (claims edited after signing)', async () => {
    const { key, payload, signature } = await setup();
    const forged = payload.replace('"jobs_completed":42', '"jobs_completed":420');
    expect(forged).not.toBe(payload);
    const r = await verifyCredential({ payload: forged, signature, publicJwk: key.publicJwk, keyStatus: 'active', revokedAt: null, now: NOW });
    expect(r.status).toBe('invalid_signature');
    expect(r.envelope).toBeNull(); // claims of a forged credential are never returned
  });
  it('rejects a signature from a different key', async () => {
    const { payload, signature } = await setup();
    const other = await generateSigningKey('k1');
    const r = await verifyCredential({ payload, signature, publicJwk: other.publicJwk, keyStatus: 'active', revokedAt: null, now: NOW });
    expect(r.status).toBe('invalid_signature');
  });
  it('rejects a truncated / garbage signature without throwing', async () => {
    const { key, payload } = await setup();
    for (const sig of ['', 'abc', '***', 'A'.repeat(86)]) {
      expect((await verifyCredential({ payload, signature: sig, publicJwk: key.publicJwk, keyStatus: 'active', revokedAt: null, now: NOW })).status).toBe('invalid_signature');
    }
  });
  it('rejects non-canonical but correctly signed payloads (re-serialised JSON)', async () => {
    const key = await generateSigningKey('k1');
    const { payload } = await signEnvelope(key.privateJwk, envelope());
    const pretty = JSON.stringify(JSON.parse(payload), null, 1);
    const c = await crypto.subtle.importKey('jwk', key.privateJwk, { name: 'Ed25519' }, false, ['sign']);
    const sigBytes = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, c, new TextEncoder().encode(pretty)));
    let bin = ''; for (const b of sigBytes) bin += String.fromCharCode(b);
    const sig = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect((await verifyCredential({ payload: pretty, signature: sig, publicJwk: key.publicJwk, keyStatus: 'active', revokedAt: null, now: NOW })).status).toBe('invalid_signature');
  });
  it('refuses to sign claims with customer data or credential numbers', async () => {
    const key = await generateSigningKey('k1');
    await expect(signEnvelope(key.privateJwk, envelope({ claims: { jobs: [{ customer_name: 'X' }] } }))).rejects.toThrow(/forbidden/);
    expect(claimsPrivacyViolations({ license_checks: [{ license_number: '1' }, { type: 'epa608' }] })).toEqual(['claims.license_checks[0].license_number']);
    expect(claimsPrivacyViolations({ verified_jobs: { jobs_completed: 3 } })).toEqual([]);
  });
});

describe('revocation, expiry and keys', () => {
  it('revoked wins over valid, and revocation is read live (same signature, new status)', async () => {
    const { key, payload, signature } = await setup();
    const base = { payload, signature, publicJwk: key.publicJwk, keyStatus: 'active' as const, now: NOW };
    expect((await verifyCredential({ ...base, revokedAt: null })).status).toBe('valid');
    expect((await verifyCredential({ ...base, revokedAt: '2026-11-23T11:00:00Z' })).status).toBe('revoked');
  });
  it('expires at the SIGNED exp, not at any database value', async () => {
    const { key, payload, signature } = await setup();
    const base = { payload, signature, publicJwk: key.publicJwk, keyStatus: 'active' as const, revokedAt: null };
    const exp = JSON.parse(payload).exp as number;
    expect((await verifyCredential({ ...base, now: new Date((exp - 1) * 1000) })).status).toBe('valid');
    expect((await verifyCredential({ ...base, now: new Date(exp * 1000) })).status).toBe('expired');
  });
  it('a revoked (compromised) signing key invalidates everything it signed; a retired key still verifies', async () => {
    const { key, payload, signature } = await setup();
    const base = { payload, signature, publicJwk: key.publicJwk, revokedAt: null, now: NOW };
    expect((await verifyCredential({ ...base, keyStatus: 'revoked' })).status).toBe('unknown_key');
    expect((await verifyCredential({ ...base, keyStatus: 'retired' })).status).toBe('valid');
    expect((await verifyCredential({ ...base, publicJwk: null, keyStatus: null })).status).toBe('unknown_key');
  });
  it('JWKS omits revoked keys and exposes no private material', async () => {
    const a = await generateSigningKey('a'); const b = await generateSigningKey('b');
    const jwks = buildJwks([{ kid: 'a', publicJwk: a.publicJwk, status: 'active' }, { kid: 'b', publicJwk: b.publicJwk, status: 'revoked' }]);
    expect(jwks.keys.map((k) => k.kid)).toEqual(['a']);
    expect(JSON.stringify(jwks)).not.toContain('"d"');
  });
});

describe('validation', () => {
  it('validates envelopes', () => {
    expect(validateEnvelope(envelope())).toBe(true);
    expect(validateEnvelope(envelope({ exp: iat }))).toBe(false);
    expect(validateEnvelope(envelope({ exp: iat + 400 * 86_400 }))).toBe(false);
    expect(validateEnvelope(envelope({ scopes: [] }))).toBe(false);
    expect(validateEnvelope(envelope({ id: 'nope' }))).toBe(false);
  });
  it('validates issue input', () => {
    expect(validateIssueInput({ scopes: ['outcomes'], validDays: 30 }).ok).toBe(true);
    expect(validateIssueInput({ scopes: [], validDays: 30 }).ok).toBe(false);
    expect(validateIssueInput({ scopes: ['x'], validDays: 30 }).ok).toBe(false);
    expect(validateIssueInput({ scopes: ['outcomes'], validDays: 0 }).ok).toBe(false);
    expect(validateIssueInput({ scopes: ['outcomes'], validDays: 366 }).ok).toBe(false);
  });
});

describe('badge + embed', () => {
  it('escapes names and shows the name only for valid credentials', () => {
    const svg = buildBadgeSvg('valid', 'Sam <Tech> & "Co"');
    expect(svg).toContain('Sam &lt;Tech&gt; &amp; &quot;Co&quot;');
    expect(svg).not.toContain('<Tech>');
    expect(buildBadgeSvg('revoked', 'Sam')).not.toContain('Sam');
    expect(escapeXml(`<'&">`)).toBe('&lt;&apos;&amp;&quot;&gt;');
  });
  it('builds embed snippets only for real ids', () => {
    const s = buildEmbedSnippets({ appUrl: 'https://vireek.com/', functionsUrl: 'https://x.supabase.co/functions/v1', id: ID });
    expect(s.link).toBe(`https://vireek.com/verify/reputation/${ID}`);
    expect(s.html).toContain(`format=svg`);
    expect(() => buildEmbedSnippets({ appUrl: 'https://vireek.com', functionsUrl: 'https://x', id: '"><script>' })).toThrow();
  });
});
