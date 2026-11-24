#!/usr/bin/env node
// Runs supabase/migrations/20290311000000_billing_region_gate.sql against in-process Postgres (PGlite) with Supabase stubs.
//   npm i -D @electric-sql/pglite      (dev-only)      node scripts/db-tests/billing-region-gate.pglite.mjs
// Proves the SQL logic (gate, grandfathering, attestation constraint, idempotent re-run). It does NOT prove RLS via PostgREST.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
let failed = 0
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${c ? '' : x}`); if (!c) failed++ }
const rejects = async (sql) => { try { await db.query(sql); return null } catch (e) { return String(e.message ?? e) } }
const as = (uid) => db.exec(`SELECT set_config('test.uid', '${uid ?? ''}', false)`)
const STAFF = '00000000-0000-0000-0000-0000000000aa'
const OWNER = '00000000-0000-0000-0000-0000000000bb'
const SHA = 'a'.repeat(64)

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE FUNCTION public.is_vireek_staff(uid uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT uid = '${STAFF}'::uuid $$;
  CREATE FUNCTION public.get_account_owner_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${OWNER}'::uuid $$;
  CREATE FUNCTION public.can_manage_regional_packs() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
  CREATE FUNCTION public.log_audit_event(uuid, text, text, text, jsonb) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
  CREATE TABLE public.regional_pack_enablements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, pack_code text NOT NULL, enabled boolean NOT NULL DEFAULT true, updated_by uuid, updated_at timestamptz DEFAULT now(), UNIQUE (user_id, pack_code));
`)
const mig = readFileSync(new URL('../../supabase/migrations/20290311000000_billing_region_gate.sql', import.meta.url), 'utf8')
await db.exec(mig)
await db.exec(mig) // idempotent
ok('migration applies twice without error', true)

await as(OWNER)
ok('US enables (default region)', (await rejects(`SELECT set_regional_pack('US', true)`)) === null)
const e1 = await rejects(`SELECT set_regional_pack('GB', true)`)
ok('GB blocked while uncleared (55000)', e1 !== null && /not cleared/.test(e1), e1 ?? '')
ok('unknown pack still rejected', /Unknown/.test((await rejects(`SELECT set_regional_pack('XX', true)`)) ?? ''))
ok('disabling is always allowed', (await rejects(`SELECT set_regional_pack('GB', false)`)) === null)

ok('non-staff cannot clear', /Staff access/.test((await rejects(`SELECT staff_set_billing_region_clearance('GB', true, '${SHA}', 'A', current_date, 'L', current_date)`)) ?? ''))
await as(STAFF)
ok('cannot clear without hash', /sha256/.test((await rejects(`SELECT staff_set_billing_region_clearance('GB', true)`)) ?? ''))
ok('cannot clear without counsel', /required/.test((await rejects(`SELECT staff_set_billing_region_clearance('GB', true, '${SHA}', 'A', current_date)`)) ?? ''))
ok('cannot clear with future date', /future/.test((await rejects(`SELECT staff_set_billing_region_clearance('GB', true, '${SHA}', 'A', current_date + 1, 'L', current_date)`)) ?? ''))
ok('US cannot be gated', /not gated/.test((await rejects(`SELECT staff_set_billing_region_clearance('US', true, '${SHA}', 'A', current_date, 'L', current_date)`)) ?? ''))
ok('table CHECK refuses cleared=true without attestation', (await rejects(`UPDATE public.billing_region_clearances SET cleared = true WHERE pack_code = 'CA'`)) !== null)
ok('staff clears GB', (await rejects(`SELECT staff_set_billing_region_clearance('GB', true, '${SHA}', 'Ada', current_date, 'Law LLP', current_date)`)) === null)

await as(OWNER)
ok('GB enables after clearance', (await rejects(`SELECT set_regional_pack('GB', true)`)) === null)
ok('EU still blocked', (await rejects(`SELECT set_regional_pack('EU', true)`)) !== null)
await as(STAFF)
await db.exec(`SELECT staff_set_billing_region_clearance('GB', false)`)
await as(OWNER)
ok('revoked: new enable blocked after disable', (await rejects(`SELECT set_regional_pack('GB', false)`)) === null && (await rejects(`SELECT set_regional_pack('GB', true)`)) !== null)
await db.exec(`INSERT INTO public.regional_pack_enablements (user_id, pack_code, enabled) VALUES ('${OWNER}', 'AU', true)`)
ok('already-enabled pack is grandfathered (no-op re-enable)', (await rejects(`SELECT set_regional_pack('AU', true)`)) === null)
const c = (await db.query(`SELECT * FROM get_billing_region_clearances()`)).rows
ok('get_billing_region_clearances reports US true, others false', c.find((r) => r.pack_code === 'US').cleared === true && c.filter((r) => r.pack_code !== 'US').every((r) => r.cleared === false))

console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
process.exit(failed ? 1 : 0)
