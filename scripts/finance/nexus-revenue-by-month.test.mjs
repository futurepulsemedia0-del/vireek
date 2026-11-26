import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CSV_HEADER, InputError, SourceError, UsageError, aggregate, csvCell, jurisdictionOf, main, parseArgs,
  previousMonthKey, readInputFile, readLedger, resolveRange, toCsv, toJson, validateRow,
} from './nexus-revenue-by-month.mjs'

const row = (o = {}) => ({
  stripe_invoice_id: 'in_1', country: 'US', state: 'CA', currency: 'usd',
  gross_cents: 10000, tax_cents: 800, paid_at: '2026-03-15T12:00:00Z', address_status: 'ok', ...o,
})
const range = resolveRange({ from: '2026-01', to: '2026-06' })

test('previousMonthKey handles January', () => {
  assert.equal(previousMonthKey(new Date(Date.UTC(2027, 0, 10))), '2026-12')
  assert.equal(previousMonthKey(new Date(Date.UTC(2026, 10, 26))), '2026-10')
})

test('resolveRange: defaults to 24 complete months, validates order and size', () => {
  const r = resolveRange({}, new Date(Date.UTC(2026, 10, 26)))
  assert.equal(r.to, '2026-10')
  assert.equal(r.from, '2024-11')
  assert.equal(r.months, 24)
  assert.equal(r.start.toISOString(), '2024-11-01T00:00:00.000Z')
  assert.equal(r.end.toISOString(), '2026-11-01T00:00:00.000Z')
  assert.throws(() => resolveRange({ from: '2026-05', to: '2026-04' }), UsageError)
  assert.throws(() => resolveRange({ from: '2010-01', to: '2026-04' }), UsageError)
  assert.throws(() => resolveRange({ from: '2026-13', to: '2026-04' }), UsageError)
})

test('parseArgs', () => {
  assert.equal(parseArgs(['--format', 'json', '--stdout']).format, 'json')
  assert.throws(() => parseArgs(['--format', 'xml']), UsageError)
  assert.throws(() => parseArgs(['--from']), UsageError)
  assert.throws(() => parseArgs(['--from', '--to']), UsageError)
  assert.throws(() => parseArgs(['--nope']), UsageError)
})

test('jurisdictionOf never guesses', () => {
  assert.equal(jurisdictionOf(null, null), 'UNKNOWN')
  assert.equal(jurisdictionOf('US', null), 'US-UNKNOWN')
  assert.equal(jurisdictionOf('US', 'TX'), 'US-TX')
  assert.equal(jurisdictionOf('GB', null), 'GB')
})

test('validateRow rejects bad data', () => {
  assert.equal(validateRow(row()).ok, true)
  for (const bad of [
    null, [], row({ stripe_invoice_id: '' }), row({ country: 'us' }), row({ state: 'california' }),
    row({ country: 'GB', state: 'CA' }), row({ currency: 'USD' }), row({ gross_cents: 0 }), row({ gross_cents: 1.5 }),
    row({ tax_cents: -1 }), row({ tax_cents: 10001 }), row({ paid_at: 'not a date' }), row({ paid_at: 5 }),
    row({ address_status: 'weird' }), row({ gross_cents: '12a' }),
  ]) assert.equal(validateRow(bad).ok, false, JSON.stringify(bad))
  assert.equal(validateRow(row({ gross_cents: '10000', tax_cents: '0' })).ok, true) // bigint as text
})

test('aggregate: groups by month, jurisdiction, currency; sums with BigInt', () => {
  const { rows, stats } = aggregate([
    row({ stripe_invoice_id: 'a' }),
    row({ stripe_invoice_id: 'b', gross_cents: 5000, tax_cents: 0 }),
    row({ stripe_invoice_id: 'c', state: 'NY' }),
    row({ stripe_invoice_id: 'd', paid_at: '2026-04-02T00:00:00Z' }),
    row({ stripe_invoice_id: 'e', currency: 'eur', country: 'DE', state: null }),
  ], range)
  const ca = rows.find((r) => r.month === '2026-03' && r.jurisdiction === 'US-CA')
  assert.equal(ca.invoices, 2)
  assert.equal(ca.gross, 15000n)
  assert.equal(ca.tax, 800n)
  assert.equal(ca.net, 14200n)
  assert.equal(rows.length, 4)
  assert.deepEqual(stats.currencies, ['eur', 'usd'])
  assert.equal(stats.invoices, 5)
})

test('aggregate: BigInt does not lose precision on huge sums', () => {
  const big = 900_000_000_000_000
  const { rows } = aggregate([row({ stripe_invoice_id: 'x', gross_cents: big, tax_cents: 0 }), row({ stripe_invoice_id: 'y', gross_cents: big, tax_cents: 0 })], range)
  assert.equal(rows[0].gross, 1_800_000_000_000_000n)
})

test('aggregate: UTC month boundaries and range edges', () => {
  const { rows, stats } = aggregate([
    row({ stripe_invoice_id: 'a', paid_at: '2026-01-31T23:59:59Z' }),
    row({ stripe_invoice_id: 'b', paid_at: '2026-02-01T00:00:00Z' }),
    row({ stripe_invoice_id: 'c', paid_at: '2025-12-31T23:59:59Z' }), // before range
    row({ stripe_invoice_id: 'd', paid_at: '2026-07-01T00:00:00Z' }), // end is exclusive
  ], range)
  assert.deepEqual(rows.map((r) => r.month), ['2026-01', '2026-02'])
  assert.equal(stats.outOfRange, 2)
})

test('aggregate: duplicates count once; unattributed rows are kept separate', () => {
  const { rows, stats } = aggregate([
    row({ stripe_invoice_id: 'a' }), row({ stripe_invoice_id: 'a' }),
    row({ stripe_invoice_id: 'b', country: null, state: null, address_status: 'no_address' }),
    row({ stripe_invoice_id: 'c', state: null, address_status: 'us_state_unresolved' }),
  ], range)
  assert.equal(stats.duplicates, 1)
  assert.equal(stats.unattributedInvoices, 2)
  assert.deepEqual(rows.map((r) => r.jurisdiction).sort(), ['UNKNOWN', 'US-CA', 'US-UNKNOWN'])
})

test('aggregate: invalid rows stop the run and are listed', () => {
  assert.throws(
    () => aggregate([row(), row({ stripe_invoice_id: 'z', gross_cents: -5 })], range),
    (e) => e instanceof InputError && e.issues.length === 1 && /row 1/.test(e.issues[0]),
  )
  assert.throws(() => aggregate('nope', range), InputError)
})

test('CSV: header, CRLF, escaping and formula neutralisation', () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)")
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell(null), '')
  const { rows } = aggregate([row()], range)
  const csv = toCsv(rows)
  assert.equal(csv.split('\r\n')[0], CSV_HEADER.join(','))
  assert.equal(csv.split('\r\n')[1], '2026-03,US-CA,US,CA,usd,1,10000,800,9200')
  assert.ok(csv.endsWith('\r\n'))
  assert.equal(toCsv([]), `${CSV_HEADER.join(',')}\r\n`)
})

test('JSON output carries the basis statement and string money', () => {
  const { rows, stats } = aggregate([row()], range)
  const j = JSON.parse(toJson(rows, range, stats))
  assert.match(j.basis, /not netted/)
  assert.equal(j.rows[0].gross_minor, '10000')
})

function fakeFetch(pages, { status = 200, onCall } = {}) {
  let i = 0
  return async (url, init) => {
    onCall?.(String(url), init)
    if (status !== 200) return { ok: false, status, headers: { get: () => null }, text: async () => JSON.stringify({ message: 'denied', code: '42501' }) }
    const body = pages[Math.min(i++, pages.length - 1)]
    return { ok: true, status: 200, headers: { get: (h) => (h === 'content-range' ? `0-${body.length - 1}/${pages.flat().length}` : null) }, text: async () => JSON.stringify(body) }
  }
}
const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k'.repeat(40) }

test('readLedger: queries the ledger with a half-open UTC range and returns rows', async () => {
  const calls = []
  const rows = await readLedger({ env: ENV, range, fetchImpl: fakeFetch([[row()]], { onCall: (u) => calls.push(u) }) })
  assert.equal(rows.length, 1)
  assert.match(calls[0], /\/rest\/v1\/nexus_revenue_facts\?/)
  assert.match(calls[0], /paid_at=gte\.2026-01-01T00%3A00%3A00\.000Z/)
  assert.match(calls[0], /paid_at=lt\.2026-07-01T00%3A00%3A00\.000Z/)
})

test('readLedger: refused read gives an actionable usage error without leaking the key', async () => {
  await assert.rejects(
    readLedger({ env: ENV, range, fetchImpl: fakeFetch([], { status: 403 }) }),
    (e) => e instanceof UsageError && /--input/.test(e.message) && !e.message.includes(ENV.SUPABASE_SERVICE_ROLE_KEY),
  )
})

test('readLedger: missing credentials are a usage error', async () => {
  await assert.rejects(readLedger({ env: {}, range, fetchImpl: fakeFetch([[]]) }), UsageError)
})

test('readLedger: an incomplete paged read is an error, never a truncation', async () => {
  const full = Array.from({ length: 1000 }, (_, i) => row({ stripe_invoice_id: `in_${i}` }))
  const endless = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(full) })
  await assert.rejects(readLedger({ env: ENV, range, fetchImpl: endless }), (e) => e instanceof SourceError && /complete/.test(e.message))
})

test('readInputFile and main: file mode end to end, no overwrite without --force', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-'))
  try {
    const input = join(dir, 'rows.json')
    writeFileSync(input, JSON.stringify([row(), row({ stripe_invoice_id: 'z', country: null, state: null, address_status: 'no_address' })]))
    assert.equal(readInputFile(input).length, 2)
    const out = join(dir, 'out.csv')
    const quiet = console.error
    console.error = () => {}
    try {
      assert.equal(await main(['--from', '2026-01', '--to', '2026-06', '--input', input, '--out', out]), 0)
      assert.ok(existsSync(out))
      assert.match(readFileSync(out, 'utf8'), /UNKNOWN/)
      await assert.rejects(main(['--from', '2026-01', '--to', '2026-06', '--input', input, '--out', out]), UsageError)
      assert.equal(await main(['--from', '2026-01', '--to', '2026-06', '--input', input, '--out', out, '--force', '--strict']), 3)
    } finally { console.error = quiet }
    writeFileSync(input, '{"not":"an array"}')
    assert.throws(() => readInputFile(input), UsageError)
    writeFileSync(input, 'not json')
    assert.throws(() => readInputFile(input), UsageError)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
