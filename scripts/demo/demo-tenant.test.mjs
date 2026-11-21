// node --test scripts/demo/demo-tenant.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_EMAIL_DOMAIN, MAX_TTL_DAYS, assertProjectConfirmed, buildDataset, computeExpiry, daysRemaining, generateCredentials,
  generatePassword, isDemoEmail, parseArgs, parseTtlDays, projectRef, purgeTenant, slugify, validateDataset,
} from './demo-tenant-lib.mjs';

const OWNER = '11111111-2222-4333-8444-555555555555';
const NOW = new Date('2026-11-19T10:00:00Z');

test('passwords: length, all character classes, never repeated, no fixed value', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const p = generatePassword();
    assert.equal(p.length, 24);
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[2-9]/); assert.match(p, /[-_.!#%*+]/);
    assert.doesNotMatch(p, /[lIO01]/);
    seen.add(p);
  }
  assert.equal(seen.size, 2000);
  assert.throws(() => generatePassword(8), /length/);
  assert.ok(![...seen].some((p) => /demodemo123/i.test(p)));
});

test('credentials: demo-only email on the reserved .invalid domain, fresh each call', () => {
  const a = generateCredentials('Acme HVAC & Sons!');
  const b = generateCredentials('Acme HVAC & Sons!');
  assert.match(a.email, new RegExp(`^demo-acme-hvac-sons-[0-9a-f]{8}@${DEMO_EMAIL_DOMAIN.replace(/\./g, '\\.')}$`));
  assert.notEqual(a.email, b.email);
  assert.notEqual(a.password, b.password);
  assert.ok(isDemoEmail(a.email));
  assert.ok(!isDemoEmail('owner@company.com'));
  assert.ok(!isDemoEmail('x@demo.vireek.invalid.evil.com'));
  assert.equal(slugify('   '), 'tenant');
  assert.ok(slugify('x'.repeat(80)).length <= 24);
});

test('TTL: default 14, bounds 1..30, rejects junk', () => {
  assert.equal(parseTtlDays(undefined), 14);
  assert.equal(parseTtlDays('30'), 30);
  assert.equal(parseTtlDays(1), 1);
  for (const bad of ['0', '31', '-3', '2.5', 'abc', '', '1e2', NaN, 31]) assert.throws(() => parseTtlDays(bad), /between 1 and 30/, String(bad));
  assert.equal(MAX_TTL_DAYS, 30);
  assert.equal(computeExpiry(NOW, 14).toISOString(), '2026-12-03T10:00:00.000Z');
  assert.equal(daysRemaining(computeExpiry(NOW, 14), NOW), 14);
  assert.equal(daysRemaining(new Date(NOW.getTime() - 1000), NOW), 0);
});

test('project guard: remote projects need the matching ref, local does not', () => {
  assert.deepEqual(projectRef('http://127.0.0.1:54321'), { ref: 'local', local: true });
  assert.equal(projectRef('https://abcdefgh.supabase.co').ref, 'abcdefgh');
  assert.throws(() => assertProjectConfirmed('https://abcdefgh.supabase.co', undefined), /--confirm-project abcdefgh/);
  assert.throws(() => assertProjectConfirmed('https://abcdefgh.supabase.co', 'other'), /--confirm-project/);
  assert.equal(assertProjectConfirmed('https://abcdefgh.supabase.co', 'abcdefgh'), 'abcdefgh');
  assert.equal(assertProjectConfirmed('http://localhost:54321', undefined), 'local');
  assert.throws(() => projectRef('nope'), /valid URL/);
});

test('parseArgs handles --k v, --k=v and boolean flags', () => {
  const { command, flags } = parseArgs(['create', '--label', 'Acme', '--ttl-days=7', '--dry-run', '--json']);
  assert.equal(command, 'create');
  assert.deepEqual(flags, { label: 'Acme', 'ttl-days': '7', 'dry-run': true, json: true });
  assert.throws(() => parseArgs(['create', 'stray']), /Unexpected/);
});

for (const scenario of ['hvac', 'plumbing']) {
  test(`dataset (${scenario}): deterministic, valid, synthetic, 6-month-ish shape`, () => {
    const a = buildDataset({ ownerId: OWNER, seed: 'seed-1', now: NOW, scenario });
    const b = buildDataset({ ownerId: OWNER, seed: 'seed-1', now: NOW, scenario });
    const c = buildDataset({ ownerId: OWNER, seed: 'seed-2', now: NOW, scenario });
    assert.deepEqual(a, b);
    assert.notDeepEqual(a.customers.map((x) => x.name), c.customers.map((x) => x.name));
    assert.deepEqual(validateDataset(a), []);
    assert.equal(a.summary.jobs, 96);
    assert.equal(a.summary.calls, 136);
    assert.match(a.profile.company_name, /\(Demo\)$/);
    assert.ok(a.jobs.every((j) => j.user_id === OWNER));
    assert.ok(a.customers.every((x) => x.tags.includes('demo-synthetic')));
    const past = a.jobs.filter((j) => new Date(j.scheduled_datetime) < NOW);
    const future = a.jobs.filter((j) => new Date(j.scheduled_datetime) >= NOW);
    assert.ok(past.length > 50 && future.length > 0);
    assert.ok(future.every((j) => j.job_status === 'scheduled' && j.invoice_amount === null));
    assert.ok(a.jobs.some((j) => j.job_status === 'completed' && j.invoice_status === 'paid' && j.invoice_amount > 0));
    assert.ok(a.customers.some((x) => x.lifecycle_stage === 'vip'));
    assert.ok(a.calls.every((x, i, arr) => i === 0 || arr[i - 1].call_datetime <= x.call_datetime));
    const blob = JSON.stringify(a);
    assert.doesNotMatch(blob, /@(gmail|yahoo|outlook|hotmail|icloud)\./i);
    assert.doesNotMatch(blob, /demodemo123/);
  });
}

test('dataset: prospect name is used and always marked (Demo); input validation', () => {
  const ds = buildDataset({ ownerId: OWNER, seed: 's', now: NOW, prospect: 'Acme Heating' });
  assert.equal(ds.profile.company_name, 'Acme Heating (Demo)');
  assert.throws(() => buildDataset({ ownerId: 'nope', seed: 's' }), /UUID/);
  assert.throws(() => buildDataset({ ownerId: OWNER, seed: 's', scenario: 'roofing' }), /scenario/);
  assert.throws(() => buildDataset({ ownerId: OWNER }), /seed/);
});

test('validateDataset catches real-looking phones/emails, dangling refs and duplicates', () => {
  const fresh = () => buildDataset({ ownerId: OWNER, seed: 'v', now: NOW });
  let ds = fresh(); ds.customers[0].phone = '+1-415-867-5309';
  assert.ok(validateDataset(ds).some((p) => /non-fictional phone/.test(p)));
  ds = fresh(); ds.customers[0].email = 'someone@gmail.com';
  assert.ok(validateDataset(ds).some((p) => /\.invalid/.test(p)));
  ds = fresh(); ds.jobs[0].customer_id = 'missing';
  assert.ok(validateDataset(ds).some((p) => /unknown customer/.test(p)));
  ds = fresh(); ds.jobs[0].assigned_technician_id = 'missing';
  assert.ok(validateDataset(ds).some((p) => /unknown technician/.test(p)));
  ds = fresh(); ds.customers[1].phone = ds.customers[0].phone;
  assert.ok(validateDataset(ds).some((p) => /duplicate phone/.test(p)));
  ds = fresh(); ds.jobs[1].id = ds.jobs[0].id;
  assert.ok(validateDataset(ds).some((p) => /duplicate ids/.test(p)));
  ds = fresh(); ds.jobs[0].invoice_amount = -5;
  assert.ok(validateDataset(ds).some((p) => /invoice amount/.test(p)));
});

// ---- purge orchestration with a recording fake client --------------------------------------------
function fakeDb({ registered = { account_id: OWNER, status: 'expired' }, email = `demo-x-1234abcd@${DEMO_EMAIL_DOMAIN}`, failTable, blocked, userMissing } = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => (table === 'demo_tenants' ? { data: registered, error: null } : { data: null, error: null }) }) }),
        delete: () => ({ eq: async (col, val) => { calls.push(`delete:${table}:${col}:${val}`); return { error: table === failTable ? { message: 'boom' } : null }; } }),
      };
    },
    rpc: async (name, args) => {
      calls.push(`rpc:${name}`);
      if (name === 'erase_user_rows') return { data: { blocked: blocked ?? {} }, error: null };
      return { data: null, error: null };
    },
    auth: { admin: {
      getUserById: async () => (userMissing ? { data: { user: null }, error: { message: 'User not found' } } : { data: { user: { id: OWNER, email } }, error: null }),
      deleteUser: async () => { calls.push('auth:deleteUser'); return { error: null }; },
    } },
  };
  return db;
}

test('purge: data first, auth user last, then tombstone', async () => {
  const db = fakeDb();
  const r = await purgeTenant(db, OWNER, { tableNames: ['jobs', 'leads', 'calls'], now: () => NOW });
  assert.equal(r.alreadyPurged, false);
  assert.deepEqual(db.calls, [
    `delete:jobs:user_id:${OWNER}`, `delete:leads:user_id:${OWNER}`, `delete:calls:user_id:${OWNER}`,
    'rpc:erase_user_rows', 'rpc:erase_sensitive_read_log_for_account', 'auth:deleteUser', 'rpc:mark_demo_tenant_purged',
  ]);
});

test('purge: refuses unregistered tenants and non-demo emails; never touches data', async () => {
  let db = fakeDb({ registered: null });
  await assert.rejects(purgeTenant(db, OWNER, { tableNames: ['jobs'] }), /Not a registered demo tenant/);
  assert.deepEqual(db.calls, []);
  db = fakeDb({ email: 'owner@realcompany.com' });
  await assert.rejects(purgeTenant(db, OWNER, { tableNames: ['jobs'] }), /not a demo address/);
  assert.deepEqual(db.calls, []);
  await assert.rejects(purgeTenant(fakeDb(), 'not-a-uuid', { tableNames: ['jobs'] }), /UUID/);
  await assert.rejects(purgeTenant(fakeDb(), OWNER, { tableNames: [] }), /tableNames/);
});

test('purge: a failing table or blocked erasure aborts BEFORE the auth user is deleted', async () => {
  let db = fakeDb({ failTable: 'leads' });
  await assert.rejects(purgeTenant(db, OWNER, { tableNames: ['jobs', 'leads', 'calls'] }), /delete leads: boom/);
  assert.ok(!db.calls.includes('auth:deleteUser'));
  assert.ok(!db.calls.some((c) => c.includes('calls:')));
  db = fakeDb({ blocked: { some_table: 'fk' } });
  await assert.rejects(purgeTenant(db, OWNER, { tableNames: ['jobs'] }), /blocked on: some_table/);
  assert.ok(!db.calls.includes('auth:deleteUser'));
});

test('purge: already purged is a no-op; user already gone is tolerated', async () => {
  let db = fakeDb({ registered: { account_id: OWNER, status: 'purged' } });
  assert.deepEqual(await purgeTenant(db, OWNER, { tableNames: ['jobs'] }), { alreadyPurged: true });
  assert.deepEqual(db.calls, []);
  db = fakeDb({ userMissing: true });
  await purgeTenant(db, OWNER, { tableNames: ['jobs'] });
  assert.ok(!db.calls.includes('auth:deleteUser'));
  assert.ok(db.calls.includes('rpc:mark_demo_tenant_purged'));
});
