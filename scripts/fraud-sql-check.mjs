// scripts/fraud-sql-check.mjs
//
// Runs the fraud migrations (20280402…, 20280403…) against an in-process Postgres (PGlite) with minimal stubs
// of the Supabase objects they reference, then exercises every RPC: atomic reservation + rollback, settlement
// refunds, inbound allowance, consent/approval checks, OTP tickets, append-only events, idempotent re-runs.
// It does NOT test RLS with real Supabase roles. Usage:
//   npm i -D @electric-sql/pglite && node scripts/fraud-sql-check.mjs
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();
await db.exec(`
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
 CREATE TABLE profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan text NOT NULL DEFAULT 'starter',
   subscription_status text NOT NULL DEFAULT 'active', stripe_subscription_id text, a2p_campaign_status text NOT NULL DEFAULT 'not_started', minutes_included integer NOT NULL DEFAULT 50, minutes_used_this_month integer NOT NULL DEFAULT 0,
   created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, actor_id uuid, actor_email text,
   action text NOT NULL, target_table text, target_id text, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now());
 CREATE FUNCTION is_vireek_staff(uid uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
 CREATE FUNCTION get_account_owner_id() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
 CREATE TABLE calls (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, usage_billed_seconds integer NOT NULL DEFAULT 0);
 CREATE TABLE consent_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, contact_phone text, consent_type text NOT NULL CHECK (consent_type IN ('call_recording','marketing_sms','marketing_email','data_processing')), granted boolean NOT NULL, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
 INSERT INTO profiles (stripe_subscription_id) VALUES ('sub_1');
 INSERT INTO profiles DEFAULT VALUES;
`);
const sql = readFileSync(new URL("../supabase/migrations/20280402000000_fraud_abuse_prevention.sql", import.meta.url), "utf8");
const sql2 = readFileSync(new URL("../supabase/migrations/20280403000000_fraud_phase2.sql", import.meta.url), "utf8");
await db.exec(sql);
await db.exec(sql);
await db.exec(sql2);
await db.exec(sql2); // idempotent re-runs
const q = async (s, p) => (await db.query(s, p)).rows;

// backfill + trigger
const states = await q(`SELECT p.stripe_subscription_id IS NOT NULL AS paid, o.outbound_unlocked FROM profiles p JOIN fraud_org_state o ON o.user_id = p.id ORDER BY paid DESC`);
assert.deepEqual(states.map(r => [r.paid, r.outbound_unlocked]), [[true, true], [false, false]]);
const [{ id: freeId }] = await q(`SELECT id FROM profiles WHERE stripe_subscription_id IS NULL`);
const [{ id: paidId }] = await q(`SELECT id FROM profiles WHERE stripe_subscription_id IS NOT NULL`);
const [{ id: newId }] = await q(`INSERT INTO profiles DEFAULT VALUES RETURNING id`);
assert.equal((await q(`SELECT 1 FROM fraud_org_state WHERE user_id=$1`, [newId])).length, 1, "trigger creates state row");

// guard context: plan derivation
const ctxFree = (await q(`SELECT fraud_guard_context($1) AS c`, [freeId]))[0].c;
const ctxPaid = (await q(`SELECT fraud_guard_context($1) AS c`, [paidId]))[0].c;
assert.equal(ctxFree.plan, "free"); assert.equal(ctxPaid.plan, "starter");
assert.equal((await q(`SELECT fraud_guard_context(gen_random_uuid()) AS c`))[0].c, null);

// reserve: success, daily cap, lifetime cap with rollback
const R = (u, d, calls, sms, cost, cc, cs, cd, cl) => q(`SELECT fraud_reserve($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r`, [u, d, calls, sms, cost, cc, cs, cd, cl]).then(x => x[0].r);
assert.equal(await R(freeId, "2026-11-03", 1, 0, 60, 10, 20, 200, 500), null);
assert.equal(await R(freeId, "2026-11-03", 1, 0, 60, 10, 20, 200, 500), null);
assert.equal(await R(freeId, "2026-11-03", 1, 0, 60, 10, 20, 200, 500), null);
assert.equal(await R(freeId, "2026-11-03", 1, 0, 60, 10, 20, 200, 500), "DAILY_COST");
let day = (await q(`SELECT calls, cost_cents FROM fraud_usage WHERE user_id=$1 AND bucket='day:2026-11-03'`, [freeId]))[0];
assert.deepEqual([day.calls, day.cost_cents], [3, 180], "denied request leaves no trace");
// lifetime: spend across days until the lifetime cap, then verify rollback of the daily row
let d = 4;
while (true) { const r = await R(freeId, `2026-11-${String(d).padStart(2, "0")}`, 1, 0, 60, 10, 20, 200, 500); if (r) { assert.equal(r, "LIFETIME_COST"); break; } d++; if (d > 28) throw new Error("never capped"); }
const life = (await q(`SELECT cost_cents FROM fraud_usage WHERE user_id=$1 AND bucket='life'`, [freeId]))[0];
assert.ok(life.cost_cents <= 500, `lifetime ${life.cost_cents} <= 500`);
const lastDay = (await q(`SELECT calls FROM fraud_usage WHERE user_id=$1 AND bucket=$2`, [freeId, `day:2026-11-${String(d).padStart(2, "0")}`]))[0];
assert.equal(lastDay, undefined, "daily increment rolled back when lifetime cap denied");
// concurrency-style: sequential hammer never exceeds cap
let okCount = 0; for (let i = 0; i < 100; i++) if (!(await R(paidId, "2026-11-03", 1, 0, 100, 1000, 1000, 1500, null))) okCount++;
assert.equal(okCount, 15);
await assert.rejects(R(paidId, "2026-11-03", -1, 0, 0, 1, 1, 1, null), /negative/);

// status change: reversible, audited, event logged
await q(`SELECT fraud_set_org_status($1,'suspended','test',NULL,NULL,'test')`, [paidId]);
assert.equal((await q(`SELECT fraud_guard_context($1) AS c`, [paidId]))[0].c.status, "suspended");
await q(`SELECT fraud_set_org_status($1,'active','restore',NULL,NULL,'test')`, [paidId]);
assert.equal((await q(`SELECT fraud_guard_context($1) AS c`, [paidId]))[0].c.status, "active");
assert.equal((await q(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'fraud.status.%'`))[0].n, 2);
// expiry of timed throttle
await q(`SELECT fraud_set_org_status($1,'throttled','t', now() - interval '1 minute', NULL,'test')`, [paidId]);
assert.equal((await q(`SELECT fraud_guard_context($1) AS c`, [paidId]))[0].c.status, "active", "expired throttle reads as active");

// append-only
await assert.rejects(db.exec(`UPDATE fraud_events SET code='x'`), /append-only/);
await assert.rejects(db.exec(`DELETE FROM fraud_events`), /append-only/);

// OTP + signup counters
const a = await q(`SELECT * FROM fraud_otp_consume('phone','h1',3600)`); assert.equal(a[0].attempts, 1);
const b = await q(`SELECT * FROM fraud_otp_consume('phone','h1',3600)`); assert.equal(b[0].attempts, 2); assert.ok(b[0].seconds_since_last < 5);
assert.equal((await q(`SELECT fraud_signup_consume('ip','i1',3600) AS n`))[0].n, 1);
assert.equal((await q(`SELECT fraud_signup_consume('ip','i1',3600) AS n`))[0].n, 2);

// one open case per account
await q(`INSERT INTO fraud_cases (user_id,title) VALUES ($1,'a')`, [paidId]);
await assert.rejects(q(`INSERT INTO fraud_cases (user_id,title) VALUES ($1,'b')`, [paidId]), /uq_fraud_cases_one_open|duplicate/);

// ================= PHASE 2 =================
// --- settlement: reserve 60c (5 min @12c) for a call, real call lasted 61s => actual 24c => refund 36c in day+life
await q(`SELECT fraud_reserve($1,'2026-11-10',1,0,60,10,20,500,500)`, [newId]);
const ref = (await q(`SELECT gen_random_uuid() AS r`))[0].r;
await q(`INSERT INTO fraud_call_events (user_id, at, country, international, prefix, cost_cents, reserved_cents, rate_cents_per_min, event_ref) VALUES ($1,'2026-11-10 12:00+00','US',false,'1415555',60,60,12,$2)`, [newId, ref]);
await q(`SELECT fraud_call_attach($1,'CA123')`, [ref]);
await q(`SELECT fraud_call_attach($1,'OTHER')`, [ref]); // second attach must not overwrite
assert.equal((await q(`SELECT external_id FROM fraud_call_events WHERE event_ref=$1`, [ref]))[0].external_id, "CA123");
await q(`SELECT fraud_call_finish('CA123', 61)`);
let u = await q(`SELECT bucket, cost_cents FROM fraud_usage WHERE user_id=$1 ORDER BY bucket`, [newId]);
assert.deepEqual(u.map(r => [r.bucket, r.cost_cents]), [["day:2026-11-10", 24], ["life", 24]]);
await q(`SELECT fraud_call_finish('CA123', 5)`); // idempotent: duration already recorded
u = await q(`SELECT cost_cents FROM fraud_usage WHERE user_id=$1 AND bucket='life'`, [newId]); assert.equal(u[0].cost_cents, 24);
assert.equal((await q(`SELECT cost_cents, duration_seconds FROM fraud_call_events WHERE event_ref=$1`, [ref]))[0].cost_cents, 24);
// never refunds below zero and ignores unknown ids
await q(`SELECT fraud_call_finish('nope', 10)`);
// overrun: reserved 12c (1 min) but call lasted 130s => logged, no refund, no negative
const ref2 = (await q(`SELECT gen_random_uuid() AS r`))[0].r;
await q(`INSERT INTO fraud_call_events (user_id, country, international, prefix, cost_cents, reserved_cents, rate_cents_per_min, event_ref, external_id) VALUES ($1,'US',false,'1415555',12,12,12,$2,'CA999')`, [newId, ref2]);
await q(`SELECT fraud_call_finish('CA999', 130)`);
assert.equal((await q(`SELECT count(*)::int AS n FROM fraud_events WHERE code='DURATION_OVERRUN'`))[0].n, 1);
assert.equal((await q(`SELECT cost_cents FROM fraud_call_events WHERE external_id='CA999'`))[0].cost_cents, 12);

// --- inbound free-minute allowance
await q(`UPDATE profiles SET minutes_used_this_month = 49 WHERE id=$1`, [freeId]);
assert.equal((await q(`SELECT fraud_inbound_allowance($1) AS a`, [freeId]))[0].a.allowed, true);
await q(`UPDATE profiles SET minutes_used_this_month = 50 WHERE id=$1`, [freeId]);
const ex = (await q(`SELECT fraud_inbound_allowance($1) AS a`, [freeId]))[0].a;
assert.deepEqual([ex.allowed, ex.free, ex.used, ex.included], [false, true, 50, 50]);
await q(`UPDATE profiles SET minutes_used_this_month = 9999 WHERE id=$1`, [paidId]);
assert.equal((await q(`SELECT fraud_inbound_allowance($1) AS a`, [paidId]))[0].a.allowed, true, "paid never blocked (overage billed)");
assert.equal((await q(`SELECT fraud_inbound_allowance(gen_random_uuid()) AS a`))[0].a.allowed, true, "unknown profile fails open");
// lifetime mode ignores the monthly reset
await q(`UPDATE profiles SET minutes_used_this_month = 0 WHERE id=$1`, [freeId]);
await q(`UPDATE fraud_settings SET free_minutes_mode='lifetime'`);
for (let i = 0; i < 5; i++) await q(`INSERT INTO calls (user_id, usage_billed_seconds) VALUES ($1, 600)`, [freeId]); // 5 x 10 min
const lt = (await q(`SELECT fraud_inbound_allowance($1) AS a`, [freeId]))[0].a;
assert.deepEqual([lt.allowed, lt.used, lt.mode], [false, 50, "lifetime"]);
await q(`UPDATE fraud_settings SET free_minutes_mode='monthly'`);
assert.equal((await q(`SELECT fraud_inbound_allowance($1) AS a`, [freeId]))[0].a.allowed, true, "monthly mode: reset counter allows again");

// --- marketing checks: consent ledger (latest row wins, expiry, phone normalisation) + campaign approval
const mk = async (phone, ch = "voice", camp = "quote_followup") => (await q(`SELECT fraud_marketing_checks($1,$2,$3,$4) AS m`, [paidId, phone, ch, camp]))[0].m;
assert.equal((await mk("+14155552671")).has_consent, false);
await db.exec(`INSERT INTO consent_records (user_id, contact_phone, consent_type, granted, created_at) VALUES ('${paidId}','(415) 555-2671','marketing_voice',true, now() - interval '2 days')`);
assert.equal((await mk("+14155552671")).has_consent, true, "formatting differences still match");
assert.equal((await mk("+14155552671", "sms")).has_consent, false, "voice consent does not cover SMS");
await db.exec(`INSERT INTO consent_records (user_id, contact_phone, consent_type, granted, created_at) VALUES ('${paidId}','4155552671','marketing_voice',false, now() - interval '1 day')`);
assert.equal((await mk("+14155552671")).has_consent, false, "a later revoke wins");
await db.exec(`INSERT INTO consent_records (user_id, contact_phone, consent_type, granted, expires_at) VALUES ('${paidId}','4155550000','marketing_sms',true, now() - interval '1 hour')`);
assert.equal((await mk("+14155550000", "sms")).has_consent, false, "expired grant does not count");
assert.equal((await mk("")).has_consent, false);
// another tenant's consent never leaks
await db.exec(`INSERT INTO consent_records (user_id, contact_phone, consent_type, granted) VALUES ('${freeId}','4155558888','marketing_voice',true)`);
assert.equal((await mk("+14155558888")).has_consent, false);
// approval: brand-new account needs it; old account does not
let m1 = (await q(`SELECT fraud_marketing_checks($1,'+14155552671','voice','quote_followup') AS m`, [newId]))[0].m;
assert.deepEqual([m1.approval_required, m1.campaign_status, m1.consent_mode], [true, "none", "log"]);
await q(`SELECT fraud_request_campaign_approval($1,'quote_followup')`, [newId]);
await q(`SELECT fraud_request_campaign_approval($1,'quote_followup')`, [newId]); // idempotent
m1 = (await q(`SELECT fraud_marketing_checks($1,'+14155552671','voice','quote_followup') AS m`, [newId]))[0].m;
assert.equal(m1.campaign_status, "pending");
await q(`UPDATE fraud_campaign_approvals SET status='approved' WHERE user_id=$1`, [newId]);
assert.equal((await q(`SELECT fraud_marketing_checks($1,'+14155552671','voice','quote_followup') AS m`, [newId]))[0].m.campaign_status, "approved");
await q(`UPDATE profiles SET created_at = now() - interval '30 days' WHERE id=$1`, [newId]);
assert.equal((await q(`SELECT fraud_marketing_checks($1,'+14155552671','voice','other') AS m`, [newId]))[0].m.approval_required, false);
await assert.rejects(q(`INSERT INTO fraud_campaign_approvals (user_id, campaign, status) VALUES ($1,'x','bogus')`, [newId]), /check/i);

// --- OTP tickets: single use + expiry + ttl clamp
await q(`SELECT fraud_otp_ticket_issue('h1','i1',120)`);
assert.equal((await q(`SELECT fraud_otp_ticket_consume('h1') AS ok`))[0].ok, true);
assert.equal((await q(`SELECT fraud_otp_ticket_consume('h1') AS ok`))[0].ok, false, "ticket is single use");
assert.equal((await q(`SELECT fraud_otp_ticket_consume('never-issued') AS ok`))[0].ok, false);
await q(`SELECT fraud_otp_ticket_issue('h2','i1',120)`);
await q(`UPDATE fraud_otp_tickets SET expires_at = now() - interval '1 second' WHERE phone_hash='h2'`);
assert.equal((await q(`SELECT fraud_otp_ticket_consume('h2') AS ok`))[0].ok, false, "expired ticket rejected");
await q(`SELECT fraud_otp_ticket_issue('h3','i1',999999)`);
const ttl = (await q(`SELECT EXTRACT(EPOCH FROM (expires_at - now())) AS s FROM fraud_otp_tickets WHERE phone_hash='h3'`))[0].s;
assert.ok(ttl <= 301, "ttl clamped to 5 minutes");

// --- consent_records now accepts marketing_voice and still rejects garbage
await assert.rejects(db.exec(`INSERT INTO consent_records (user_id, consent_type, granted) VALUES ('${paidId}','bogus',true)`), /check/i);
console.log("SQL CHECKS PASSED");
