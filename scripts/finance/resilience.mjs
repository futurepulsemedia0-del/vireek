#!/usr/bin/env node
// Financial resilience model (offline, read-only, no network, no database).
//
//   node scripts/finance/resilience.mjs --input scripts/finance/resilience.sample.json
//   node scripts/finance/resilience.mjs --input reports/finance/2026-12.json --format json
//   node scripts/finance/resilience.mjs --input <file> --out reports/finance/resilience-2026-12.md [--force]
//   flags: --format md|json (default md)  --out <path>  --force (overwrite)  --fail-under-months <n> (exit 3 when the
//          baseline runway is below n months)  --help
//
// What it does: takes cash, gross monthly burn and monthly collected revenue by customer and processor, and prints
//   (1) runway under a baseline and a set of stress scenarios, and (2) revenue concentration (top customers,
//   processor share, HHI).
//
// Rules this file enforces (tests: scripts/finance/resilience.test.mjs):
//   * Nothing is invented. Every number comes from the input file or from arithmetic on it. Scenarios are stress
//     tests with stated assumptions, NOT forecasts.
//   * One currency per file. Currencies are never converted or added together (same rule as the board pack).
//     A file with a mixed or unknown currency is rejected, not guessed.
//   * Money is integer minor units (cents). A ratio with an empty denominator is "not available", never 0.
//   * Threshold flags are internal review prompts with configurable defaults, not an external standard.
//   * Untrusted text (customer and processor labels) never reaches the Markdown report raw.
//
// Reuses formatMoney / cell / mdTable / NA from scripts/reporting/board-pack.mjs so money and Markdown escaping
// behave exactly like the board pack.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NA, cell, formatMoney, mdTable } from '../reporting/board-pack.mjs'

export { NA }

export const SCHEMA_VERSION = 1
export const MAX_INPUT_BYTES = 5 * 1024 * 1024
export const MAX_REVENUE_ROWS = 100_000
export const DEFAULT_HORIZON_MONTHS = 36
export const MAX_HORIZON_MONTHS = 120
export const DAYS_PER_MONTH = 30 // freeze windows are expressed in days and mapped onto 30-day model months
const AVG_DAYS_PER_MONTH = 365.2425 / 12
const DAY_MS = 86_400_000
const TOP_N_LEVELS = [1, 3, 5, 10]

export const DEFAULT_THRESHOLDS = Object.freeze({
  // Internal review prompts. They are NOT an industry or regulatory standard. Finance sets the real values [VERIFY].
  top1_share_pct: 20,
  top3_share_pct: 50,
  processor_share_pct: 60,
  min_runway_months: 12,
})

export class UsageError extends Error {}
export class InputError extends Error {
  constructor(message, issues = []) {
    super(message)
    this.issues = issues
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isMinor = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const CURRENCY_RE = /^[A-Z]{3}$/

function validCurrency(code) {
  if (typeof code !== 'string' || !CURRENCY_RE.test(code)) return false
  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
    return true
  } catch {
    return false
  }
}

function validAsOf(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const d = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d
}

const cleanLabel = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '')

/**
 * Validates and normalises an input document. Throws InputError listing EVERY problem found (not just the first),
 * so a finance user can fix the file in one pass. Returns a normalised object; the input is never mutated.
 */
export function validateInput(raw) {
  const issues = []
  const add = (path, msg) => issues.push(`${path}: ${msg}`)
  if (!isPlainObject(raw)) throw new InputError('Input must be a JSON object', ['$: expected an object'])

  if (raw.schema_version !== SCHEMA_VERSION) add('schema_version', `must be ${SCHEMA_VERSION}`)

  const asOf = validAsOf(raw.as_of)
  if (!asOf) add('as_of', 'must be a real calendar date written YYYY-MM-DD')

  if (!validCurrency(raw.currency)) add('currency', 'must be an ISO 4217 code in upper case, e.g. "USD"')

  if (!isMinor(raw.cash_minor)) add('cash_minor', 'must be a non-negative integer in minor units (cents)')
  const restricted = raw.restricted_cash_minor === undefined ? 0 : raw.restricted_cash_minor
  if (!isMinor(restricted)) add('restricted_cash_minor', 'must be a non-negative integer in minor units')
  else if (isMinor(raw.cash_minor) && restricted > raw.cash_minor) add('restricted_cash_minor', 'cannot exceed cash_minor')

  if (!isMinor(raw.gross_monthly_burn_minor)) add('gross_monthly_burn_minor', 'must be a non-negative integer in minor units (cash operating costs per month, before revenue)')

  // Revenue rows -------------------------------------------------------------------------------------------------
  const rows = []
  if (!Array.isArray(raw.revenue)) add('revenue', 'must be an array (use [] for a pre-revenue company)')
  else if (raw.revenue.length > MAX_REVENUE_ROWS) add('revenue', `too many rows (max ${MAX_REVENUE_ROWS})`)
  else {
    raw.revenue.forEach((r, i) => {
      const p = `revenue[${i}]`
      if (!isPlainObject(r)) return add(p, 'expected an object')
      const customer = cleanLabel(r.customer)
      const processor = cleanLabel(r.processor)
      if (!customer) add(`${p}.customer`, 'required, non-empty (use a pseudonymous id, not a name or email)')
      if (!processor) add(`${p}.processor`, 'required, non-empty (use "direct" or "bank_transfer" for revenue that bypasses a processor)')
      if (r.currency !== undefined && r.currency !== raw.currency) {
        add(`${p}.currency`, `row currency ${JSON.stringify(r.currency)} differs from file currency ${JSON.stringify(raw.currency)}; currencies are never converted or mixed, run one file per currency`)
      }
      if (!isMinor(r.monthly_minor)) add(`${p}.monthly_minor`, 'must be a non-negative integer in minor units (net cash expected per month)')
      if (customer && processor && isMinor(r.monthly_minor)) rows.push({ customer, processor, monthly_minor: r.monthly_minor })
    })
  }
  const totalRevenue = rows.reduce((s, r) => s + r.monthly_minor, 0)
  if (!Number.isSafeInteger(totalRevenue)) add('revenue', 'total exceeds the safe integer range')

  // Assumptions --------------------------------------------------------------------------------------------------
  const a = raw.assumptions === undefined ? {} : raw.assumptions
  if (!isPlainObject(a)) add('assumptions', 'must be an object')
  const assumptions = { revenue_growth_pct_per_month: 0, cost_growth_pct_per_month: 0, horizon_months: DEFAULT_HORIZON_MONTHS }
  if (isPlainObject(a)) {
    for (const k of ['revenue_growth_pct_per_month', 'cost_growth_pct_per_month']) {
      if (a[k] === undefined) continue
      if (typeof a[k] !== 'number' || !Number.isFinite(a[k]) || a[k] < -50 || a[k] > 50) add(`assumptions.${k}`, 'must be a number between -50 and 50')
      else assumptions[k] = a[k]
    }
    if (a.horizon_months !== undefined) {
      if (!Number.isInteger(a.horizon_months) || a.horizon_months < 1 || a.horizon_months > MAX_HORIZON_MONTHS) add('assumptions.horizon_months', `must be an integer from 1 to ${MAX_HORIZON_MONTHS}`)
      else assumptions.horizon_months = a.horizon_months
    }
  }

  // Thresholds ---------------------------------------------------------------------------------------------------
  const t = raw.thresholds === undefined ? {} : raw.thresholds
  const thresholds = { ...DEFAULT_THRESHOLDS }
  if (!isPlainObject(t)) add('thresholds', 'must be an object')
  else {
    for (const k of Object.keys(t)) {
      if (!(k in DEFAULT_THRESHOLDS)) { add(`thresholds.${k}`, `unknown key (allowed: ${Object.keys(DEFAULT_THRESHOLDS).join(', ')})`); continue }
      const max = k === 'min_runway_months' ? MAX_HORIZON_MONTHS : 100
      if (typeof t[k] !== 'number' || !Number.isFinite(t[k]) || t[k] <= 0 || t[k] > max) add(`thresholds.${k}`, `must be a number greater than 0 and at most ${max}`)
      else thresholds[k] = t[k]
    }
  }

  // Scenarios ----------------------------------------------------------------------------------------------------
  let scenarios = null
  if (raw.scenarios !== undefined) {
    if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0 || raw.scenarios.length > 50) add('scenarios', 'must be a non-empty array of at most 50 scenarios (omit the key to use the defaults)')
    else {
      scenarios = []
      const seen = new Set()
      raw.scenarios.forEach((s, i) => {
        const p = `scenarios[${i}]`
        const parsed = parseScenario(s, p, add)
        if (!parsed) return
        if (seen.has(parsed.id)) return add(`${p}.id`, `duplicate id ${JSON.stringify(parsed.id)}`)
        seen.add(parsed.id)
        scenarios.push(parsed)
      })
    }
  }

  if (issues.length) throw new InputError(`Input is invalid (${issues.length} problem${issues.length === 1 ? '' : 's'})`, issues)

  const classification = typeof raw.data_classification === 'string' ? cleanLabel(raw.data_classification).slice(0, 40) : 'UNSPECIFIED'
  return {
    as_of: raw.as_of,
    as_of_date: asOf,
    currency: raw.currency,
    classification,
    cash_minor: raw.cash_minor,
    restricted_cash_minor: restricted,
    usable_cash_minor: raw.cash_minor - restricted,
    gross_monthly_burn_minor: raw.gross_monthly_burn_minor,
    revenue: rows,
    assumptions,
    thresholds,
    scenarios,
  }
}

const EFFECT_TYPES = ['revenue_change', 'cost_change', 'lose_top_customers', 'processor_freeze']

function parseScenario(s, p, add) {
  if (!isPlainObject(s)) { add(p, 'expected an object'); return null }
  const id = cleanLabel(s.id)
  const label = cleanLabel(s.label)
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) { add(`${p}.id`, 'must match [a-z0-9][a-z0-9_-]{0,39}'); return null }
  if (!label) { add(`${p}.label`, 'required'); return null }
  if (!Array.isArray(s.effects)) { add(`${p}.effects`, 'must be an array (use [] for a baseline)'); return null }
  if (s.effects.length > 10) { add(`${p}.effects`, 'at most 10 effects per scenario'); return null }
  const effects = []
  let ok = true
  s.effects.forEach((e, j) => {
    const q = `${p}.effects[${j}]`
    if (!isPlainObject(e) || !EFFECT_TYPES.includes(e.type)) { add(q, `type must be one of ${EFFECT_TYPES.join(', ')}`); ok = false; return }
    const start = e.start_month === undefined ? 1 : e.start_month
    if (!Number.isInteger(start) || start < 1 || start > MAX_HORIZON_MONTHS) { add(`${q}.start_month`, `must be an integer from 1 to ${MAX_HORIZON_MONTHS}`); ok = false; return }
    if (e.type === 'revenue_change' || e.type === 'cost_change') {
      if (typeof e.pct !== 'number' || !Number.isFinite(e.pct) || e.pct < -100 || e.pct > 1000) { add(`${q}.pct`, 'must be a number from -100 to 1000'); ok = false; return }
      effects.push({ type: e.type, pct: e.pct, start_month: start })
    } else if (e.type === 'lose_top_customers') {
      if (!Number.isInteger(e.n) || e.n < 1 || e.n > 1000) { add(`${q}.n`, 'must be an integer from 1 to 1000'); ok = false; return }
      effects.push({ type: e.type, n: e.n, start_month: start })
    } else {
      const processor = e.processor === '@largest' ? '@largest' : cleanLabel(e.processor)
      if (!processor) { add(`${q}.processor`, 'required: a processor label from the revenue rows, or "@largest"'); ok = false; return }
      if (!Number.isInteger(e.days) || e.days < 1 || e.days > 365) { add(`${q}.days`, 'must be an integer from 1 to 365'); ok = false; return }
      effects.push({ type: e.type, processor, days: e.days, start_month: start })
    }
  })
  return ok ? { id, label, effects } : null
}

// ---------------------------------------------------------------------------------------------------------------
// Concentration
// ---------------------------------------------------------------------------------------------------------------
function groupSum(rows, key) {
  const m = new Map()
  for (const r of rows) m.set(r[key], (m.get(r[key]) ?? 0) + r.monthly_minor)
  return [...m.entries()]
    .map(([name, total]) => ({ name, monthly_minor: total }))
    .sort((x, y) => y.monthly_minor - x.monthly_minor || x.name.localeCompare(y.name, 'en'))
}

function shareTable(groups, total) {
  return groups.map((g) => ({ ...g, share_pct: total > 0 ? (g.monthly_minor / total) * 100 : null }))
}

function hhi(groups, total) {
  if (!(total > 0)) return { hhi: null, effective_n: null }
  const sumSq = groups.reduce((s, g) => s + (g.monthly_minor / total) ** 2, 0)
  return { hhi: sumSq * 10_000, effective_n: sumSq > 0 ? 1 / sumSq : null }
}

/**
 * Revenue concentration. Customers and processors are ranked by total monthly revenue (ties broken by name so the
 * output is deterministic). Everything is "not available" (null) when there is no revenue; never 0%.
 */
export function computeConcentration(rows, thresholds = DEFAULT_THRESHOLDS) {
  const total = rows.reduce((s, r) => s + r.monthly_minor, 0)
  const customers = shareTable(groupSum(rows, 'customer'), total)
  const processors = shareTable(groupSum(rows, 'processor'), total)

  const perProcessor = processors.map((p) => {
    const inside = groupSum(rows.filter((r) => r.processor === p.name), 'customer')
    const top = inside[0]
    return {
      ...p,
      customer_count: inside.length,
      top_customer_share_of_processor_pct: p.monthly_minor > 0 && top ? (top.monthly_minor / p.monthly_minor) * 100 : null,
    }
  })

  const topN = TOP_N_LEVELS.map((n) => {
    const slice = customers.slice(0, n)
    const sum = slice.reduce((s, c) => s + c.monthly_minor, 0)
    return { n, available: customers.length >= n, customers_included: slice.length, monthly_minor: sum, share_pct: total > 0 ? (sum / total) * 100 : null }
  })

  const flags = []
  if (total > 0) {
    const top1 = topN[0].share_pct
    const top3 = topN[1].share_pct
    if (top1 > thresholds.top1_share_pct) flags.push({ id: 'top1_share', message: `Largest customer is ${top1.toFixed(1)}% of monthly revenue (review threshold ${thresholds.top1_share_pct}%).` })
    if (customers.length >= 3 && top3 > thresholds.top3_share_pct) flags.push({ id: 'top3_share', message: `Top 3 customers are ${top3.toFixed(1)}% of monthly revenue (review threshold ${thresholds.top3_share_pct}%).` })
    if (customers.length < 3 && customers.length > 0) flags.push({ id: 'few_customers', message: `Only ${customers.length} paying customer${customers.length === 1 ? '' : 's'}: top-3 share is trivially 100%.` })
    const p1 = processors[0]
    if (p1.share_pct > thresholds.processor_share_pct) flags.push({ id: 'processor_share', message: `Largest processor carries ${p1.share_pct.toFixed(1)}% of monthly revenue (review threshold ${thresholds.processor_share_pct}%).` })
  }

  return {
    total_monthly_minor: total,
    customer_count: customers.length,
    processor_count: processors.length,
    customers,
    processors: perProcessor,
    top_n: topN,
    customer_hhi: hhi(customers, total),
    processor_hhi: hhi(processors, total),
    flags,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios and simulation
// ---------------------------------------------------------------------------------------------------------------
export function defaultScenarios() {
  const lose = (n, startMonth = 1) => ({ type: 'lose_top_customers', n, start_month: startMonth })
  return [
    { id: 'baseline', label: 'Baseline (inputs as given)', effects: [] },
    { id: 'revenue-20', label: 'Revenue 20% lower from month 1', effects: [{ type: 'revenue_change', pct: -20, start_month: 1 }] },
    { id: 'revenue-50', label: 'Revenue 50% lower from month 1', effects: [{ type: 'revenue_change', pct: -50, start_month: 1 }] },
    { id: 'lose-top-1', label: 'Largest customer lost from month 1', effects: [lose(1)] },
    { id: 'lose-top-3', label: 'Top 3 customers lost from month 1', effects: [lose(3)] },
    { id: 'processor-freeze-14d', label: 'Largest processor holds payouts for 14 days (not released within the window)', effects: [{ type: 'processor_freeze', processor: '@largest', days: 14, start_month: 1 }] },
    { id: 'costs+20', label: 'Costs 20% higher from month 1', effects: [{ type: 'cost_change', pct: 20, start_month: 1 }] },
    { id: 'lose-top-1-costs+20', label: 'Largest customer lost and costs 20% higher', effects: [lose(1), { type: 'cost_change', pct: 20, start_month: 1 }] },
  ]
}

/** Fraction (0..1) of model month `m` (1-based, 30-day months) covered by a freeze that starts at the beginning of `startMonth`. */
export function frozenFraction(m, startMonth, days) {
  const windowStart = (startMonth - 1) * DAYS_PER_MONTH
  const windowEnd = windowStart + days
  const monthStart = (m - 1) * DAYS_PER_MONTH
  const monthEnd = monthStart + DAYS_PER_MONTH
  const overlap = Math.max(0, Math.min(windowEnd, monthEnd) - Math.max(windowStart, monthStart))
  return overlap / DAYS_PER_MONTH
}

function resolveEffects(effects, concentration) {
  const customerRank = new Map(concentration.customers.map((c, i) => [c.name, i]))
  const largestProcessor = concentration.processors[0]?.name ?? null
  const warnings = []
  const resolved = effects.map((e) => {
    if (e.type === 'processor_freeze') {
      const name = e.processor === '@largest' ? largestProcessor : e.processor
      if (name !== null && !concentration.processors.some((p) => p.name === name)) {
        warnings.push(`Processor ${JSON.stringify(name)} has no revenue rows; the freeze has no effect.`)
      }
      if (name === null) warnings.push('No revenue rows, so the processor freeze has no effect.')
      return { ...e, processor: name }
    }
    if (e.type === 'lose_top_customers' && e.n > concentration.customer_count) {
      warnings.push(`Asked to lose ${e.n} customers but only ${concentration.customer_count} exist; all revenue is lost from month ${e.start_month}.`)
    }
    return e
  })
  return { resolved, customerRank, warnings }
}

/**
 * Month-by-month cash simulation. Runway is the (fractional) number of months until cash first goes below zero,
 * interpolated linearly inside the month it crosses. Deterministic, no randomness. Returns:
 *   status: 'runs_out' | 'beyond_horizon' | 'self_funding' | 'no_cash'
 */
export function simulate(input, concentration, scenario) {
  const { resolved, customerRank, warnings } = resolveEffects(scenario.effects, concentration)
  const { revenue_growth_pct_per_month: rg, cost_growth_pct_per_month: cg, horizon_months: horizon } = input.assumptions
  const rows = input.revenue

  let cash = input.usable_cash_minor
  let minCash = cash
  let minCashMonth = 0
  let month1Revenue = null
  let month1Net = null
  let allNonBurning = true

  for (let m = 1; m <= horizon; m++) {
    let revenue = 0
    for (const r of rows) {
      let f = 1
      for (const e of resolved) {
        if (m < e.start_month && e.type !== 'processor_freeze') continue
        if (e.type === 'revenue_change') f *= 1 + e.pct / 100
        else if (e.type === 'lose_top_customers') {
          if (customerRank.get(r.customer) < e.n) f = 0
        } else if (e.type === 'processor_freeze' && r.processor === e.processor) {
          f *= 1 - frozenFraction(m, e.start_month, e.days)
        }
      }
      revenue += r.monthly_minor * (1 + rg / 100) ** (m - 1) * f
    }
    let costFactor = 1
    for (const e of resolved) if (e.type === 'cost_change' && m >= e.start_month) costFactor *= 1 + e.pct / 100
    const cost = input.gross_monthly_burn_minor * (1 + cg / 100) ** (m - 1) * costFactor
    const net = cost - revenue // positive = cash goes down
    if (m === 1) { month1Revenue = revenue; month1Net = net }
    if (net > 0) allNonBurning = false

    const before = cash
    cash -= net
    if (cash < minCash) { minCash = cash; minCashMonth = m }
    if (cash < 0) {
      if (m === 1 && before <= 0) return finish('no_cash', 0)
      return finish('runs_out', before <= 0 ? m - 1 : m - 1 + before / net)
    }
  }
  return finish(allNonBurning ? 'self_funding' : 'beyond_horizon', null)

  function finish(status, runway) {
    const cashOutDate = runway === null || !input.as_of_date
      ? null
      : new Date(input.as_of_date.getTime() + Math.round(runway * AVG_DAYS_PER_MONTH * DAY_MS)).toISOString().slice(0, 10)
    return {
      id: scenario.id,
      label: scenario.label,
      status,
      runway_months: runway,
      approx_cash_out_date: cashOutDate,
      month1_revenue_minor: month1Revenue === null ? null : Math.round(month1Revenue),
      month1_net_burn_minor: month1Net === null ? null : Math.round(month1Net),
      min_cash_minor: Math.round(minCash),
      min_cash_month: minCashMonth,
      horizon_months: horizon,
      warnings,
    }
  }
}

export function runScenarios(input, concentration) {
  const list = input.scenarios ?? defaultScenarios()
  return list.map((s) => simulate(input, concentration, s))
}

export function analyse(raw) {
  const input = validateInput(raw)
  const concentration = computeConcentration(input.revenue, input.thresholds)
  const scenarios = runScenarios(input, concentration)
  const baseline = scenarios.find((s) => s.id === 'baseline') ?? scenarios[0]
  const flags = [...concentration.flags]
  if (baseline && baseline.status === 'runs_out' && baseline.runway_months < input.thresholds.min_runway_months) {
    flags.unshift({ id: 'runway_below_minimum', message: `Baseline runway is ${baseline.runway_months.toFixed(1)} months (review threshold ${input.thresholds.min_runway_months}).` })
  }
  if (baseline && baseline.status === 'no_cash') flags.unshift({ id: 'no_usable_cash', message: 'Usable cash (cash minus restricted cash) is zero.' })
  return {
    schema_version: SCHEMA_VERSION,
    as_of: input.as_of,
    currency: input.currency,
    data_classification: input.classification,
    cash_minor: input.cash_minor,
    restricted_cash_minor: input.restricted_cash_minor,
    usable_cash_minor: input.usable_cash_minor,
    gross_monthly_burn_minor: input.gross_monthly_burn_minor,
    assumptions: input.assumptions,
    thresholds: input.thresholds,
    scenarios,
    concentration,
    flags,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------
const pctText = (v) => (v === null || v === undefined ? NA : `${v.toFixed(1)}%`)

function runwayText(s) {
  switch (s.status) {
    case 'runs_out': return `${s.runway_months.toFixed(1)} months`
    case 'no_cash': return '0 months (no usable cash)'
    case 'self_funding': return `no cash-out (net cash-positive throughout ${s.horizon_months} months)`
    case 'beyond_horizon': return `beyond ${s.horizon_months}-month horizon`
    default: return NA
  }
}

export function renderMarkdown(report) {
  const cur = report.currency
  const m = (v) => formatMoney(v, cur)
  const c = report.concentration
  const baseline = report.scenarios.find((s) => s.id === 'baseline') ?? report.scenarios[0]
  const out = []
  out.push(`# Vireek — Financial resilience model`)
  out.push('')
  if (report.data_classification === 'SYNTHETIC_SAMPLE') {
    out.push('> **SYNTHETIC SAMPLE DATA.** Every customer, processor and amount below is fictional. Nothing here describes Vireek.')
    out.push('')
  }
  out.push(`As of ${report.as_of}. Currency: ${cur} (no conversion; one currency per file). Data classification: ${cell(report.data_classification, 40)}.`)
  out.push('')
  out.push('> Stress tests, not forecasts. Each scenario applies the stated assumption to the figures in the input file and nothing else. Release of held-back processor payouts after a freeze is not modelled (conservative).')
  out.push('')
  out.push('## Inputs')
  out.push('')
  out.push(mdTable(['Item', 'Value'], [
    ['Cash', m(report.cash_minor)],
    ['Restricted cash (excluded from runway)', m(report.restricted_cash_minor)],
    ['Usable cash', m(report.usable_cash_minor)],
    ['Gross monthly burn (cash operating costs)', m(report.gross_monthly_burn_minor)],
    ['Monthly collected revenue', c.customer_count ? m(c.total_monthly_minor) : `${m(0)} (no revenue rows)`],
    ['Baseline net monthly burn (month 1)', baseline && baseline.month1_net_burn_minor !== null ? m(baseline.month1_net_burn_minor) : NA],
    ['Revenue growth assumption', `${report.assumptions.revenue_growth_pct_per_month}% per month`],
    ['Cost growth assumption', `${report.assumptions.cost_growth_pct_per_month}% per month`],
    ['Simulation horizon', `${report.assumptions.horizon_months} months`],
  ]))
  out.push('')
  out.push('## Runway scenarios')
  out.push('')
  out.push(mdTable(
    ['Scenario', 'Runway', 'Approx. cash-out date', 'Month-1 revenue', 'Month-1 net burn'],
    report.scenarios.map((s) => [s.label, runwayText(s), s.approx_cash_out_date ?? NA, s.month1_revenue_minor === null ? NA : m(s.month1_revenue_minor), s.month1_net_burn_minor === null ? NA : m(s.month1_net_burn_minor)]),
  ))
  const warned = report.scenarios.filter((s) => s.warnings.length)
  if (warned.length) {
    out.push('')
    out.push('Scenario notes:')
    for (const s of warned) for (const w of s.warnings) out.push(`- ${cell(s.id, 40)}: ${cell(w, 200)}`)
  }
  out.push('')
  out.push('Net monthly burn is negative when revenue exceeds costs (cash grows). The cash-out date uses a 30.44-day month and is approximate.')
  out.push('')
  out.push('## Revenue concentration')
  out.push('')
  if (!c.customer_count) {
    out.push(`${NA} — the input has no revenue rows.`)
  } else {
    out.push(`${c.customer_count} paying customer${c.customer_count === 1 ? '' : 's'} across ${c.processor_count} processor${c.processor_count === 1 ? '' : 's'}.`)
    out.push('')
    out.push('### Top customers')
    out.push('')
    out.push(mdTable(['Level', 'Monthly revenue', 'Share'], c.top_n.map((t) => [
      t.available ? `Top ${t.n}` : `Top ${t.n} (only ${t.customers_included} exist)`, m(t.monthly_minor), pctText(t.share_pct),
    ])))
    out.push('')
    out.push(mdTable(['Rank', 'Customer', 'Monthly revenue', 'Share'], c.customers.slice(0, 10).map((x, i) => [String(i + 1), x.name, m(x.monthly_minor), pctText(x.share_pct)])))
    if (c.customers.length > 10) out.push(`\n${c.customers.length - 10} more customers not shown.`)
    out.push('')
    out.push('### Processor share')
    out.push('')
    out.push(mdTable(['Processor', 'Monthly revenue', 'Share', 'Customers', 'Largest customer inside this processor'], c.processors.map((p) => [
      p.name, m(p.monthly_minor), pctText(p.share_pct), String(p.customer_count), pctText(p.top_customer_share_of_processor_pct),
    ])))
    out.push('')
    out.push('### Index values')
    out.push('')
    out.push(mdTable(['Dimension', 'HHI (0–10,000)', 'Effective number of equal-sized parties'], [
      ['Customers', c.customer_hhi.hhi === null ? NA : c.customer_hhi.hhi.toFixed(0), c.customer_hhi.effective_n === null ? NA : c.customer_hhi.effective_n.toFixed(1)],
      ['Processors', c.processor_hhi.hhi === null ? NA : c.processor_hhi.hhi.toFixed(0), c.processor_hhi.effective_n === null ? NA : c.processor_hhi.effective_n.toFixed(1)],
    ]))
    out.push('')
    out.push('HHI is the sum of squared revenue shares ×10,000. No "safe" or "unsafe" band is asserted here.')
  }
  out.push('')
  out.push('## Review prompts')
  out.push('')
  if (!report.flags.length) out.push('None of the configured thresholds was crossed.')
  else for (const f of report.flags) out.push(`- ${cell(f.message, 300)}`)
  out.push('')
  out.push(`Thresholds used (internal review prompts, not a standard) **[VERIFY with finance]**: largest customer ${report.thresholds.top1_share_pct}%, top 3 ${report.thresholds.top3_share_pct}%, largest processor ${report.thresholds.processor_share_pct}%, minimum runway ${report.thresholds.min_runway_months} months.`)
  out.push('')
  return `${out.join('\n')}\n`
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------
export const HELP = `Usage: node scripts/finance/resilience.mjs --input <file.json> [options]

Options:
  --input <path>             JSON input (see docs/finance/resilience.md). Required.
  --format md|json           Output format (default md).
  --out <path>               Write to a file instead of stdout (file mode 600). Refuses to overwrite without --force.
  --force                    Overwrite an existing --out file.
  --fail-under-months <n>    Exit 3 if the baseline runway is below n months.
  --help                     Show this help.

Sample (fictional) input: scripts/finance/resilience.sample.json
Real inputs belong under reports/finance/ (git-ignored), never in a tracked path.
`

export function parseArgs(argv) {
  const opts = { input: null, format: 'md', out: null, force: false, failUnderMonths: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new UsageError(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '--input') opts.input = next()
    else if (a === '--format') {
      opts.format = next()
      if (!['md', 'json'].includes(opts.format)) throw new UsageError('--format must be md or json')
    } else if (a === '--out') opts.out = next()
    else if (a === '--force') opts.force = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--fail-under-months') {
      const v = Number(next())
      if (!Number.isFinite(v) || v <= 0 || v > MAX_HORIZON_MONTHS) throw new UsageError(`--fail-under-months must be a number from 0 (exclusive) to ${MAX_HORIZON_MONTHS}`)
      opts.failUnderMonths = v
    } else throw new UsageError(`Unknown argument: ${a}`)
  }
  return opts
}

export function readInputFile(path) {
  let text
  try {
    const buf = readFileSync(path)
    if (buf.length > MAX_INPUT_BYTES) throw new UsageError(`Input file is larger than ${MAX_INPUT_BYTES} bytes`)
    text = buf.toString('utf8')
  } catch (e) {
    if (e instanceof UsageError) throw e
    throw new UsageError(`Cannot read input file ${JSON.stringify(path)}: ${e.code ?? e.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new UsageError(`Input is not valid JSON: ${e.message}`)
  }
}

export function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  const opts = parseArgs(argv)
  if (opts.help) { io.log(HELP); return 0 }
  if (!opts.input) throw new UsageError('--input is required (see --help)')
  const report = analyse(readInputFile(resolve(opts.input)))
  const text = opts.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report)

  if (opts.out) {
    const target = resolve(opts.out)
    if (existsSync(target) && !opts.force) throw new UsageError(`${opts.out} already exists; pass --force to overwrite`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text, { mode: 0o600 })
    io.log(`Wrote ${opts.out}`)
  } else {
    io.log(text.replace(/\n$/, ''))
  }

  if (opts.failUnderMonths !== null) {
    const base = report.scenarios.find((s) => s.id === 'baseline') ?? report.scenarios[0]
    const months = base.status === 'runs_out' ? base.runway_months : base.status === 'no_cash' ? 0 : Infinity
    if (months < opts.failUnderMonths) {
      io.error(`Baseline runway ${months.toFixed(1)} months is below --fail-under-months ${opts.failUnderMonths}`)
      return 3
    }
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main()
  } catch (e) {
    if (e instanceof InputError) {
      console.error(`${e.message}:\n${e.issues.map((i) => `  - ${i}`).join('\n')}`)
      process.exitCode = 2
    } else if (e instanceof UsageError) {
      console.error(e.message)
      process.exitCode = 2
    } else {
      console.error(e)
      process.exitCode = 1
    }
  }
}
