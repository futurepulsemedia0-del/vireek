#!/usr/bin/env node
// Vireek's OWN subscription revenue by jurisdiction (US state / country) and UTC month, as CSV or JSON.
// Input for the sales-tax nexus checklist in docs/finance/sales-tax-nexus.md. Read-only.
//
//   node scripts/finance/nexus-revenue-by-month.mjs                       last 24 complete UTC months -> reports/finance/
//   node scripts/finance/nexus-revenue-by-month.mjs --from 2025-01 --to 2026-10 --stdout
//   node scripts/finance/nexus-revenue-by-month.mjs --input ledger-rows.json --format json --stdout
//   flags: --from YYYY-MM  --to YYYY-MM (inclusive)  --format csv|json (default csv)  --out <path>  --stdout
//          --force (overwrite)  --input <json file>  --strict (exit 3 when revenue has no usable address)  --help
//
// Data source: `nexus_revenue_facts` (one row per paid Stripe invoice, built from billing_events by migration
// 20290304000000_nexus_tracker.sql). Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY unless --input is used.
// --input takes a JSON array of ledger rows (same column names), e.g. exported from the SQL editor.
//
// Rules (tests: scripts/finance/nexus-revenue-by-month.test.mjs):
//   * Nothing is guessed. Revenue with no country is `UNKNOWN`; a US invoice whose state is not a 2-letter code is
//     `US-UNKNOWN`. Both are always emitted, never folded into a state.
//   * Money is integer minor units, summed with BigInt. Currencies are never converted or added together.
//   * Gross collected only: refunds, credit notes and chargebacks are NOT netted. `net_of_tax_minor` = gross - tax.
//   * A row that fails validation stops the run (listed, not skipped). A paged read that cannot be proven complete
//     is an error, never a silent truncation. Duplicate invoice ids in --input are counted once and reported.
//   * Months are UTC calendar months of `paid_at`. Months with no revenue are not emitted.
//   * No legal conclusion is produced. Thresholds are not read or applied here.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SourceError, UsageError, createReader, parseMonth, periodBounds } from '../reporting/board-pack.mjs'

export { SourceError, UsageError }

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const MAX_INPUT_BYTES = 50 * 1024 * 1024
export const DEFAULT_MONTHS = 24
export const MAX_MONTHS = 120
export const MAX_PAGES = 400 // x 1000 rows = 400k invoices
export const UNKNOWN = 'UNKNOWN'
export const US_UNKNOWN = 'US-UNKNOWN'
export const CSV_HEADER = ['month', 'jurisdiction', 'country', 'state', 'currency', 'invoices', 'gross_minor', 'tax_minor', 'net_of_tax_minor']
export const LEDGER_COLUMNS = ['stripe_invoice_id', 'country', 'state', 'currency', 'gross_cents', 'tax_cents', 'paid_at', 'address_status']

const ADDRESS_STATUSES = new Set(['ok', 'no_address', 'us_state_unresolved'])
const DIGITS = /^\d{1,15}$/

export class InputError extends Error {
  constructor(message, issues = []) {
    super(message)
    this.issues = issues
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Period handling (UTC)
// ---------------------------------------------------------------------------------------------------------------
const monthKeyOf = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
const monthIndex = (key) => { const { year, month } = parseMonth(key); return year * 12 + (month - 1) }
const keyFromIndex = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`

export function previousMonthKey(now) {
  return keyFromIndex(now.getUTCFullYear() * 12 + now.getUTCMonth() - 1)
}

/** Resolve --from/--to into an inclusive UTC range. Defaults: the 24 complete months ending last month. */
export function resolveRange({ from, to }, now = new Date()) {
  const toKey = to ?? previousMonthKey(now)
  const fromKey = from ?? keyFromIndex(monthIndex(toKey) - (DEFAULT_MONTHS - 1))
  const span = monthIndex(toKey) - monthIndex(fromKey) + 1
  if (span < 1) throw new UsageError(`--from (${fromKey}) must not be after --to (${toKey})`)
  if (span > MAX_MONTHS) throw new UsageError(`range is ${span} months; the maximum is ${MAX_MONTHS}`)
  const start = periodBounds(fromKey).start
  const end = periodBounds(toKey).end // exclusive
  return { from: fromKey, to: toKey, months: span, start, end }
}

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------
function minorInt(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null
  if (typeof value === 'string' && DIGITS.test(value)) return BigInt(value) // PostgREST may return bigint as text
  return null
}

/** Returns { ok:true, row } or { ok:false, issue }. Never throws on bad data. */
export function validateRow(raw, index = 0) {
  const bad = (why) => ({ ok: false, issue: `row ${index}: ${why}` })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad('not an object')
  const id = typeof raw.stripe_invoice_id === 'string' ? raw.stripe_invoice_id.trim() : ''
  if (!id || id.length > 255) return bad('stripe_invoice_id missing or too long')
  const country = raw.country ?? null
  if (country !== null && !(typeof country === 'string' && /^[A-Z]{2}$/.test(country))) return bad('country must be null or 2 uppercase letters')
  const state = raw.state ?? null
  if (state !== null && !(typeof state === 'string' && /^[A-Z0-9]{1,3}$/.test(state))) return bad('state must be null or 1-3 uppercase letters/digits')
  if (state !== null && country !== 'US') return bad('state is only valid with country US')
  if (typeof raw.currency !== 'string' || !/^[a-z]{3}$/.test(raw.currency)) return bad('currency must be 3 lowercase letters')
  const gross = minorInt(raw.gross_cents)
  const tax = minorInt(raw.tax_cents ?? 0)
  if (gross === null || gross <= 0n) return bad('gross_cents must be a positive integer')
  if (tax === null || tax < 0n || tax > gross) return bad('tax_cents must be an integer between 0 and gross_cents')
  const paid = typeof raw.paid_at === 'string' ? new Date(raw.paid_at) : null
  if (!paid || Number.isNaN(paid.getTime())) return bad('paid_at is not a valid timestamp')
  if (raw.address_status !== undefined && !ADDRESS_STATUSES.has(raw.address_status)) return bad('address_status is not recognised')
  return { ok: true, row: { id, country, state, currency: raw.currency, gross, tax, paidAt: paid } }
}

export function jurisdictionOf(country, state) {
  if (country === null) return UNKNOWN
  if (country === 'US') return state === null ? US_UNKNOWN : `US-${state}`
  return country
}

// ---------------------------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------------------------
/**
 * @param {unknown[]} rawRows ledger rows
 * @param {{start: Date, end: Date}} range  start inclusive, end exclusive (UTC)
 */
export function aggregate(rawRows, range) {
  if (!Array.isArray(rawRows)) throw new InputError('expected an array of ledger rows')
  const issues = []
  const valid = []
  rawRows.forEach((raw, i) => {
    const v = validateRow(raw, i)
    if (v.ok) valid.push(v.row)
    else if (issues.length < 10) issues.push(v.issue)
    else issues.push(null)
  })
  const badCount = issues.length
  if (badCount > 0) {
    const shown = issues.filter(Boolean)
    throw new InputError(`${badCount} invalid ledger row(s); nothing was written`, shown)
  }

  const seen = new Set()
  let duplicates = 0
  let outOfRange = 0
  const groups = new Map()
  for (const r of valid) {
    if (seen.has(r.id)) { duplicates++; continue }
    seen.add(r.id)
    if (r.paidAt < range.start || r.paidAt >= range.end) { outOfRange++; continue }
    const month = monthKeyOf(r.paidAt)
    const jurisdiction = jurisdictionOf(r.country, r.state)
    const key = `${month}\u0000${jurisdiction}\u0000${r.currency}`
    let g = groups.get(key)
    if (!g) { g = { month, jurisdiction, country: r.country, state: r.state, currency: r.currency, invoices: 0, gross: 0n, tax: 0n }; groups.set(key, g) }
    g.invoices += 1
    g.gross += r.gross
    g.tax += r.tax
  }

  const rows = [...groups.values()]
    .map((g) => ({ ...g, net: g.gross - g.tax }))
    .sort((a, b) => a.month.localeCompare(b.month) || a.jurisdiction.localeCompare(b.jurisdiction) || a.currency.localeCompare(b.currency))

  const unattributed = rows.filter((r) => r.jurisdiction === UNKNOWN || r.jurisdiction === US_UNKNOWN)
  return {
    rows,
    stats: {
      inputRows: rawRows.length,
      duplicates,
      outOfRange,
      invoices: rows.reduce((n, r) => n + r.invoices, 0),
      unattributedInvoices: unattributed.reduce((n, r) => n + r.invoices, 0),
      currencies: [...new Set(rows.map((r) => r.currency))].sort(),
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}` // spreadsheet-formula neutralisation (values are validated, this is defence in depth)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows) {
  const lines = [CSV_HEADER.join(',')]
  for (const r of rows) {
    lines.push([r.month, r.jurisdiction, r.country, r.state, r.currency, r.invoices, r.gross, r.tax, r.net].map(csvCell).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

export function toJson(rows, range, stats) {
  return `${JSON.stringify({
    schema: 1,
    basis: 'gross collected; refunds/credit notes/chargebacks not netted; no currency conversion; UTC months of paid_at',
    from: range.from,
    to: range.to,
    stats,
    rows: rows.map((r) => ({
      month: r.month, jurisdiction: r.jurisdiction, country: r.country, state: r.state, currency: r.currency,
      invoices: r.invoices, gross_minor: r.gross.toString(), tax_minor: r.tax.toString(), net_of_tax_minor: r.net.toString(),
    })),
  }, null, 2)}\n`
}

// ---------------------------------------------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------------------------------------------
export async function readLedger({ env = process.env, fetchImpl, range, readerFactory = createReader }) {
  const reader = readerFactory({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl })
  const params = [
    ['select', LEDGER_COLUMNS.join(',')],
    ['paid_at', `gte.${range.start.toISOString()}`],
    ['paid_at', `lt.${range.end.toISOString()}`],
    ['order', 'paid_at.asc,stripe_invoice_id.asc'],
  ]
  let result
  try {
    result = await reader.selectAll('nexus_revenue_facts', params, { maxPages: MAX_PAGES })
  } catch (e) {
    if (e instanceof SourceError && (e.status === 401 || e.status === 403)) {
      throw new UsageError(`the database refused the read (${e.message}). The service-role key needs SELECT on public.nexus_revenue_facts; if it was revoked, run the export from the SQL editor and use --input.`)
    }
    throw e
  }
  if (!result.complete) throw new SourceError(`ledger read could not be proven complete after ${MAX_PAGES} pages; narrow --from/--to`)
  return result.rows
}

export function readInputFile(path) {
  const full = resolve(path)
  if (!existsSync(full)) throw new UsageError(`input file not found: ${path}`)
  if (statSync(full).size > MAX_INPUT_BYTES) throw new UsageError(`input file is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB`)
  let json
  try { json = JSON.parse(readFileSync(full, 'utf8')) } catch { throw new UsageError('input file is not valid JSON') }
  if (!Array.isArray(json)) throw new UsageError('input JSON must be an array of ledger rows')
  return json
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------
export function parseArgs(argv) {
  const out = { from: null, to: null, format: 'csv', out: null, stdout: false, force: false, input: null, strict: false, help: false }
  const takes = new Set(['--from', '--to', '--format', '--out', '--input'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (takes.has(a)) {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new UsageError(`${a} needs a value`)
      out[a.slice(2)] = v
    } else if (a === '--stdout') out.stdout = true
    else if (a === '--force') out.force = true
    else if (a === '--strict') out.strict = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new UsageError(`unknown argument ${a}`)
  }
  if (!['csv', 'json'].includes(out.format)) throw new UsageError('--format must be csv or json')
  return out
}

const HELP = `Usage: node scripts/finance/nexus-revenue-by-month.mjs [--from YYYY-MM] [--to YYYY-MM] [--format csv|json] [--out path] [--stdout] [--force] [--input rows.json] [--strict]
Env:   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (not needed with --input)
Default range: the ${DEFAULT_MONTHS} complete UTC months ending last month. Default output: reports/finance/nexus-revenue-by-month-<from>_<to>.<ext> (git-ignored; refuses to overwrite without --force).
Gross collected only; refunds are not netted; currencies are never converted. Not a legal determination of nexus.`

export async function main(argv = process.argv.slice(2), { now = new Date(), env = process.env, fetchImpl } = {}) {
  const args = parseArgs(argv)
  if (args.help) { console.log(HELP); return 0 }
  const range = resolveRange({ from: args.from, to: args.to }, now)
  const ext = args.format
  const target = resolve(ROOT, args.out ?? `reports/finance/nexus-revenue-by-month-${range.from}_${range.to}.${ext}`)
  if (!args.stdout && !args.force && existsSync(target)) throw new UsageError(`${target} already exists; pass --force to overwrite`)

  const raw = args.input ? readInputFile(args.input) : await readLedger({ env, fetchImpl, range })
  const { rows, stats } = aggregate(raw, range)
  const body = ext === 'json' ? toJson(rows, range, stats) : toCsv(rows)

  if (args.stdout) process.stdout.write(body)
  else {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body, { mode: 0o600, flag: args.force ? 'w' : 'wx' })
    console.error(`written: ${target}`)
  }
  console.error(`range ${range.from}..${range.to} (UTC) | ${stats.invoices} invoices in ${rows.length} rows | currencies: ${stats.currencies.join(', ') || 'none'}`)
  if (stats.duplicates) console.error(`note: ${stats.duplicates} duplicate invoice id(s) in the input were counted once`)
  if (stats.outOfRange) console.error(`note: ${stats.outOfRange} input row(s) fell outside the range and were ignored`)
  if (stats.unattributedInvoices) {
    console.error(`warning: ${stats.unattributedInvoices} invoice(s) have no usable address (rows ${UNKNOWN} / ${US_UNKNOWN}); fix the Stripe customer addresses, do not assign them to a state`)
  }
  return args.strict && stats.unattributedInvoices > 0 ? 3 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code }, (e) => {
    if (e instanceof InputError) {
      console.error(`error: ${e.message}`)
      for (const issue of e.issues) console.error(`  - ${issue}`)
      process.exitCode = 2
    } else if (e instanceof UsageError) {
      console.error(`error: ${e.message}`)
      process.exitCode = 2
    } else if (e instanceof SourceError) {
      console.error(`error: could not read the ledger: ${e.message}`)
      process.exitCode = 1
    } else {
      console.error(`unexpected failure: ${e?.stack ?? e}`)
      process.exitCode = 1
    }
  })
}
