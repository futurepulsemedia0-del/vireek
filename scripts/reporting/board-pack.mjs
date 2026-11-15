#!/usr/bin/env node
// Monthly board pack generator (read-only).
//
//   node scripts/reporting/board-pack.mjs                      previous full UTC month -> reports/board-pack/YYYY-MM.md
//   node scripts/reporting/board-pack.mjs --month 2026-10      a specific month
//   node scripts/reporting/board-pack.mjs --dry-run            no network; every figure renders as "not available"
//   node scripts/reporting/board-pack.mjs --stdout             print instead of writing a file
//   flags: --out <path>  --force (overwrite)  --allow-partial (current, unfinished month)  --strict (exit 3 if any section is not fully available)
//
// Env (same names as the other scripts in this repo): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// The service-role key is required because every source below is service-role-only (the staff_* RPCs need a staff
// session and cannot be called from a script). The script only READS: GET on views/tables and POST on read-only
// RPCs. It never writes to the database and never prints the key.
//
// Rules this file enforces (tests: scripts/reporting/board-pack.test.mjs):
//   * A figure is either measured from a registered source or shown as "not available". Nothing is estimated,
//     interpolated, extrapolated or defaulted. A failed or partial read never turns into 0.
//   * No FX conversion: each currency is reported separately.
//   * Template: docs/finance/board-pack-template.md (everything after the template-begin marker).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const NA = 'not available'
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const TEMPLATE_PATH = 'docs/finance/board-pack-template.md'
export const TEMPLATE_MARKER = '<!-- board-pack:template-begin -->'
export const REQUIRED_TOKENS = [
  'period_label', 'period_start', 'period_end', 'generated_at', 'report_status',
  'section.summary', 'section.attention', 'section.arr', 'section.retention',
  'section.usage', 'section.incidents', 'section.compliance', 'section.sources',
]
const AVAILABILITY_FRESHNESS_DAYS = 7 // public_status_feed() is a trailing-30-day window; only valid close to period end
const SMALL_COHORT = 20
const DAY_MS = 86_400_000

export class UsageError extends Error {}
export class SourceError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message)
    this.status = status
    this.code = code
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Period handling (all UTC)
// ---------------------------------------------------------------------------------------------------------------
export function parseMonth(value) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(value ?? ''))
  if (!m) throw new UsageError(`--month must look like YYYY-MM (got ${JSON.stringify(value)})`)
  const year = Number(m[1])
  if (year < 2020 || year > 2100) throw new UsageError(`--month year out of range: ${year}`)
  return { year, month: Number(m[2]) }
}

export function periodBounds(key) {
  const { year, month } = parseMonth(key)
  const start = new Date(Date.UTC(year, month - 1, 1))
  const end = new Date(Date.UTC(year, month, 1)) // exclusive
  const label = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(start)
  const lastDay = new Date(end.getTime() - DAY_MS)
  return { key, start, end, label, firstDayIso: isoDay(start), lastDayIso: isoDay(lastDay) }
}

export function previousMonthKey(now) {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() // 0-based current month
  const d = new Date(Date.UTC(y, m - 1, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

const isoDay = (d) => d.toISOString().slice(0, 10)

// ---------------------------------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------------------------------
export const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function currencyLabel(currency) {
  return typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : '(unspecified)'
}

// Minor units -> "USD 1,234.56". The exponent comes from ISO 4217 via Intl (JPY 0, USD 2, KWD 3). Stripe's
// handling of a few special currencies is [VERIFY]. Unknown/invalid currency => the raw minor-unit count, never a guess.
export function formatMoney(cents, currency) {
  const n = num(cents)
  if (n === null) return NA
  const code = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null
  if (!code) return `${n.toLocaleString('en-US')} minor units (currency unspecified)`
  let digits
  try {
    digits = new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits
  } catch {
    return `${n.toLocaleString('en-US')} minor units of ${code}`
  }
  const text = new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: 'code' }).format(n / 10 ** digits)
  return text.replace(/\u00a0/g, ' ')
}

export function pct(numerator, denominator) {
  const a = num(numerator)
  const b = num(denominator)
  if (a === null || b === null || b <= 0) return NA
  return `${((a / b) * 100).toFixed(1)}%`
}

export const count = (v) => (num(v) === null ? NA : num(v).toLocaleString('en-US'))

export function formatDuration(minutes) {
  const m = num(minutes)
  if (m === null || m < 0) return NA
  if (m < 90) return `${Math.round(m)} min`
  const h = m / 60
  if (h < 48) return `${h.toFixed(1)} h`
  return `${(h / 24).toFixed(1)} days`
}

export function formatSeconds(s) {
  const n = num(s)
  if (n === null || n < 0) return NA
  return n < 120 ? `${Math.round(n)} s` : formatDuration(n / 60)
}

// Markdown-safe single-line cell. Untrusted text (incident titles, control titles) never reaches the pack raw.
export function cell(value, max = 140) {
  if (value === null || value === undefined) return NA
  let s = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (s.length > max) s = `${s.slice(0, max - 1)}…`
  return s
    .replace(/([\\`*{}[\]<>#|!~])/g, '\\$1')
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '\\_') // snake_case stays readable; emphasis-capable underscores are escaped
}

export function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.map((c) => cell(c)).join(' | ')} |`
  return [line(headers), `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n')
}

const bullets = (items) => items.map((i) => `- ${i}`).join('\n')
const na = (reason) => `${NA} — ${reason}`

// ---------------------------------------------------------------------------------------------------------------
// Supabase reader (PostgREST over fetch; no dependencies)
// ---------------------------------------------------------------------------------------------------------------
export function assertSupabaseUrl(raw) {
  let u
  try { u = new URL(String(raw)) } catch { throw new UsageError('SUPABASE_URL is missing or not a valid URL') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new UsageError('SUPABASE_URL must be https (http is allowed only for localhost)')
  }
  return u.origin
}

export function assertServiceKey(key) {
  if (typeof key !== 'string' || key.length < 20) throw new UsageError('SUPABASE_SERVICE_ROLE_KEY is missing')
  if (key.startsWith('sb_publishable_')) throw new UsageError('SUPABASE_SERVICE_ROLE_KEY is a publishable (client) key; a service-role/secret key is required') // [VERIFY] key prefix formats
  const parts = key.split('.')
  const isJwt = parts.length === 3
  if (isJwt) {
    let role
    try { role = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role } catch { role = undefined }
    if (role && role !== 'service_role') throw new UsageError(`SUPABASE_SERVICE_ROLE_KEY carries role "${role}"; "service_role" is required`)
  }
  return { isJwt }
}

const redactor = (key) => (text) => {
  let out = String(text ?? '')
  if (key) out = out.split(key).join('[redacted]')
  return out.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')
}

export function parseContentRangeTotal(header) {
  const m = /\/(\d+)\s*$/.exec(String(header ?? ''))
  return m ? Number(m[1]) : null
}

export function createReader({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 20_000, retries = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const origin = assertSupabaseUrl(url)
  const { isJwt } = assertServiceKey(key)
  if (typeof fetchImpl !== 'function') throw new UsageError('global fetch is not available (Node 18+ required)')
  const redact = redactor(key)
  const base = `${origin}/rest/v1`

  async function request(path, { method = 'GET', body, range, query } = {}) {
    const qs = query ? `?${query.toString()}` : ''
    const headers = { apikey: key, Accept: 'application/json', 'Accept-Profile': 'public' }
    if (isJwt) headers.Authorization = `Bearer ${key}`
    if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['Content-Profile'] = 'public' }
    if (range) { headers['Range-Unit'] = 'items'; headers.Range = `${range[0]}-${range[1]}`; headers.Prefer = 'count=exact' }
    let lastErr
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(`${base}/${path}${qs}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
        })
        if (res.status === 416) return { json: [], contentRange: res.headers?.get?.('content-range') ?? null }
        if (res.ok) {
          const text = await res.text()
          let json
          try { json = text ? JSON.parse(text) : null } catch { throw new SourceError('response was not valid JSON', { status: res.status }) }
          return { json, contentRange: res.headers?.get?.('content-range') ?? null }
        }
        let detail = {}
        try { detail = JSON.parse(await res.text()) } catch { /* non-JSON error body */ }
        const err = new SourceError(`HTTP ${res.status}${detail.code ? ` ${detail.code}` : ''}: ${redact(detail.message ?? res.statusText ?? '').slice(0, 160)}`, { status: res.status, code: detail.code ?? null })
        if ([429, 502, 503, 504].includes(res.status) && attempt < retries) { lastErr = err; await sleep(400 * 2 ** attempt); continue }
        throw err
      } catch (e) {
        if (e instanceof SourceError) throw e
        lastErr = new SourceError(`network error: ${redact(e?.name === 'TimeoutError' ? 'request timed out' : (e?.message ?? e))}`)
        if (attempt < retries) { await sleep(400 * 2 ** attempt); continue }
        throw lastErr
      }
    }
    throw lastErr
  }

  // Paged read. Completeness is decided from Content-Range's total (Prefer: count=exact); without a total, a short
  // page is treated as the last page. Anything else is reported as incomplete, never silently truncated.
  async function readAll(path, { method = 'GET', body, query, pageSize = 1000, maxPages = 20 } = {}) {
    const rows = []
    let total = null
    for (let page = 0; page < maxPages; page++) {
      const from = page * pageSize
      const { json, contentRange } = await request(path, { method, body, query, range: [from, from + pageSize - 1] })
      if (!Array.isArray(json)) throw new SourceError('unexpected response shape (expected a JSON array)')
      rows.push(...json)
      total = parseContentRangeTotal(contentRange) ?? total
      if (total !== null && rows.length >= total) return { rows, complete: true }
      if (total === null && json.length < pageSize) return { rows, complete: true }
      if (json.length === 0) return { rows, complete: total === null }
    }
    return { rows, complete: false }
  }

  return {
    rpc: async (name, args = {}) => (await request(`rpc/${name}`, { method: 'POST', body: args })).json,
    rpcAll: (name, args = {}) => readAll(`rpc/${name}`, { method: 'POST', body: args }),
    selectAll: (relation, params = [], opts = {}) => {
      const query = new URLSearchParams()
      for (const [k, v] of params) query.append(k, v)
      return readAll(relation, { query, ...opts })
    },
  }
}

const settle = async (promise) => {
  try { return { ok: true, value: await promise } } catch (e) { return { ok: false, error: e instanceof SourceError ? e.message : `unexpected error: ${String(e?.message ?? e).slice(0, 160)}` } }
}

// ---------------------------------------------------------------------------------------------------------------
// Registered data sources (the data-source notes in the pack come from here; tests check every path exists)
// ---------------------------------------------------------------------------------------------------------------
export const SOURCES = [
  { id: 'growth_period_summary', object: 'growth_period_summary(timestamptz, timestamptz)', type: 'function over view growth_mrr_movements_v', used: 'ARR / MRR bridge; retention', basis: 'Event-time ledger: reconstructible for any past period', access: 'service role (REVOKEd from anon/authenticated)', defined: ['supabase/migrations/20281103000000_growth_analytics_core.sql', 'supabase/migrations/20281104000000_growth_analytics_phase2.sql'] },
  { id: 'growth_digest_snapshot', object: 'growth_digest_snapshot()', type: 'function', used: 'Ledger history length; past-due, trial and ledger-gap counts', basis: 'State at generation time (not period end)', access: 'service role', defined: ['supabase/migrations/20281104000000_growth_analytics_phase2.sql'] },
  { id: 'growth_latest_facts', object: 'growth_latest_facts()', type: 'function over subscription_facts', used: 'Count of live subscriptions with an unresolved discount', basis: 'State at generation time (not period end)', access: 'service role', defined: ['supabase/migrations/20281104000000_growth_analytics_phase2.sql'] },
  { id: 'first_call_kpi_daily', object: 'first_call_kpi_daily', type: 'view', used: 'Accounts reaching a first answered call (activation usage)', basis: 'Daily grain; filterable to the period', access: 'service role (aggregates across tenants)', defined: ['supabase/migrations/20280501000000_first_call_sessions.sql'] },
  { id: 'status_incidents', object: 'status_incidents', type: 'TABLE (no incident view exists; read-only SELECT, no summary text)', used: 'Incidents started in the period; carry-over', basis: 'started_at in period; resolution state at generation time', access: 'service role (RLS enabled, no client policy)', defined: ['supabase/migrations/20271102000000_synthetic_monitoring_slo.sql'] },
  { id: 'public_status_feed', object: 'public_status_feed()', type: 'function', used: 'Voice availability, trailing 30 days', basis: 'Trailing 30 days at generation time; used only if generated within 7 days of period end', access: 'service role', defined: ['supabase/migrations/20271102000000_synthetic_monitoring_slo.sql'] },
  { id: 'compliance_control_status', object: 'compliance_control_status', type: 'view (security_invoker)', used: 'Compliance calendar status: evidence freshness and next due dates per control', basis: 'Snapshot at generation time (uses now())', access: 'service role (view is RLS-gated to staff for clients)', defined: ['supabase/migrations/20280402000000_soc2_control_program.sql'] },
]

// ---------------------------------------------------------------------------------------------------------------
// Section model builders (pure: take collected rows, return { status, reason, ...model })
// ---------------------------------------------------------------------------------------------------------------
const unavailable = (reason) => ({ status: 'unavailable', reason })

export function ledgerHistoryState(historyDays, generatedAt, periodStart) {
  const d = num(historyDays)
  if (d === null) return 'unknown'
  if (d === 0) return 'empty'
  const earliestMax = new Date(generatedAt.getTime() - d * DAY_MS) // extract(day ...) truncates, so earliest is within [max-1d, max]
  const earliestMin = new Date(earliestMax.getTime() - DAY_MS)
  if (earliestMin > periodStart) return 'starts_after_period'
  if (earliestMax > periodStart) return 'ambiguous'
  return 'covers'
}

export function buildBilling(ledger, ctx) {
  if (ctx.dryRun) return { arr: unavailable('dry run: no data source was queried'), retention: unavailable('dry run: no data source was queried') }
  if (!ledger.summary.ok) {
    const reason = `growth_period_summary failed (${ledger.summary.error})`
    return { arr: unavailable(reason), retention: unavailable(reason) }
  }
  const raw = ledger.summary.value
  if (!Array.isArray(raw)) {
    const reason = 'growth_period_summary returned an unexpected shape'
    return { arr: unavailable(reason), retention: unavailable(reason) }
  }
  const digest = ledger.digest.ok && ledger.digest.value && typeof ledger.digest.value === 'object' ? ledger.digest.value : null
  const notes = []
  const history = digest ? ledgerHistoryState(digest.history_days, ctx.generatedAt, ctx.period.start) : 'unknown'
  if (!digest) notes.push(`Ledger-history check: ${na(ledger.digest.ok ? 'unexpected digest shape' : ledger.digest.error)}`)
  if (history === 'empty') return { arr: unavailable('subscription_facts has no history (run growth_backfill_subscription_facts() or wait for billing events); an empty ledger cannot be told apart from zero revenue'), retention: unavailable('subscription_facts has no history') }
  if (history === 'starts_after_period') notes.push(`WARNING: the subscription ledger begins after the start of ${ctx.period.label}; opening MRR is understated and "new" MRR may be overstated. Backfill from billing_events before relying on this section.`)
  if (history === 'ambiguous') notes.push(`WARNING: the subscription ledger may begin inside ${ctx.period.label} (history length is day-truncated); confirm the backfill covers the period start.`)
  if (raw.length === 0) {
    return {
      arr: unavailable('the ledger contains no MRR movements; this cannot be distinguished from zero revenue'),
      retention: unavailable('the ledger contains no MRR movements'),
    }
  }

  // Discount check: live subscriptions with an unresolved discount (MRR may be overstated). Amount is never estimated.
  let discountNote
  if (ledger.facts.ok) {
    const { rows, complete } = ledger.facts.value
    const flagged = rows.filter((r) => r && r.discount_unresolved === true && num(r.mrr_cents) > 0).length
    discountNote = `Unresolved-discount check (state at generation time): ${flagged} live subscription(s) carry a discount the ledger could not apply${flagged ? ', so MRR may be overstated by an amount that is not available' : ''}${complete ? '' : ' [partial read: more subscriptions exist than were read]'}.`
  } else {
    discountNote = `Unresolved-discount check: ${na(ledger.facts.error)}`
  }
  notes.push(discountNote)

  const currencies = raw
    .filter((c) => c && typeof c === 'object')
    .map((c) => {
      const mv = c.movements && typeof c.movements === 'object' ? c.movements : {}
      const m = (k) => ({ cents: num(mv?.[k]?.cents) ?? 0, n: num(mv?.[k]?.n) ?? 0 }) // key absent in the aggregate = zero events of that kind
      const opening = num(c.opening_mrr_cents)
      const closing = num(c.closing_mrr_cents)
      const mNew = m('new'), mReact = m('reactivation'), mExp = m('expansion'), mCon = m('contraction'), mChurn = m('churn')
      const signedNet = mNew.cents + mReact.cents + mExp.cents - mCon.cents - mChurn.cents
      return {
        currency: c.currency ?? null,
        opening, closing, mNew, mReact, mExp, mCon, mChurn, signedNet,
        reconciles: opening === null || closing === null ? null : closing - opening === signedNet,
        cohort: { n: num(c.cohort_n), churned: num(c.cohort_churned_n), opening: num(c.cohort_opening_cents), closing: num(c.cohort_closing_cents), floor: num(c.cohort_retained_floor_cents) },
      }
    })
    .sort((a, b) => currencyLabel(a.currency).localeCompare(currencyLabel(b.currency)))

  const billing = { status: 'ok', notes, currencies, history }
  const snapshot = digest ? {
    pastDue: num(digest.past_due_accounts), trialsInFlight: num(digest.trials_in_flight), trialsEnding7d: num(digest.trials_ending_7d), eventsWithoutFact30d: num(digest.events_without_fact_30d),
  } : null
  const reasons = []
  if (!digest) reasons.push('ledger-history check unavailable')
  if (history === 'ambiguous' || history === 'starts_after_period') reasons.push('ledger history may not cover the full period')
  if (!ledger.facts.ok) reasons.push('unresolved-discount check unavailable')
  else if (!ledger.facts.value.complete) reasons.push('unresolved-discount check read was incomplete')
  if (currencies.some((c) => c.reconciles === false)) reasons.push('reconciliation failed')
  const retentionReasons = reasons.filter((r) => /history/.test(r))
  return {
    arr: { ...billing, status: reasons.length ? 'partial' : 'ok', reason: reasons.join('; ') || undefined, snapshot },
    retention: { ...billing, status: retentionReasons.length ? 'partial' : 'ok', reason: retentionReasons.join('; ') || undefined },
  }
}

export function buildUsage(res, ctx) {
  if (ctx.dryRun) return unavailable('dry run: no data source was queried')
  if (!res.ok) return unavailable(`first_call_kpi_daily failed (${res.error})`)
  const { rows, complete } = res.value
  const clean = rows.filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(String(r.day ?? '')) && num(r.accounts) !== null)
  const dropped = rows.length - clean.length
  const total = clean.reduce((s, r) => s + num(r.accounts), 0)
  return {
    status: complete && dropped === 0 ? 'ok' : 'partial',
    reason: !complete ? 'read was incomplete (page cap reached)' : dropped ? `${dropped} malformed row(s) were ignored` : undefined,
    accountsFirstCall: total,
    daysWithData: clean.length,
    daily: clean.map((r) => ({ day: r.day, accounts: num(r.accounts), p50: num(r.p50_seconds_to_first_call), p90: num(r.p90_seconds_to_first_call), wow: num(r.p50_seconds_to_wow) })),
  }
}

export function buildIncidents(res, carry, feed, ctx) {
  if (ctx.dryRun) return unavailable('dry run: no data source was queried')
  if (!res.ok) return unavailable(`status_incidents failed (${res.error})`)
  const { rows, complete } = res.value
  const incidents = rows.filter((r) => r && r.id && num(Date.parse(r.started_at)) !== null)
  const impact = (k) => incidents.filter((i) => i.impact === k).length
  const source = (k) => incidents.filter((i) => i.source === k).length
  const resolved = incidents.filter((i) => i.status === 'resolved' && i.resolved_at && Date.parse(i.resolved_at) >= Date.parse(i.started_at))
  const durations = resolved.map((i) => (Date.parse(i.resolved_at) - Date.parse(i.started_at)) / 60000)
  const mttr = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null
  const longest = durations.length ? Math.max(...durations) : null

  let carryOver = { state: 'unavailable', reason: carry.ok ? '' : carry.error }
  if (carry.ok) carryOver = { state: 'ok', count: carry.value.rows.length, complete: carry.value.complete }

  const lateEnough = Math.abs(ctx.generatedAt.getTime() - ctx.period.end.getTime()) <= AVAILABILITY_FRESHNESS_DAYS * DAY_MS
  let availability
  if (!lateEnough) availability = { value: NA, reason: `public_status_feed() reports a trailing 30-day window at generation time; it cannot be reconstructed for ${ctx.period.label}` }
  else if (!feed.ok) availability = { value: NA, reason: `public_status_feed() failed (${feed.error})` }
  else if (num(feed.value?.voice_availability_30d) === null) availability = { value: NA, reason: `fewer than 20 probe samples in the window (samples: ${count(feed.value?.probe_samples_30d)})` }
  else availability = { value: `${num(feed.value.voice_availability_30d).toFixed(3)}%`, reason: `trailing 30 days at generation time (${count(feed.value.probe_samples_30d)} probe samples); not calendar-month aligned` }

  return {
    status: complete && carry.ok && carry.value.complete ? 'ok' : 'partial',
    reason: !complete ? 'incident read was incomplete (page cap reached)' : !carry.ok ? `carry-over read failed (${carry.error})` : undefined,
    total: incidents.length, major: impact('major'), minor: impact('minor'), synthetic: source('synthetic'), manual: source('manual'),
    resolvedN: resolved.length, openN: incidents.length - incidents.filter((i) => i.status === 'resolved').length,
    mttr, longest, carryOver, availability,
    listed: incidents.map((i) => ({ started: i.started_at, impact: i.impact, status: i.status, component: i.component_id, title: i.title, minutes: i.resolved_at && i.status === 'resolved' ? (Date.parse(i.resolved_at) - Date.parse(i.started_at)) / 60000 : null })),
  }
}

const STATE_ORDER = ['failing', 'overdue', 'never', 'incomplete', 'fresh', 'not_applicable']
const ATTENTION_STATES = ['failing', 'overdue', 'never', 'incomplete']

export function buildCompliance(res, ctx) {
  if (ctx.dryRun) return unavailable('dry run: no data source was queried')
  if (!res.ok) return unavailable(`compliance_control_status failed (${res.error})`)
  const { rows, complete } = res.value
  const controls = rows.filter((r) => r && typeof r.id === 'string')
  if (controls.length === 0) return unavailable('compliance_control_status returned no controls (registry not synced)')
  const byState = {}
  const byDeclared = {}
  for (const c of controls) {
    const s = STATE_ORDER.includes(c.evidence_state) ? c.evidence_state : 'unknown'
    byState[s] = (byState[s] ?? 0) + 1
    const d = ['met', 'partial', 'missing'].includes(c.status) ? c.status : 'unknown'
    byDeclared[d] = (byDeclared[d] ?? 0) + 1
  }
  const horizon = ctx.generatedAt.getTime() + 30 * DAY_MS
  const due = (c) => (c.next_due_at ? Date.parse(c.next_due_at) : null)
  const attention = controls
    .filter((c) => ATTENTION_STATES.includes(c.evidence_state))
    .sort((a, b) => STATE_ORDER.indexOf(a.evidence_state) - STATE_ORDER.indexOf(b.evidence_state) || (due(a) ?? Infinity) - (due(b) ?? Infinity) || a.id.localeCompare(b.id))
  const dueSoon = controls
    .filter((c) => c.evidence_state === 'fresh' && due(c) !== null && due(c) <= horizon)
    .sort((a, b) => due(a) - due(b))
  const applicable = controls.length - (byState.not_applicable ?? 0)
  return {
    status: complete && !byState.unknown && !byDeclared.unknown ? 'ok' : 'partial',
    reason: !complete ? 'read was incomplete (page cap reached)' : (byState.unknown || byDeclared.unknown) ? 'some rows carry a state this script does not recognise' : undefined,
    total: controls.length, applicable, byState, byDeclared, attention, dueSoon,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------
const sectionBanner = (m) => (m.status === 'partial' ? `> **Partial data.** ${m.reason ?? 'One or more inputs could not be read; affected figures are shown as "not available".'}\n` : '')

export function renderArr(m, ctx) {
  if (m.status === 'unavailable') return `ARR / MRR: ${na(m.reason)}\n`
  const parts = []
  if (m.status === 'partial') parts.push('> **Partial data.** See the notes below; figures that could not be measured are shown as "not available".\n')
  for (const c of m.currencies) {
    const label = currencyLabel(c.currency)
    const f = (v) => formatMoney(v, c.currency)
    parts.push(`#### ${label}\n`)
    parts.push(mdTable(['Line', 'MRR', 'ARR (MRR × 12)', 'Events'], [
      ['Opening MRR (period start)', f(c.opening), c.opening === null ? NA : f(c.opening * 12), ''],
      ['+ New', f(c.mNew.cents), '', count(c.mNew.n)],
      ['+ Reactivation', f(c.mReact.cents), '', count(c.mReact.n)],
      ['+ Expansion', f(c.mExp.cents), '', count(c.mExp.n)],
      ['− Contraction', f(c.mCon.cents), '', count(c.mCon.n)],
      ['− Churn', f(c.mChurn.cents), '', count(c.mChurn.n)],
      ['Closing MRR (period end)', f(c.closing), c.closing === null ? NA : f(c.closing * 12), ''],
      ['Net change in MRR (closing − opening)', c.opening === null || c.closing === null ? NA : f(c.closing - c.opening), '', ''],
    ]))
    parts.push('')
    if (c.reconciles === false) parts.push(`> **RECONCILIATION FAILED (${label}).** Closing − opening does not equal the sum of the movements. Do not circulate this figure until the ledger is investigated.\n`)
    else if (c.reconciles === true) parts.push(`Reconciliation: closing − opening equals the sum of the movements (${label}).\n`)
    else parts.push(`Reconciliation: ${na('opening or closing MRR missing')}\n`)
  }
  if (m.snapshot) {
    parts.push(`**Billing snapshot at generation time (${ctx.generatedAt.toISOString()}), not period end:**\n`)
    parts.push(bullets([
      `Accounts past due: ${count(m.snapshot.pastDue)}`,
      `Trials in flight: ${count(m.snapshot.trialsInFlight)} (ending within 7 days: ${count(m.snapshot.trialsEnding7d)})`,
      `Subscription events in the last 30 days with no ledger row (ledger gaps): ${count(m.snapshot.eventsWithoutFact30d)}`,
    ]))
    parts.push('')
  }
  parts.push('**Notes**\n')
  parts.push(bullets([
    'ARR here is closing MRR × 12 from the Stripe-derived subscription ledger. It is a run-rate, not recognised revenue, contracted ARR or cash.',
    'MRR counts only subscriptions in status active or past_due; trialing, canceled, unpaid, incomplete and paused count as 0. Yearly prices are divided by 12.',
    'Percent-off "forever" coupons are applied; any other discount is not applied (see the unresolved-discount note).',
    'No FX conversion: each currency is a separate table and must not be added together.',
    ...m.notes,
  ]))
  return parts.join('\n')
}

export function renderRetention(m) {
  if (m.status === 'unavailable') return `Retention: ${na(m.reason)}\n`
  const parts = []
  if (m.status === 'partial') parts.push('> **Partial data.** The ledger-history check did not confirm full coverage of the period (see the ARR section notes). Treat these ratios as provisional.\n')
  for (const c of m.currencies) {
    const k = c.cohort
    const label = currencyLabel(c.currency)
    const f = (v) => formatMoney(v, c.currency)
    parts.push(`#### ${label}\n`)
    parts.push(mdTable(['Measure', 'Value', 'Basis'], [
      ['Opening cohort (accounts with MRR above 0 at period start)', count(k.n), 'accounts'],
      ['Accounts in the cohort with MRR = 0 at period end', count(k.churned), 'accounts'],
      ['Logo retention (monthly)', k.n !== null && k.churned !== null ? pct(k.n - k.churned, k.n) : NA, '(cohort − churned) ÷ cohort'],
      ['Opening cohort MRR', f(k.opening), ''],
      ['Gross revenue retention, GRR (monthly)', pct(k.floor, k.opening), 'Σ min(opening, closing) ÷ Σ opening, per account'],
      ['Net revenue retention, NRR (monthly)', pct(k.closing, k.opening), 'Σ closing ÷ Σ opening, cohort accounts only'],
    ]))
    parts.push('')
    if (k.n !== null && k.n < SMALL_COHORT) parts.push(`> Small cohort (n = ${k.n}). One account can move these ratios by several points; read them with that in mind.\n`)
  }
  parts.push('**Notes**\n')
  parts.push(bullets([
    'All ratios are one-month, not annualised. The cohort is fixed at period start, so new customers acquired in the period are excluded.',
    'An account that churned and came back within the period counts as retained (end state is compared with start state).',
    'Multi-month cohort tables (staff_growth_retention_cohorts) need a staff session and are not available to this script.',
  ]))
  return parts.join('\n')
}

const USAGE_GAPS = [
  ['Calls handled by the AI receptionist (all accounts)', 'No platform-wide monthly view found; the BI views are tenant-scoped and calls_safe is a per-tenant security_invoker view [VERIFY]'],
  ['Active accounts (platform)', 'No existing view defines "active account"; adding one needs a metric definition decision'],
  ['Provider usage and unit cost for the month', 'Only available through staff_usage_events_summary / staff_margin_extras, which require a staff session'],
]

export function renderUsage(m) {
  if (m.status === 'unavailable') return `Usage: ${na(m.reason)}\n\n${mdTable(['Metric', 'Value', 'Why'], USAGE_GAPS.map(([a, b]) => [a, NA, b]))}\n`
  const parts = [sectionBanner(m)]
  parts.push(mdTable(['Metric', 'Value', 'Source / basis'], [
    ['Accounts reaching a first answered call in the period', count(m.accountsFirstCall), 'first_call_kpi_daily, sum of daily "accounts"'],
    ['Days with at least one such account', count(m.daysWithData), 'first_call_kpi_daily'],
    ['Median / p90 time to first call for the month', NA, 'The view stores daily percentiles; percentiles cannot be combined across days (see appendix table)'],
    ...USAGE_GAPS.map(([a, b]) => [a, NA, b]),
  ]))
  parts.push('')
  if (m.daily.length) {
    parts.push('<details><summary>Daily time to first call (appendix)</summary>\n')
    parts.push(mdTable(['Day', 'Accounts', 'p50 to first call', 'p90 to first call', 'p50 to first transcript'], m.daily.map((d) => [d.day, count(d.accounts), formatSeconds(d.p50), formatSeconds(d.p90), formatSeconds(d.wow)])))
    parts.push('\n</details>\n')
  } else {
    parts.push('No account reached a first answered call in this period according to first_call_kpi_daily.\n')
  }
  return parts.join('\n')
}

export function renderIncidents(m, ctx) {
  if (m.status === 'unavailable') return `Incidents: ${na(m.reason)}\n`
  const parts = [sectionBanner(m)]
  parts.push(mdTable(['Measure', 'Value'], [
    [`Incidents started in ${ctx.period.label}`, count(m.total)],
    ['  of which major / minor', `${count(m.major)} / ${count(m.minor)}`],
    ['  of which detected by synthetic probes / raised manually', `${count(m.synthetic)} / ${count(m.manual)}`],
    ['Resolved (as of generation time) / still open', `${count(m.resolvedN)} / ${count(m.openN)}`],
    ['Mean time to resolve (resolved incidents only)', m.mttr === null ? na('no resolved incident in the period') : formatDuration(m.mttr)],
    ['Longest resolved incident', m.longest === null ? na('no resolved incident in the period') : formatDuration(m.longest)],
    ['Open incidents carried over from before the period', m.carryOver.state === 'ok' ? `${count(m.carryOver.count)}${m.carryOver.complete ? '' : ' (partial read)'}` : na(m.carryOver.reason)],
    ['Voice availability (trailing 30 days)', m.availability.value],
  ]))
  parts.push('')
  parts.push(`Availability basis: ${m.availability.reason}.\n`)
  if (m.listed.length) {
    const shown = m.listed.slice(0, 25)
    parts.push(mdTable(['Started (UTC)', 'Impact', 'Status', 'Component', 'Time to resolve', 'Title'], shown.map((i) => [String(i.started).slice(0, 16).replace('T', ' '), i.impact, i.status, i.component, i.minutes === null ? NA : formatDuration(i.minutes), i.title])))
    if (m.listed.length > shown.length) parts.push(`\n…and ${m.listed.length - shown.length} more not listed.`)
    parts.push('')
  }
  parts.push('**Notes**\n')
  parts.push(bullets([
    `A count of ${count(m.total)} means ${count(m.total)} incident(s) recorded in status_incidents. Incidents that were never recorded there are not available to this pack.`,
    'Time to resolve is resolved_at − started_at as recorded; it is not customer-impact time and no post-incident review is implied.',
  ]))
  return parts.join('\n')
}

export function renderCompliance(m, ctx) {
  if (m.status === 'unavailable') return `Compliance calendar: ${na(m.reason)}\n`
  const parts = [sectionBanner(m)]
  parts.push(`> **Readiness tracking, not a certification.** This section reports how current Vireek's own control-evidence collection is. It does not state or imply SOC 2 compliance, an audit, an attestation or any certification. Any external wording about it is **[COUNSEL]**.\n`)
  parts.push(`Snapshot at ${ctx.generatedAt.toISOString()} (the source view uses now() and cannot be reconstructed for a past date).\n`)
  const row = (label, key) => [label, count(m.byState[key] ?? 0)]
  parts.push(mdTable(['Evidence state', 'Controls'], [
    row('fresh (all collectors within their cadence)', 'fresh'), row('overdue', 'overdue'), row('failing', 'failing'),
    row('never collected', 'never'), row('incomplete (some collectors never ran)', 'incomplete'), row('not applicable (no collectors)', 'not_applicable'),
    ...(m.byState.unknown ? [row('unrecognised state', 'unknown')] : []),
  ]))
  parts.push('')
  parts.push(`Controls with current evidence: ${count(m.byState.fresh ?? 0)} of ${count(m.applicable)} applicable (${pct(m.byState.fresh ?? 0, m.applicable)}). Declared status in the registry — met: ${count(m.byDeclared.met ?? 0)}, partial: ${count(m.byDeclared.partial ?? 0)}, missing: ${count(m.byDeclared.missing ?? 0)}.\n`)
  if (m.attention.length) {
    const shown = m.attention.slice(0, 20)
    parts.push('**Needs attention**\n')
    parts.push(mdTable(['Control', 'Category', 'Evidence state', 'Declared', 'Last evidence', 'Next due', 'Owner role'], shown.map((c) => [c.id, c.category, c.evidence_state, c.status, c.last_evidence_at ? String(c.last_evidence_at).slice(0, 10) : NA, c.next_due_at ? String(c.next_due_at).slice(0, 10) : NA, c.owner_role])))
    if (m.attention.length > shown.length) parts.push(`\n…and ${m.attention.length - shown.length} more not listed.`)
    parts.push('')
  } else {
    parts.push('No control is overdue, failing, never collected or incomplete.\n')
  }
  if (m.dueSoon.length) {
    parts.push(`**Evidence due within 30 days of generation (${m.dueSoon.length})**\n`)
    parts.push(mdTable(['Control', 'Next due', 'Category'], m.dueSoon.slice(0, 10).map((c) => [c.id, String(c.next_due_at).slice(0, 10), c.category])))
    parts.push('')
  }
  parts.push('**Not available**\n')
  parts.push(bullets([
    `Legal, regulatory, tax-filing and contract-renewal deadlines: ${na('no company-level calendar of these exists in any view or table found in the repository [VERIFY]; track them with counsel [COUNSEL]')}`,
    'Gap descriptions and control owners by name are deliberately not pulled into this pack; see docs/compliance/gap-list.md and docs/compliance/soc2/CONTROL_MAP.md.',
  ]))
  return parts.join('\n')
}

export function renderSources(queryStatus, ctx) {
  const rows = SOURCES.map((s) => [s.object, s.type, s.used, s.basis, s.access, s.defined.join('; '), ctx.dryRun ? 'not queried (dry run)' : (queryStatus[s.id] ?? 'not queried')])
  return `${mdTable(['Object', 'Type', 'Used for', 'Time basis', 'Access', 'Defined in', 'Read status'], rows)}

**How to read this pack**

${bullets([
    `Every figure is measured from one of the objects above. If a source could not be read, or does not exist, the figure is shown as "${NA}" with the reason. The script never estimates, interpolates, extrapolates or substitutes a default.`,
    'A zero is a measured zero from a source that answered. A failed or partial read is never rendered as 0.',
    'All periods are UTC calendar months, start inclusive and end exclusive.',
    'Figures marked as generation-time snapshots describe the state when the script ran, not the end of the period.',
    '[VERIFY] items are facts this script could not establish from the repository. [COUNSEL] items need legal review before external use.',
  ])}
`
}

// Summary + attention are derived only from section models, so they cannot disagree with the sections below them.
export function buildSummaryAndAttention(models, ctx) {
  const lines = []
  const attention = []
  const note = (s) => attention.push(s)

  if (models.arr.status === 'unavailable') lines.push(`ARR: ${na(models.arr.reason)}`)
  else for (const c of models.arr.currencies) lines.push(`ARR (closing MRR × 12, ${currencyLabel(c.currency)}): ${c.closing === null ? NA : formatMoney(c.closing * 12, c.currency)}; net MRR change in the month: ${c.opening === null || c.closing === null ? NA : formatMoney(c.closing - c.opening, c.currency)}`)

  if (models.retention.status === 'unavailable') lines.push(`Retention: ${na(models.retention.reason)}`)
  else for (const c of models.retention.currencies) lines.push(`Retention (${currencyLabel(c.currency)}, monthly): GRR ${pct(c.cohort.floor, c.cohort.opening)}, NRR ${pct(c.cohort.closing, c.cohort.opening)}, logo retention ${c.cohort.n !== null && c.cohort.churned !== null ? pct(c.cohort.n - c.cohort.churned, c.cohort.n) : NA}`)

  lines.push(models.usage.status === 'unavailable' ? `Usage: ${na(models.usage.reason)}` : `Usage: ${count(models.usage.accountsFirstCall)} account(s) reached a first answered call`)
  lines.push(models.incidents.status === 'unavailable' ? `Incidents: ${na(models.incidents.reason)}` : `Incidents: ${count(models.incidents.total)} recorded (${count(models.incidents.major)} major); mean time to resolve ${models.incidents.mttr === null ? NA : formatDuration(models.incidents.mttr)}`)
  if (models.compliance.status === 'unavailable') lines.push(`Compliance calendar: ${na(models.compliance.reason)}`)
  else {
    const bad = ATTENTION_STATES.reduce((s, k) => s + (models.compliance.byState[k] ?? 0), 0)
    lines.push(`Compliance calendar (readiness evidence, snapshot): ${count(bad)} control(s) overdue, failing, never collected or incomplete; ${count(models.compliance.byState.fresh ?? 0)} of ${count(models.compliance.applicable)} applicable controls have current evidence`)
  }

  for (const [name, m] of Object.entries(models)) {
    if (m.status === 'unavailable') note(`${name}: ${m.reason}`)
    else if (m.status === 'partial') note(`${name}: partial data${m.reason ? ` (${m.reason})` : ''}`)
  }
  if (models.arr.status !== 'unavailable') {
    for (const c of models.arr.currencies) if (c.reconciles === false) note(`ARR (${currencyLabel(c.currency)}): reconciliation failed; do not circulate`)
    if (models.arr.history === 'starts_after_period' || models.arr.history === 'ambiguous') note('ARR and retention: subscription ledger history may not cover the full period')
  }
  if (models.retention.status !== 'unavailable') {
    for (const c of models.retention.currencies) if (c.cohort.n !== null && c.cohort.n < SMALL_COHORT) note(`Retention (${currencyLabel(c.currency)}): small cohort (n = ${c.cohort.n})`)
  }
  return { summary: bullets(lines), attention: attention.length ? bullets([...new Set(attention)]) : 'None. All five sections were read in full. This is not an assurance of accuracy; the reconciliation and notes in each section still apply.' }
}

export function renderTemplate(templateText, values) {
  const at = templateText.indexOf(TEMPLATE_MARKER)
  if (at < 0) throw new UsageError(`template is missing the marker ${TEMPLATE_MARKER}`)
  const body = templateText.slice(at + TEMPLATE_MARKER.length).replace(/^\r?\n/, '')
  const seen = new Set()
  for (const m of body.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)) {
    if (!REQUIRED_TOKENS.includes(m[1])) throw new UsageError(`template uses unknown token {{${m[1]}}}`)
    seen.add(m[1])
  }
  const missing = REQUIRED_TOKENS.filter((t) => !seen.has(t))
  if (missing.length) throw new UsageError(`template is missing required token(s): ${missing.map((t) => `{{${t}}}`).join(', ')}; dropping a section silently is not allowed`)
  return body.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_, name) => {
    if (typeof values[name] !== 'string') throw new UsageError(`no value supplied for {{${name}}}`)
    return values[name]
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------------------------
export async function collect({ reader, ctx }) {
  const status = {}
  const track = (id, r) => { status[id] = r.ok ? 'read OK' : `failed (${r.error})`; return r }
  const startIso = ctx.period.start.toISOString()
  const endIso = ctx.period.end.toISOString()

  const [summary, digest, facts, usage, incidents, carry, feed, compliance] = await Promise.all([
    settle(reader.rpc('growth_period_summary', { p_start: startIso, p_end: endIso })).then((r) => track('growth_period_summary', r)),
    settle(reader.rpc('growth_digest_snapshot', {})).then((r) => track('growth_digest_snapshot', r)),
    settle(reader.rpcAll('growth_latest_facts', {})).then((r) => track('growth_latest_facts', r)),
    settle(reader.selectAll('first_call_kpi_daily', [['select', 'day,accounts,p50_seconds_to_first_call,p90_seconds_to_first_call,p50_seconds_to_wow'], ['day', `gte.${ctx.period.firstDayIso}`], ['day', `lt.${isoDay(ctx.period.end)}`], ['order', 'day.asc']])).then((r) => track('first_call_kpi_daily', r)),
    settle(reader.selectAll('status_incidents', [['select', 'id,title,impact,status,component_id,source,started_at,resolved_at'], ['started_at', `gte.${startIso}`], ['started_at', `lt.${endIso}`], ['order', 'started_at.asc']])).then((r) => track('status_incidents', r)),
    settle(reader.selectAll('status_incidents', [['select', 'id,impact,started_at'], ['status', 'neq.resolved'], ['started_at', `lt.${startIso}`], ['order', 'started_at.asc']])),
    settle(reader.rpc('public_status_feed', {})).then((r) => track('public_status_feed', r)),
    settle(reader.selectAll('compliance_control_status', [['select', 'id,category,title,status,owner_role,frequency_days,last_evidence_at,next_due_at,evidence_state'], ['order', 'id.asc']])).then((r) => track('compliance_control_status', r)),
  ])
  return { status, ledger: { summary, digest, facts }, usage, incidents, carry, feed, compliance }
}

export async function generate({ now = new Date(), monthKey, dryRun = false, allowPartial = false, env = process.env, fetchImpl, templateText }) {
  const key = monthKey ?? previousMonthKey(now)
  const period = periodBounds(key)
  const partialPeriod = period.end > now
  if (period.start > now) throw new UsageError(`${period.label} is in the future`)
  if (partialPeriod && !allowPartial) throw new UsageError(`${period.label} has not finished (it ends ${period.end.toISOString()}). Use --allow-partial for a clearly labelled in-progress pack.`)
  const ctx = { period, generatedAt: now, dryRun }

  let collected = { status: {}, ledger: null, usage: null, incidents: null, carry: null, feed: null, compliance: null }
  if (!dryRun) {
    const reader = createReader({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl })
    collected = await collect({ reader, ctx })
  }
  const billing = buildBilling(collected.ledger, ctx)
  const models = {
    arr: billing.arr,
    retention: billing.retention,
    usage: buildUsage(collected.usage, ctx),
    incidents: buildIncidents(collected.incidents, collected.carry, collected.feed, ctx),
    compliance: buildCompliance(collected.compliance, ctx),
  }
  const { summary, attention } = buildSummaryAndAttention(models, ctx)
  const reportStatus = [
    '**DRAFT — machine-generated; requires human review before distribution.**',
    'Figures are measured from the sources in section 7, never estimated. Anything that could not be measured is shown as "not available".',
    ...(partialPeriod ? [`**PARTIAL PERIOD:** ${period.label} is still in progress; figures run to ${now.toISOString()}.`] : []),
    ...(dryRun ? ['**DRY RUN:** no data source was queried; every figure is "not available".'] : []),
  ].join('\n\n')

  const markdown = renderTemplate(templateText, {
    period_label: period.label,
    period_start: period.firstDayIso,
    period_end: partialPeriod ? isoDay(now) : period.lastDayIso,
    generated_at: now.toISOString(),
    report_status: reportStatus,
    'section.summary': summary,
    'section.attention': attention,
    'section.arr': renderArr(models.arr, ctx),
    'section.retention': renderRetention(models.retention),
    'section.usage': renderUsage(models.usage),
    'section.incidents': renderIncidents(models.incidents, ctx),
    'section.compliance': renderCompliance(models.compliance, ctx),
    'section.sources': renderSources(collected.status, ctx),
  })
  return { markdown, models, period }
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------
export function parseArgs(argv) {
  const out = { month: null, out: null, stdout: false, dryRun: false, force: false, allowPartial: false, strict: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--month' || a === '--out') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new UsageError(`${a} needs a value`)
      out[a === '--month' ? 'month' : 'out'] = v
    } else if (a === '--stdout') out.stdout = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--force') out.force = true
    else if (a === '--allow-partial') out.allowPartial = true
    else if (a === '--strict') out.strict = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new UsageError(`unknown argument ${a}`)
  }
  return out
}

const HELP = `Usage: node scripts/reporting/board-pack.mjs [--month YYYY-MM] [--out path] [--stdout] [--dry-run] [--force] [--allow-partial] [--strict]
Env:   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (not needed with --dry-run)
Writes reports/board-pack/YYYY-MM.md by default; refuses to overwrite without --force (the file is meant to be edited by hand).`

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) { console.log(HELP); return 0 }
  const templatePath = resolve(ROOT, TEMPLATE_PATH)
  if (!existsSync(templatePath)) throw new UsageError(`template not found: ${TEMPLATE_PATH}`)
  const now = new Date()
  const monthKey = args.month ?? previousMonthKey(now)
  parseMonth(monthKey) // validate before the value is used in a file path
  const target = resolve(ROOT, args.out ?? `reports/board-pack/${monthKey}.md`)
  if (!args.stdout && !args.force && existsSync(target)) throw new UsageError(`${target} already exists; pass --force to overwrite (this would discard hand-written commentary)`)

  const { markdown, models } = await generate({ now, monthKey, dryRun: args.dryRun, allowPartial: args.allowPartial, templateText: readFileSync(templatePath, 'utf8') })
  if (args.stdout) process.stdout.write(markdown)
  else {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, markdown, { mode: 0o600, flag: args.force ? 'w' : 'wx' })
    console.error(`board pack written: ${target}`)
  }
  const notFull = Object.entries(models).filter(([, m]) => m.status !== 'ok').map(([k, m]) => `${k}=${m.status}`)
  if (notFull.length) console.error(`sections not fully available: ${notFull.join(', ')}`)
  return args.strict && notFull.length ? 3 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code }, (e) => {
    console.error(e instanceof UsageError ? `error: ${e.message}` : `unexpected failure: ${e?.stack ?? e}`)
    process.exitCode = e instanceof UsageError ? 2 : 1
  })
}
