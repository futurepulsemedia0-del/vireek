#!/usr/bin/env node
// Executes supabase/migrations/20280415000000_missed_call_audit.sql against an in-process Postgres (PGlite)
// and asserts the retention, cap, append-only and cost-guard behaviour of the SQL itself.
//
//   npm i -D @electric-sql/pglite      (dev-only; not a runtime dependency)
//   node scripts/db-tests/audit-migration.pglite.mjs
//
// PGlite is real Postgres compiled to WASM, but it is NOT Supabase: roles/auth are stubbed below. It proves the
// SQL is valid and its logic is right; it does not prove RLS through PostgREST (see the manual checklist).
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = new URL('../../supabase/migrations/20280415000000_missed_call_audit.sql', import.meta.url);
const db = new PGlite();
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`PASS  ${name}`);
  else { failed++; console.log(`FAIL  ${name} ${extra}`); }
};
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const rejects = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return String(e.message ?? e); } };

// --- Supabase stand-ins ---------------------------------------------------------------------
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE FUNCTION public.is_vireek_staff(uid uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT uid = '00000000-0000-0000-0000-0000000000aa'::uuid $$;
`);
await db.exec(readFileSync(MIGRATION, 'utf8'));
ok('migration applies cleanly', true);

// re-apply: idempotent where it claims to be
const rerun = await db.exec(readFileSync(MIGRATION, 'utf8')).then(() => null, (e) => String(e.message ?? e));
ok('migration is re-runnable (CREATE ... IF NOT EXISTS / OR REPLACE)', rerun === null, String(rerun).slice(0, 200));

// Deterministic 64-char lowercase-hex fixtures (the schema CHECKs require hex).
const H = (c) => (c.charCodeAt(0) % 16).toString(16).repeat(64);
const s = await one('SELECT * FROM audit_settings');
ok('kill switch defaults to OFF', s.enabled === false);
ok('retention defaults to 30 days', s.retention_days === 30 && s.cooldown_days === 30);

// --- rate limiter ----------------------------------------------------------------------------
const rl = [];
for (let i = 0; i < 4; i++) rl.push((await one(`SELECT audit_consume_rate('k1', 3, 3600) AS ok`)).ok);
ok('rate limit allows 3 then blocks', JSON.stringify(rl) === '[true,true,true,false]', JSON.stringify(rl));
ok('rate limit is per key', (await one(`SELECT audit_consume_rate('k2', 3, 3600) AS ok`)).ok === true);

// --- cooldown --------------------------------------------------------------------------------
ok('first claim of a number wins', (await one(`SELECT audit_claim_number($1) AS ok`, [H('a')])).ok === true);
ok('second claim within 30 days loses', (await one(`SELECT audit_claim_number($1) AS ok`, [H('a')])).ok === false);
await db.query(`UPDATE audit_cooldown SET expires_at = now() - interval '1 second' WHERE phone_hash = $1`, [H('a')]);
ok('claim succeeds again after expiry', (await one(`SELECT audit_claim_number($1) AS ok`, [H('a')])).ok === true);
await db.query(`SELECT audit_release_number($1)`, [H('a')]);
ok('release hands the number back', (await one(`SELECT audit_claim_number($1) AS ok`, [H('a')])).ok === true);

// --- start cap + spend guard -----------------------------------------------------------------
await db.query(`UPDATE audit_settings SET daily_start_cap = 2, daily_budget_cents = 100, per_audit_cap_cents = 60`);
const starts = [];
for (let i = 0; i < 3; i++) starts.push((await one('SELECT audit_try_start() AS ok')).ok);
ok('daily start cap enforced', JSON.stringify(starts) === '[true,true,false]', JSON.stringify(starts));

const mkAudit = async (tokenChar, phone = '+15125550123') => (await one(
  `INSERT INTO audits (token_hash, phone_e164, phone_hash, email, email_hash, business_name, trade, timezone, expires_at)
   VALUES ($1, $2, $3, 'o@example.com', $4, 'Acme HVAC', 'hvac', 'America/Chicago', now() + interval '30 days') RETURNING id`,
  [H(tokenChar), phone, H(tokenChar === 'b' ? 'c' : 'd'), H('e')])).id;
const a1 = await mkAudit('b');
ok('reserve within per-audit cap', (await one(`SELECT audit_reserve_audit($1, 40) AS r`, [a1])).r === 'ok');
ok('per-audit cap blocks overspend', (await one(`SELECT audit_reserve_audit($1, 40) AS r`, [a1])).r === 'audit_cap');
const a2 = await mkAudit('f', '+15125550124');
ok('daily budget blocks (40 + 40 used, 100 cap, +40 more)', (await one(`SELECT audit_reserve_audit($1, 40) AS r`, [a2])).r === 'ok');
const a3 = await mkAudit('g', '+15125550125');
ok('daily budget exhaustion rolls back the audit reservation', (await one(`SELECT audit_reserve_audit($1, 40) AS r`, [a3])).r === 'daily_budget'
  && (await one(`SELECT cost_cents_reserved c FROM audits WHERE id = $1`, [a3])).c === 0);
await db.query(`UPDATE audit_settings SET daily_budget_cents = 3000, per_audit_cap_cents = 150`);

// --- hard cap of 3 calls, one dial per slot ---------------------------------------------------
const mkCall = (audit, slot, cond, offsetMin = -1) => db.query(
  `INSERT INTO audit_calls (audit_id, slot, condition, scheduled_for, window_end)
   VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, now() + ($4 || ' minutes')::interval + interval '30 minutes')`,
  [audit, slot, cond, String(offsetMin)]);
await mkCall(a1, 1, 'business_hours'); await mkCall(a1, 2, 'lunch'); await mkCall(a1, 3, 'after_hours');
ok('4th call slot is impossible (slot CHECK)', (await rejects(`INSERT INTO audit_calls (audit_id, slot, condition, scheduled_for, window_end) VALUES ($1, 4, 'lunch', now(), now() + interval '1 hour')`, [a1])) !== null);
ok('same slot twice is impossible (UNIQUE)', (await rejects(`INSERT INTO audit_calls (audit_id, slot, condition, scheduled_for, window_end) VALUES ($1, 1, 'lunch', now(), now() + interval '1 hour')`, [a1])) !== null);
ok('same condition twice is impossible (UNIQUE)', (await rejects(`INSERT INTO audit_calls (audit_id, slot, condition, scheduled_for, window_end) VALUES ($1, 2, 'business_hours', now(), now() + interval '1 hour')`, [a1])) !== null);

// --- claim / stuck / complete ----------------------------------------------------------------
await db.query(`UPDATE audits SET status = 'scheduled' WHERE id = $1`, [a1]);
await db.query(`UPDATE audit_calls SET scheduled_for = now() + interval '1 day', window_end = now() + interval '1 day 30 minutes' WHERE audit_id = $1 AND slot = 3`, [a1]);
const claimed = (await one(`SELECT audit_claim_due_calls(5) AS r`)).r;
ok('claims only due calls (2 of 3)', claimed.length === 2, JSON.stringify(claimed));
ok('claim returns the phone and tz for the dialer', claimed[0].phone_e164 === '+15125550123' && claimed[0].timezone === 'America/Chicago');
ok('audit flips to running', (await one(`SELECT status FROM audits WHERE id = $1`, [a1])).status === 'running');
ok('a second sweep claims nothing (no double dial)', (await one(`SELECT audit_claim_due_calls(5) AS r`)).r.length === 0);
await db.query(`UPDATE audit_calls SET claimed_at = now() - interval '10 minutes' WHERE audit_id = $1 AND status = 'claimed'`, [a1]);
ok('stuck claimed calls are parked, not re-dialed', (await one(`SELECT audit_release_stuck() AS n`)).n === 2);
ok('parked calls are failed/unknown', (await one(`SELECT count(*)::int n FROM audit_calls WHERE audit_id = $1 AND status = 'failed' AND answer_kind = 'unknown'`, [a1])).n === 2);
ok('audit not complete while slot 3 pending', ((await one(`SELECT audit_complete_ready() AS ids`)).ids ?? []).length === 0);
await db.query(`UPDATE audit_calls SET status = 'completed' WHERE audit_id = $1 AND slot = 3`, [a1]);
ok('audit completes when nothing is pending', ((await one(`SELECT audit_complete_ready() AS ids`)).ids ?? []).includes(a1));

const missed = await mkAudit('h', '+15125550130');
await db.query(`UPDATE audits SET status = 'scheduled' WHERE id = $1`, [missed]);
await db.query(`INSERT INTO audit_calls (audit_id, slot, condition, scheduled_for, window_end) VALUES ($1, 1, 'lunch', now() - interval '2 hours', now() - interval '1 hour')`, [missed]);
await db.query(`SELECT audit_claim_due_calls(5)`);
ok('a call whose window passed is skipped, never dialed late', (await one(`SELECT status, skip_reason FROM audit_calls WHERE audit_id = $1`, [missed])).skip_reason === 'window_missed');

// --- consent ledger: append-only, redactable only via maintenance -----------------------------
const consent = (audit) => db.query(
  `INSERT INTO audit_consents (audit_id, scope, granted, phone_e164, phone_hash, email, text_version, text_sha256, text_snapshot, captured_at, ip_address, user_agent, basis, record_sha256)
   VALUES ($1, 'ai_test_calls', true, '+15125550123', $2, 'o@example.com', 'v1', $3, 'I agree...', now(), '203.0.113.9', 'UA', 'owner_request', $4)`,
  [audit, H('c'), H('9'), H('8')]);
await consent(a1);
ok('consent UPDATE is refused', (await rejects(`UPDATE audit_consents SET granted = false`)) !== null);
ok('consent DELETE is refused', (await rejects(`DELETE FROM audit_consents`)) !== null);

await db.query(`INSERT INTO audit_events (audit_id, kind) VALUES ($1, 'test')`, [a1]);
ok('one-click delete returns true', (await one(`SELECT audit_delete($1) AS d`, [a1])).d === true);
ok('audit gone', (await one(`SELECT count(*)::int n FROM audits WHERE id = $1`, [a1])).n === 0);
ok('calls cascade-deleted', (await one(`SELECT count(*)::int n FROM audit_calls WHERE audit_id = $1`, [a1])).n === 0);
ok('events deleted', (await one(`SELECT count(*)::int n FROM audit_events WHERE audit_id = $1`, [a1])).n === 0);
const red = await one(`SELECT * FROM audit_consents WHERE audit_id = $1`, [a1]);
ok('consent receipt survives but is REDACTED (no phone/email/IP/UA)', red && red.phone_e164 === null && red.email === null && red.ip_address === null && red.user_agent === null && red.redacted_at !== null);
ok('redacted receipt keeps proof fields (hash, text version, timestamp)', red.text_sha256 === H('9') && red.text_version === 'v1' && red.phone_hash === H('c'));
ok('delete of unknown audit returns false', (await one(`SELECT audit_delete(gen_random_uuid()) AS d`)).d === false);
ok('maintenance flag does not leak after delete', (await rejects(`UPDATE audit_consents SET granted = false`)) !== null);

// --- purge -----------------------------------------------------------------------------------
const old = await mkAudit('i', '+15125550140');
await db.query(`UPDATE audits SET expires_at = now() - interval '1 minute' WHERE id = $1`, [old]);
await consent(old);
await db.query(`UPDATE audit_consents SET received_at = now() - interval '40 days' WHERE audit_id = $1`, [old]).catch(() => {});
const purge1 = (await one(`SELECT audit_purge_expired() AS r`)).r;
ok('purge deletes expired audits', purge1.audits_deleted === 1 && (await one(`SELECT count(*)::int n FROM audits WHERE id = $1`, [old])).n === 0);
await db.query(`SELECT set_config('audit.maintenance','on', false)`);
await db.query(`UPDATE audit_consents SET received_at = now() - interval '40 days' WHERE audit_id = $1`, [old]);
await db.query(`SELECT set_config('audit.maintenance','off', false)`);
const purge2 = (await one(`SELECT audit_purge_expired() AS r`)).r;
ok('redacted receipts are purged after consent_receipt_retention_days', purge2.receipts_deleted >= 1 && (await one(`SELECT count(*)::int n FROM audit_consents WHERE audit_id = $1`, [old])).n === 0);

// --- benchmarks ------------------------------------------------------------------------------
ok('benchmarks are NULL below the 30-audit floor', (await one(`SELECT audit_benchmark_public() AS b`)).b === null);
for (let i = 0; i < 31; i++) {
  await db.query(
    `INSERT INTO audits (token_hash, phone_e164, phone_hash, email, email_hash, business_name, trade, timezone, status, score, expires_at)
     VALUES ($1, '+15125550199', $2, 'x@example.com', $3, 'Bench Co', 'plumbing', 'America/Chicago', 'complete', $4::jsonb, now() + interval '5 days')`,
    [String(i).padStart(64, '0'), String(i).padStart(64, '1'), H('e'), JSON.stringify({ total: 40 + i, confidence: 'ok' })]);
}
const bm = (await one(`SELECT audit_benchmark_public() AS b`)).b;
ok('benchmarks appear at n >= 30 with percentiles', bm && bm.overall.n === 31 && Number(bm.overall.total_p50) === 55);
ok('per-trade benchmark only when that trade has >= 30', bm.by_trade.plumbing?.n === 31 && !bm.by_trade.hvac);
ok('benchmark payload carries no phone/email/business name', !/@|\+1|Bench Co/.test(JSON.stringify(bm)));

// --- privileges + staff gating ---------------------------------------------------------------
// Each probe switches role with its own statement (PGlite refuses multi-statement prepared queries,
// which would make a negative test pass for the wrong reason), and asserts the error is a PERMISSION error.
const asRole = async (role, sql) => {
  await db.exec(`SET ROLE ${role}`);
  try { return await rejects(sql); } finally { await db.exec('RESET ROLE'); }
};
const denied = (e) => e !== null && /permission denied/i.test(e);
ok('anon cannot read audits', denied(await asRole('anon', 'SELECT * FROM audits')));
ok('authenticated cannot read consents', denied(await asRole('authenticated', 'SELECT * FROM audit_consents')));
ok('authenticated cannot read the blocklist or settings', denied(await asRole('authenticated', 'SELECT * FROM audit_blocklist')) && denied(await asRole('authenticated', 'SELECT * FROM audit_settings')));
ok('anon cannot write audits', denied(await asRole('anon', "DELETE FROM audits")));
ok('anon cannot call internal functions', denied(await asRole('anon', 'SELECT audit_purge_expired()')));
ok('authenticated cannot call internal functions', denied(await asRole('authenticated', 'SELECT audit_delete(gen_random_uuid())')));
ok('service_role can call internal functions', (await asRole('service_role', 'SELECT audit_try_start()')) === null);
await db.query(`SELECT set_config('test.uid', '11111111-1111-1111-1111-111111111111', false)`);
ok('non-staff cannot read ops summary', (await rejects(`SELECT audit_ops_summary()`)) !== null);
ok('non-staff cannot flip the kill switch', (await rejects(`SELECT audit_staff_set_enabled(true, null)`)) !== null);
await db.query(`SELECT set_config('test.uid', '00000000-0000-0000-0000-0000000000aa', false)`);
ok('staff can read ops summary', (await one(`SELECT audit_ops_summary() AS s`)).s.settings.enabled === false);
await db.query(`SELECT audit_staff_set_enabled(true, null)`);
ok('staff can enable', (await one(`SELECT enabled FROM audit_settings`)).enabled === true);
await db.query(`SELECT audit_staff_set_enabled(false, 'incident 42')`);
const off = await one(`SELECT enabled, disabled_reason FROM audit_settings`);
ok('staff kill switch disables and records the reason', off.enabled === false && off.disabled_reason === 'incident 42');

console.log(failed ? `\n${failed} FAILED` : '\nAll SQL checks passed');
process.exit(failed ? 1 : 0);
