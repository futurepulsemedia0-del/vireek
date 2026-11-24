// Guards the vendor review register: seed derivation from code, drift detection, and static safety rules of the migration.
// Run: node --test scripts/compliance/gen-vendor-review-seed.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROVIDERS } from './gen-vendor-exit.mjs'
import {
  ROOT, EXTRA_VENDORS, SUBPROCESSOR_SLUG, SEED_BEGIN, SEED_END,
  buildSeedRows, criticalityFor, findMissing, readSubprocessorNames, renderSeedSql, seededKeys,
} from './gen-vendor-review-seed.mjs'
import { checkMigrationSql } from '../lib/migrationSafety.mjs'

const MIGRATION = 'supabase/migrations/20290307000000_vendor_review_register.sql'
const sql = readFileSync(join(ROOT, MIGRATION), 'utf8')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
const code = stripComments(sql)

test('criticality is a proposal from the vendor-exit tier', () => {
  assert.deepEqual(criticalityFor({ kind: 'supplier', tier: 1 }), { criticality: 'critical', source: 'vendor_exit_tier' })
  assert.deepEqual(criticalityFor({ kind: 'platform', tier: 1 }), { criticality: 'critical', source: 'vendor_exit_tier' })
  assert.deepEqual(criticalityFor({ kind: 'supplier', tier: 2 }), { criticality: 'high', source: 'vendor_exit_tier' })
  assert.deepEqual(criticalityFor({ kind: 'supplier', tier: 3 }), { criticality: 'medium', source: 'vendor_exit_tier' })
  assert.deepEqual(criticalityFor({ kind: 'customer', tier: 3 }), { criticality: 'low', source: 'vendor_exit_tier' })
  assert.deepEqual(criticalityFor({ kind: 'public', tier: 3 }), { criticality: 'low', source: 'vendor_exit_tier' })
  assert.deepEqual(criticalityFor({ kind: 'supplier', tier: null }), { criticality: 'medium', source: 'proposed' })
})

test('every vendor-exit provider and every extra vendor is seeded exactly once, with a valid slug and kind', () => {
  const rows = buildSeedRows()
  assert.equal(rows.length, new Set(rows.map((r) => r.slug)).size, 'duplicate slug')
  for (const p of PROVIDERS) assert.ok(rows.some((r) => r.slug === p.slug), `missing provider ${p.slug}`)
  for (const e of EXTRA_VENDORS) assert.ok(rows.some((r) => r.slug === e.slug), `missing extra ${e.slug}`)
  for (const r of rows) {
    assert.match(r.slug, /^[a-z0-9][a-z0-9-]{0,62}$/)
    assert.ok(['platform', 'supplier', 'customer', 'public'].includes(r.kind), `${r.slug}: kind ${r.kind}`)
    assert.ok(['critical', 'high', 'medium', 'low'].includes(r.criticality))
    assert.ok(r.name.length > 0 && r.name.length <= 200)
  }
})

test('every vendor-exit page has a tier, so no provider silently falls back to a guessed criticality', () => {
  for (const r of buildSeedRows().filter((x) => PROVIDERS.some((p) => p.slug === x.slug))) {
    assert.ok(r.tier, `${r.slug}: no "Criticality tier" in docs/vendor-exit/${r.slug}.md`)
  }
})

test('every published sub-processor maps to a seeded vendor and is flagged is_subprocessor', () => {
  const names = readSubprocessorNames()
  assert.ok(names.length >= 15, 'subprocessors.ts parsing found too few names')
  const rows = buildSeedRows()
  for (const n of names) {
    const slug = SUBPROCESSOR_SLUG[n]
    assert.ok(slug, `sub-processor "${n}" is not mapped in SUBPROCESSOR_SLUG (gen-vendor-review-seed.mjs)`)
    const row = rows.find((r) => r.slug === slug)
    assert.ok(row, `sub-processor "${n}" maps to unknown vendor "${slug}"`)
    assert.equal(row.isSubprocessor, true, `${slug} must be flagged is_subprocessor`)
  }
  for (const n of Object.keys(SUBPROCESSOR_SLUG)) assert.ok(names.includes(n), `SUBPROCESSOR_SLUG has a stale entry: "${n}"`)
})

test('renderSeedSql escapes quotes, is idempotent SQL and is stable', () => {
  const out = renderSeedSql([{ slug: 'x', name: "O'Reilly, Inc.", kind: 'supplier', criticality: 'low', source: 'proposed', isSubprocessor: false }])
  assert.ok(out.startsWith(SEED_BEGIN) && out.endsWith(SEED_END))
  assert.ok(out.includes("'O''Reilly, Inc.'"))
  assert.ok(out.includes('ON CONFLICT (vendor_key) DO NOTHING;'))
  assert.equal(renderSeedSql(buildSeedRows()), renderSeedSql(buildSeedRows()))
})

test('the shipped migration seeds every vendor found in code (drift guard)', () => {
  const { missing } = findMissing()
  assert.deepEqual(missing.map((m) => m.slug), [], 'vendors in code without a seed row: run gen-vendor-review-seed.mjs --emit-missing')
})

test('findMissing reports a new vendor and an orphaned one on a fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'vreview-'))
  mkdirSync(join(root, 'supabase/migrations'), { recursive: true })
  mkdirSync(join(root, 'docs/vendor-exit'), { recursive: true })
  mkdirSync(join(root, 'src/lib'), { recursive: true })
  writeFileSync(join(root, 'src/lib/subprocessors.ts'), "export const X = [{ name: 'Stripe, Inc.' }]\n")
  writeFileSync(
    join(root, 'supabase/migrations/20300101000000_vendor_review_seed2.sql'),
    "INSERT INTO public.vendor_reviews (vendor_key, vendor_name, vendor_kind, criticality, criticality_source, is_subprocessor)\nVALUES\n  ('stripe', 'Stripe', 'supplier', 'critical', 'proposed', true),\n  ('gone-vendor', 'Gone', 'supplier', 'low', 'proposed', false)\nON CONFLICT (vendor_key) DO NOTHING;\n",
  )
  assert.deepEqual([...seededKeys(root)].sort(), ['gone-vendor', 'stripe'])
  const { missing, orphaned } = findMissing(root)
  assert.ok(missing.some((m) => m.slug === 'supabase'))
  assert.ok(!missing.some((m) => m.slug === 'stripe'))
  assert.deepEqual(orphaned, ['gone-vendor'])
})

// ---- static safety rules of the migration (pgTAP covers the behaviour; these catch regressions without a database) ----

test('migration passes the repo release-safety rules and carries a rollback note', () => {
  assert.deepEqual(checkMigrationSql(sql), [])
})

test('both tables have RLS enabled, no delete policy/privilege, and no anon grant', () => {
  for (const t of ['vendor_reviews', 'vendor_review_reminders']) {
    assert.match(code, new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`))
    assert.match(code, new RegExp(`REVOKE ALL ON TABLE public\\.${t} FROM PUBLIC, anon, authenticated`))
  }
  assert.ok(!/FOR\s+DELETE/i.test(code), 'a DELETE policy exists')
  assert.ok(!/GRANT[^;]*\bDELETE\b/i.test(code), 'DELETE is granted')
  assert.ok(!/GRANT[^;]*\bTO\s+anon\b/i.test(code), 'something is granted to anon')
  assert.ok(!/GRANT[^;]*\bTO\s+PUBLIC\b/i.test(code), 'something is granted to PUBLIC')
  assert.match(code, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.vendor_reviews TO authenticated/)
  assert.match(code, /GRANT SELECT ON TABLE public\.vendor_review_reminders TO authenticated/)
})

test('every policy is staff-only and wraps auth.uid() as (select auth.uid())', () => {
  const policies = [...code.matchAll(/CREATE POLICY[\s\S]*?;/g)].map((m) => m[0])
  assert.equal(policies.length, 4)
  for (const p of policies) {
    assert.match(p, /is_vireek_staff\(\(select auth\.uid\(\)\)\)/)
    const bare = p.replace(/\(select auth\.uid\(\)\)/g, '')
    assert.ok(!/auth\.uid\(\)/.test(bare), 'bare auth.uid() in a policy')
  }
})

test('definer functions pin search_path; mutating functions are service_role only', () => {
  for (const m of code.matchAll(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$/g)) {
    if (/SECURITY DEFINER/.test(m[0])) assert.match(m[0], /SET search_path = public/, m[0].slice(0, 80))
  }
  for (const f of [
    'vendor_review_evaluate_reminders(integer)',
    'vendor_review_claim_notifications(integer, integer)',
    'vendor_review_release_notifications(uuid[])',
  ]) {
    assert.ok(code.includes(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon, authenticated`), `${f} not revoked`)
    assert.ok(code.includes(`GRANT EXECUTE ON FUNCTION public.${f} TO service_role`), `${f} not granted to service_role`)
    assert.ok(!code.includes(`GRANT EXECUTE ON FUNCTION public.${f} TO authenticated`), `${f} granted to authenticated`)
  }
})

test('the claim is race-safe and the evaluator is guarded and idempotent', () => {
  assert.match(code, /FOR UPDATE SKIP LOCKED/)
  assert.match(code, /pg_try_advisory_xact_lock\(hashtext\('vendor_review_evaluate_reminders'\)\)/)
  assert.match(code, /ON CONFLICT \(vendor_id\) WHERE resolved_at IS NULL DO NOTHING/)
  assert.match(code, /CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_review_reminders_open[\s\S]*?WHERE resolved_at IS NULL/)
})

test('pg_cron scheduling is optional and cannot fail the migration', () => {
  const block = code.slice(code.indexOf("cron.schedule"), code.indexOf("cron.schedule") + 400)
  assert.match(code, /IF EXISTS \(SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'\)/)
  assert.match(code, /EXCEPTION WHEN OTHERS THEN\s+RAISE NOTICE 'vendor_review/)
  assert.ok(block.includes("'vireek-vendor-review-evaluate'"))
})

test('a review without evidence is impossible and evidence rejects credentials and traversal', () => {
  assert.match(code, /jsonb_array_length\(evidence_links\) >= 1/)
  assert.match(code, /!~ '\^https:\/\/\[\^\/\]\*@'/)
  assert.match(code, /!~ '\\\.\\\.'/)
})

test('the seed never overwrites an existing row and contains no secrets or review claims', () => {
  const block = sql.slice(sql.indexOf(SEED_BEGIN), sql.indexOf(SEED_END))
  assert.match(block, /ON CONFLICT \(vendor_key\) DO NOTHING/)
  assert.ok(!/last_reviewed_on|last_review_outcome|evidence_links/.test(block), 'seed must not claim a review')
  assert.ok(!/(sk_live|sk_test|api[_-]?key|secret|token)/i.test(block))
})
