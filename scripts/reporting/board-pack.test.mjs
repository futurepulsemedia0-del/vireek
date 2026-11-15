// Tests for scripts/reporting/board-pack.mjs. No database, no network: a fake PostgREST (and, for one test,
// a local http server) stands in for Supabase.
// Run: node --test scripts/reporting/board-pack.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  NA, ROOT, SOURCES, REQUIRED_TOKENS, TEMPLATE_MARKER, TEMPLATE_PATH, UsageError,
  assertServiceKey, assertSupabaseUrl, cell, createReader, currencyLabel, formatMoney, generate, ledgerHistoryState,
  main, mdTable, parseArgs, parseContentRangeTotal, parseMonth, pct, periodBounds, previousMonthKey, renderTemplate,
} from './board-pack.mjs'

const TEMPLATE = readFileSync(resolve(ROOT, TEMPLATE_PATH), 'utf8')
const KEY = `eyJ${'a'.repeat(20)}.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.${'s'.repeat(30)}`
const NOW = new Date('2026-11-14T10:00:00Z') // 13 days after the end of October
const NOW_SOON = new Date('2026-11-03T10:00:00Z') // 2 days after the end of October

// ---- fixtures -------------------------------------------------------------------------------------------------
const SUMMARY = [{
  currency: 'usd', opening_mrr_cents: 1_000_000, closing_mrr_cents: 1_150_000,
  movements: { new: { cents: 200_000, n: 3 }, expansion: { cents: 50_000, n: 2 }, contraction: { cents: 30_000, n: 1 }, churn: { cents: 70_000, n: 1 } },
  cohort_n: 10, cohort_opening_cents: 1_000_000, cohort_closing_cents: 960_000, cohort_retained_floor_cents: 930_000, cohort_churned_n: 1,
}]
const DIGEST = { history_days: 400, past_due_accounts: 2, trials_in_flight: 5, trials_ending_7d: 1, events_without_fact_30d: 0 }
const FACTS = [
  { stripe_subscription_id: 'sub_1', status: 'active', mrr_cents: 1000, currency: 'usd', discount_unresolved: true },
  { stripe_subscription_id: 'sub_2', status: 'active', mrr_cents: 2000, currency: 'usd', discount_unresolved: false },
]
const FIRST_CALL = [
  { day: '2026-10-05', accounts: 2, p50_seconds_to_first_call: 95, p90_seconds_to_first_call: 400, p50_seconds_to_wow: null },
  { day: '2026-10-06', accounts: 1, p50_seconds_to_first_call: 60, p90_seconds_to_first_call: 60, p50_seconds_to_wow: 130 },
]
const INCIDENTS = [
  { id: '1', title: 'Voice | outage [click](http://evil.example) <script>alert(1)</script>', impact: 'major', status: 'resolved', component_id: 'voice', source: 'synthetic', started_at: '2026-10-03T10:00:00Z', resolved_at: '2026-10-03T11:30:00Z' },
  { id: '2', title: 'Slow dashboard', impact: 'minor', status: 'resolved', component_id: 'app', source: 'manual', started_at: '2026-10-09T10:00:00Z', resolved_at: '2026-10-09T10:30:00Z' },
  { id: '3', title: 'SMS delays', impact: 'minor', status: 'investigating', component_id: 'sms', source: 'manual', started_at: '2026-10-30T10:00:00Z', resolved_at: null },
]
const CONTROLS = [
  { id: 'SEC-01', category: 'security', title: 'MFA enforced', status: 'met', owner_role: 'CTO', frequency_days: 30, last_evidence_at: '2026-10-20T00:00:00Z', next_due_at: '2026-11-19T00:00:00Z', evidence_state: 'fresh' },
  { id: 'SEC-02', category: 'security', title: 'Backups tested', status: 'partial', owner_role: 'CTO', frequency_days: 90, last_evidence_at: '2026-06-01T00:00:00Z', next_due_at: '2026-08-30T00:00:00Z', evidence_state: 'overdue' },
  { id: 'AVL-01', category: 'availability', title: 'Status page', status: 'missing', owner_role: 'COO', frequency_days: 30, last_evidence_at: null, next_due_at: null, evidence_state: 'never' },
  { id: 'CNF-01', category: 'confidentiality', title: 'Retention job', status: 'met', owner_role: 'CTO', frequency_days: 30, last_evidence_at: null, next_due_at: null, evidence_state: 'not_applicable' },
]

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const rows = (arr) => json(200, arr, { 'content-range': arr.length ? `0-${arr.length - 1}/${arr.length}` : '*/0' })

function fakeSupabase(overrides = {}) {
  const calls = []
  const handlers = {
    'POST rpc/growth_period_summary': () => json(200, SUMMARY),
    'POST rpc/growth_digest_snapshot': () => json(200, DIGEST),
    'POST rpc/growth_latest_facts': () => rows(FACTS),
    'GET first_call_kpi_daily': () => rows(FIRST_CALL),
    'GET status_incidents': ({ query }) => (query.get('status') === 'neq.resolved' ? rows([{ id: '9', impact: 'minor', started_at: '2026-09-28T00:00:00Z' }]) : rows(INCIDENTS)),
    'POST rpc/public_status_feed': () => json(200, { voice_availability_30d: 99.95, probe_samples_30d: 4000, incidents: [] }),
    'GET compliance_control_status': () => rows(CONTROLS),
    ...overrides,
  }
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url)
    const key = `${init.method ?? 'GET'} ${u.pathname.replace('/rest/v1/', '')}`
    calls.push({ key, url: String(url), init, query: u.searchParams })
    const h = handlers[key]
    return h ? h({ query: u.searchParams, init }) : json(404, { code: 'PGRST205', message: `no route ${key}` })
  }
  return { fetchImpl, calls }
}

const run = (overrides, { now = NOW, month = '2026-10', ...rest } = {}) => {
  const fake = fakeSupabase(overrides)
  const env = { SUPABASE_URL: 'https://example-ref.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY }
  return generate({ now, monthKey: month, env, fetchImpl: fake.fetchImpl, templateText: TEMPLATE, ...rest }).then((r) => ({ ...r, calls: fake.calls }))
}

// ---- periods ---------------------------------------------------------------------------------------------------
test('parseMonth accepts YYYY-MM only', () => {
  assert.deepEqual(parseMonth('2026-10'), { year: 2026, month: 10 })
  for (const bad of ['2026-13', '2026-00', '26-10', '2026-1', '2026-10-01', '../x', '', undefined, '2019-12']) assert.throws(() => parseMonth(bad), UsageError, String(bad))
})

test('period bounds are UTC, start-inclusive / end-exclusive, across leap years and year ends', () => {
  const feb = periodBounds('2028-02')
  assert.equal(feb.end.toISOString(), '2028-03-01T00:00:00.000Z')
  assert.equal(feb.lastDayIso, '2028-02-29')
  const dec = periodBounds('2026-12')
  assert.equal(dec.end.toISOString(), '2027-01-01T00:00:00.000Z')
  assert.equal(dec.label, 'December 2026')
  assert.equal(previousMonthKey(new Date('2027-01-15T00:00:00Z')), '2026-12')
  assert.equal(previousMonthKey(new Date('2026-11-14T00:00:00Z')), '2026-10')
})

// ---- formatting ------------------------------------------------------------------------------------------------
test('money uses the ISO exponent and never guesses an unknown currency', () => {
  assert.equal(formatMoney(1_150_000, 'usd'), 'USD 11,500.00')
  assert.equal(formatMoney(5000, 'JPY'), 'JPY 5,000')
  assert.match(formatMoney(100, null), /minor units \(currency unspecified\)/)
  assert.match(formatMoney(100, 'U$D'), /currency unspecified/)
  assert.equal(formatMoney(null, 'usd'), NA)
  assert.equal(formatMoney(Number.NaN, 'usd'), NA)
  assert.equal(currencyLabel(undefined), '(unspecified)')
})

test('ratios with an empty or missing denominator are "not available", never 0%', () => {
  assert.equal(pct(0, 0), NA)
  assert.equal(pct(5, null), NA)
  assert.equal(pct(null, 5), NA)
  assert.equal(pct(0, 100), '0.0%')
  assert.equal(pct(93, 100), '93.0%')
})

test('untrusted text cannot inject markdown, html or extra table columns', () => {
  const t = cell('a | b [x](http://e) <img src=x> `code` *bold* line\nbreak')
  assert.doesNotMatch(t, /(?<!\\)[|<>`]/)
  assert.doesNotMatch(t, /\n/)
  assert.equal(cell('first_call_kpi_daily'), 'first_call_kpi_daily')
  assert.equal(cell(''), '')
  assert.equal(cell(null), NA)
  assert.equal(cell('x'.repeat(500)).length <= 141, true)
  const table = mdTable(['A', 'B'], [['x', 'y | z']])
  assert.equal(table.split('\n')[2].match(/(?<!\\)\|/g).length, 3)
})

// ---- dry run and template --------------------------------------------------------------------------------------
test('dry run queries nothing and renders every figure as not available', async () => {
  const r = await generate({ now: NOW, monthKey: '2026-10', dryRun: true, templateText: TEMPLATE, env: {}, fetchImpl: () => { throw new Error('network must not be used') } })
  for (const m of Object.values(r.models)) assert.equal(m.status, 'unavailable')
  assert.match(r.markdown, /DRY RUN/)
  assert.doesNotMatch(r.markdown, /\{\{/)
  assert.doesNotMatch(r.markdown, /USD|\d+\.\d%/)
  for (const s of SOURCES) assert.ok(r.markdown.includes(s.object.replace(/_/g, '_')), `source ${s.object} missing from the data-source notes`)
})

test('template: marker, unknown tokens, and dropped sections are rejected; values are not treated as patterns', () => {
  assert.throws(() => renderTemplate('no marker {{period_label}}', {}), /marker/)
  const all = REQUIRED_TOKENS.map((t) => `{{${t}}}`).join('\n')
  const values = Object.fromEntries(REQUIRED_TOKENS.map((t) => [t, `v-${t}`]))
  assert.throws(() => renderTemplate(`${TEMPLATE_MARKER}\n${all}\n{{surprise}}`, values), /unknown token/)
  assert.throws(() => renderTemplate(`${TEMPLATE_MARKER}\n${all.replace('{{section.incidents}}', '')}`, values), /missing required token.*section\.incidents/)
  const out = renderTemplate(`${TEMPLATE_MARKER}\n${all}`, { ...values, period_label: 'costs $& and $1 and $$' })
  assert.match(out, /costs \$& and \$1 and \$\$/)
  assert.throws(() => renderTemplate(`${TEMPLATE_MARKER}\n${all}`, { ...values, period_label: undefined }), /no value supplied/)
})

test('the shipped template contains exactly the required tokens', () => {
  const body = TEMPLATE.slice(TEMPLATE.indexOf(TEMPLATE_MARKER))
  const used = new Set([...body.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)].map((m) => m[1]))
  assert.deepEqual([...used].sort(), [...REQUIRED_TOKENS].sort())
})

// ---- happy path ------------------------------------------------------------------------------------------------
test('measured figures appear exactly and reconcile', async () => {
  const { markdown, models } = await run()
  assert.equal(models.arr.status, 'ok')
  assert.match(markdown, /Closing MRR \(period end\) \| USD 11,500\.00 \| USD 138,000\.00/)
  assert.match(markdown, /Opening MRR \(period start\) \| USD 10,000\.00 \| USD 120,000\.00/)
  assert.match(markdown, /Reconciliation: closing − opening equals the sum of the movements \(USD\)/)
  assert.match(markdown, /Logo retention \(monthly\) \| 90\.0%/)
  assert.match(markdown, /Gross revenue retention, GRR \(monthly\) \| 93\.0%/)
  assert.match(markdown, /Net revenue retention, NRR \(monthly\) \| 96\.0%/)
  assert.match(markdown, /Small cohort \(n = 10\)/)
  assert.match(markdown, /1 live subscription\(s\) carry a discount/)
  assert.match(markdown, /Accounts past due: 2/)
  assert.match(markdown, /Accounts reaching a first answered call in the period \| 3 \|/)
  assert.match(markdown, /Incidents started in October 2026 \| 3/)
  assert.match(markdown, /Mean time to resolve \(resolved incidents only\) \| 60 min/)
  assert.match(markdown, /Open incidents carried over from before the period \| 1/)
  assert.match(markdown, /Controls with current evidence: 1 of 3 applicable \(33\.3%\)/)
  assert.match(markdown, /Readiness tracking, not a certification/)
})

test('incident titles are neutralised in the rendered pack', async () => {
  const { markdown } = await run()
  assert.doesNotMatch(markdown, /<script>/)
  assert.doesNotMatch(markdown, /\[click\]\(http/)
  assert.match(markdown, /Voice \\\| outage/)
})

test('availability is shown only when the pack is generated close to period end', async () => {
  const late = await run()
  assert.match(late.markdown, /Voice availability \(trailing 30 days\) \| not available/)
  assert.match(late.markdown, /cannot be reconstructed for October 2026/)
  const soon = await run({}, { now: NOW_SOON })
  assert.match(soon.markdown, /Voice availability \(trailing 30 days\) \| 99\.950%/)
  const fewSamples = await run({ 'POST rpc/public_status_feed': () => json(200, { voice_availability_30d: null, probe_samples_30d: 3 }) }, { now: NOW_SOON })
  assert.match(fewSamples.markdown, /Voice availability \(trailing 30 days\) \| not available/)
  assert.match(fewSamples.markdown, /fewer than 20 probe samples/)
})

test('a partial period is refused unless asked for, and then labelled', async () => {
  await assert.rejects(run({}, { now: new Date('2026-11-14T00:00:00Z'), month: '2026-11' }), /has not finished/)
  await assert.rejects(run({}, { now: new Date('2026-11-14T00:00:00Z'), month: '2027-01', allowPartial: true }), /in the future/)
  const r = await run({}, { now: new Date('2026-11-14T00:00:00Z'), month: '2026-11', allowPartial: true })
  assert.match(r.markdown, /PARTIAL PERIOD/)
})

// ---- missing data is never estimated ---------------------------------------------------------------------------
test('a failing source becomes "not available" and never a zero', async () => {
  const { markdown, models } = await run({
    'GET first_call_kpi_daily': () => json(500, { code: 'XX000', message: 'boom' }),
    'GET compliance_control_status': () => json(404, { code: 'PGRST205', message: 'not found' }),
  })
  assert.equal(models.usage.status, 'unavailable')
  assert.equal(models.compliance.status, 'unavailable')
  assert.match(markdown, /Usage: not available — first_call_kpi_daily failed/)
  assert.match(markdown, /Compliance calendar: not available — compliance_control_status failed/)
  assert.doesNotMatch(markdown, /Accounts reaching a first answered call in the period \| 0/)
  assert.match(markdown, /Items needing attention/)
})

test('an empty denominator or empty ledger is not turned into 0%, $0 or zero ARR', async () => {
  const empty = await run({ 'POST rpc/growth_period_summary': () => json(200, []), 'POST rpc/growth_digest_snapshot': () => json(200, { ...DIGEST, history_days: 0 }) })
  assert.equal(empty.models.arr.status, 'unavailable')
  assert.match(empty.markdown, /ARR \/ MRR: not available/)
  assert.doesNotMatch(empty.markdown, /USD 0\.00/)
  const noMovements = await run({ 'POST rpc/growth_period_summary': () => json(200, []) })
  assert.equal(noMovements.models.arr.status, 'unavailable')

  const zeroCohort = await run({ 'POST rpc/growth_period_summary': () => json(200, [{ ...SUMMARY[0], cohort_n: 0, cohort_opening_cents: 0, cohort_closing_cents: 0, cohort_retained_floor_cents: 0, cohort_churned_n: 0 }]) })
  assert.match(zeroCohort.markdown, /Gross revenue retention, GRR \(monthly\) \| not available/)
  assert.doesNotMatch(zeroCohort.markdown, /GRR[^\n]*\| 0\.0%/)
})

test('ledger history shorter than the period is flagged, never silently accepted', async () => {
  const r = await run({ 'POST rpc/growth_digest_snapshot': () => json(200, { ...DIGEST, history_days: 3 }) })
  assert.equal(r.models.arr.status, 'partial')
  assert.match(r.markdown, /ledger begins after the start of October 2026/)
  assert.equal(ledgerHistoryState(0, NOW, periodBounds('2026-10').start), 'empty')
  assert.equal(ledgerHistoryState(400, NOW, periodBounds('2026-10').start), 'covers')
  assert.equal(ledgerHistoryState(14, NOW, periodBounds('2026-10').start), 'starts_after_period')
  assert.equal(ledgerHistoryState(null, NOW, periodBounds('2026-10').start), 'unknown')
})

test('a bridge that does not reconcile is called out and listed as needing attention', async () => {
  const bad = [{ ...SUMMARY[0], closing_mrr_cents: 1_200_000 }]
  const r = await run({ 'POST rpc/growth_period_summary': () => json(200, bad) })
  assert.match(r.markdown, /RECONCILIATION FAILED \(USD\)/)
  assert.match(r.markdown, /reconciliation failed; do not circulate/)
})

test('multiple currencies are kept apart and never summed', async () => {
  const eur = { ...SUMMARY[0], currency: 'eur', opening_mrr_cents: 500, closing_mrr_cents: 500, movements: {}, cohort_n: 25, cohort_churned_n: 0, cohort_opening_cents: 500, cohort_closing_cents: 500, cohort_retained_floor_cents: 500 }
  const { markdown } = await run({ 'POST rpc/growth_period_summary': () => json(200, [SUMMARY[0], eur]) })
  assert.match(markdown, /#### EUR/)
  assert.match(markdown, /#### USD/)
  assert.match(markdown, /No FX conversion/)
})

test('partial reads are reported as partial', async () => {
  const { models } = await run({ 'GET first_call_kpi_daily': () => json(200, FIRST_CALL, { 'content-range': '0-1/5000' }) }, {})
  assert.equal(models.usage.status, 'partial')
})

// ---- credentials, transport, read-only guarantee ----------------------------------------------------------------
test('credential and URL checks fail closed and never echo the key', () => {
  const anon = `eyJ${'a'.repeat(20)}.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.${'s'.repeat(30)}`
  assert.throws(() => assertServiceKey(anon), (e) => e instanceof UsageError && !e.message.includes(anon))
  assert.throws(() => assertServiceKey('sb_publishable_abcdefghijklmnopqrstuvwxyz'), UsageError)
  assert.throws(() => assertServiceKey(''), UsageError)
  assert.throws(() => assertServiceKey(undefined), UsageError)
  assert.deepEqual(assertServiceKey(KEY), { isJwt: true })
  assert.deepEqual(assertServiceKey(`sb_secret_${'x'.repeat(30)}`), { isJwt: false })
  assert.equal(assertSupabaseUrl('https://abc.supabase.co/'), 'https://abc.supabase.co')
  assert.equal(assertSupabaseUrl('http://127.0.0.1:54321'), 'http://127.0.0.1:54321')
  assert.throws(() => assertSupabaseUrl('http://abc.supabase.co'), UsageError)
  assert.throws(() => assertSupabaseUrl('not a url'), UsageError)
  assert.throws(() => assertSupabaseUrl(undefined), UsageError)
})

test('the service-role key is sent only in headers and never appears in the pack or in error text', async () => {
  const { markdown, calls } = await run({ 'GET first_call_kpi_daily': () => json(401, { code: '401', message: `Invalid API key ${KEY}` }) })
  assert.ok(!markdown.includes(KEY))
  assert.doesNotMatch(markdown, /eyJ[\w-]+\.[\w-]+\.[\w-]+/)
  for (const c of calls) { assert.ok(!c.url.includes(KEY)); assert.equal(c.init.headers.apikey, KEY); assert.equal(c.init.headers.Authorization, `Bearer ${KEY}`) }
})

test('an opaque key echoed back by the server is redacted by exact match', async () => {
  const opaque = `sb_secret_${'Q'.repeat(30)}`
  const fake = fakeSupabase({ 'GET first_call_kpi_daily': () => json(401, { code: '401', message: `Invalid API key ${opaque} for project` }) })
  const env = { SUPABASE_URL: 'https://example-ref.supabase.co', SUPABASE_SERVICE_ROLE_KEY: opaque }
  const { markdown } = await generate({ now: NOW, monthKey: '2026-10', env, fetchImpl: fake.fetchImpl, templateText: TEMPLATE })
  assert.match(markdown, /Usage: not available — first_call_kpi_daily failed \(HTTP 401 401: Invalid API key \[redacted\] for project\)/)
  assert.ok(!markdown.includes(opaque))
})

test('opaque (non-JWT) keys are sent as apikey only', async () => {
  const opaque = `sb_secret_${'x'.repeat(30)}`
  const fake = fakeSupabase()
  await createReader({ url: 'https://abc.supabase.co', key: opaque, fetchImpl: fake.fetchImpl }).rpc('growth_digest_snapshot', {})
  assert.equal(fake.calls[0].init.headers.apikey, opaque)
  assert.equal(fake.calls[0].init.headers.Authorization, undefined)
})

test('only reads are performed: GET on relations and POST on four read-only RPCs', async () => {
  const { calls } = await run()
  const allowedPost = new Set(['POST rpc/growth_period_summary', 'POST rpc/growth_digest_snapshot', 'POST rpc/growth_latest_facts', 'POST rpc/public_status_feed'])
  assert.ok(calls.length >= 8)
  for (const c of calls) assert.ok(c.key.startsWith('GET ') || allowedPost.has(c.key), `unexpected request ${c.key}`)
  assert.deepEqual(new Set(calls.filter((c) => c.key.startsWith('GET ')).map((c) => c.key)), new Set(['GET first_call_kpi_daily', 'GET status_incidents', 'GET compliance_control_status']))
})

test('the period is passed to the database as UTC month bounds', async () => {
  const { calls } = await run()
  const summary = calls.find((c) => c.key === 'POST rpc/growth_period_summary')
  assert.deepEqual(JSON.parse(summary.init.body), { p_start: '2026-10-01T00:00:00.000Z', p_end: '2026-11-01T00:00:00.000Z' })
  const usage = calls.find((c) => c.key === 'GET first_call_kpi_daily')
  assert.deepEqual(usage.query.getAll('day'), ['gte.2026-10-01', 'lt.2026-11-01'])
  const incidents = calls.find((c) => c.key === 'GET status_incidents' && c.query.has('started_at') && !c.query.has('status'))
  assert.deepEqual(incidents.query.getAll('started_at'), ['gte.2026-10-01T00:00:00.000Z', 'lt.2026-11-01T00:00:00.000Z'])
  assert.ok(!incidents.query.get('select').includes('summary'), 'incident summary text must not be selected')
  assert.ok(!calls.find((c) => c.key === 'GET compliance_control_status').query.get('select').includes('gap'), 'control gap text must not be selected')
})

test('transient failures are retried; client errors are not', async () => {
  let n = 0
  const fetchImpl = async () => (++n < 3 ? json(503, { message: 'busy' }) : json(200, { ok: true }))
  const sleeps = []
  const reader = createReader({ url: 'https://abc.supabase.co', key: KEY, fetchImpl, sleep: async (ms) => { sleeps.push(ms) } })
  assert.deepEqual(await reader.rpc('x', {}), { ok: true })
  assert.equal(n, 3)
  assert.equal(sleeps.length, 2)
  let m = 0
  const bad = createReader({ url: 'https://abc.supabase.co', key: KEY, fetchImpl: async () => { m++; return json(400, { code: '22023', message: 'invalid_range' }) }, sleep: async () => {} })
  await assert.rejects(bad.rpc('x', {}), /HTTP 400 22023/)
  assert.equal(m, 1)
  let k = 0
  const down = createReader({ url: 'https://abc.supabase.co', key: KEY, fetchImpl: async () => { k++; throw new TypeError('fetch failed') }, sleep: async () => {} })
  await assert.rejects(down.rpc('x', {}), /network error/)
  assert.equal(k, 3)
})

test('paging uses the total from Content-Range and detects truncation', async () => {
  assert.equal(parseContentRangeTotal('0-999/2500'), 2500)
  assert.equal(parseContentRangeTotal('*/0'), 0)
  assert.equal(parseContentRangeTotal('0-9/*'), null)
  const all = Array.from({ length: 2500 }, (_, i) => ({ i }))
  const ranges = []
  const fetchImpl = async (_url, init) => {
    const [a, b] = init.headers.Range.split('-').map(Number)
    ranges.push([a, b])
    const slice = all.slice(a, b + 1)
    return json(200, slice, { 'content-range': `${a}-${a + slice.length - 1}/${all.length}` })
  }
  const reader = createReader({ url: 'https://abc.supabase.co', key: KEY, fetchImpl })
  const full = await reader.selectAll('t', [])
  assert.equal(full.rows.length, 2500)
  assert.equal(full.complete, true)
  assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]])
  const capped = await reader.selectAll('t', [], { maxPages: 2 })
  assert.equal(capped.rows.length, 2000)
  assert.equal(capped.complete, false)
})

test('the real fetch path works against a local PostgREST stand-in', async () => {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      const path = new URL(req.url, 'http://x').pathname.replace('/rest/v1/', '')
      seen.push({ method: req.method, path, apikey: req.headers.apikey, range: req.headers.range })
      const payload = {
        'rpc/growth_period_summary': SUMMARY, 'rpc/growth_digest_snapshot': DIGEST, 'rpc/growth_latest_facts': FACTS,
        first_call_kpi_daily: FIRST_CALL, status_incidents: INCIDENTS, 'rpc/public_status_feed': { voice_availability_30d: 99.9, probe_samples_30d: 100 }, compliance_control_status: CONTROLS,
      }[path]
      res.writeHead(payload ? 200 : 404, { 'content-type': 'application/json', ...(Array.isArray(payload) ? { 'content-range': `0-${payload.length - 1}/${payload.length}` } : {}) })
      res.end(JSON.stringify(payload ?? { code: 'PGRST205', message: 'no' }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const { port } = server.address()
    const { models } = await generate({ now: NOW, monthKey: '2026-10', templateText: TEMPLATE, env: { SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_SERVICE_ROLE_KEY: KEY } })
    assert.equal(models.arr.status, 'ok')
    assert.equal(models.compliance.status, 'ok')
    assert.ok(seen.every((s) => s.apikey === KEY))
    assert.ok(seen.some((s) => s.range === '0-999'))
  } finally { server.close() }
})

// ---- registered sources ----------------------------------------------------------------------------------------
test('every registered source points at a real migration that defines it', () => {
  for (const s of SOURCES) {
    const name = s.object.split('(')[0].trim()
    let found = false
    for (const rel of s.defined) {
      const abs = resolve(ROOT, rel)
      assert.ok(existsSync(abs), `${rel} does not exist`)
      if (readFileSync(abs, 'utf8').includes(name)) found = true
    }
    assert.ok(found, `${name} is not defined in any of: ${s.defined.join(', ')}`)
  }
})

// ---- CLI -------------------------------------------------------------------------------------------------------
test('argument parsing is strict', () => {
  assert.deepEqual(parseArgs(['--month', '2026-10', '--strict']).month, '2026-10')
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)
  assert.throws(() => parseArgs(['--month']), /needs a value/)
  assert.throws(() => parseArgs(['--out', '--force']), /needs a value/)
})

test('main writes a private file once, refuses to overwrite hand-edited packs, and validates the month first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-pack-'))
  const out = join(dir, 'sub', 'pack.md')
  const quiet = console.error
  console.error = () => {}
  try {
    assert.equal(await main(['--dry-run', '--month', '2026-10', '--out', out]), 0)
    assert.ok(readFileSync(out, 'utf8').includes('DRY RUN'))
    if (process.platform !== 'win32') assert.equal(statSync(out).mode & 0o777, 0o600)
    await assert.rejects(main(['--dry-run', '--month', '2026-10', '--out', out]), /already exists/)
    assert.equal(await main(['--dry-run', '--month', '2026-10', '--out', out, '--force']), 0)
    await assert.rejects(main(['--dry-run', '--month', '../../etc/x', '--out', out, '--force']), UsageError)
    assert.equal(await main(['--dry-run', '--strict', '--month', '2026-10', '--out', out, '--force']), 3)
    assert.equal(await main(['--help']), 0)
  } finally { console.error = quiet; rmSync(dir, { recursive: true, force: true }) }
})
