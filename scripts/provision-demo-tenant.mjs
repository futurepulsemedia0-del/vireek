#!/usr/bin/env node
// scripts/provision-demo-tenant.mjs
//
// Provisions a disposable DEMO tenant for a sales demo / proof of concept:
// synthetic data, a RANDOM password (never stored, shown once) and a hard expiry date.
// Replaces the fixed demo@vireek.com / demodemo123 account from 20260821101216_seed_demo_data.sql (see docs/sales/poc-playbook.md).
//
//   export SUPABASE_URL=https://<ref>.supabase.co
//   export SUPABASE_SERVICE_ROLE_KEY=<service key>          # never commit, never pass on the command line
//   npm run demo:provision -- create --label "Acme HVAC" --prospect "Acme Heating" --ttl-days 14 --confirm-project <ref>
//   npm run demo:provision -- create --label "Acme HVAC" --dry-run          # no network, validates the dataset only
//   npm run demo:provision -- list
//   npm run demo:provision -- extend --id <uuid> --days 7 --confirm-project <ref>
//   npm run demo:provision -- expire --confirm-project <ref>                # normally run hourly by pg_cron
//   npm run demo:provision -- purge --id <uuid> --yes --confirm-project <ref>
//   npm run demo:provision -- purge --expired-older-than-days 7 --yes --confirm-project <ref>
//
// Requires supabase/migrations/20290307000000_demo_tenants.sql. Node >= 22 (runs with --experimental-strip-types
// because the purge reuses the TypeScript table registry that delete-account uses).
import { randomBytes, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { OWNED_TABLE_NAMES } from '../supabase/functions/_shared/compliance/ownedTables.ts';
import {
  MAX_EXTEND_DAYS, SCENARIOS, assertProjectConfirmed, buildDataset, computeExpiry, daysRemaining, generateCredentials,
  parseArgs, parseTtlDays, purgeTenant, validateDataset,
} from './demo/demo-tenant-lib.mjs';

const USAGE = `Usage: provision-demo-tenant.mjs <create|list|extend|expire|purge> [flags]
  create  --label <text> [--prospect <text>] [--ttl-days 1-30 (default 14)] [--scenario ${SCENARIOS.join('|')}] [--seed <text>] [--dry-run] [--json]
  list    [--json]
  extend  --id <uuid> --days 1-${MAX_EXTEND_DAYS}
  expire  (bans every active demo tenant that is past its expiry)
  purge   (--id <uuid> | --expired-older-than-days <n>) --yes
Remote projects need --confirm-project <ref>.`;

const fail = (message) => { console.error(`✗ ${message}`); process.exit(1); };
const BATCH = 200;

function connect(flags) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
  try { assertProjectConfirmed(url, flags['confirm-project']); } catch (e) { fail(e.message); }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function insertAll(db, table, rows, options) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = options ? await db.from(table).upsert(chunk, options) : await db.from(table).insert(chunk);
    if (error) throw new Error(`insert ${table}: ${error.message}`);
  }
}

async function create(flags) {
  if (typeof flags.label !== 'string' || !flags.label.trim()) fail('--label is required');
  const label = flags.label.trim().slice(0, 80);
  const prospect = typeof flags.prospect === 'string' ? flags.prospect.trim().slice(0, 120) : '';
  const scenario = typeof flags.scenario === 'string' ? flags.scenario : 'hvac';
  if (!SCENARIOS.includes(scenario)) fail(`--scenario must be one of: ${SCENARIOS.join(', ')}`);
  let ttlDays;
  try { ttlDays = parseTtlDays(flags['ttl-days']); } catch (e) { fail(e.message); }
  const seed = typeof flags.seed === 'string' && flags.seed ? flags.seed.slice(0, 120) : randomBytes(8).toString('hex');
  const now = new Date();
  const expiresAt = computeExpiry(now, ttlDays);

  if (flags['dry-run']) {
    const ds = buildDataset({ ownerId: randomUUID(), seed, now, scenario, prospect });
    const problems = validateDataset(ds);
    if (problems.length) fail(`Dataset invalid:\n  ${problems.slice(0, 10).join('\n  ')}`);
    console.log(`✓ Dry run OK (no network). scenario=${scenario} seed=${seed} expires=${expiresAt.toISOString()}`);
    console.log(`  rows: ${JSON.stringify(ds.summary)}`);
    return;
  }

  const db = connect(flags);
  const { email, password } = generateCredentials(label);
  const created = await db.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { demo: true }, app_metadata: { demo: true },
  });
  if (created.error || !created.data?.user) fail(`create auth user: ${created.error?.message ?? 'no user returned'}`);
  const ownerId = created.data.user.id;
  let registered = false;
  try {
    const reg = await db.rpc('register_demo_tenant', {
      p_account: ownerId, p_label: label, p_prospect: prospect, p_scenario: scenario, p_seed: seed,
      p_expires_at: expiresAt.toISOString(), p_created_by: process.env.DEMO_CREATED_BY || userInfo().username,
    });
    if (reg.error) throw new Error(`register_demo_tenant: ${reg.error.message}`);
    registered = true;

    const ds = buildDataset({ ownerId, seed, now, scenario, prospect });
    const problems = validateDataset(ds);
    if (problems.length) throw new Error(`dataset invalid: ${problems.slice(0, 5).join('; ')}`);

    const upd = await db.from('profiles').update(ds.profile).eq('id', ownerId);
    if (upd.error) throw new Error(`update profile: ${upd.error.message}`);
    await insertAll(db, 'business_profile', [ds.businessProfile], { onConflict: 'user_id' });
    await insertAll(db, 'team_members', ds.team);
    await insertAll(db, 'customers', ds.customers);
    await insertAll(db, 'calls', ds.calls);
    await insertAll(db, 'leads', ds.leads);
    await insertAll(db, 'jobs', ds.jobs);
  } catch (e) {
    console.error(`✗ Provisioning failed, rolling back: ${e.message}`);
    try {
      if (registered) await purgeTenant(db, ownerId, { tableNames: OWNED_TABLE_NAMES });
      else await db.auth.admin.deleteUser(ownerId);
      console.error('  rollback complete');
    } catch (r) {
      console.error(`  ROLLBACK FAILED for account ${ownerId}: ${r.message}\n  Run: purge --id ${ownerId} --yes`);
    }
    process.exit(1);
  }

  const out = {
    account_id: ownerId, email, password, expires_at: expiresAt.toISOString(), ttl_days: ttlDays, scenario, seed,
    rows: buildDataset({ ownerId, seed, now, scenario, prospect }).summary,
    note: 'The password is shown once and stored nowhere. Share it through a password manager or one-time link, never by plain email or chat.',
  };
  if (flags.json) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`✓ Demo tenant ready  (${label})`);
  console.log(`  account : ${ownerId}`);
  console.log(`  login   : ${email}`);
  console.log(`  password: ${password}`);
  console.log(`  expires : ${out.expires_at}  (${ttlDays} days)`);
  console.log(`  rows    : ${JSON.stringify(out.rows)}`);
  console.log(`  ${out.note}`);
}

async function list(flags) {
  const db = connect(flags);
  const { data, error } = await db.from('demo_tenants').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) fail(error.message);
  if (flags.json) { console.log(JSON.stringify(data, null, 2)); return; }
  if (!data.length) { console.log('No demo tenants.'); return; }
  const now = new Date();
  for (const t of data) {
    const left = t.status === 'active' ? `${daysRemaining(t.expires_at, now)}d left` : t.status;
    console.log(`${t.account_id}  ${t.status.padEnd(7)}  ${left.padEnd(8)}  ext=${t.extensions}  ${t.label}`);
  }
}

async function extend(flags) {
  const db = connect(flags);
  if (typeof flags.id !== 'string') fail('--id is required');
  let days;
  try { days = parseTtlDays(flags.days, { fallback: undefined, max: MAX_EXTEND_DAYS, flag: '--days' }); } catch (e) { fail(e.message); }
  if (days === undefined) fail('--days is required');
  const { data, error } = await db.rpc('extend_demo_tenant', { p_account: flags.id, p_days: days });
  if (error) fail(error.message);
  console.log(`✓ Extended. New expiry ${data.expires_at} (extension ${data.extensions}/2).`);
}

async function expire(flags) {
  const db = connect(flags);
  const { data, error } = await db.rpc('expire_due_demo_tenants');
  if (error) fail(error.message);
  const ids = Array.isArray(data) ? data : [];
  for (const id of ids) {
    const u = await db.auth.admin.getUserById(id);
    const banned = u.data?.user?.banned_until && new Date(u.data.user.banned_until) > new Date();
    console.log(`${banned ? '✓' : '! NOT BANNED'} expired ${id}`);
  }
  console.log(`Expired ${ids.length} demo tenant(s).`);
}

async function purge(flags) {
  if (!flags.yes) fail('purge is destructive: add --yes');
  const db = connect(flags);
  let ids = [];
  if (typeof flags.id === 'string') ids = [flags.id];
  else if (flags['expired-older-than-days'] !== undefined) {
    let n;
    try { n = parseTtlDays(flags['expired-older-than-days'], { max: 3650, flag: '--expired-older-than-days' }); } catch (e) { fail(e.message); }
    const cutoff = new Date(Date.now() - n * 86_400_000).toISOString();
    const { data, error } = await db.from('demo_tenants').select('account_id').eq('status', 'expired').lt('expired_at', cutoff);
    if (error) fail(error.message);
    ids = data.map((r) => r.account_id);
  } else fail('pass --id <uuid> or --expired-older-than-days <n>');

  let failures = 0;
  for (const id of ids) {
    try {
      const r = await purgeTenant(db, id, { tableNames: OWNED_TABLE_NAMES });
      console.log(r.alreadyPurged ? `- ${id} already purged` : `✓ purged ${id}`);
    } catch (e) {
      failures++;
      console.error(`✗ ${id}: ${e.message}`);
    }
  }
  console.log(`Done: ${ids.length - failures} purged, ${failures} failed.`);
  if (failures) process.exit(1);
}

const { command, flags } = (() => { try { return parseArgs(process.argv.slice(2)); } catch (e) { fail(e.message); } })();
const commands = { create, list, extend, expire, purge };
if (!command || command === '--help' || flags.help || !commands[command]) { console.log(USAGE); process.exit(command && !commands[command] && command !== '--help' ? 1 : 0); }
await commands[command](flags);
