// Tests for scripts/finance/resilience.mjs. No database, no network, no real data.
// Run: node --test scripts/finance/resilience.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  InputError, NA, UsageError, analyse, computeConcentration, defaultScenarios, frozenFraction, main, parseArgs,
  renderMarkdown, simulate, validateInput,
} from './resilience.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SAMPLE_PATH = resolve(HERE, 'resilience.sample.json')
const SAMPLE = JSON.parse(readFileSync(SAMPLE_PATH, 'utf8'))

const base = (over = {}) => ({
  schema_version: 1,
  as_of: '2026-12-31',
  currency: 'USD',
  cash_minor: 1_200_000,
  gross_monthly_burn_minor: 100_000,
  revenue: [
    { customer: 'c1', processor: 'pA', monthly_minor: 60_000 },
    { customer: 'c2', processor: 'pA', monthly_minor: 20_000 },
    { customer: 'c3', processor: 'pB', monthly_minor: 20_000 },
  ],
  ...over,
})
const scen = (id, effects) => ({ id, label: id, effects })
const capture = () => {
  const logs = []
  const errors = []
  return { io: { log: (m) => logs.push(m), error: (m) => errors.push(m) }, logs, errors }
}

// ---- sample file is clearly fake ---------------------------------------------------------------------------------
test('sample input is labelled synthetic and uses only FAKE- names', () => {
  assert.equal(SAMPLE.data_classification, 'SYNTHETIC_SAMPLE')
  assert.match(SAMPLE._notice, /SYNTHETIC SAMPLE DATA/)
  for (const r of SAMPLE.revenue) {
    assert.match(r.customer, /^FAKE-/)
    assert.match(r.processor, /^FAKE-/)
  }
  const md = renderMarkdown(analyse(SAMPLE))
  assert.match(md, /SYNTHETIC SAMPLE DATA/)
})

// ---- runway arithmetic -------------------------------------------------------------------------------------------
test('baseline runway = usable cash / net burn (hand-computed)', () => {
  // revenue 100,000 = burn 100,000 -> self funding; change burn to 150,000 -> net 50,000 -> 1,200,000/50,000 = 24
  const r = analyse(base({ gross_monthly_burn_minor: 150_000 }))
  const b = r.scenarios.find((s) => s.id === 'baseline')
  assert.equal(b.status, 'runs_out')
  assert.ok(Math.abs(b.runway_months - 24) < 1e-9)
  assert.equal(b.month1_net_burn_minor, 50_000)
  assert.equal(b.month1_revenue_minor, 100_000)
})

test('restricted cash is excluded from runway', () => {
  const r = analyse(base({ gross_monthly_burn_minor: 150_000, restricted_cash_minor: 200_000 }))
  assert.equal(r.usable_cash_minor, 1_000_000)
  assert.ok(Math.abs(r.scenarios[0].runway_months - 20) < 1e-9)
})

test('revenue >= burn is self-funding, not infinite or zero', () => {
  const r = analyse(base())
  assert.equal(r.scenarios[0].status, 'self_funding')
  assert.equal(r.scenarios[0].runway_months, null)
  assert.equal(r.scenarios[0].approx_cash_out_date, null)
  assert.match(renderMarkdown(r), /no cash-out/)
})

test('slow burn that outlasts the horizon is beyond_horizon', () => {
  const r = analyse(base({ gross_monthly_burn_minor: 101_000, assumptions: { horizon_months: 12 } }))
  assert.equal(r.scenarios[0].status, 'beyond_horizon')
  assert.equal(r.scenarios[0].runway_months, null)
})

test('fraction of a month is interpolated, crossing inside the month', () => {
  // cash 250k, net burn 100k: month 1 -> 150k, month 2 -> 50k, month 3 crosses at 50k/100k = 0.5 -> 2.5
  const r = analyse(base({ cash_minor: 250_000, gross_monthly_burn_minor: 200_000 }))
  assert.ok(Math.abs(r.scenarios[0].runway_months - 2.5) < 1e-9)
})

test('zero cash with a burning company is no_cash (0 months)', () => {
  const r = analyse(base({ cash_minor: 0, gross_monthly_burn_minor: 200_000 }))
  assert.equal(r.scenarios[0].status, 'no_cash')
  assert.equal(r.scenarios[0].runway_months, 0)
  assert.ok(r.flags.some((f) => f.id === 'no_usable_cash'))
})

test('zero cash but cash-positive operations is self-funding, not no_cash', () => {
  const r = analyse(base({ cash_minor: 0 }))
  assert.equal(r.scenarios[0].status, 'self_funding')
})

test('pre-revenue company: concentration is not available, runway = cash / burn', () => {
  const r = analyse(base({ revenue: [], cash_minor: 1_000_000, gross_monthly_burn_minor: 100_000 }))
  assert.ok(Math.abs(r.scenarios[0].runway_months - 10) < 1e-9)
  assert.equal(r.concentration.customer_hhi.hhi, null)
  assert.equal(r.concentration.top_n[0].share_pct, null)
  const md = renderMarkdown(r)
  assert.ok(md.includes(`${NA} — the input has no revenue rows.`))
  assert.equal(r.concentration.flags.length, 0)
})

test('growth assumptions change the path (revenue +10%/month extends runway)', () => {
  const flat = analyse(base({ gross_monthly_burn_minor: 150_000 })).scenarios[0].runway_months
  const growing = analyse(base({ gross_monthly_burn_minor: 150_000, assumptions: { revenue_growth_pct_per_month: 10 } })).scenarios[0]
  assert.ok(growing.status === 'self_funding' || growing.status === 'beyond_horizon' || growing.runway_months > flat)
  const costly = analyse(base({ gross_monthly_burn_minor: 150_000, assumptions: { cost_growth_pct_per_month: 5 } })).scenarios[0].runway_months
  assert.ok(costly < flat)
})

// ---- scenarios ---------------------------------------------------------------------------------------------------
test('losing the largest customer removes ALL of that customer revenue across processors', () => {
  const rows = [
    { customer: 'big', processor: 'pA', monthly_minor: 50_000 },
    { customer: 'big', processor: 'pB', monthly_minor: 30_000 },
    { customer: 'small', processor: 'pA', monthly_minor: 20_000 },
  ]
  const input = validateInput(base({ revenue: rows, scenarios: [scen('baseline', []), scen('lose', [{ type: 'lose_top_customers', n: 1 }])] }))
  const conc = computeConcentration(input.revenue)
  const lost = simulate(input, conc, input.scenarios[1])
  assert.equal(lost.month1_revenue_minor, 20_000)
})

test('lose_top_customers beyond the customer count loses everything and warns', () => {
  const input = validateInput(base({ scenarios: [scen('x', [{ type: 'lose_top_customers', n: 50 }])] }))
  const conc = computeConcentration(input.revenue)
  const r = simulate(input, conc, input.scenarios[0])
  assert.equal(r.month1_revenue_minor, 0)
  assert.equal(r.warnings.length, 1)
})

test('customer-loss ties are broken by name so results are deterministic', () => {
  const rows = [
    { customer: 'zeta', processor: 'p', monthly_minor: 10 },
    { customer: 'alpha', processor: 'p', monthly_minor: 10 },
  ]
  const conc = computeConcentration(rows)
  assert.deepEqual(conc.customers.map((c) => c.name), ['alpha', 'zeta'])
})

test('processor freeze: 14 days freezes 14/30 of month 1 only, for that processor only', () => {
  const input = validateInput(base({
    scenarios: [scen('f', [{ type: 'processor_freeze', processor: 'pA', days: 14 }])],
  }))
  const conc = computeConcentration(input.revenue)
  const r = simulate(input, conc, input.scenarios[0])
  // pA = 80,000, pB = 20,000 -> month 1 = 20,000 + 80,000 * (1 - 14/30)
  assert.equal(r.month1_revenue_minor, Math.round(20_000 + 80_000 * (1 - 14 / 30)))
})

test('"@largest" resolves to the largest processor', () => {
  const input = validateInput(base({ scenarios: [scen('f', [{ type: 'processor_freeze', processor: '@largest', days: 30 }])] }))
  const conc = computeConcentration(input.revenue)
  const r = simulate(input, conc, input.scenarios[0])
  assert.equal(r.month1_revenue_minor, 20_000) // pA fully frozen in month 1
})

test('freeze of an unknown processor has no effect and says so', () => {
  const input = validateInput(base({ scenarios: [scen('f', [{ type: 'processor_freeze', processor: 'nope', days: 30 }])] }))
  const conc = computeConcentration(input.revenue)
  const r = simulate(input, conc, input.scenarios[0])
  assert.equal(r.month1_revenue_minor, 100_000)
  assert.match(r.warnings[0], /no revenue rows/)
})

test('frozenFraction covers whole, partial and out-of-window months', () => {
  assert.equal(frozenFraction(1, 1, 30), 1)
  assert.equal(frozenFraction(2, 1, 30), 0)
  assert.equal(frozenFraction(1, 1, 45), 1)
  assert.equal(frozenFraction(2, 1, 45), 0.5)
  assert.equal(frozenFraction(1, 2, 10), 0)
  assert.ok(Math.abs(frozenFraction(2, 2, 10) - 10 / 30) < 1e-12)
})

test('start_month delays an effect', () => {
  const input = validateInput(base({
    gross_monthly_burn_minor: 150_000,
    scenarios: [scen('later', [{ type: 'revenue_change', pct: -100, start_month: 3 }])],
  }))
  const conc = computeConcentration(input.revenue)
  const r = simulate(input, conc, input.scenarios[0])
  assert.equal(r.month1_revenue_minor, 100_000) // month 1 untouched
})

test('stress scenarios never extend runway beyond baseline', () => {
  const r = analyse(SAMPLE)
  const baseline = r.scenarios.find((s) => s.id === 'baseline').runway_months
  for (const s of r.scenarios) {
    if (s.status === 'runs_out') assert.ok(s.runway_months <= baseline + 1e-9, `${s.id} longer than baseline`)
  }
})

test('default scenarios have unique ids and include a baseline', () => {
  const ids = defaultScenarios().map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.includes('baseline'))
})

// ---- concentration -----------------------------------------------------------------------------------------------
test('shares, HHI and effective number are exact for a known split', () => {
  const c = computeConcentration([
    { customer: 'a', processor: 'p1', monthly_minor: 50 },
    { customer: 'b', processor: 'p1', monthly_minor: 30 },
    { customer: 'c', processor: 'p2', monthly_minor: 20 },
  ])
  assert.equal(c.total_monthly_minor, 100)
  assert.equal(c.customers[0].share_pct, 50)
  assert.ok(Math.abs(c.customer_hhi.hhi - 3800) < 1e-9) // .25 + .09 + .04 = .38
  assert.ok(Math.abs(c.customer_hhi.effective_n - 1 / 0.38) < 1e-9)
  assert.ok(Math.abs(c.processor_hhi.hhi - 6800) < 1e-9) // .64 + .04
  assert.equal(c.top_n[1].share_pct, 100) // top 3 of 3 customers
  assert.equal(c.top_n[2].available, false) // fewer than 5 customers
})

test('a customer paying through two processors counts once as a customer and in both processors', () => {
  const c = computeConcentration([
    { customer: 'a', processor: 'p1', monthly_minor: 60 },
    { customer: 'a', processor: 'p2', monthly_minor: 40 },
  ])
  assert.equal(c.customer_count, 1)
  assert.equal(c.processor_count, 2)
  assert.equal(c.customers[0].share_pct, 100)
  assert.equal(c.processors[0].share_pct, 60)
})

test('threshold flags fire only above the threshold, and thresholds are configurable', () => {
  const rows = [
    { customer: 'a', processor: 'p1', monthly_minor: 25 },
    { customer: 'b', processor: 'p1', monthly_minor: 25 },
    { customer: 'c', processor: 'p2', monthly_minor: 25 },
    { customer: 'd', processor: 'p2', monthly_minor: 25 },
  ]
  const ids = computeConcentration(rows).flags.map((f) => f.id).sort()
  assert.deepEqual(ids, ['top1_share', 'top3_share'])
  const relaxed = computeConcentration(rows, { top1_share_pct: 25, top3_share_pct: 75, processor_share_pct: 50, min_runway_months: 12 })
  assert.equal(relaxed.flags.length, 0) // strictly greater-than: equal does not flag
})

test('runway below the configured minimum raises a review prompt', () => {
  const r = analyse(base({ cash_minor: 300_000, gross_monthly_burn_minor: 200_000, thresholds: { min_runway_months: 12 } }))
  assert.equal(r.flags[0].id, 'runway_below_minimum')
})

// ---- validation: every problem is reported, nothing is guessed ----------------------------------------------------
test('validation reports every problem at once', () => {
  let err
  try { validateInput({ schema_version: 2, as_of: '2026-02-30', currency: 'usd', cash_minor: -1, gross_monthly_burn_minor: 1.5, revenue: 'x' }) } catch (e) { err = e }
  assert.ok(err instanceof InputError)
  const paths = err.issues.map((i) => i.split(':')[0])
  for (const p of ['schema_version', 'as_of', 'currency', 'cash_minor', 'gross_monthly_burn_minor', 'revenue']) assert.ok(paths.includes(p), `missing issue for ${p}`)
})

test('floats, strings and unsafe integers are rejected for money', () => {
  for (const bad of [1.5, '100', Number.MAX_SAFE_INTEGER + 2, null, NaN, -5]) {
    assert.throws(() => validateInput(base({ cash_minor: bad })), InputError, String(bad))
  }
})

test('a row in a different currency is rejected, never converted', () => {
  const rows = [{ customer: 'a', processor: 'p', monthly_minor: 1, currency: 'EUR' }]
  assert.throws(() => validateInput(base({ revenue: rows })), (e) => e instanceof InputError && /never converted/.test(e.issues[0]))
})

test('unknown or malformed ISO currency is rejected', () => {
  for (const c of ['XYZ1', 'us', 'usd', 123, undefined]) assert.throws(() => validateInput(base({ currency: c })), InputError, String(c))
})

test('restricted cash above cash is rejected', () => {
  assert.throws(() => validateInput(base({ restricted_cash_minor: 2_000_000 })), InputError)
})

test('empty customer/processor labels and bad scenario shapes are rejected', () => {
  assert.throws(() => validateInput(base({ revenue: [{ customer: '  ', processor: 'p', monthly_minor: 1 }] })), InputError)
  assert.throws(() => validateInput(base({ scenarios: [{ id: 'Bad ID', label: 'x', effects: [] }] })), InputError)
  assert.throws(() => validateInput(base({ scenarios: [scen('a', [{ type: 'teleport' }])] })), InputError)
  assert.throws(() => validateInput(base({ scenarios: [scen('a', []), scen('a', [])] })), InputError)
  assert.throws(() => validateInput(base({ scenarios: [scen('a', [{ type: 'processor_freeze', processor: 'p', days: 0 }])] })), InputError)
  assert.throws(() => validateInput(base({ thresholds: { nonsense: 1 } })), InputError)
  assert.throws(() => validateInput(base({ assumptions: { horizon_months: 1000 } })), InputError)
})

test('validateInput does not mutate its input', () => {
  const raw = base()
  const copy = JSON.parse(JSON.stringify(raw))
  validateInput(raw)
  assert.deepEqual(raw, copy)
})

// ---- output safety -----------------------------------------------------------------------------------------------
test('hostile labels cannot inject Markdown, HTML or table breaks into the report', () => {
  const evil = 'x | y <script>alert(1)</script> [click](http://evil.example)\n# Heading'
  const md = renderMarkdown(analyse(base({ revenue: [{ customer: evil, processor: 'p|q', monthly_minor: 10 }] })))
  assert.ok(!md.includes('<script>'))
  assert.ok(!/\n# Heading/.test(md))
  assert.ok(!/(?<!\\)\]\(/.test(md), 'an unescaped ]( would make a live link')
  assert.ok(!/(?<!\\)\[click/.test(md))
})

test('JSON report round-trips and carries minor units as integers', () => {
  const j = JSON.parse(JSON.stringify(analyse(SAMPLE)))
  assert.equal(j.currency, 'USD')
  assert.ok(Number.isInteger(j.scenarios[0].month1_net_burn_minor))
  assert.ok(Number.isInteger(j.usable_cash_minor))
})

// ---- CLI ---------------------------------------------------------------------------------------------------------
test('parseArgs validates flags', () => {
  assert.throws(() => parseArgs(['--format', 'xml']), UsageError)
  assert.throws(() => parseArgs(['--input']), UsageError)
  assert.throws(() => parseArgs(['--bogus']), UsageError)
  assert.throws(() => parseArgs(['--fail-under-months', '0']), UsageError)
  assert.deepEqual(parseArgs(['--input', 'a.json', '--format', 'json', '--force']).format, 'json')
})

test('main requires --input and prints help', () => {
  assert.throws(() => main([], capture().io), UsageError)
  const c = capture()
  assert.equal(main(['--help'], c.io), 0)
  assert.match(c.logs[0], /Usage:/)
})

test('main runs on the sample, exit 0, markdown and json', () => {
  const c = capture()
  assert.equal(main(['--input', SAMPLE_PATH], c.io), 0)
  assert.match(c.logs[0], /Runway scenarios/)
  const j = capture()
  assert.equal(main(['--input', SAMPLE_PATH, '--format', 'json'], j.io), 0)
  assert.equal(JSON.parse(j.logs[0]).data_classification, 'SYNTHETIC_SAMPLE')
})

test('--fail-under-months exits 3 when baseline runway is shorter', () => {
  const c = capture()
  assert.equal(main(['--input', SAMPLE_PATH, '--fail-under-months', '24'], c.io), 0) // baseline ~27.3
  const d = capture()
  assert.equal(main(['--input', SAMPLE_PATH, '--fail-under-months', '30'], d.io), 3)
  assert.match(d.errors[0], /below/)
})

test('--out writes mode 600, refuses to overwrite without --force', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resilience-'))
  try {
    const out = join(dir, 'nested', 'r.md')
    assert.equal(main(['--input', SAMPLE_PATH, '--out', out], capture().io), 0)
    assert.ok(existsSync(out))
    if (process.platform !== 'win32') assert.equal(statSync(out).mode & 0o777, 0o600)
    assert.throws(() => main(['--input', SAMPLE_PATH, '--out', out], capture().io), /already exists/)
    writeFileSync(out, 'old')
    assert.equal(main(['--input', SAMPLE_PATH, '--out', out, '--force'], capture().io), 0)
    assert.notEqual(readFileSync(out, 'utf8'), 'old')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unreadable and non-JSON input produce a usage error, not a stack trace', () => {
  assert.throws(() => main(['--input', '/nonexistent/x.json'], capture().io), UsageError)
  const dir = mkdtempSync(join(tmpdir(), 'resilience-'))
  try {
    const p = join(dir, 'bad.json')
    writeFileSync(p, '{not json')
    assert.throws(() => main(['--input', p], capture().io), /not valid JSON/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
