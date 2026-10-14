import { describe, it, expect } from 'vitest';
import {
  CRM_CATALOG,
  CRM_ENTITIES,
  CRM_PROVIDERS,
  buildAuthorizeUrl,
  buildCreateRequest,
  buildCrmPayload,
  buildGetRequest,
  buildListRequest,
  buildTokenRequest,
  buildUpdateRequest,
  coerceValue,
  crmReadFields,
  dealStatusFromStage,
  decryptSecret,
  defaultSettings,
  encryptSecret,
  escapeLike,
  isAllowedApiBase,
  isAllowedZohoAccountsServer,
  normalizeValue,
  parseListResponse,
  parseTimestamp,
  parseTokenResponse,
  parseWriteResponse,
  pkceChallenge,
  pkceVerifier,
  signOAuthState,
  splitName,
  threeWayMerge,
  toCanonical,
  validateSettings,
  verifyOAuthState,
  type Canon,
  type MergeField,
} from '../../supabase/functions/_shared/crm/engine';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

// ------------------------------------------------------------------ OAuth

describe('OAuth state', () => {
  const data = { owner: 'owner-1', user: 'user-1', provider: 'zoho' as const };

  it('round-trips and carries owner, user and provider', async () => {
    const { state } = await signOAuthState(data, 's3cret');
    const v = await verifyOAuthState(state, 's3cret');
    expect(v?.o).toBe('owner-1');
    expect(v?.u).toBe('user-1');
    expect(v?.p).toBe('zoho');
  });
  it('rejects tampering, wrong secrets and garbage', async () => {
    const { state } = await signOAuthState(data, 's3cret');
    expect(await verifyOAuthState(state, 'other')).toBeNull();
    const [body, sig] = state.split('.');
    const forged = btoa(JSON.stringify({ o: 'attacker', u: 'x', p: 'zoho', n: 'n', t: Date.now() })).replace(/=+$/, '');
    expect(await verifyOAuthState(`${forged}.${sig}`, 's3cret')).toBeNull();
    expect(await verifyOAuthState(`${body}.AAAA`, 's3cret')).toBeNull();
    expect(await verifyOAuthState('nope', 's3cret')).toBeNull();
  });
  it('expires after 10 minutes', async () => {
    const t0 = Date.now();
    const { state } = await signOAuthState(data, 's3cret', t0);
    expect(await verifyOAuthState(state, 's3cret', t0 + 9 * 60_000)).toBeTruthy();
    expect(await verifyOAuthState(state, 's3cret', t0 + 11 * 60_000)).toBeNull();
  });
});

describe('PKCE', () => {
  it('derives a stable RFC 7636 verifier from the nonce and its S256 challenge', async () => {
    const v1 = await pkceVerifier('s', 'nonce');
    expect(v1).toBe(await pkceVerifier('s', 'nonce'));
    expect(v1).not.toBe(await pkceVerifier('s', 'nonce2'));
    expect(/^[A-Za-z0-9_-]{43,128}$/.test(v1)).toBe(true);
    // RFC 7636 appendix B test vector
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('host allow-lists (credential-leak / SSRF protection)', () => {
  it('only accepts genuine provider API hosts', () => {
    expect(isAllowedApiBase('salesforce', 'https://acme.my.salesforce.com')).toBe(true);
    expect(isAllowedApiBase('salesforce', 'https://acme.lightning.force.com')).toBe(true);
    expect(isAllowedApiBase('salesforce', 'https://salesforce.com.evil.io')).toBe(false);
    expect(isAllowedApiBase('salesforce', 'http://acme.my.salesforce.com')).toBe(false);
    expect(isAllowedApiBase('pipedrive', 'https://acme.pipedrive.com')).toBe(true);
    expect(isAllowedApiBase('pipedrive', 'https://pipedrive.com.evil.io')).toBe(false);
    expect(isAllowedApiBase('zoho', 'https://www.zohoapis.eu')).toBe(true);
    expect(isAllowedApiBase('zoho', 'https://www.zohoapis.eu.evil.io')).toBe(false);
  });
  it('only accepts real Zoho accounts servers', () => {
    expect(isAllowedZohoAccountsServer('https://accounts.zoho.in')).toBe(true);
    expect(isAllowedZohoAccountsServer('https://accounts.zoho.com.evil.io')).toBe(false);
    expect(isAllowedZohoAccountsServer('https://evil.io/accounts.zoho.com')).toBe(false);
  });
  it('refuses a token response that points at a foreign API host', () => {
    expect(() => parseTokenResponse('salesforce', { access_token: 'a', instance_url: 'https://evil.io' })).toThrow();
    const ok = parseTokenResponse('pipedrive', { access_token: 'a', refresh_token: 'r', expires_in: 3599, api_domain: 'https://acme.pipedrive.com/' });
    expect(ok.apiBase).toBe('https://acme.pipedrive.com');
    expect(ok.expiresInSec).toBe(3599);
  });
});

describe('authorize URL + token requests', () => {
  it('builds each provider URL with the right parameters', () => {
    const sf = new URL(buildAuthorizeUrl('salesforce', { clientId: 'cid', redirectUri: 'https://x/cb', state: 'st', pkceChallenge: 'ch' }));
    expect(sf.origin + sf.pathname).toBe('https://login.salesforce.com/services/oauth2/authorize');
    expect(sf.searchParams.get('code_challenge_method')).toBe('S256');
    expect(sf.searchParams.get('scope')).toBe('api refresh_token');
    const pd = new URL(buildAuthorizeUrl('pipedrive', { clientId: 'cid', redirectUri: 'https://x/cb', state: 'st' }));
    expect(pd.origin).toBe('https://oauth.pipedrive.com');
    const zh = new URL(buildAuthorizeUrl('zoho', { clientId: 'cid', redirectUri: 'https://x/cb', state: 'st' }));
    expect(zh.searchParams.get('access_type')).toBe('offline');
    expect(zh.searchParams.get('prompt')).toBe('consent');
  });
  it('refuses to build URLs for untrusted auth servers', () => {
    expect(() => buildAuthorizeUrl('zoho', { clientId: 'c', redirectUri: 'r', state: 's', authBase: 'https://evil.io' })).toThrow();
    expect(() => buildTokenRequest('zoho', 'refresh', { clientId: 'c', clientSecret: 's', refreshToken: 'r', authBase: 'https://evil.io' })).toThrow();
    expect(() => buildTokenRequest('salesforce', 'code', { clientId: 'c', clientSecret: 's', code: 'x', authBase: 'https://evil.io' })).toThrow();
  });
  it('Pipedrive authenticates the token call with HTTP Basic, the others with the body', () => {
    const pd = buildTokenRequest('pipedrive', 'code', { clientId: 'cid', clientSecret: 'sec', code: 'c', redirectUri: 'https://x/cb' });
    expect(pd.headers.Authorization).toBe(`Basic ${btoa('cid:sec')}`);
    expect(pd.body.includes('client_secret')).toBe(false);
    const sf = buildTokenRequest('salesforce', 'code', { clientId: 'cid', clientSecret: 'sec', code: 'c', redirectUri: 'https://x/cb', codeVerifier: 'ver' });
    expect(sf.body).toContain('client_secret=sec');
    expect(sf.body).toContain('code_verifier=ver');
    const zr = buildTokenRequest('zoho', 'refresh', { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt', authBase: 'https://accounts.zoho.eu' });
    expect(zr.url).toBe('https://accounts.zoho.eu/oauth/v2/token');
    expect(zr.body).toContain('grant_type=refresh_token');
  });
});

describe('token encryption at rest', () => {
  it('round-trips, uses a fresh IV, and detects tampering', async () => {
    const a = await encryptSecret('refresh-token-123', KEY);
    const b = await encryptSecret('refresh-token-123', KEY);
    expect(a).not.toBe(b);
    expect(await decryptSecret(a, KEY)).toBe('refresh-token-123');
    const parts = a.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}AA`;
    let failed = false;
    try {
      await decryptSecret(tampered, KEY);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
  it('rejects keys that are not 32 bytes', async () => {
    let failed = false;
    try {
      await encryptSecret('x', btoa('short'));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

// ------------------------------------------------------------------ Settings

describe('settings', () => {
  it('defaults are valid for every provider', () => {
    for (const p of CRM_PROVIDERS) {
      const r = validateSettings(p, defaultSettings(p));
      expect(r.ok).toBe(true);
    }
  });
  it('every default mapping points at a catalog field', () => {
    for (const p of CRM_PROVIDERS) {
      const s = defaultSettings(p);
      for (const e of CRM_ENTITIES) {
        for (const m of s.entities[e].mapping) {
          expect(CRM_CATALOG[p][e].some((c) => c.key === m.crm)).toBe(true);
        }
      }
    }
  });
  it('rejects unsafe custom field names (SOQL injection)', () => {
    const s = defaultSettings('salesforce');
    s.entities.contact.mapping.push({ vireek: 'notes', crm: 'Id FROM User--', direction: 'both' });
    s.entities.contact.mapping = s.entities.contact.mapping.filter((m, i, a) => !(m.vireek === 'notes' && m.crm === 'Description' && a.length > 5));
    expect(validateSettings('salesforce', s).ok).toBe(false);
  });
  it('accepts a custom API name and rejects duplicates', () => {
    const s = defaultSettings('salesforce');
    s.entities.lead.mapping.push({ vireek: 'service_interested', crm: 'Service_Interested__c', direction: 'both' });
    expect(validateSettings('salesforce', s).ok).toBe(true);
    s.entities.lead.mapping.push({ vireek: 'service_interested', crm: 'Other__c', direction: 'both' });
    expect(validateSettings('salesforce', s).ok).toBe(false);
  });
  it('requires the name field to be mapped for an enabled entity', () => {
    const s = defaultSettings('zoho');
    s.entities.contact.mapping = s.entities.contact.mapping.filter((m) => m.vireek !== 'name');
    expect(validateSettings('zoho', s).ok).toBe(false);
    s.entities.contact.enabled = false;
    expect(validateSettings('zoho', s).ok).toBe(true);
  });
  it('rejects bad rules and directions', () => {
    const s = defaultSettings('pipedrive');
    (s.entities.contact as { conflict_rule: string }).conflict_rule = 'chaos';
    expect(validateSettings('pipedrive', s).ok).toBe(false);
    const t = defaultSettings('pipedrive');
    (t.entities.contact.mapping[0] as { direction: string }).direction = 'sideways';
    expect(validateSettings('pipedrive', t).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ Normalisation

describe('normalisation', () => {
  it('treats formatting differences as equal', () => {
    expect(normalizeValue('email', ' Ann@Example.COM ')).toBe('ann@example.com');
    expect(normalizeValue('phone', '+1 (555) 123-4567')).toBe('+15551234567');
    expect(normalizeValue('phone', '555.123.4567')).toBe('5551234567');
    expect(normalizeValue('number', '1,250.456')).toBe(1250.46);
    expect(normalizeValue('date', '2026-03-10T12:00:00Z')).toBe('2026-03-10');
    expect(normalizeValue('status', ' WON ')).toBe('won');
    expect(normalizeValue('text', '  a   b ')).toBe('a b');
    expect(normalizeValue('text', '   ')).toBeNull();
  });
  it('keeps original formatting when coercing for storage', () => {
    expect(coerceValue('phone', ' +1 (555) 123-4567 ')).toBe('+1 (555) 123-4567');
    expect(coerceValue('email', 'Ann@Example.com')).toBe('Ann@Example.com');
  });
  it('parses vendor timestamps', () => {
    expect(parseTimestamp('2026-10-08T01:23:45.000+0000')).toBe(Date.parse('2026-10-08T01:23:45.000Z'));
    expect(parseTimestamp('2026-10-08 01:23:45')).toBe(Date.parse('2026-10-08T01:23:45Z'));
    expect(parseTimestamp('2026-10-08T01:23:45+00:00')).toBe(Date.parse('2026-10-08T01:23:45Z'));
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp('garbage')).toBeNull();
  });
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });
});

// ------------------------------------------------------------------ Merge

describe('threeWayMerge', () => {
  const fields: MergeField[] = [
    { key: 'name', type: 'text', direction: 'both', required: true },
    { key: 'email', type: 'email', direction: 'both' },
    { key: 'phone', type: 'phone', direction: 'both' },
  ];
  const base: Canon = { name: 'Ann Lee', email: 'ann@x.com', phone: '+15551234567' };
  const run = (over: Partial<Parameters<typeof threeWayMerge>[0]>) =>
    threeWayMerge({ fields, base, vireek: base, crm: base, rule: 'newest_wins', vireekTs: 2, crmTs: 1, ...over });

  it('does nothing when nothing changed, ignoring formatting-only differences', () => {
    const r = run({ crm: { name: 'Ann  Lee', email: 'ANN@x.com', phone: '(555) 123-4567' } });
    // phone differs in country code only, everything else is formatting
    expect(r.toVireek.name).toBeUndefined();
    expect(r.toCrm.name).toBeUndefined();
    expect(r.toVireek.email).toBeUndefined();
  });
  it('propagates a one-sided change in each direction', () => {
    const a = run({ vireek: { ...base, email: 'new@x.com' } });
    expect(a.toCrm).toEqual({ email: 'new@x.com' });
    expect(a.toVireek).toEqual({});
    const b = run({ crm: { ...base, phone: '+15559998888' } });
    expect(b.toVireek).toEqual({ phone: '+15559998888' });
    expect(b.toCrm).toEqual({});
  });
  it('merges non-overlapping changes made on both sides', () => {
    const r = run({ vireek: { ...base, email: 'v@x.com' }, crm: { ...base, phone: '+15550001111' } });
    expect(r.toCrm).toEqual({ email: 'v@x.com' });
    expect(r.toVireek).toEqual({ phone: '+15550001111' });
    expect(r.conflicts).toHaveLength(0);
  });
  it('resolves a true conflict by newest_wins using the timestamps', () => {
    const vireek = { ...base, email: 'v@x.com' };
    const crm = { ...base, email: 'c@x.com' };
    const v = run({ vireek, crm, vireekTs: 20, crmTs: 10 });
    expect(v.toCrm).toEqual({ email: 'v@x.com' });
    expect(v.resolved).toEqual([{ field: 'email', winner: 'vireek' }]);
    const c = run({ vireek, crm, vireekTs: 10, crmTs: 20 });
    expect(c.toVireek).toEqual({ email: 'c@x.com' });
    const unknownV = run({ vireek, crm, vireekTs: null, crmTs: 20 });
    expect(unknownV.toVireek).toEqual({ email: 'c@x.com' });
  });
  it('honours vireek_wins and crm_wins', () => {
    const vireek = { ...base, email: 'v@x.com' };
    const crm = { ...base, email: 'c@x.com' };
    expect(run({ vireek, crm, rule: 'vireek_wins', vireekTs: 1, crmTs: 99 }).toCrm).toEqual({ email: 'v@x.com' });
    expect(run({ vireek, crm, rule: 'crm_wins', vireekTs: 99, crmTs: 1 }).toVireek).toEqual({ email: 'c@x.com' });
  });
  it('manual rule leaves both values alone, reports the conflict and keeps the old base', () => {
    const r = run({ vireek: { ...base, email: 'v@x.com' }, crm: { ...base, email: 'c@x.com' }, rule: 'manual' });
    expect(r.toCrm).toEqual({});
    expect(r.toVireek).toEqual({});
    expect(r.conflicts).toEqual([{ field: 'email', vireek: 'v@x.com', crm: 'c@x.com', base: 'ann@x.com' }]);
    expect(r.next.email).toBe('ann@x.com');
  });
  it('first link: fills blanks both ways and only conflicts on real disagreement', () => {
    const r = threeWayMerge({
      fields,
      base: null,
      vireek: { name: 'Ann Lee', email: null, phone: '+15551112222' },
      crm: { name: 'Ann Lee', email: 'ann@x.com', phone: null },
      rule: 'manual',
      vireekTs: 1,
      crmTs: 1,
    });
    expect(r.toVireek).toEqual({ email: 'ann@x.com' });
    expect(r.toCrm).toEqual({ phone: '+15551112222' });
    expect(r.conflicts).toHaveLength(0);
    const d = threeWayMerge({
      fields,
      base: null,
      vireek: { name: 'Ann Lee', email: 'a@x.com', phone: null },
      crm: { name: 'Annie Lee', email: 'a@x.com', phone: null },
      rule: 'manual',
      vireekTs: 1,
      crmTs: 1,
    });
    expect(d.conflicts.map((c) => c.field)).toEqual(['name']);
  });
  it('direction acts as a master switch and never raises conflicts', () => {
    const f: MergeField[] = [
      { key: 'email', type: 'email', direction: 'from_crm' },
      { key: 'phone', type: 'phone', direction: 'to_crm' },
    ];
    const r = threeWayMerge({
      fields: f,
      base: { email: 'old@x.com', phone: '+1' },
      vireek: { email: 'v@x.com', phone: '+15550001111' },
      crm: { email: 'c@x.com', phone: '+15559999999' },
      rule: 'manual',
      vireekTs: 1,
      crmTs: 2,
    });
    expect(r.toVireek).toEqual({ email: 'c@x.com' });
    expect(r.toCrm).toEqual({ phone: '+15550001111' });
    expect(r.conflicts).toHaveLength(0);
  });
  it('never blanks a required field on either side', () => {
    const r = run({ crm: { ...base, name: null } });
    expect(r.toVireek.name).toBeUndefined();
    expect(r.toCrm.name).toBe('Ann Lee'); // restored in the CRM instead
  });
  it('lets a side clear an optional field', () => {
    const r = run({ vireek: { ...base, phone: null } });
    expect(r.toCrm).toEqual({ phone: null });
  });
  it('is idempotent: applying the result and merging again is a no-op', () => {
    const vireek = { ...base, email: 'v@x.com' };
    const crm = { ...base, phone: '+15550001111' };
    const first = run({ vireek, crm });
    const afterV = { ...vireek, ...first.toVireek };
    const afterC = { ...crm, ...first.toCrm };
    const second = threeWayMerge({ fields, base: first.next, vireek: afterV, crm: afterC, rule: 'newest_wins', vireekTs: 3, crmTs: 3 });
    expect(second.toVireek).toEqual({});
    expect(second.toCrm).toEqual({});
    expect(second.conflicts).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ Adapters

describe('Salesforce adapter', () => {
  const mapping = defaultSettings('salesforce').entities.contact.mapping;
  it('reads composite name and address', () => {
    const c = toCanonical(
      'salesforce',
      'contact',
      { Id: '003X', FirstName: 'Ann', LastName: 'Lee', Email: 'a@x.com', Phone: '555', MailingStreet: '1 Main St', MailingCity: 'Austin', MailingState: 'TX', LastModifiedDate: '2026-10-08T01:00:00.000+0000', Description: 'VIP' },
      mapping,
    );
    expect(c.externalId).toBe('003X');
    expect(c.values).toEqual({ name: 'Ann Lee', email: 'a@x.com', phone: '555', address: '1 Main St, Austin, TX', notes: 'VIP' });
    expect(c.modifiedAt).toBe(Date.parse('2026-10-08T01:00:00Z'));
  });
  it('splits names on write and requires LastName semantics', () => {
    expect(splitName('Ann Marie Lee')).toEqual({ first: 'Ann Marie', last: 'Lee' });
    expect(splitName('Madonna')).toEqual({ first: '', last: 'Madonna' });
    const p = buildCrmPayload('salesforce', 'contact', { name: 'Ann Lee', email: 'a@x.com' }, mapping);
    expect(p).toEqual({ FirstName: 'Ann', LastName: 'Lee', Email: 'a@x.com' });
  });
  it('never writes fields mapped from_crm only', () => {
    const p = buildCrmPayload('salesforce', 'contact', { address: '9 Elm' }, mapping);
    expect(p).toEqual({});
  });
  it('lead creation supplies the required Company', () => {
    const lm = defaultSettings('salesforce').entities.lead.mapping;
    const p = buildCrmPayload('salesforce', 'lead', { name: 'Zed Quinn' }, lm, { creating: true });
    expect(p.Company).toBe('Zed Quinn');
    expect(p.LastName).toBe('Quinn');
  });
  it('opportunity creation supplies stage + close date, and status drives the stage', () => {
    const dm = defaultSettings('salesforce').entities.deal.mapping;
    const created = buildCrmPayload('salesforce', 'deal', { title: 'Roof' }, dm, { creating: true, now: Date.parse('2026-10-01T00:00:00Z') });
    expect(created).toEqual({ Name: 'Roof', StageName: 'Prospecting', CloseDate: '2026-10-31' });
    const won = buildCrmPayload('salesforce', 'deal', { status: 'won' }, dm);
    expect(won).toEqual({ StageName: 'Closed Won' });
    const explicit = buildCrmPayload('salesforce', 'deal', { status: 'won', stage: 'Negotiation' }, dm);
    expect(explicit).toEqual({ StageName: 'Negotiation' });
  });
  it('derives deal status from IsWon / IsClosed', () => {
    const dm = defaultSettings('salesforce').entities.deal.mapping;
    const v = (raw: Record<string, unknown>) => toCanonical('salesforce', 'deal', { Id: '006', ...raw }, dm).values.status;
    expect(v({ IsWon: true, IsClosed: true })).toBe('won');
    expect(v({ IsWon: false, IsClosed: true })).toBe('lost');
    expect(v({ IsWon: false, IsClosed: false })).toBe('open');
  });
  it('builds a safe SOQL query with a watermark', () => {
    const req = buildListRequest({ provider: 'salesforce', entity: 'lead', base: 'https://a.my.salesforce.com', mapping: defaultSettings('salesforce').entities.lead.mapping, since: '2026-10-08T01:23:45.678Z', cursor: null });
    const q = decodeURIComponent(req.url.split('?q=')[1]);
    expect(q).toContain('FROM Lead');
    expect(q).toContain('IsConverted = false');
    expect(q).toContain('LastModifiedDate > 2026-10-08T01:23:45.000Z');
    expect(q).toContain('ORDER BY LastModifiedDate ASC');
    expect(req.url.startsWith('https://a.my.salesforce.com/services/data/v61.0/query')).toBe(true);
  });
  it('refuses to put unsafe field names or cursors into a request', () => {
    const bad = [{ vireek: 'notes', crm: "Description FROM User WHERE Name='x'", direction: 'both' as const }];
    expect(() => crmReadFields('salesforce', 'contact', bad)).toThrow();
    expect(() => buildListRequest({ provider: 'salesforce', entity: 'contact', base: 'https://a.my.salesforce.com', mapping, since: null, cursor: 'https://evil.io/x' })).toThrow();
    expect(() => buildGetRequest('salesforce', 'contact', 'https://a.my.salesforce.com', '003X/../../x', mapping)).toThrow();
  });
  it('parses list pages, writes and errors', () => {
    expect(parseListResponse('salesforce', { records: [{ Id: '1' }], done: false, nextRecordsUrl: '/services/data/v61.0/query/01g-200' }, { cursor: null })).toEqual({ records: [{ Id: '1' }], next: '/services/data/v61.0/query/01g-200' });
    expect(parseListResponse('salesforce', { records: [], done: true }, { cursor: null }).next).toBeNull();
    expect(parseWriteResponse('salesforce', 201, { id: '003X', success: true })).toEqual({ ok: true, id: '003X' });
    expect(parseWriteResponse('salesforce', 204, null).ok).toBe(true);
    expect(parseWriteResponse('salesforce', 400, [{ message: 'Required fields are missing: [LastName]', errorCode: 'REQUIRED_FIELD_MISSING' }])).toEqual({ ok: false, id: null, error: 'Required fields are missing: [LastName]' });
    const upd = buildUpdateRequest('salesforce', 'contact', 'https://a.my.salesforce.com', '003X', { Email: 'x' });
    expect(upd.method).toBe('PATCH');
    expect(buildCreateRequest('salesforce', 'deal', 'https://a.my.salesforce.com', {}).url.endsWith('/sobjects/Opportunity')).toBe(true);
  });
});

describe('Pipedrive adapter', () => {
  const mapping = defaultSettings('pipedrive').entities.contact.mapping;
  it('reads primary email / phone from multi-value arrays', () => {
    const c = toCanonical(
      'pipedrive',
      'contact',
      { id: 7, name: 'Ann Lee', email: [{ value: 'old@x.com', primary: false }, { value: 'main@x.com', primary: true }], phone: [{ value: '555', primary: true }], update_time: '2026-10-08 01:00:00' },
      mapping,
    );
    expect(c.externalId).toBe('7');
    expect(c.values).toEqual({ name: 'Ann Lee', email: 'main@x.com', phone: '555' });
    expect(c.modifiedAt).toBe(Date.parse('2026-10-08T01:00:00Z'));
  });
  it('replaces only the primary value and preserves the other addresses', () => {
    const current = { email: [{ value: 'old@x.com', primary: false, label: 'work' }, { value: 'main@x.com', primary: true }] };
    const p = buildCrmPayload('pipedrive', 'contact', { email: 'new@x.com' }, mapping, { current });
    expect(p.email).toEqual([
      { value: 'new@x.com', primary: true },
      { value: 'old@x.com', primary: false, label: 'work' },
    ]);
  });
  it('lead value keeps the existing currency', () => {
    const lm = defaultSettings('pipedrive').entities.lead.mapping;
    const p = buildCrmPayload('pipedrive', 'lead', { quote_amount: 1200 }, lm, { current: { value: { amount: 1, currency: 'EUR' } } });
    expect(p.value).toEqual({ amount: 1200, currency: 'EUR' });
    expect(toCanonical('pipedrive', 'lead', { id: 'abc', title: 'Roof', value: { amount: 99, currency: 'USD' } }, lm).values).toEqual({ name: 'Roof', quote_amount: 99 });
  });
  it('cannot create leads (Pipedrive needs a person first) but can create deals', () => {
    expect(() => buildCreateRequest('pipedrive', 'lead', 'https://a.pipedrive.com', {})).toThrow();
    expect(buildCreateRequest('pipedrive', 'deal', 'https://a.pipedrive.com', { title: 'x' }).url).toBe('https://a.pipedrive.com/api/v1/deals');
    const p = buildCrmPayload('pipedrive', 'deal', { title: 'Roof' }, defaultSettings('pipedrive').entities.deal.mapping, { creating: true });
    expect(p).toEqual({ title: 'Roof', status: 'open' });
  });
  it('uses stable id order for the first pass and newest-first afterwards', () => {
    const full = buildListRequest({ provider: 'pipedrive', entity: 'contact', base: 'https://a.pipedrive.com', mapping, since: null, cursor: null });
    expect(full.url).toContain('sort=id%20ASC');
    const inc = buildListRequest({ provider: 'pipedrive', entity: 'contact', base: 'https://a.pipedrive.com', mapping, since: '2026-10-01T00:00:00Z', cursor: '200' });
    expect(inc.url).toContain('sort=update_time%20DESC');
    expect(inc.url).toContain('start=200');
  });
  it('parses pagination and writes; maps deleted deals to lost', () => {
    expect(parseListResponse('pipedrive', { data: [{ id: 1 }], additional_data: { pagination: { more_items_in_collection: true, next_start: 200 } } }, { cursor: null })).toEqual({ records: [{ id: 1 }], next: '200' });
    expect(parseListResponse('pipedrive', { data: null }, { cursor: null })).toEqual({ records: [], next: null });
    expect(parseWriteResponse('pipedrive', 201, { success: true, data: { id: 55 } })).toEqual({ ok: true, id: '55' });
    expect(parseWriteResponse('pipedrive', 400, { success: false, error: 'bad' }).error).toBe('bad');
    const dm = defaultSettings('pipedrive').entities.deal.mapping;
    expect(toCanonical('pipedrive', 'deal', { id: 1, title: 'x', status: 'deleted' }, dm).values.status).toBe('lost');
  });
});

describe('Zoho adapter', () => {
  const mapping = defaultSettings('zoho').entities.contact.mapping;
  it('reads and writes composite names', () => {
    const c = toCanonical('zoho', 'contact', { id: '4000', First_Name: 'Ann', Last_Name: 'Lee', Email: 'a@x.com', Modified_Time: '2026-10-08T01:00:00+00:00' }, mapping);
    expect(c.values.name).toBe('Ann Lee');
    expect(buildCrmPayload('zoho', 'contact', { name: 'Ann Lee' }, mapping)).toEqual({ First_Name: 'Ann', Last_Name: 'Lee' });
  });
  it('wraps writes in the data[] envelope and sends If-Modified-Since', () => {
    expect(buildCreateRequest('zoho', 'contact', 'https://www.zohoapis.com', { Last_Name: 'x' }).body).toEqual({ data: [{ Last_Name: 'x' }] });
    const list = buildListRequest({ provider: 'zoho', entity: 'contact', base: 'https://www.zohoapis.com', mapping, since: '2026-10-08T01:00:00.000Z', cursor: null });
    expect(list.headers?.['If-Modified-Since']).toBe('2026-10-08T01:00:00+00:00');
    const u = new URL(list.url);
    expect(u.pathname).toBe('/crm/v6/Contacts');
    expect(u.searchParams.get('fields')).toContain('Last_Name');
    expect(u.searchParams.get('fields')).toContain('Modified_Time');
  });
  it('pages by token when Zoho provides one, otherwise by page number', () => {
    expect(parseListResponse('zoho', { data: [], info: { more_records: true, next_page_token: 'tok', page: 1 } }, { cursor: null }).next).toBe('token:tok');
    expect(parseListResponse('zoho', { data: [], info: { more_records: true, page: 3 } }, { cursor: 'page:3' }).next).toBe('page:4');
    expect(parseListResponse('zoho', { data: [], info: { more_records: false } }, { cursor: null }).next).toBeNull();
    const withToken = buildListRequest({ provider: 'zoho', entity: 'deal', base: 'https://www.zohoapis.com', mapping: defaultSettings('zoho').entities.deal.mapping, since: null, cursor: 'token:abc' });
    expect(new URL(withToken.url).searchParams.get('page_token')).toBe('abc');
  });
  it('parses write results including duplicates', () => {
    expect(parseWriteResponse('zoho', 201, { data: [{ code: 'SUCCESS', status: 'success', details: { id: '99' } }] })).toEqual({ ok: true, id: '99' });
    expect(parseWriteResponse('zoho', 202, { data: [{ code: 'DUPLICATE_DATA', status: 'error', details: { id: '77' }, message: 'dup' }] })).toEqual({ ok: false, id: null, duplicateOf: '77', error: 'Duplicate record in Zoho CRM' });
    expect(parseWriteResponse('zoho', 400, { data: [{ code: 'MANDATORY_NOT_FOUND', status: 'error', message: 'required' }] }).error).toBe('required');
  });
  it('derives deal status from the stage name and defaults the stage on create', () => {
    expect(dealStatusFromStage('Closed Won')).toBe('won');
    expect(dealStatusFromStage('Closed Lost to Competition')).toBe('lost');
    expect(dealStatusFromStage('Negotiation/Review')).toBe('open');
    const dm = defaultSettings('zoho').entities.deal.mapping;
    const p = buildCrmPayload('zoho', 'deal', { title: 'Roof' }, dm, { creating: true, now: Date.parse('2026-10-01T00:00:00Z') });
    expect(p).toEqual({ Deal_Name: 'Roof', Stage: 'Qualification', Closing_Date: '2026-10-31' });
  });
});
