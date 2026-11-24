import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Writable } from 'node:stream'
import { PROBES, checkEntry, evaluate, isIsoDay, renderMarkdown, validateConfig } from './marketEntry.mjs'
import { parseArgs, run } from '../global/market-entry-report.mjs'

const TODAY = '2026-11-20'
const packs = { XX: { name: 'Testland', countries: ['AA', 'BB'], dataVerifiedAt: '2026-01-01' } }
const mkCfg = (over = {}) => ({
  schemaVersion: 1,
  categories: [{ id: 'c1', label: 'Cat 1' }],
  items: [
    { id: 'c1.plain', category: 'c1', title: 'Plain', description: 'd', tags: [] },
    { id: 'c1.verify', category: 'c1', title: 'Verify', description: 'd', tags: ['VERIFY'] },
    { id: 'c1.counsel', category: 'c1', title: 'Counsel', description: 'd', tags: ['COUNSEL'] },
    { id: 'c1.probe', category: 'c1', title: 'Probe', description: 'd', tags: [], probe: 'p' },
  ],
  packs: { XX: { shared: {} } },
  markets: {},
  ...over,
})
const ctx = { packs, today: TODAY, fileExists: (p) => p === 'real/file.ts' }
const item = (cfg, id) => cfg.items.find((i) => i.id === id)

test('isIsoDay rejects impossible dates', () => {
  assert.equal(isIsoDay('2026-02-28'), true)
  assert.equal(isIsoDay('2026-02-30'), false)
  assert.equal(isIsoDay('26-02-28'), false)
  assert.equal(isIsoDay(20260228), false)
})

test('done needs evidence; VERIFY needs source + date; COUNSEL needs reviewer + date', () => {
  const cfg = mkCfg()
  assert.deepEqual(checkEntry(item(cfg, 'c1.plain'), { state: 'done', evidence: 'ticket 1' }, ctx), [])
  assert.match(checkEntry(item(cfg, 'c1.plain'), { state: 'done' }, ctx)[0], /evidence/)
  const v = checkEntry(item(cfg, 'c1.verify'), { state: 'done', evidence: 'x' }, ctx)
  assert.equal(v.length, 2)
  assert.deepEqual(checkEntry(item(cfg, 'c1.verify'), { state: 'done', evidence: 'x', source: 'https://example.org', verifiedOn: '2026-11-01' }, ctx), [])
  const c = checkEntry(item(cfg, 'c1.counsel'), { state: 'done', evidence: 'x' }, ctx)
  assert.equal(c.length, 2)
  assert.deepEqual(checkEntry(item(cfg, 'c1.counsel'), { state: 'done', evidence: 'x', reviewer: 'A. Lawyer', reviewedOn: '2026-11-02' }, ctx), [])
})

test('not_applicable and blocked need a note; COUNSEL not_applicable needs counsel review', () => {
  const cfg = mkCfg()
  assert.match(checkEntry(item(cfg, 'c1.plain'), { state: 'not_applicable' }, ctx)[0], /note/)
  assert.match(checkEntry(item(cfg, 'c1.plain'), { state: 'blocked' }, ctx)[0], /blocker/)
  assert.equal(checkEntry(item(cfg, 'c1.counsel'), { state: 'not_applicable', note: 'n' }, ctx).length, 2)
})

test('future dates, bad states and missing repo evidence are rejected', () => {
  const cfg = mkCfg()
  assert.match(checkEntry(item(cfg, 'c1.verify'), { state: 'done', evidence: 'x', source: 's', verifiedOn: '2027-01-01' }, ctx).join(), /future/)
  assert.match(checkEntry(item(cfg, 'c1.plain'), { state: 'finished' }, ctx)[0], /state must be/)
  assert.match(checkEntry(item(cfg, 'c1.plain'), { state: 'done', evidence: 'repo:nope.ts' }, ctx)[0], /not found/)
  assert.deepEqual(checkEntry(item(cfg, 'c1.plain'), { state: 'done', evidence: 'repo:real/file.ts' }, ctx), [])
})

test('validateConfig: unknown items/countries/packs, manual entry on a probe item, missing pack', () => {
  assert.deepEqual(validateConfig(mkCfg(), ctx).errors, [])
  assert.match(validateConfig(mkCfg({ markets: { ZZ: {} } }), ctx).errors.join(), /not a country/)
  assert.match(validateConfig(mkCfg({ markets: { AA: { 'c1.nope': { state: 'done', evidence: 'x' } } } }), ctx).errors.join(), /unknown item/)
  assert.match(validateConfig(mkCfg({ markets: { AA: { 'c1.probe': { state: 'done', evidence: 'x' } } } }), ctx).errors.join(), /derived from code/)
  assert.match(validateConfig(mkCfg({ packs: {} }), ctx).errors.join(), /packs\.XX: missing/)
  assert.match(validateConfig(mkCfg({ packs: { XX: { shared: {} }, YY: {} } }), ctx).errors.join(), /not a regional pack/)
  const dup = mkCfg(); dup.items.push({ ...dup.items[0] })
  assert.match(validateConfig(dup, ctx).errors.join(), /duplicate item id/)
  assert.match(validateConfig(mkCfg({ schemaVersion: 2 }), ctx).errors.join(), /schemaVersion/)
})

const probes = { p: (country) => (country === 'AA' ? { state: 'done', evidence: 'repo:x', detail: 'ok' } : { state: 'in_progress' }) }
const ev = (cfg, extra = {}) => evaluate(cfg, { packs, probes, probeCtx: {}, today: TODAY, ...extra })

test('empty config is not ready and nothing defaults to done', () => {
  const r = ev(mkCfg())
  assert.equal(r.allReady, false)
  const aa = r.packs[0].countries.find((c) => c.code === 'AA')
  assert.equal(aa.counts.done, 1) // only the probe item
  assert.equal(aa.counts.not_started, 3)
  assert.equal(aa.ready, false)
})

test('precedence: probe > country entry > pack shared; shared applies to every country', () => {
  const cfg = mkCfg({
    packs: { XX: { shared: { 'c1.plain': { state: 'done', evidence: 'shared' } } } },
    markets: { BB: { 'c1.plain': { state: 'blocked', note: 'waiting on registry' } } },
  })
  const r = ev(cfg)
  const by = (code) => r.packs[0].countries.find((c) => c.code === code).items.find((i) => i.id === 'c1.plain')
  assert.equal(by('AA').state, 'done')
  assert.equal(by('BB').state, 'blocked')
})

test('a pack is ready only when every country is fully resolved', () => {
  const all = (state, extra) => Object.fromEntries(['c1.plain', 'c1.verify', 'c1.counsel'].map((id) => [id, { state, evidence: 'e', source: 's', verifiedOn: '2026-11-01', reviewer: 'r', reviewedOn: '2026-11-01', note: 'n', ...extra }]))
  const cfg = mkCfg({ markets: { AA: all('done'), BB: all('not_applicable') } })
  assert.deepEqual(validateConfig(cfg, ctx).errors, [])
  // BB's probe item is in_progress -> BB not ready -> pack not ready
  assert.equal(ev(cfg).packs[0].ready, false)
  const ok = ev(cfg, { probes: { p: () => ({ state: 'done' }) } })
  assert.equal(ok.packs[0].ready, true)
  assert.equal(ok.packs[0].percent, 100)
  assert.equal(ok.allReady, true)
})

test('probe failures and unknown probes block instead of passing', () => {
  const boom = ev(mkCfg(), { probes: { p: () => { throw new Error('boom') } } })
  const row = boom.packs[0].countries[0].items.find((i) => i.id === 'c1.probe')
  assert.equal(row.state, 'blocked'); assert.match(row.detail, /boom/)
  const unknown = ev(mkCfg(), { probes: {} })
  assert.match(unknown.packs[0].countries[0].items.find((i) => i.id === 'c1.probe').detail, /unknown probe/)
  const bad = ev(mkCfg(), { probes: { p: () => ({ state: 'great' }) } })
  assert.equal(bad.packs[0].countries[0].items.find((i) => i.id === 'c1.probe').state, 'blocked')
})

test('stale bundled pack data yields a warning', () => {
  const r = evaluate(mkCfg(), { packs: { XX: { ...packs.XX, dataVerifiedAt: '2025-01-01' } }, probes, probeCtx: {}, today: TODAY })
  assert.match(r.packs[0].warnings[0], /2025-01-01/)
  assert.equal(ev(mkCfg()).packs[0].warnings.length, 0)
})

test('onlyPack filters and unknown filter yields no packs (never "all ready")', () => {
  assert.equal(ev(mkCfg(), { onlyPack: 'XX' }).packs.length, 1)
  const none = ev(mkCfg(), { onlyPack: 'QQ' })
  assert.equal(none.packs.length, 0)
  assert.equal(none.allReady, false)
})

test('markdown escapes table separators and lists blockers', () => {
  const cfg = mkCfg({ markets: { AA: { 'c1.plain': { state: 'blocked', note: 'a | b' } } } })
  const md = renderMarkdown(ev(cfg), { detail: true })
  assert.match(md, /a \\\| b/)
  assert.match(md, /NOT READY/)
  assert.match(md, /### AA/)
})

/* ---- probes against fake repo facts ---- */
const facts = {
  countries: {
    DE: { code: 'DE', currency: 'EUR', locale: 'de-DE', phone: { callingCode: '49', minLen: 6, maxLen: 13 }, postal: { regex: /^\d{5}$/, label: 'Postal code' } },
    IT: { code: 'IT', currency: 'EUR', locale: 'it-IT', phone: { callingCode: '39', minLen: 6, maxLen: 11 }, postal: { regex: /^\d{5}$/, label: 'Postal code' } },
    XX: { code: 'XX', currency: 'XXX', locale: 'en-US', phone: { callingCode: '9', minLen: 0, maxLen: 0 }, postal: { regex: null } },
  },
  locales: { de: { tier: 'C', beta: true, surfaces: ['S1'] }, en: { tier: 'source', beta: false, surfaces: ['S1'] } },
  chargeCurrencies: ['eur'],
  paymentMethodsFor: (country) => (country === 'DE' ? [{ type: 'card' }, { type: 'sepa_debit' }] : []),
  calendarInfo: (c) => (c === 'DE' ? { coverage: 'full' } : c === 'IT' ? { coverage: 'national_core', note: 'core' } : { coverage: 'minimal' }),
}
test('probes derive state from repo facts', () => {
  assert.equal(PROBES.ui_locale('DE', facts).state, 'in_progress')
  assert.equal(PROBES.ui_locale('IT', facts).state, 'not_started')
  assert.equal(PROBES.ui_locale('QQ', facts).state, 'not_started')
  assert.equal(PROBES.payment_methods('DE', facts).state, 'done')
  assert.equal(PROBES.payment_methods('IT', facts).state, 'blocked')
  assert.equal(PROBES.payment_methods('XX', facts).state, 'blocked')
  assert.equal(PROBES.country_profile('DE', facts).state, 'done')
  assert.equal(PROBES.country_profile('XX', facts).state, 'in_progress')
  assert.equal(PROBES.country_profile('QQ', facts).state, 'not_started')
  assert.equal(PROBES.holiday_calendar('DE', facts).state, 'done')
  assert.equal(PROBES.holiday_calendar('IT', facts).state, 'in_progress')
  assert.equal(PROBES.holiday_calendar('ZZ', facts).state, 'not_started')
})

/* ---- CLI + the shipped config ---- */
const sink = () => { let s = ''; const w = new Writable({ write(c, _e, cb) { s += c; cb() } }); w.text = () => s; return w }
const exec = async (...args) => { const out = sink(); const err = sink(); const code = await run(args, { stdout: out, stderr: err }); return { code, out: out.text(), err: err.text() } }

test('parseArgs validates flags', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown flag/)
  assert.throws(() => parseArgs(['--format', 'xml']), /--format/)
  assert.throws(() => parseArgs(['--pack']), /needs a value/)
  assert.throws(() => parseArgs(['--today', '20-11-2026']), /YYYY-MM-DD/)
  assert.equal(parseArgs(['--pack', 'eu']).pack, 'EU')
})

test('shipped config is valid and covers every pack and every VERIFY/COUNSEL tag rule', async () => {
  const r = await exec('--check', '--today', TODAY)
  assert.equal(r.code, 0, r.err)
})

test('CLI: unknown pack -> 2; strict + not ready -> 3; json output is parseable', async () => {
  assert.equal((await exec('--pack', 'DE')).code, 2)
  const strict = await exec('--strict', '--format', 'text', '--today', TODAY)
  assert.equal(strict.code, 3)
  const json = await exec('--format', 'json', '--pack', 'EU', '--today', TODAY)
  assert.equal(json.code, 0)
  const rep = JSON.parse(json.out)
  assert.equal(rep.packs[0].countries.length, 27)
  assert.equal(rep.allReady, false)
})

test('CLI: the shipped checklist never reports a pack ready on assertion alone', async () => {
  const rep = JSON.parse((await exec('--format', 'json', '--today', TODAY)).out)
  for (const p of rep.packs) {
    assert.equal(p.ready, false, `${p.code} must stay NOT READY until COUNSEL/VERIFY evidence is recorded`)
    for (const c of p.countries) for (const i of c.items) {
      if (i.tags.length && i.state === 'done') assert.ok(i.evidence, `${c.code} ${i.id}: done without evidence`)
    }
  }
})

test('CLI: an invalid config exits 2 and names the problem', async () => {
  const bad = new URL('./__tmp-bad-market-entry.json', import.meta.url)
  const { writeFileSync, rmSync } = await import('node:fs')
  const cfg = JSON.parse(readFileSync(new URL('../../config/global/market-entry.json', import.meta.url), 'utf8'))
  cfg.markets.DE = { 'legal_entity.contracting_entity': { state: 'done', evidence: 'x' } }
  writeFileSync(bad, JSON.stringify(cfg))
  try {
    const r = await exec('--config', 'scripts/lib/__tmp-bad-market-entry.json', '--check', '--today', TODAY)
    assert.equal(r.code, 2)
    assert.match(r.err, /requires reviewer/)
  } finally { rmSync(bad, { force: true }) }
})
