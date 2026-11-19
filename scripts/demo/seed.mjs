#!/usr/bin/env node
// scripts/demo/seed.mjs
// Explicit, opt-in demo seeding for DEMO / STAGING projects only. Replaces the old seed migration.
//
//   DEMO_ENV=staging SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
//   DEMO_CONFIRM_PROJECT_REF=<ref> node scripts/demo/seed.mjs            (add --dry-run to only print the plan)
//
// - Refuses to run unless DEMO_ENV is "demo" or "staging" AND the target project ref is confirmed (guard.mjs).
// - Generates a fresh random password on every run and prints it once. It is never stored or written to disk.
// - Idempotent: users/rows are upserted by their fixed ids; re-running rotates the password and re-enables the user.
// - Uses the fixed demo user id so supabase/seed-*-demo.sql keep working.
// [VERIFY] The GoTrue admin endpoints below (POST/PUT /auth/v1/admin/users, `id` accepted on create) were written from the
// documented API and covered by a fake-fetch unit test only; run once against a throw-away project before relying on it.

import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertDemoAllowed, DemoGuardError } from './guard.mjs';
import * as D from './data.mjs';

export const newPassword = () => randomBytes(24).toString('base64url');

/** @param {{ env: Record<string,string|undefined>, dryRun?: boolean, fetchImpl?: typeof fetch, now?: () => Date, log?: (s: string) => void, password?: string }} o */
export async function seedDemo(o) {
  const log = o.log ?? ((s) => console.log(s));
  const g = assertDemoAllowed(o.env, { dryRun: o.dryRun }); // throws BEFORE any network use
  const now = (o.now ?? (() => new Date()))().getTime();
  const iso = (minutesFromNow) => new Date(now + minutesFromNow * 60_000).toISOString();

  const plan = {
    user: D.DEMO_EMAIL, profile: 1, business_profile: 1, integrations: 1, team_members: 1,
    calls: D.calls.length, leads: D.leads.length, jobs: D.jobs.length, ai_insights: 1,
  };
  if (g.dryRun) { log(`[dry-run] DEMO_ENV=${g.demoEnv}; would seed: ${JSON.stringify(plan)}`); return { dryRun: true, plan }; }

  const doFetch = o.fetchImpl ?? fetch;
  const headers = { apikey: g.serviceKey, Authorization: `Bearer ${g.serviceKey}`, 'Content-Type': 'application/json' };
  const call = async (method, path, body, extra = {}) => {
    const res = await doFetch(`${g.url}${path}`, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, json };
  };
  const must = (r, what) => { if (!r.ok) throw new Error(`${what} failed (HTTP ${r.status})`); return r; };
  const upsert = async (table, rows, conflict) => must(await call('POST', `/rest/v1/${table}?on_conflict=${conflict}`, rows, { Prefer: 'resolution=merge-duplicates,return=minimal' }), `upsert ${table}`);

  const password = o.password ?? newPassword();
  const created = await call('POST', '/auth/v1/admin/users', { id: D.DEMO_USER_ID, email: D.DEMO_EMAIL, password, email_confirm: true });
  if (!created.ok) {
    if (created.status !== 422 && created.status !== 409) throw new Error(`create demo user failed (HTTP ${created.status})`);
    // Already exists: rotate its password and lift any ban (e.g. from the neutralize migration). Only the fixed id is ever touched.
    must(await call('PUT', `/auth/v1/admin/users/${D.DEMO_USER_ID}`, { password, email_confirm: true, ban_duration: 'none' }), 'update demo user (is the existing demo@ address a different id?)');
  }

  await upsert('profiles', [D.profile], 'id');
  await upsert('business_profile', [D.businessProfile], 'user_id');

  const hasIntegration = must(await call('GET', `/rest/v1/integrations?select=id&user_id=eq.${D.DEMO_USER_ID}&integration_type=eq.${D.integration.integration_type}&limit=1`), 'read integrations');
  if (!hasIntegration.json?.length) must(await call('POST', '/rest/v1/integrations', [D.integration], { Prefer: 'return=minimal' }), 'insert integration');

  const tm = must(await call('GET', `/rest/v1/team_members?select=id&account_owner_id=eq.${D.DEMO_USER_ID}&member_email=eq.${encodeURIComponent(D.TECHNICIAN_EMAIL)}&limit=1`), 'read team member');
  let technicianId = tm.json?.[0]?.id;
  if (!technicianId) {
    const ins = must(await call('POST', '/rest/v1/team_members', [D.teamMember], { Prefer: 'return=representation' }), 'insert team member');
    technicianId = ins.json?.[0]?.id;
  }
  if (!technicianId) throw new Error('technician id unavailable');

  await upsert('calls', D.calls.map(({ minutes_ago, ...c }) => ({ ...c, user_id: D.DEMO_USER_ID, recording_url: null, call_datetime: iso(-minutes_ago) })), 'id');
  await upsert('leads', D.leads.map((l) => ({ ...l, user_id: D.DEMO_USER_ID })), 'id');
  await upsert('jobs', D.jobs.map(({ minutes_from_now, ...j }) => ({ ...j, user_id: D.DEMO_USER_ID, scheduled_datetime: iso(minutes_from_now), assigned_technician_id: technicianId })), 'id');

  const hasInsight = must(await call('GET', `/rest/v1/ai_insights?select=id&user_id=eq.${D.DEMO_USER_ID}&title=eq.${encodeURIComponent(D.insight.title)}&limit=1`), 'read insight');
  if (!hasInsight.json?.length) must(await call('POST', '/rest/v1/ai_insights', [D.insight], { Prefer: 'return=minimal' }), 'insert insight');

  log(`Demo data seeded into project "${g.ref}" (DEMO_ENV=${g.demoEnv}): ${JSON.stringify(plan)}`);
  log('Sign-in (shown once, not stored anywhere):');
  log(`  email:    ${D.DEMO_EMAIL}`);
  log(`  password: ${password}`);
  return { dryRun: false, plan, email: D.DEMO_EMAIL, password };
}

async function main() {
  try {
    await seedDemo({ env: process.env, dryRun: process.argv.includes('--dry-run') });
  } catch (e) {
    console.error(e instanceof DemoGuardError ? e.message : `Seeding failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    process.exitCode = e instanceof DemoGuardError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
