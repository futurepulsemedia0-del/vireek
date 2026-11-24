import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DOC_BEGIN, DOC_END, evaluatePacks, extractBlock, injectBlock, isIsoDay, packHash, renderTables, rowMissing, validateMatrix,
} from './paymentsEinvoicing.mjs'
import { PROBES } from './marketEntry.mjs'
import { parseArgs, run } from '../global/payments-einvoicing.mjs'

const TODAY = '2026-11-22'
const packs = { US: { name: 'US', countries: ['US'] }, XX: { name: 'Testland', countries: ['AA', 'BB'] } }
const goodRow = (country, pack = 'XX', over = {}) => ({
  country, pack,
  localMethods: ['card', 'sepa_debit'],
  taxInvoiceRequirements: 'Supplier VAT id, date, rate and amount per rate.',
  eInvoicing: { b2b: 'none', b2g: 'none', system: null, vireekSupport: 'not_required', workaround: null, note: '' },
  verification: { status: 'verified', source: 'https://example.gov/rules', verifiedOn: '2026-10-01', reviewer: 'Ada', counselReviewer: 'Law LLP', counselReviewedOn: '2026-10-05' },
  ...over,
})
const mk = (rows) => ({ schemaVersion: 1, verificationMaxAgeDays: 365, rows })
const full = () => mk([goodRow('US', 'US'), goodRow('AA'), goodRow('BB')])
const missing = (row) => rowMissing(row, { today: TODAY, maxAgeDays: 365 })

test('a fully verified row is complete', () => assert.deepEqual(missing(goodRow('AA')), []))

test('each required field blocks completeness', () => {
  const cases = [
    [{ localMethods: [] }, /localMethods/],
    [{ taxInvoiceRequirements: 'short' }, /taxInvoiceRequirements/],
    [{ eInvoicing: { ...goodRow('AA').eInvoicing, b2b: 'unknown' } }, /b2b/],
    [{ eInvoicing: { ...goodRow('AA').eInvoicing, b2g: 'unknown' } }, /b2g/],
    [{ eInvoicing: { ...goodRow('AA').eInvoicing, vireekSupport: 'unassessed' } }, /vireekSupport/],
    [{ verification: { ...goodRow('AA').verification, status: 'unverified' } }, /verification.status/],
    [{ verification: { ...goodRow('AA').verification, source: 'http://insecure.example' } }, /source/],
    [{ verification: { ...goodRow('AA').verification, reviewer: ' ' } }, /reviewer/],
    [{ verification: { ...goodRow('AA').verification, counselReviewer: null } }, /counselReviewer/],
    [{ verification: { ...goodRow('AA').verification, counselReviewedOn: null } }, /counselReviewedOn/],
  ]
  for (const [over, re] of cases) assert.match(missing(goodRow('AA', 'XX', over)).join(), re, JSON.stringify(over))
})

test('dates: future, impossible and stale are rejected', () => {
  const v = goodRow('AA').verification
  assert.match(missing(goodRow('AA', 'XX', { verification: { ...v, verifiedOn: '2026-12-01' } })).join(), /future/)
  assert.match(missing(goodRow('AA', 'XX', { verification: { ...v, verifiedOn: '2026-02-30' } })).join(), /verifiedOn/)
  assert.match(missing(goodRow('AA', 'XX', { verification: { ...v, counselReviewedOn: '2025-01-01' } })).join(), /older than 365/)
  assert.equal(isIsoDay('2026-02-28'), true)
})

test('a mandate needs a system and implemented support or a written workaround', () => {
  const e = { b2b: 'mandatory', b2g: 'none', system: null, vireekSupport: 'none', workaround: null, note: '' }
  const m = missing(goodRow('AA', 'XX', { eInvoicing: e })).join()
  assert.match(m, /system/); assert.match(m, /workaround/)
  assert.deepEqual(missing(goodRow('AA', 'XX', { eInvoicing: { ...e, system: 'SDI', workaround: 'Tenants use a certified intermediary' } })), [])
  assert.deepEqual(missing(goodRow('AA', 'XX', { eInvoicing: { ...e, system: 'SDI', vireekSupport: 'implemented' } })), [])
  assert.match(missing(goodRow('AA', 'XX', { eInvoicing: { ...e, b2b: 'phased', system: 'KSeF' } })).join(), /workaround/)
})

test('validateMatrix catches duplicates, unknown countries, wrong pack, missing rows and bad enums', () => {
  assert.deepEqual(validateMatrix(full(), { packs }), [])
  assert.match(validateMatrix(mk([goodRow('US', 'US'), goodRow('AA')]), { packs }).join(), /BB: missing row/)
  assert.match(validateMatrix(mk([...full().rows, goodRow('AA')]), { packs }).join(), /duplicate/)
  assert.match(validateMatrix(mk([...full().rows, goodRow('ZZ')]), { packs }).join(), /not a country/)
  assert.match(validateMatrix(mk([goodRow('US', 'US'), goodRow('AA', 'US'), goodRow('BB')]), { packs }).join(), /pack must be XX/)
  assert.match(validateMatrix(mk([goodRow('US', 'US'), goodRow('AA', 'XX', { eInvoicing: { b2b: 'maybe' } }), goodRow('BB')]), { packs }).join(), /b2b must be/)
  assert.match(validateMatrix({ ...full(), schemaVersion: 2 }, { packs }).join(), /schemaVersion/)
  assert.match(validateMatrix({ ...full(), verificationMaxAgeDays: 5 }, { packs }).join(), /verificationMaxAgeDays/)
})

test('gate semantics: a gated pack may be cleared only when ALL its countries are complete; US is never gated', () => {
  const rows = full().rows
  const ok = evaluatePacks(mk(rows), { packs, today: TODAY })
  assert.equal(ok.find((p) => p.code === 'XX').mayBeCleared, true)
  const bad = evaluatePacks(mk([...rows.filter((r) => r.country !== 'BB'), goodRow('BB', 'XX', { localMethods: [] })]), { packs, today: TODAY })
  const xx = bad.find((p) => p.code === 'XX')
  assert.equal(xx.mayBeCleared, false); assert.equal(xx.gated, true)
  const us = evaluatePacks(mk([goodRow('US', 'US', { localMethods: [] }), goodRow('AA'), goodRow('BB')]), { packs, today: TODAY }).find((p) => p.code === 'US')
  assert.equal(us.complete, false); assert.equal(us.mayBeCleared, true)
})

test('an expired verification re-blocks a previously complete pack', () => {
  assert.equal(evaluatePacks(full(), { packs, today: '2027-11-30' }).find((p) => p.code === 'XX').complete, false)
})

test('pack hash is stable under key/row order and changes when any cell changes', () => {
  const a = full(); const b = mk([...a.rows].reverse().map((r) => ({ ...r, localMethods: [...r.localMethods] })))
  assert.equal(packHash(a, 'XX'), packHash(b, 'XX'))
  assert.match(packHash(a, 'XX'), /^[0-9a-f]{64}$/)
  const c = full(); c.rows[1].taxInvoiceRequirements += ' x'
  assert.notEqual(packHash(a, 'XX'), packHash(c, 'XX'))
  assert.equal(packHash(a, 'US') === packHash(c, 'US'), true)
})

test('doc block injection is idempotent, preserves prose and refuses a doc without markers', () => {
  const doc = `intro\n${DOC_BEGIN}\nold\n${DOC_END}\noutro\n`
  const once = injectBlock(doc, 'TABLE')
  assert.equal(injectBlock(once, 'TABLE'), once)
  assert.ok(once.startsWith('intro\n') && once.endsWith('outro\n'))
  assert.match(extractBlock(once), /TABLE/)
  assert.throws(() => injectBlock('no markers', 'x'), /markers/)
})

test('rendered table escapes pipes, flags methods missing from code and says unverified', () => {
  const cfg = full(); cfg.rows[1].localMethods = ['card', 'bizum']; cfg.rows[1].taxInvoiceRequirements = 'a | b requirement text here'
  cfg.rows[1].verification.status = 'unverified'
  const md = renderTables(cfg, { packs, knownMethods: ['card'] })
  assert.match(md, /bizum \(not in code\)/); assert.match(md, /a \\\| b/); assert.match(md, /unverified \[VERIFY\]/)
})

test('market-entry probe reads matrix completeness', () => {
  const ctx = { billingRows: { AA: { complete: true, missing: [] }, BB: { complete: false, missing: ['x', 'y', 'z', 'w'] } } }
  assert.equal(PROBES.billing_matrix('AA', ctx).state, 'done')
  assert.match(PROBES.billing_matrix('BB', ctx).detail, /4 field/)
  assert.equal(PROBES.billing_matrix('CC', ctx).state, 'not_started')
})

/* ---- shipped files ---- */
const root = new URL('../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const cap = () => { let o = ''; let e = ''; return { out: (s) => { o += s }, err: (s) => { e += s }, get o() { return o }, get e() { return e } } }

test('parseArgs', () => {
  assert.equal(parseArgs([]).mode, 'report')
  assert.throws(() => parseArgs(['--check', '--write']), /one mode/)
  assert.throws(() => parseArgs(['--nope']), /unknown flag/)
  assert.throws(() => parseArgs(['--hash']), /needs a value/)
  assert.equal(parseArgs(['--hash', 'gb']).hashPack, 'GB')
})

test('shipped config is valid, doc in sync, and NO gated pack is complete (nothing is verified yet)', async () => {
  const c = cap()
  assert.equal(await run(['--check'], c), 0, c.e)
  const j = cap()
  assert.equal(await run(['--report', '--json', '--today', TODAY], j), 0)
  const rep = JSON.parse(j.o)
  for (const p of rep.packs.filter((x) => x.gated)) assert.equal(p.complete, false, `${p.code} must stay blocked until verified`)
  const cfg = JSON.parse(read('config/global/payments-einvoicing.json'))
  assert.equal(cfg.rows.length, 31)
  for (const r of cfg.rows) assert.equal(r.verification.status, 'unverified', `${r.country}: do not ship rows as verified without evidence`)
})

test('strict report fails (3) while a gated pack is incomplete; hash mode prints a sha256', async () => {
  assert.equal(await run(['--report', '--strict', '--pack', 'GB', '--today', TODAY], cap()), 3)
  assert.equal(await run(['--report', '--strict', '--pack', 'US', '--today', TODAY], cap()), 0)
  const h = cap(); assert.equal(await run(['--hash', 'EU'], h), 0); assert.match(h.o.trim(), /^[0-9a-f]{64}$/)
  assert.equal(await run(['--hash', 'DE'], cap()), 2)
})

test('check exits 4 when the doc drifts, 2 when the config is invalid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pei-'))
  mkdirSync(join(dir, 'config/global'), { recursive: true }); mkdirSync(join(dir, 'docs/global'), { recursive: true })
  cpSync(new URL('config/global/payments-einvoicing.json', root), join(dir, 'config/global/payments-einvoicing.json'))
  writeFileSync(join(dir, 'docs/global/payments-einvoicing.md'), read('docs/global/payments-einvoicing.md').replace('| Country |', '| Land |'))
  const c = cap(); assert.equal(await run(['--check'], { ...c, root: dir }), 4); assert.match(c.e, /out of date/)
  const cfg = JSON.parse(read('config/global/payments-einvoicing.json')); cfg.rows.pop()
  writeFileSync(join(dir, 'config/global/payments-einvoicing.json'), JSON.stringify(cfg))
  const d = cap(); assert.equal(await run(['--check'], { ...d, root: dir }), 2); assert.match(d.e, /missing row/)
})

test('migration: gate is wired into set_regional_pack, US exempt, pack list matches code, no destructive SQL', () => {
  const sql = read('supabase/migrations/20290311000000_billing_region_gate.sql')
  const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.set_regional_pack'))
  assert.match(fn, /billing_region_allowed\(p_pack\)/)
  assert.match(fn, /55000/)
  assert.match(fn, /e\.enabled/) // existing enablements are grandfathered
  assert.match(sql, /SELECT p_pack = 'US'/)
  const packs = ['US', 'CA', 'GB', 'EU', 'AU']
  for (const p of packs) assert.match(sql, new RegExp(`'${p}'`))
  assert.match(read('src/lib/regionalPacks/packTypes.ts'), /PACK_CODES[^\n]*\['US', 'CA', 'GB', 'EU', 'AU'\]/)
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/)
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON public\.billing_region_clearances FROM anon, authenticated/)
  const code = sql.replace(/^--.*$/gm, '')
  assert.equal((code.match(/SECURITY DEFINER\nSET search_path = public/g) ?? []).length, (code.match(/SECURITY DEFINER/g) ?? []).length, 'every SECURITY DEFINER pins search_path')
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bDROP\s+(TABLE|COLUMN)|\bTRUNCATE\b|\bDELETE\s+FROM\b/i)
})

test('API maps SQLSTATE 55000 to a readable message', () => {
  assert.match(read('src/lib/regionalPacksApi.ts'), /error\?\.code === '55000'/)
})
