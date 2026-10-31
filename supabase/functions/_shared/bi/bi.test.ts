// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { TOKEN_RE, extractToken, generateToken, hashToken, isExpired, tokenHint, validateTokenInput } from './access';
import { csvCell, encodeFile, isFormulaLike, toCsv, toNdjson } from './serialize';
import { PAGE_MAX, datasetFromEntitySet, decodeSkipToken, encodeSkipToken, entitySetName, metadataXml, pageBudget, parseFilter, parseODataQuery } from './odata';
import { encodeKey, normalizePrefix, objectUrl, signRequest, validateS3Config, validateS3Credentials } from './s3';
import { exportColumns, makeRunLabel, normalizeSettings, partPath, runExport, validateSftpConfig, type Transport } from './export';
import { DATASETS } from '../data-platform/catalog';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OWNER = '11111111-1111-4111-8111-111111111111';
const AWS = { access_key_id: 'AKIAIOSFODNN7EXAMPLE', secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

describe('access tokens', () => {
  it('generates unique, well-formed tokens and hashes them deterministically', async () => {
    const a = generateToken();
    expect(a).toMatch(TOKEN_RE);
    expect(generateToken()).not.toBe(a);
    expect(await hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken(a)).toBe(await hashToken(a));
    expect(tokenHint(a)).toHaveLength(9);
    expect(tokenHint(a)).not.toContain(a.slice(9));
  });
  it('reads Bearer and Basic (token as password or user), rejects everything else', () => {
    const t = generateToken();
    expect(extractToken(`Bearer ${t}`)).toBe(t);
    expect(extractToken(`Basic ${btoa(`vireek:${t}`)}`)).toBe(t);
    expect(extractToken(`Basic ${btoa(`${t}:`)}`)).toBe(t);
    expect(extractToken(`Basic ${btoa('user:password')}`)).toBeNull();
    expect(extractToken('Bearer nope')).toBeNull();
    expect(extractToken(null)).toBeNull();
    expect(extractToken(`Token ${t}`)).toBeNull();
  });
  it('expiry', () => {
    expect(isExpired(null)).toBe(false);
    expect(isExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(isExpired(new Date(Date.now() + 60_000).toISOString())).toBe(false);
    expect(isExpired('garbage')).toBe(true);
  });
  it('validates input; full personal data is owner-only', () => {
    const ok = validateTokenInput({ name: ' Power BI ', datasets: ['jobs', 'jobs', 'calls'], pii_mode: 'hashed' }, { isOwner: false });
    expect(ok.ok && ok.value).toMatchObject({ name: 'Power BI', datasets: ['jobs', 'calls'], rate_limit_per_minute: 60, expires_in_days: 180 });
    const full = validateTokenInput({ name: 'x', datasets: ['jobs'], pii_mode: 'full' }, { isOwner: false });
    expect(!full.ok && full.errors.pii_mode).toBeTruthy();
    expect(validateTokenInput({ name: 'x', datasets: ['jobs'], pii_mode: 'full' }, { isOwner: true }).ok).toBe(true);
    const bad = validateTokenInput({ name: '', datasets: ['nope'], rate_limit_per_minute: 0, expires_in_days: 9999 }, { isOwner: true });
    expect(!bad.ok && Object.keys(bad.errors).sort()).toEqual(['datasets', 'expires_in_days', 'name', 'rate_limit_per_minute']);
    expect(validateTokenInput({ name: 'x', datasets: ['jobs'], expires_in_days: null }, { isOwner: true }).ok).toBe(true);
  });
});

describe('serialization', () => {
  it('quotes CSV and neutralises spreadsheet formulas without damaging phones or negatives', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(true)).toBe('true');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(isFormulaLike('=SUM(A1)')).toBe(true);
    expect(isFormulaLike('@cmd')).toBe(true);
    expect(isFormulaLike('+cmd|calc')).toBe(true);
    expect(isFormulaLike('-1+1')).toBe(true);
    expect(isFormulaLike('+15551234567')).toBe(false);
    expect(isFormulaLike('-12.5')).toBe(false);
    expect(csvCell('=1+1')).toBe("'=1+1");
  });
  it('writes header + CRLF rows and NDJSON in column order', () => {
    const cols = [{ name: 'id', type: 'uuid' as const }, { name: 'n', type: 'integer' as const }];
    expect(toCsv(cols, [{ id: 'a', n: 1 }, { id: 'b' }])).toBe('id,n\r\na,1\r\nb,\r\n');
    expect(toNdjson(cols, [{ n: 2, id: 'a', extra: 1 }])).toBe('{"id":"a","n":2}\n');
  });
  it('gzips round-trip', async () => {
    const f = await encodeFile('csv', true, [{ name: 'a', type: 'text' }], [{ a: 'x' }]);
    expect(f.extension).toBe('csv.gz');
    const text = await new Response(new Blob([f.bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    expect(text).toBe('a\r\nx\r\n');
  });
});

describe('OData', () => {
  const q = (s: string) => parseODataQuery('jobs', new URLSearchParams(s));
  it('names entity sets and resolves only allowed datasets', () => {
    expect(entitySetName('job_costs')).toBe('JobCosts');
    expect(datasetFromEntitySet('JobCosts', ['job_costs'])).toBe('job_costs');
    expect(datasetFromEntitySet('Jobs', ['calls'])).toBeNull();
  });
  it('metadata lists exactly the allowed sets and every catalog column', () => {
    const xml = metadataXml(['jobs']);
    expect(xml).toContain('EntitySet Name="Jobs"');
    expect(xml).not.toContain('EntitySet Name="Calls"');
    for (const c of DATASETS.jobs.columns) expect(xml).toContain(`Name="${c.name}"`);
  });
  it('parses select / filter / orderby / top / skip / count', () => {
    const r = q('$select=id,invoice_amount&$filter=updated_at ge 2027-01-01T00:00:00Z and updated_at lt 2027-02-01&$orderby=created_at desc&$top=10&$skip=5&$count=true');
    expect(r.ok && r.value).toMatchObject({ select: ['id', 'invoice_amount'], top: 10, skip: 5, count: true, orderBy: { column: 'created_at', asc: false } });
    expect(r.ok && r.value.filters).toEqual([
      { column: 'updated_at', op: 'ge', value: '2027-01-01T00:00:00.000Z' },
      { column: 'updated_at', op: 'lt', value: '2027-02-01T00:00:00.000Z' },
    ]);
  });
  it('rejects everything outside the whitelist', () => {
    for (const bad of ['$expand=x', '$search=a', '$select=password', '$filter=customer_name eq 1', '$filter=updated_at ge 2027-01-01T00:00:00Z or created_at lt 2027-01-01T00:00:00Z', "$filter=contains(address,'x')", '$orderby=address', '$orderby=customer_name', '$top=-1', '$top=abc', '$skip=100001', '$count=maybe', '$format=xml', '$skiptoken=garbage']) {
      expect(q(bad).ok, bad).toBe(false);
    }
    expect(parseFilter('jobs', 'updated_at ge nonsense').ok).toBe(false);
  });
  it('round-trips skiptokens and rejects tampered ones', () => {
    const t = { ts: '2027-01-01T00:00:00.000Z', id: '22222222-2222-4222-8222-222222222222', remaining: 7 };
    expect(decodeSkipToken(encodeSkipToken(t))).toEqual(t);
    expect(decodeSkipToken(encodeSkipToken({ ...t, id: 'x' }))).toBeNull();
    expect(decodeSkipToken('!!!')).toBeNull();
    expect(q(`$skiptoken=${encodeSkipToken(t)}&$orderby=created_at`).ok).toBe(false);
  });
  it('budgets pages', () => {
    expect(pageBudget({ top: null, skiptoken: null })).toEqual({ limit: 2000, remainingAfter: null });
    expect(pageBudget({ top: 10, skiptoken: null })).toEqual({ limit: 10, remainingAfter: 0 });
    expect(pageBudget({ top: 12_000, skiptoken: null })).toEqual({ limit: PAGE_MAX, remainingAfter: 7000 });
    expect(pageBudget({ top: null, skiptoken: { ts: 'x', id: 'y', remaining: 300 } })).toEqual({ limit: 300, remainingAfter: 0 });
  });
});

describe('S3', () => {
  it('matches the AWS Signature V4 published test vectors', async () => {
    const t = new Date('2013-05-24T00:00:00Z');
    const get = await signRequest({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { Range: 'bytes=0-9' }, region: 'us-east-1', creds: AWS, now: t });
    expect(get.authorization).toContain('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    const put = await signRequest({ method: 'PUT', url: new URL('https://examplebucket.s3.amazonaws.com/test%24file.text'), headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, body: new TextEncoder().encode('Welcome to Amazon S3.'), region: 'us-east-1', creds: AWS, now: t });
    expect(put.authorization).toContain('Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });
  it('encodes keys and builds virtual-hosted, path-style and custom-endpoint URLs', () => {
    expect(encodeKey("a b/c$d/e'(f)*")).toBe('a%20b/c%24d/e%27%28f%29%2A');
    expect(objectUrl({ bucket: 'my-bkt', region: 'eu-west-1', endpoint: null }, 'x/y.csv').href).toBe('https://my-bkt.s3.eu-west-1.amazonaws.com/x/y.csv');
    expect(objectUrl({ bucket: 'my.bkt', region: 'eu-west-1', endpoint: null }, 'x').href).toBe('https://s3.eu-west-1.amazonaws.com/my.bkt/x');
    expect(objectUrl({ bucket: 'b', region: 'auto', endpoint: 'https://acc.r2.cloudflarestorage.com' }, 'x').href).toBe('https://acc.r2.cloudflarestorage.com/b/x');
  });
  it('validates config and credentials; blocks private endpoints and path traversal', () => {
    expect(validateS3Config({ bucket: 'my-bucket', region: 'us-east-1', prefix: '/exports/vireek' })).toMatchObject({ ok: true, value: { prefix: 'exports/vireek/', endpoint: null, sse: false } });
    for (const bad of [{ bucket: 'A', region: 'us-east-1' }, { bucket: 'ok-bucket', region: '' }, { bucket: 'ok-bucket', region: 'us-east-1', prefix: '../x' }, { bucket: 'ok-bucket', region: 'us-east-1', endpoint: 'http://s3.example.com' }, { bucket: 'ok-bucket', region: 'us-east-1', endpoint: 'https://169.254.169.254' }, { bucket: 'ok-bucket', region: 'us-east-1', endpoint: 'https://localhost' }]) {
      expect(validateS3Config(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(normalizePrefix('a//b')).toBe('a/b/');
    expect(normalizePrefix('')).toBe('');
    expect(validateS3Credentials(AWS).ok).toBe(true);
    expect(validateS3Credentials({ access_key_id: 'x', secret_access_key: 'short' }).ok).toBe(false);
  });
});

describe('SFTP config', () => {
  const fp = `SHA256:${'A'.repeat(43)}`;
  it('requires a public host and a pinned host key', () => {
    expect(validateSftpConfig({ host: 'sftp.example.com', username: 'vireek', remote_path: '/in/vireek', host_key_sha256: fp })).toMatchObject({ ok: true, value: { port: 22, remote_path: '/in/vireek/' } });
    expect(validateSftpConfig({ host: '10.0.0.5', username: 'u', host_key_sha256: fp }).ok).toBe(false);
    expect(validateSftpConfig({ host: 'sftp.example.com', username: 'u' }).ok).toBe(false);
    expect(validateSftpConfig({ host: 'sftp.example.com', username: 'u', remote_path: '../x', host_key_sha256: fp }).ok).toBe(false);
  });
});

describe('export layout and settings', () => {
  it('builds sortable run labels and Hive-style part paths', () => {
    const run = makeRunLabel(new Date('2027-12-15T03:15:00Z'), () => 0.5);
    expect(run).toBe('20271215T031500Z-7fffff');
    expect(partPath('exp/', 'jobs', run, 3, 'csv.gz')).toBe('exp/jobs/dt=2027-12-15/run=20271215T031500Z-7fffff/part-00003.csv.gz');
  });
  it('normalises settings to safe defaults', () => {
    expect(normalizeSettings({ datasets: ['nope'], pii_mode: 'x', format: 'xml', rows_per_file: 3, mode: 'weird' })).toEqual({ datasets: ['customers', 'leads', 'calls', 'jobs', 'quotes', 'job_costs', 'metrics_daily'], pii_mode: 'hashed', format: 'csv', compress: true, mode: 'incremental', rows_per_file: 20000 });
  });
  it('export columns never include transcripts, recordings or notes', () => {
    const names = (['customers', 'calls', 'jobs'] as const).flatMap((k) => exportColumns(k).map((c) => c.name));
    for (const bad of ['transcript', 'recording_url', 'summary', 'notes', 'signature', '_vireek_deleted']) expect(names).not.toContain(bad);
    expect(names).toContain('account_id');
  });
});

// ---- runner with in-memory fakes ----
function fakeDb(rowsByTable: Record<string, Record<string, unknown>[]>) {
  const upserts: Record<string, unknown>[] = [];
  return {
    upserts,
    from(table: string) {
      const st: { cursorTs?: string; cursorId?: string; limit: number } = { limit: 1000 };
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        or: (f: string) => { const m = /updated_at\.gt\.([^,]+),and\(updated_at\.eq\.[^,]+,id\.gt\.([^)]+)\)/.exec(f); st.cursorTs = m?.[1]; st.cursorId = m?.[2]; return q; },
        order: () => q,
        limit: (n: number) => { st.limit = n; return q; },
        upsert: async (v: Record<string, unknown>) => { upserts.push(v); return { error: null }; },
        then: (res: (v: unknown) => unknown) => {
          if (table === 'bi_export_state') return Promise.resolve({ data: [], error: null }).then(res);
          const all = [...(rowsByTable[table] ?? [])].sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) || String(a.id).localeCompare(String(b.id)));
          const after = all.filter((r) => !st.cursorTs || String(r.updated_at) > st.cursorTs || (String(r.updated_at) === st.cursorTs && String(r.id) > String(st.cursorId)));
          return Promise.resolve({ data: after.slice(0, st.limit), error: null }).then(res);
        },
      };
      return q;
    },
  };
}

describe('runExport', () => {
  const mkJobs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, customer_name: 'Ann', address: '1 Main', job_status: 'completed', invoice_amount: 100 + i, updated_at: `2027-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z` }));
  const target = (settings: Record<string, unknown>) => ({ id: 't1', user_id: OWNER, kind: 's3' as const, name: 'lake', settings });
  const transport = () => { const puts: { path: string; bytes: number; type: string }[] = []; const t: Transport = { async put(path, data, type) { puts.push({ path, bytes: data.length, type }); }, async test() { return []; } }; return { puts, t }; };

  it('splits into part files, writes manifests last and applies privacy', async () => {
    const db = fakeDb({ jobs: mkJobs(2500) });
    const { puts, t } = transport();
    const r = await runExport({ db, transport: t, encryptionKey: KEY, base: 'exp/' }, target({ datasets: ['jobs'], rows_per_file: 5000, compress: false }), { full: false, deadline: Date.now() + 60_000 });
    expect(r.status).toBe('success');
    expect(r.stats).toMatchObject({ files: 1, datasets: { jobs: { rows: 2500, files: 1, done: true } } });
    const paths = puts.map((p) => p.path);
    expect(paths[0]).toMatch(/^exp\/jobs\/dt=\d{4}-\d{2}-\d{2}\/run=[0-9TZ]+-[0-9a-f]{6}\/part-00001\.csv$/);
    expect(paths.slice(-2)).toEqual([expect.stringMatching(/^exp\/_manifests\/\d{8}T\d{6}Z-[0-9a-f]{6}\.json$/), 'exp/_manifests/latest.json']);
    expect(r.manifest_key).toBe(paths[paths.length - 2]);
    expect(db.upserts.at(-1)).toMatchObject({ target_id: 't1', dataset: 'jobs', rows_total: 2500 });
  });
  it('writes several files when rows exceed rows_per_file, with no personal names or addresses in hashed mode', async () => {
    const db = fakeDb({ jobs: mkJobs(2500) });
    const written: Uint8Array[] = [];
    const t: Transport = { async put(_p, d, type) { if (type.startsWith('text/csv')) written.push(d); }, async test() { return []; } };
    const r = await runExport({ db, transport: t, encryptionKey: KEY, base: '' }, target({ datasets: ['jobs'], rows_per_file: 5000, compress: false }), { full: true, deadline: Date.now() + 60_000 });
    expect(r.status).toBe('success');
    const text = new TextDecoder().decode(written[0]);
    expect(text.split('\r\n')[0]).toContain('invoice_amount');
    expect(text).not.toContain('Ann');
    expect(text).not.toContain('1 Main');
  });
  it('is partial (not failed) in incremental mode when the time budget runs out, and fails clearly in snapshot mode', async () => {
    const db = fakeDb({ jobs: mkJobs(10) });
    const { t } = transport();
    const inc = await runExport({ db, transport: t, encryptionKey: KEY, base: '' }, target({ datasets: ['jobs'] }), { full: false, deadline: Date.now() - 1 });
    expect(inc.status).toBe('partial');
    const snap = await runExport({ db, transport: t, encryptionKey: KEY, base: '' }, target({ datasets: ['jobs'], mode: 'snapshot' }), { full: false, deadline: Date.now() - 1 });
    expect(snap.status).toBe('failed');
    expect(snap.error).toMatch(/incremental/);
  });
  it('reports a transport failure without marking anything as written', async () => {
    const db = fakeDb({ jobs: mkJobs(3) });
    const bad: Transport = { async put() { throw Object.assign(new Error('Access denied.'), { status: 403 }); }, async test() { return []; } };
    const r = await runExport({ db, transport: bad, encryptionKey: KEY, base: '' }, target({ datasets: ['jobs'] }), { full: false, deadline: Date.now() + 60_000 });
    expect(r).toMatchObject({ status: 'failed', error: 'Access denied.', manifest_key: null });
    expect(db.upserts).toHaveLength(0);
  });
});
