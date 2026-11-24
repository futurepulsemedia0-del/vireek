// Static checks for supabase/migrations/20290307000000_currency_exposure_views.sql and its pgTAP file.
// These tests READ the SQL text; they do not execute SQL (no Postgres needed). They guard the properties that must
// never regress: additive-only, staff-only access, no FX conversion, USD-only cost, no double counting.
// The behaviour itself is covered by supabase/tests/database/fx_exposure_views.test.sql (pgTAP, needs `supabase test db`).
// Run: node --test scripts/finance/fx-exposure-migration.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkMigrationSql } from '../lib/migrationSafety.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATION = 'supabase/migrations/20290307000000_currency_exposure_views.sql'
const PGTAP = 'supabase/tests/database/fx_exposure_views.test.sql'
const sql = readFileSync(resolve(ROOT, MIGRATION), 'utf8')
const tap = readFileSync(resolve(ROOT, PGTAP), 'utf8')

// Code only: comments and string literals removed, so words in prose cannot satisfy or break a rule.
const code = sql
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ')
  .replace(/'(?:[^']|'')*'/g, "''")

const VIEWS = ['fx_revenue_run_rate_v', 'fx_collected_by_currency_month_v', 'fx_cost_by_currency_month_v', 'fx_exposure_summary_v']

test('file name is a canonical, unique 14-digit version', () => {
  assert.match(MIGRATION.split('/').pop(), /^\d{14}_[a-z0-9_]+\.sql$/)
})

test('passes the repository migration-safety rules (rollback note, no blocking DDL)', () => {
  assert.deepEqual(checkMigrationSql(sql), [])
})

test('is additive: no destructive or table-altering statements in executable code', () => {
  for (const re of [/\bdrop\s+(table|column|schema|type|database|view|function)\b/i, /\btruncate\b/i, /\balter\s+table\b/i, /\bdelete\s+from\b/i, /\bupdate\s+\w/i, /\binsert\s+into\b/i, /\bcreate\s+table\b/i, /\brename\b/i]) {
    assert.ok(!re.test(code), `unexpected statement matching ${re}`)
  }
})

test('every view is security_invoker, revoked from clients, granted only to service_role', () => {
  for (const v of VIEWS) {
    assert.match(code, new RegExp(`create or replace view public\\.${v} with \\(security_invoker = true\\)`, 'i'), `${v} must be security_invoker`)
    assert.match(code, new RegExp(`revoke all on[^;]*public\\.${v}[^;]*from public, anon, authenticated`, 'i'), `${v} must be revoked from clients`)
    assert.match(code, new RegExp(`grant select on[^;]*public\\.${v}[^;]*to service_role`, 'i'), `${v} must be granted to service_role`)
    assert.ok(!new RegExp(`grant[^;]*public\\.${v}[^;]*to[^;]*(anon|authenticated|public)\\b`, 'i').test(code), `${v} must not be granted to clients`)
  }
})

test('the staff RPC is SECURITY DEFINER with a pinned search_path and a staff guard', () => {
  const fn = /create or replace function public\.staff_fx_exposure[\s\S]*?\$\$;/i.exec(sql)?.[0] ?? ''
  assert.ok(fn, 'staff_fx_exposure not found')
  assert.match(fn, /security definer/i)
  assert.match(fn, /set search_path = public/i)
  assert.match(fn, /is_vireek_staff\(auth\.uid\(\)\)/)
  assert.match(fn, /raise exception 'staff only' using errcode = '42501'/i)
  assert.match(fn, /p_months < 1 or p_months > 36/i)
  assert.match(code, /revoke all on function public\.staff_fx_exposure\(integer\) from public, anon/i)
  assert.match(code, /grant execute on function public\.staff_fx_exposure\(integer\) to authenticated/i)
  assert.ok(!/grant execute on function public\.staff_fx_exposure[^;]*(anon|public)\b/i.test(code))
})

test('no FX conversion: no rate table, no multiplication by a rate, no cross-currency totals', () => {
  assert.ok(!/\b(fx_rates?|exchange_rates?|rate_to_usd|usd_equivalent|converted)\b/i.test(code), 'conversion vocabulary found')
  // Every aggregate that touches money is grouped by currency (or by month+currency / month+source).
  for (const v of ['fx_revenue_run_rate_v', 'fx_collected_by_currency_month_v']) {
    const body = new RegExp(`create or replace view public\\.${v}[\\s\\S]*?;`, 'i').exec(code)?.[0] ?? ''
    assert.match(body, /group by 1(, 2)?\s*;/i, `${v} must group by currency`)
  }
  assert.ok(!/sum\([^)]*\)\s*over\s*\(\s*\)/i.test(code), 'a window total over all currencies would add currencies together')
})

test('cost side is USD by construction and provider_invoices is never added to cost_ledger', () => {
  const summary = /create or replace view public\.fx_exposure_summary_v[\s\S]*?;/i.exec(sql)?.[0] ?? ''
  assert.match(summary, /v\.source = 'cost_ledger'/, 'summary must read the ledger source only')
  assert.ok(!/provider_invoices/i.test(summary.replace(/--[^\n]*/g, '')), 'summary must not read provider_invoices')
  assert.match(sql, /'USD'::text AS currency,\s*'cost_ledger'::text AS source/)
  assert.match(sql, /\/ 10000\.0/, 'micro-USD to cents divisor')
})

test('unrecorded cost stays NULL (no coalesce-to-zero on cost columns of the summary)', () => {
  const summaryCode = /create or replace view public\.fx_exposure_summary_v[\s\S]*?;/i.exec(code)?.[0] ?? ''
  assert.ok(summaryCode, 'summary view not found')
  assert.ok(!/coalesce\s*\(\s*(cst|avg|cost)/i.test(summaryCode), 'cost must not be coalesced to 0')
  assert.match(sql, /ELSE 'revenue_only_no_recorded_cost'/)
})

test('invoice events are de-duplicated per invoice and malformed numbers cannot raise cast errors', () => {
  const view = /create or replace view public\.fx_collected_by_currency_month_v[\s\S]*?;/i.exec(sql)?.[0] ?? ''
  assert.match(view, /DISTINCT ON \(coalesce\(e\.payload #>> '\{data,object,id\}', e\.stripe_event_id\)\)/)
  assert.match(view, /~ '\^\[0-9\]\{1,15\}\$'/, 'amount cast must be guarded by a regex')
  assert.match(view, /event_type IN \('invoice\.paid', 'invoice\.payment_succeeded'\)/)
})

test('SQL is syntactically balanced (parentheses, quotes, dollar quotes)', () => {
  const noComments = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
  const noDollar = noComments.replace(/\$\$/g, '')
  assert.equal((noComments.match(/\$\$/g) ?? []).length % 2, 0, 'unbalanced $$')
  const bare = noDollar.replace(/'(?:[^']|'')*'/g, '').replace(/''/g, '')
  assert.equal((bare.match(/'/g) ?? []).length, 0, 'unbalanced single quote')
  assert.equal((bare.match(/\(/g) ?? []).length, (bare.match(/\)/g) ?? []).length, 'unbalanced parentheses')
  assert.ok(noComments.trim().endsWith(';'), 'file must end with a statement terminator')
})

test('pgTAP plan count equals the number of assertions', () => {
  const plan = Number(/select plan\((\d+)\)/.exec(tap)?.[1])
  const asserts = (tap.match(/^select (is|ok|throws_ok|has_view|has_function)\(/gm) ?? []).length
  assert.ok(plan > 0)
  assert.equal(asserts, plan, `pgTAP declares ${plan} tests but contains ${asserts} assertions`)
  assert.match(tap, /select \* from finish\(\);\s*rollback;/)
})

test('pgTAP file covers the properties these static tests cannot (behaviour)', () => {
  for (const needle of ['de-dup', 'count once', 'NULL, not 0', 'provider_invoices NOT added', 'a non-staff user is refused', 'UNSPECIFIED']) {
    assert.ok(tap.includes(needle), `pgTAP file lost its coverage of: ${needle}`)
  }
})
