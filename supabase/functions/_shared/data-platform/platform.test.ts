// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { DATASETS, DATASET_KEYS, allColumns, createPseudonymizer, renderDataDictionaryMarkdown, selectList, transformRow } from './catalog';
import {
  advanceCursor, backoffMs, bigQuerySchema, buildBigQueryMerge, buildDdl, buildMarkDeleted, buildPostgresUpsert, buildSnowflakeMerge,
  classifyFailure, cursorFilter, isPublicHost, quoteIdent, schemaHash, startCursor, validateWarehouseConfig, validateWarehouseCredentials,
  type PostgresConfig, type SnowflakeConfig, type BigQueryConfig,
} from './warehouse';
import { sealSecret, openSecret, randomSecret, safeEqual } from './secrets';
import { parseServiceAccountJson, signServiceAccountJwt } from './googleAuth';
import { EMBED_TOKEN_MAX_TTL_SEC, mergeFilters, peekEmbedId, resolveEmbedQuery, sanitizeEmbedConfig, signEmbedToken, verifyEmbedToken } from './embed';
import {
  audienceTable, buildAudience, consentedWithEmail, klaviyoImportBody, mailchimpDc, mailchimpMemberRequest, md5, selectAudience, sheetRange,
  sheetValues, toE164, validateReverseConfig, columnLetter,
} from './reverseEtl';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ACCT = '11111111-1111-4111-8111-111111111111';

describe('catalog', () => {
  it('never exports transcripts, recordings, notes or signatures', () => {
    const names = DATASET_KEYS.flatMap((k) => allColumns(k).map((c) => c.name));
    for (const bad of ['transcript', 'recording_url', 'summary', 'notes', 'signature']) expect(names).not.toContain(bad);
  });
  it('every dataset has id + updated_at and unique column names', () => {
    for (const k of DATASET_KEYS) {
      const n = allColumns(k).map((c) => c.name);
      expect(n).toContain('id'); expect(n).toContain('updated_at'); expect(new Set(n).size).toBe(n.length);
      expect(selectList(k)).not.toContain('*');
    }
  });
  it('pseudonymises identifiers stably, blanks sensitive fields, per account', async () => {
    const p1 = await createPseudonymizer('s3cret', ACCT);
    const p2 = await createPseudonymizer('s3cret', '22222222-2222-4222-8222-222222222222');
    const row = { id: 'x', name: 'Ann', email: ' Ann@X.com ', phone: '(555) 123-4567', updated_at: '2026-01-01T00:00:00Z', tags: ['a'] };
    const ctx = { accountId: ACCT, piiMode: 'hashed' as const, pseudonymize: p1, syncedAt: '2026-01-02T00:00:00Z' };
    const a = await transformRow('customers', row, ctx);
    const b = await transformRow('customers', { ...row, email: 'ann@x.com' }, ctx);
    expect(a.name).toBeNull(); expect(a.email).toBe(b.email); expect(String(a.email)).toMatch(/^[0-9a-f]{64}$/);
    expect((await transformRow('customers', row, { ...ctx, pseudonymize: p2 })).email).not.toBe(a.email);
    expect(a.tags).toEqual(['a']); expect(a._vireek_deleted).toBe(false);
    expect((await transformRow('customers', row, { ...ctx, piiMode: 'omit' })).email).toBeNull();
    expect((await transformRow('customers', row, { ...ctx, piiMode: 'full' })).name).toBe('Ann');
  });
  it('renders a data dictionary', () => {
    const md = renderDataDictionaryMarkdown({ schemaName: 'vireek', piiMode: 'hashed' });
    expect(md).toContain('## jobs'); expect(md).toContain('| `invoice_amount` |');
  });
});

describe('warehouse', () => {
  const pg: PostgresConfig = { kind: 'postgres', host: 'db.example.com', port: 5432, database: 'd', username: 'u', schema: 'vireek', ssl: 'require' };
  const sf: SnowflakeConfig = { kind: 'snowflake', account: 'org-acct', username: 'u', warehouse: 'WH', database: 'DB', schema: 'VIREEK', role: '' };
  const bq: BigQueryConfig = { kind: 'bigquery', project_id: 'my-proj-123', dataset: 'vireek', location: 'US' };
  it('blocks SSRF targets', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '172.20.1.1', '::1', 'fd00::1', 'db.internal', 'metadata.google.internal', 'intranet', '100.64.0.1']) expect(isPublicHost(h)).toBe(false);
    for (const h of ['db.example.com', '8.8.8.8', 'x.abc123.us-east-1.rds.amazonaws.com']) expect(isPublicHost(h)).toBe(true);
    expect(validateWarehouseConfig('postgres', { ...pg, host: '10.1.1.1' }).ok).toBe(false);
  });
  it('validates configs and credentials', () => {
    expect(validateWarehouseConfig('bigquery', { project_id: 'X', dataset: 'a-b' }).ok).toBe(false);
    expect(validateWarehouseConfig('bigquery', bq).ok).toBe(true);
    expect(validateWarehouseConfig('snowflake', { ...sf, warehouse: 'a; drop' }).ok).toBe(false);
    expect(validateWarehouseCredentials('snowflake', { auth: 'keypair', private_key: 'nope' }).ok).toBe(false);
    expect(validateWarehouseCredentials('postgres', { password: '' }).ok).toBe(false);
  });
  it('quotes identifiers per dialect and refuses unsafe ones', () => {
    expect(quoteIdent('snowflake', 'jobs')).toBe('"JOBS"'); expect(quoteIdent('postgres', 'Jobs')).toBe('"jobs"'); expect(quoteIdent('bigquery', 'jobs')).toBe('`jobs`');
    expect(() => quoteIdent('postgres', 'a"; drop table x; --')).toThrow();
  });
  it('builds DDL, upserts and soft deletes', () => {
    expect(buildDdl(pg, 'jobs')[1]).toContain('PRIMARY KEY ("id")');
    expect(buildDdl(sf, 'jobs').some((s) => s.startsWith('COMMENT ON COLUMN'))).toBe(true);
    const up = buildPostgresUpsert(pg, 'jobs', '[]'); expect(up.sql).toContain('ON CONFLICT ("id") DO UPDATE'); expect(up.params).toEqual(['[]']);
    expect(buildSnowflakeMerge(sf, 'jobs', '[]').sql).toContain('MERGE INTO "DB"."VIREEK"."JOBS"');
    expect(buildBigQueryMerge(bq, 'jobs', 'jobs__stg_1')).toContain('MERGE `my-proj-123.vireek.jobs`');
    expect(bigQuerySchema('jobs').find((f) => f.name === 'id')?.mode).toBe('REQUIRED');
    expect(buildMarkDeleted(pg, 'jobs', ACCT, '2026-01-01T00:00:00Z')).toContain('"_vireek_synced_at" <');
    expect(() => buildMarkDeleted(pg, 'jobs', "x' OR 1=1 --", '2026-01-01T00:00:00Z')).toThrow();
    expect(schemaHash('jobs')).toBe(schemaHash('jobs'));
  });
  it('keyset cursor re-reads an overlap window and advances by raw strings', () => {
    expect(startCursor(null, { full: false }).ts).toBe('1970-01-01T00:00:00.000Z');
    expect(startCursor('2026-01-01T00:10:00Z', { full: false }).ts).toBe('2026-01-01T00:05:00.000Z');
    expect(startCursor('2026-01-01T00:10:00Z', { full: true }).ts).toBe('1970-01-01T00:00:00.000Z');
    const c = advanceCursor([{ updated_at: '2026-01-01T00:00:00.123456+00:00', id: 'abc' }], startCursor(null, { full: true }));
    expect(c).toEqual({ ts: '2026-01-01T00:00:00.123456+00:00', id: 'abc' });
    expect(cursorFilter(c)).toContain('and(updated_at.eq.2026-01-01T00:00:00.123456+00:00,id.gt.abc)');
  });
  it('classifies failures and backs off', () => {
    expect(classifyFailure(429, '')).toBe('retryable'); expect(classifyFailure(403, 'Access Denied')).toBe('auth'); expect(classifyFailure(404, 'Not found: dataset')).toBe('config');
    expect(backoffMs(3, () => 1)).toBeLessThanOrEqual(2000);
  });
});

describe('secrets and google auth', () => {
  it('round-trips and binds ciphertext to its row', async () => {
    const t = await sealSecret('hunter2', KEY, 'dp_destination:a');
    expect(await openSecret(t, KEY, 'dp_destination:a')).toBe('hunter2');
    await expect(openSecret(t, KEY, 'dp_destination:b')).rejects.toThrow();
    await expect(sealSecret('x', 'short', 'a')).rejects.toThrow();
    expect(randomSecret().length).toBeGreaterThan(30); expect(safeEqual('a', 'a')).toBe(true); expect(safeEqual('a', 'b')).toBe(false);
  });
  it('parses a service account and signs a verifiable RS256 JWT', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
    const parsed = parseServiceAccountJson(JSON.stringify({ type: 'service_account', client_email: 'a@p.iam.gserviceaccount.com', private_key: pem }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const jwt = await signServiceAccountJwt(parsed.key, ['scope1'], 1000);
    const [h, c, s] = jwt.split('.');
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4)), (x) => x.charCodeAt(0));
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', kp.publicKey, sig, new TextEncoder().encode(`${h}.${c}`))).toBe(true);
    expect(JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/')))).toMatchObject({ iss: 'a@p.iam.gserviceaccount.com', aud: 'https://oauth2.googleapis.com/token', exp: 4600 });
    expect(parseServiceAccountJson('{}').ok).toBe(false);
  });
});

describe('embed tokens', () => {
  const EID = '33333333-3333-4333-8333-333333333333';
  const now = 1_800_000_000;
  it('signs, verifies and rejects tampering, expiry and long TTLs', async () => {
    const tok = await signEmbedToken('sek', { eid: EID, iat: now, exp: now + 600, sub: 'viewer-1' });
    expect(peekEmbedId(tok)).toBe(EID);
    expect((await verifyEmbedToken('sek', tok, now)).ok).toBe(true);
    expect(await verifyEmbedToken('other', tok, now)).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(await verifyEmbedToken('sek', tok, now + 3600)).toMatchObject({ ok: false, reason: 'expired' });
    const parts = tok.split('.'); parts[1] = parts[1].slice(0, -2) + 'AA';
    expect((await verifyEmbedToken('sek', parts.join('.'), now)).ok).toBe(false);
    const long = await signEmbedToken('sek', { eid: EID, iat: now, exp: now + EMBED_TOKEN_MAX_TTL_SEC + 10 });
    expect(await verifyEmbedToken('sek', long, now)).toMatchObject({ ok: false, reason: 'ttl_too_long' });
    expect((await verifyEmbedToken('sek', 'garbage', now)).ok).toBe(false);
  });
  it('a viewer token can only narrow locked filters', () => {
    expect(mergeFilters({ service_type: ['HVAC', 'Plumbing'] }, { service_type: ['Plumbing', 'Roofing'] })).toEqual({ service_type: ['Plumbing'] });
    expect(mergeFilters({ service_type: ['HVAC'] }, { service_type: ['Roofing'] }).service_type).not.toEqual([]);
  });
  it('caps what a viewer can request', () => {
    const cfg = sanitizeEmbedConfig({ metrics: ['revenue', 'jobs_completed', 'nope'], max_range_days: 30, allowed_group_by: ['service_type'], locked_filters: { service_type: ['HVAC'] } });
    expect(cfg.ok).toBe(true); if (!cfg.ok) return;
    const nowD = new Date('2026-09-30T00:00:00Z');
    const p = { eid: EID, iat: now, exp: now + 60 };
    expect(resolveEmbedQuery(cfg.config, p, { metrics: ['close_rate'] }, nowD).ok).toBe(false);
    expect(resolveEmbedQuery(cfg.config, p, { from: '2020-01-01', to: '2026-09-30' }, nowD).ok).toBe(false);
    expect(resolveEmbedQuery(cfg.config, p, { groupBy: 'technician' }, nowD).ok).toBe(false);
    const ok = resolveEmbedQuery(cfg.config, p, { groupBy: 'service_type' }, nowD);
    expect(ok.ok).toBe(true); if (ok.ok) expect(ok.query.filters).toEqual({ service_type: ['HVAC'] });
    expect(sanitizeEmbedConfig({ metrics: ['close_rate'], locked_filters: { service_type: ['HVAC'] } }).ok).toBe(false);
  });
});

describe('reverse ETL', () => {
  const customers = [
    { id: 'c1', name: 'Ann Lee', email: 'Ann@X.com', phone: '5551234567', marketing_opt_in: true, lifecycle_stage: 'active' },
    { id: 'c2', name: 'Bob', email: 'bob@x.com', phone: null, marketing_opt_in: false, lifecycle_stage: 'active' },
    { id: 'c3', name: 'Cy', email: 'bad-email', phone: null, marketing_opt_in: true, lifecycle_stage: 'active' },
  ];
  const jobs = [
    { customer_id: 'c1', job_status: 'completed', invoice_amount: 3000, completed_at: '2024-01-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z' },
    { customer_id: 'c2', job_status: 'completed', invoice_amount: 100, completed_at: '2026-09-20T00:00:00Z', created_at: '2026-09-20T00:00:00Z' },
  ];
  const now = new Date('2026-10-01T00:00:00Z');
  const aud = buildAudience(customers, jobs);
  it('selects audiences', () => {
    expect(selectAudience('lapsed_customers', aud, 12, now).map((m) => m.customer_id)).toEqual(['c1']);
    expect(selectAudience('high_value_customers', aud, 2000, now).map((m) => m.customer_id)).toEqual(['c1']);
    expect(selectAudience('recent_customers', aud, 30, now).map((m) => m.customer_id)).toEqual(['c2']);
  });
  it('email tools only get consented customers with valid email', () => {
    const r = consentedWithEmail(aud);
    expect(r.eligible.map((m) => m.customer_id)).toEqual(['c1']);
    expect(r.skippedNoConsent).toBe(1); expect(r.skippedNoEmail).toBe(1);
  });
  it('md5 matches RFC 1321 vectors', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e'); expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });
  it('builds Mailchimp requests that never resubscribe', () => {
    expect(mailchimpDc('0123456789abcdef0123456789abcdef-us21')).toBe('us21'); expect(mailchimpDc('x-evil.com/')).toBeNull();
    const r = mailchimpMemberRequest('abcdef1234', aud[0], 'vireek');
    expect(r.path).toBe(`/3.0/lists/abcdef1234/members/${md5('ann@x.com')}`);
    expect(r.body.status_if_new).toBe('subscribed'); expect((r.body as any).status).toBeUndefined();
  });
  it('builds Klaviyo bodies and E.164 phones', () => {
    expect(toE164('(555) 123-4567')).toBe('+15551234567'); expect(toE164('12')).toBeNull(); expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
    expect(klaviyoImportBody('AbC123', [aud[0]], 'lapsed').data.relationships.lists.data[0].id).toBe('AbC123');
  });
  it('keeps sheet values as plain data and validates config', () => {
    const v = sheetValues({ columns: ['a'], rows: [['=HYPERLINK("x")'], [null]], truncated: false });
    expect(v[1][0]).toBe('=HYPERLINK("x")'); expect(v[2][0]).toBe('');
    expect(sheetRange("O'Brien", 'A1')).toBe("'O''Brien'!A1"); expect(columnLetter(27)).toBe('AA');
    expect(audienceTable(aud).columns.length).toBe(7);
    expect(validateReverseConfig('sheets', { spreadsheet_id: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit', tab: 'Vireek' }).ok).toBe(true);
    expect(validateReverseConfig('sheets', { spreadsheet_id: 'x', tab: 'a/b' }).ok).toBe(false);
    expect(validateReverseConfig('mailchimp', { list_id: 'zzz' }).ok).toBe(false);
  });
});
