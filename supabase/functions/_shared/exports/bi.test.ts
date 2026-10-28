// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPseudonymizer, DATASETS, DATASET_KEYS } from '../data-platform/catalog.ts';
import {
  BI_VIEW_NAMES, CsvPart, awsUriEncode, biColumns, biPiiViewName, biSchemaHash, biSelectList, canonicalJson, csvHeader, csvLine,
  datasetDir, deleteObject, describeStorageFailure, hasPii, objectLocation, outputName, putObject, sha256Hex, signAwsV4, signManifest,
  validatePrefix, validateScheduleInput, validateTargetInput, verifyManifest, verifyPart, nextRunAt, type BiManifestBody, type FetchLike,
} from './bi.ts';
import { runBiDelivery } from './biRunner.ts';

const ACCT = '11111111-1111-4111-8111-111111111111';
const SECRET = 'signing-secret-for-tests';
const PII_VALUES = ['Ann Lee', '+1 555 0100', 'ann@example.com', '12 Oak St'];

describe('columns and PII', () => {
  it('omit mode contains no personal column anywhere', () => {
    for (const d of DATASET_KEYS) {
      expect(biColumns(d, 'omit').some((c) => !!c.pii)).toBe(false);
      const sel = biSelectList(d, 'omit').split(',');
      for (const c of DATASETS[d].columns) if (c.pii) expect(sel).not.toContain(c.name);
      expect(sel).toContain('id');
      expect(sel).toContain('updated_at');
    }
  });
  it('hashed keeps identifiers (renamed _hash) and drops sensitive columns', () => {
    const cols = biColumns('customers', 'hashed').map((c) => outputName(c, 'hashed'));
    expect(cols).toContain('email_hash');
    expect(cols).toContain('phone_hash');
    expect(cols).not.toContain('name');
    expect(cols).not.toContain('address');
  });
  it('full keeps everything; schema hash differs per mode', () => {
    expect(biColumns('customers', 'full').length).toBe(DATASETS.customers.columns.length);
    expect(biSchemaHash('customers', 'omit')).not.toBe(biSchemaHash('customers', 'full'));
  });
  it('every dataset has unique output names', () => {
    for (const d of DATASET_KEYS) for (const m of ['omit', 'hashed', 'full'] as const) {
      const n = biColumns(d, m).map((c) => outputName(c, m));
      expect(new Set(n).size).toBe(n.length);
    }
  });
});

describe('csv', () => {
  const cols = biColumns('customers', 'omit');
  it('header, escaping, booleans, json and formula neutralisation', () => {
    expect(csvHeader('customers', 'omit').split(',')[0]).toBe('id');
    const vals = cols.map((c) => (c.name === 'source' ? '=HYPERLINK("x")' : c.name === 'marketing_opt_in' ? true : c.name === 'tags' ? ['a', 'b'] : c.name === 'id' ? 'i,d' : null));
    const line = csvLine(cols, vals);
    expect(line).toContain('"i,d"');
    expect(line).toContain("'=HYPERLINK");
    expect(line).toContain('true');
    expect(line).toContain('"[""a"",""b""]"');
  });
  it('does not alter negative numbers', () => {
    const jc = biColumns('job_costs', 'omit');
    const line = csvLine(jc, jc.map((c) => (c.name === 'total_cost_cents' ? -500 : null)));
    expect(line).toContain('-500');
  });
  it('part is full at its row budget and ends with CRLF, no BOM', () => {
    const p = new CsvPart('a', 2, 1e9);
    p.add('1');
    expect(p.full).toBe(false);
    p.add('2');
    expect(p.full).toBe(true);
    const text = new TextDecoder().decode(p.toBytes());
    expect(text).toBe('a\r\n1\r\n2\r\n');
  });
});

describe('signed manifest', () => {
  const body: BiManifestBody = {
    version: 1, format: 'csv', run_id: 'r', account_id: ACCT, dataset: 'jobs', mode: 'snapshot', pii_mode: 'omit', generated_at: 'now',
    since: null, watermark: null, complete: true, schema_hash: 'x', columns: [], row_count: 1, parts: [{ name: 'part-0001.csv', rows: 1, bytes: 3, sha256: 'ab' }],
  };
  it('canonical json is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [2, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[2,{"y":2,"z":1}],"d":1},"b":1}');
  });
  it('verifies, and detects tampering or a wrong secret', async () => {
    const m = await signManifest(body, SECRET);
    expect((await verifyManifest(m, SECRET)).ok).toBe(true);
    expect((await verifyManifest(m, 'other')).ok).toBe(false);
    expect((await verifyManifest({ ...m, row_count: 2 }, SECRET)).ok).toBe(false);
    expect((await verifyManifest({ ...m, parts: [{ ...m.parts[0], sha256: 'cd' }] }, SECRET)).ok).toBe(false);
  });
  it('verifies a part against its entry', async () => {
    const bytes = new TextEncoder().encode('abc');
    const entry = { name: 'p', rows: 1, bytes: 3, sha256: await sha256Hex(bytes) };
    expect(await verifyPart(bytes, entry)).toBe(true);
    expect(await verifyPart(new TextEncoder().encode('abd'), entry)).toBe(false);
  });
});

describe('AWS signature v4', () => {
  it('matches the published S3 GET example', async () => {
    const r = await signAwsV4({
      method: 'GET', path: '/test.txt', region: 'us-east-1', service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', amzDate: '20130524T000000Z',
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
    });
    expect(r.authorization).toContain('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(r.signedHeaders).toBe('host;range;x-amz-content-sha256;x-amz-date');
  });
  it('encodes keys', () => {
    expect(awsUriEncode('a b/c')).toBe('a%20b%2Fc');
    expect(awsUriEncode("it's", true)).toBe('it%27s');
  });
});

describe('object locations', () => {
  it('s3 virtual-hosted, dotted bucket path-style, gcs', () => {
    expect(objectLocation({ provider: 's3', bucket: 'my-bkt', region: 'eu-central-1', prefix: 'vireek/x' }, 'a/b.csv').url).toBe('https://my-bkt.s3.eu-central-1.amazonaws.com/vireek/x/a/b.csv');
    expect(objectLocation({ provider: 's3', bucket: 'my.bkt', region: 'us-east-1', prefix: '' }, 'a.csv').url).toBe('https://s3.us-east-1.amazonaws.com/my.bkt/a.csv');
    const g = objectLocation({ provider: 'gcs', bucket: 'bkt', region: 'auto', prefix: 'p' }, 'k=1/a.csv');
    expect(g.host).toBe('storage.googleapis.com');
    expect(g.signRegion).toBe('auto');
    expect(g.path).toBe('/bkt/p/k%3D1/a.csv');
  });
  it('dataset dir is partitioned by day and run', () => {
    expect(datasetDir('jobs', 'incremental', '2026-10-28', 'abcdef12-0000-4000-8000-000000000000')).toBe('jobs/incremental/dt=2026-10-28/run=abcdef12');
  });
});

describe('validation', () => {
  it('prefix rules', () => {
    expect(validatePrefix('/a/b/')).toBe('a/b');
    expect(validatePrefix('')).toBe('');
    expect(validatePrefix('a/../b')).toBeNull();
    expect(validatePrefix('a b')).toBeNull();
    expect(validatePrefix('a//b')).toBeNull();
  });
  it('target input', () => {
    const ok = validateTargetInput({ name: 'Prod', provider: 's3', bucket: 'my-bucket', region: 'eu-west-1', prefix: 'v', access_key_id: 'AKIA12345678', secret_access_key: 'x'.repeat(40) }, { requireSecret: true });
    expect(ok.ok).toBe(true);
    const bad = validateTargetInput({ name: '', provider: 'ftp', bucket: 'B', access_key_id: 'x' }, { requireSecret: true });
    expect(bad.ok).toBe(false);
    const gcs = validateTargetInput({ name: 'G', provider: 'gcs', bucket: 'my_bucket', region: 'whatever', access_key_id: 'GOOG1EXAMPLE1', secret_access_key: 's'.repeat(40) }, { requireSecret: true });
    expect(gcs.ok && gcs.value.region).toBe('auto');
    expect(validateTargetInput({ name: 'A', provider: 's3', bucket: 'my-bucket', region: 'eu-west-1', access_key_id: 'AKIA12345678' }, { requireSecret: false }).ok).toBe(true);
  });
  it('schedule input rejects unknown tables and bad intervals', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(validateScheduleInput({ name: 'n', target_id: id, datasets: ['jobs', 'users'], mode: 'snapshot', interval_minutes: 60 }).ok).toBe(false);
    expect(validateScheduleInput({ name: 'n', target_id: id, datasets: ['jobs'], mode: 'snapshot', interval_minutes: 15 }).ok).toBe(false);
    const ok = validateScheduleInput({ name: 'n', target_id: id, datasets: ['jobs', 'jobs'.replace('jobs', 'calls')], mode: 'incremental', interval_minutes: 1440 });
    expect(ok.ok && ok.value.pii_mode).toBe('omit');
  });
  it('backoff grows and is capped at a week', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(nextRunAt(now, 60, 0).getTime() - now.getTime()).toBe(3_600_000);
    expect(nextRunAt(now, 10080, 5).getTime() - now.getTime()).toBe(10080 * 60_000);
  });
});

describe('storage', () => {
  const t = { provider: 's3' as const, bucket: 'bkt', region: 'eu-west-1', prefix: '' };
  const creds = { accessKeyId: 'AKIA12345678', secretAccessKey: 'secret'.repeat(8) };
  it('signs, never sends host, and retries a 503', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const f: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { status: calls.length === 1 ? 503 : 200, text: async () => '' };
    };
    await putObject(t, creds, 'a.csv', new Uint8Array([1, 2]), 'text/csv', f);
    expect(calls.length).toBe(2);
    expect(calls[1].headers.Authorization).toContain('AWS4-HMAC-SHA256');
    expect(Object.keys(calls[1].headers).map((k) => k.toLowerCase())).not.toContain('host');
  });
  it('does not retry access denied and explains it', async () => {
    let n = 0;
    const f: FetchLike = async () => { n++; return { status: 403, text: async () => '<Error><Code>AccessDenied</Code></Error>' }; };
    await expect(putObject(t, creds, 'a.csv', new Uint8Array(1), 'text/csv', f)).rejects.toThrow('Access denied');
    expect(n).toBe(1);
  });
  it('delete works and failure descriptions are specific', async () => {
    await deleteObject(t, creds, 'a.csv', async () => ({ status: 204, text: async () => '' }));
    expect(describeStorageFailure(403, '<Code>SignatureDoesNotMatch</Code>', 's3').message).toContain('secret');
    expect(describeStorageFailure(404, '<Code>NoSuchBucket</Code>', 'gcs').retryable).toBe(false);
    expect(describeStorageFailure(null, '', 's3').retryable).toBe(true);
  });
});

// ---------------------------------------------------------------- run (fake database) --
type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>) {
  const log: { table: string; eq: [string, unknown][]; is: [string, unknown][] }[] = [];
  const upserts: Row[] = [];
  const from = (table: string) => {
    const entry = { table, eq: [] as [string, unknown][], is: [] as [string, unknown][] };
    let rows = [...(tables[table] ?? [])];
    let gtId: string | null = null;
    let limit = 1000;
    let cols: string[] | null = null;
    const q: Record<string, unknown> = {
      select: (s: string) => { cols = s.split(','); return q; },
      eq: (c: string, v: unknown) => { entry.eq.push([c, v]); rows = rows.filter((r) => r[c] === v); return q; },
      is: (c: string, v: unknown) => { entry.is.push([c, v]); return q; },
      or: () => q,
      gt: (_c: string, v: string) => { gtId = v; return q; },
      order: () => q,
      limit: (n: number) => { limit = n; return q; },
      maybeSingle: async () => ({ data: null }),
      upsert: async (r: Row) => { upserts.push(r); return { error: null }; },
      then: (res: (v: unknown) => unknown) => {
        log.push(entry);
        let out = rows;
        if (gtId !== null) out = out.filter((r) => String(r.id) > (gtId as string));
        out = out.slice(0, limit).map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : r));
        return Promise.resolve({ data: out, error: null }).then(res);
      },
    };
    return q;
  };
  return { db: { from }, log, upserts };
}

const customers = (n: number, user = ACCT): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, user_id: user, name: 'Ann Lee', phone: '+1 555 0100', email: 'ann@example.com', address: '12 Oak St',
    customer_type: 'residential', lifecycle_stage: 'active', source: 'call', tags: ['vip'], marketing_opt_in: true, marketing_opt_in_at: null,
    last_contacted_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`, deleted_at: null,
  }));

async function deliver(piiMode: 'omit' | 'hashed' | 'full', opts: { permitted?: boolean; mode?: 'snapshot' | 'incremental'; deadline?: number; rows?: Row[] } = {}) {
  const f = fakeDb({ customers: [...(opts.rows ?? customers(3)), ...customers(2, '99999999-9999-4999-8999-999999999999')] });
  const uploads: Record<string, Uint8Array> = {};
  const res = await runBiDelivery(
    {
      db: f.db, signingSecret: SECRET, pseudonymSecret: 'pseudo', deadline: opts.deadline ?? Date.now() + 60_000, piiPermitted: opts.permitted ?? true,
      put: async (k, b) => { uploads[k] = b; },
    },
    { id: 's1', user_id: ACCT, datasets: ['customers'], mode: opts.mode ?? 'snapshot', pii_mode: piiMode },
    'abcdef12-0000-4000-8000-000000000000',
  );
  return { res, uploads, ...f };
}
const text = (u: Record<string, Uint8Array>) => Object.values(u).map((b) => new TextDecoder().decode(b)).join('\n');

describe('delivery run', () => {
  it('omit mode: no personal value or column reaches storage', async () => {
    const { res, uploads } = await deliver('omit');
    expect(res.status).toBe('success');
    const all = text(uploads);
    for (const v of PII_VALUES) expect(all).not.toContain(v);
    expect(all).not.toContain('email');
    expect(all).not.toContain('phone');
  });
  it('is scoped to the tenant and skips soft-deleted rows', async () => {
    const { res, log: all } = await deliver('omit');
    const log = all.filter((l) => l.table === 'customers');
    expect(log.length).toBeGreaterThan(0);
    expect(res.stats.datasets.customers.rows).toBe(3);
    expect(log.every((l) => l.eq.some(([c, v]) => c === 'user_id' && v === ACCT))).toBe(true);
    expect(log.every((l) => l.is.some(([c]) => c === 'deleted_at'))).toBe(true);
  });
  it('hashed mode writes keyed hashes, never raw identifiers or names', async () => {
    const { uploads } = await deliver('hashed');
    const all = text(uploads);
    const hash = await (await createPseudonymizer('pseudo', ACCT))('ann@example.com', 'email');
    expect(all).toContain(hash);
    for (const v of PII_VALUES) expect(all).not.toContain(v);
  });
  it('full mode writes personal data only when permitted', async () => {
    const denied = await deliver('full', { permitted: false });
    expect(denied.res.status).toBe('failed');
    expect(Object.keys(denied.uploads).length).toBe(0);
    const ok = await deliver('full');
    expect(text(ok.uploads)).toContain('ann@example.com');
  });
  it('writes a verifiable manifest last, plus _latest.json', async () => {
    const { uploads } = await deliver('omit');
    const keys = Object.keys(uploads);
    expect(keys[keys.length - 1]).toBe('customers/snapshot/_latest.json');
    const mKey = keys.find((k) => k.endsWith('/manifest.json')) as string;
    const m = JSON.parse(new TextDecoder().decode(uploads[mKey]));
    expect((await verifyManifest(m, SECRET)).ok).toBe(true);
    expect(m.row_count).toBe(3);
    const partKey = keys.find((k) => k.endsWith('part-0001.csv')) as string;
    expect(await verifyPart(uploads[partKey], m.parts[0])).toBe(true);
  });
  it('snapshot of an empty table still delivers a header-only part', async () => {
    const { uploads, res } = await deliver('omit', { rows: [] });
    expect(res.status).toBe('success');
    expect(Object.keys(uploads).some((k) => k.endsWith('part-0001.csv'))).toBe(true);
  });
  it('incremental run advances the watermark; a snapshot past its deadline fails cleanly', async () => {
    const inc = await deliver('omit', { mode: 'incremental' });
    expect(inc.res.status).toBe('success');
    expect(inc.upserts[0].watermark).toBe('2026-01-01T00:00:02Z');
    const late = await deliver('omit', { deadline: Date.now() - 1 });
    expect(late.res.status).toBe('partial');
    const snapLate = await runBiDelivery(
      { db: fakeDb({ customers: customers(1) }).db, signingSecret: SECRET, pseudonymSecret: 'p', deadline: Date.now() - 1, piiPermitted: true, put: async () => {} },
      { id: 's', user_id: ACCT, datasets: ['customers'], mode: 'snapshot', pii_mode: 'omit' }, 'r',
    );
    expect(snapLate.status).toBe('partial');
  });
});

describe('SQL view contract matches the catalog', () => {
  const sql = readFileSync(new URL('../../../migrations/20280120000000_bi_export.sql', import.meta.url), 'utf8');
  const body = (name: string) => {
    const m = new RegExp(`CREATE OR REPLACE VIEW public\\.${name} WITH \\(security_barrier = true\\) AS\\n([\\s\\S]*?);\\n`).exec(sql);
    expect(m).not.toBeNull();
    return (m as RegExpExecArray)[1];
  };
  it('has every view, with exactly the catalog columns', () => {
    for (const d of DATASET_KEYS) {
      const plain = body(`bi_${d}`);
      const cols = (/SELECT (.*)\n/.exec(plain) as RegExpExecArray)[1].split(', ').map((x) => x.split('.')[1]);
      expect(cols).toEqual(DATASETS[d].columns.filter((c) => !c.pii).map((c) => c.name));
      expect(plain).toContain('public.bi_tenant_id()');
      expect(plain).not.toContain('bi_pii_allowed');
      if (hasPii(d)) {
        const pii = body(biPiiViewName(d) as string);
        const pcols = (/SELECT (.*)\n/.exec(pii) as RegExpExecArray)[1].split(', ').map((x) => x.split('.')[1]);
        expect(pcols).toEqual(['id', ...DATASETS[d].columns.filter((c) => c.pii).map((c) => c.name)]);
        expect(pii).toContain('public.bi_pii_allowed()');
        expect(pii).toContain('public.bi_tenant_id()');
      }
    }
    expect(BI_VIEW_NAMES.length).toBe(14);
  });
  it('revokes anon, never grants writes, and soft-deleted rows are excluded', () => {
    expect(sql).toContain("REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated");
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO (authenticated|anon)/i);
    expect(body('bi_customers')).toContain('deleted_at IS NULL');
    expect(body('bi_leads')).toContain('deleted_at IS NULL');
  });
});
