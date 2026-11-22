#!/usr/bin/env node
// scripts/e2e/seed-test-account.mjs — idempotently create the dedicated account that authenticated Playwright specs log in with.
//
//   E2E_SEED_SUPABASE_URL=https://<ref>.supabase.co \
//   E2E_SEED_SERVICE_ROLE_KEY=...        (service role of the E2E/STAGING project — never production)
//   E2E_SEED_CONFIRM_PROJECT_REF=<ref>   (must equal the subdomain of the URL: guards against seeding the wrong project)
//   E2E_TEST_EMAIL=e2e+ci@yourdomain  E2E_TEST_PASSWORD=...
//   npm run e2e:seed
//
// Creates (or updates the password of) the auth user, marks onboarding complete on its profile (the profile row is created
// by the handle_new_user trigger) and ensures one customer exists so specs that open a customer do not skip.
// Safe to re-run. Secrets are read from the environment and never printed.
import { pathToFileURL } from 'node:url';

export const SEED_CUSTOMER = { name: 'E2E Test Customer', email: 'e2e-customer@example.com' };

/** Validates inputs; returns a list of human-readable problems (empty = OK). */
export function validateSeedEnv(env) {
  const problems = [];
  for (const n of ['E2E_SEED_SUPABASE_URL', 'E2E_SEED_SERVICE_ROLE_KEY', 'E2E_SEED_CONFIRM_PROJECT_REF', 'E2E_TEST_EMAIL', 'E2E_TEST_PASSWORD']) {
    if (!(env[n] ?? '').trim()) problems.push(`${n} is not set`);
  }
  if (problems.length) return problems;
  let host = '';
  try { host = new URL(env.E2E_SEED_SUPABASE_URL).hostname; } catch { problems.push('E2E_SEED_SUPABASE_URL is not a valid URL'); }
  if (host && host.split('.')[0] !== env.E2E_SEED_CONFIRM_PROJECT_REF.trim()) problems.push('E2E_SEED_CONFIRM_PROJECT_REF does not match the project in E2E_SEED_SUPABASE_URL');
  if (!/^e2e/i.test(env.E2E_TEST_EMAIL.trim())) problems.push('E2E_TEST_EMAIL must start with "e2e" so a real user can never be overwritten');
  if (env.E2E_TEST_PASSWORD.length < 12) problems.push('E2E_TEST_PASSWORD must be at least 12 characters');
  return problems;
}

async function findUserIdByEmail(admin, email) {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return null;
}

export async function seedTestAccount(admin, { email, password }) {
  let userId;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: 'E2E Test User' } });
  if (created.error) {
    userId = await findUserIdByEmail(admin, email);
    if (!userId) throw new Error(`createUser failed: ${created.error.message}`);
    const upd = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true });
    if (upd.error) throw new Error(`updateUserById failed: ${upd.error.message}`);
  } else {
    userId = created.data.user.id;
  }

  const prof = await admin.from('profiles').update({ onboarding_completed: true, company_name: 'E2E Test Co', full_name: 'E2E Test User' }).eq('id', userId);
  if (prof.error) throw new Error(`profile update failed: ${prof.error.message}`);

  const existing = await admin.from('customers').select('id').eq('user_id', userId).limit(1);
  if (existing.error) throw new Error(`customer lookup failed: ${existing.error.message}`);
  let customerCreated = false;
  if ((existing.data ?? []).length === 0) {
    const ins = await admin.from('customers').insert({ user_id: userId, ...SEED_CUSTOMER });
    if (ins.error) throw new Error(`customer insert failed: ${ins.error.message}`);
    customerCreated = true;
  }
  return { userId, userCreated: !created.error, customerCreated };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = validateSeedEnv(process.env);
  if (problems.length) { for (const p of problems) console.error(`✘ ${p}`); process.exit(1); }
  const { createClient } = await import('@supabase/supabase-js'); // lazy: unit tests need no dependencies
  const admin = createClient(process.env.E2E_SEED_SUPABASE_URL, process.env.E2E_SEED_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const r = await seedTestAccount(admin, { email: process.env.E2E_TEST_EMAIL.trim(), password: process.env.E2E_TEST_PASSWORD });
    console.log(`✔ E2E account ready (${r.userCreated ? 'created' : 'updated'}); customer ${r.customerCreated ? 'created' : 'already present'}.`);
  } catch (e) { console.error(`✘ ${e.message}`); process.exit(1); }
}
