#!/usr/bin/env node
// Backlog prioritization ranker (read-only, no network, no dependencies).
//
//   node scripts/product/prioritize.mjs backlog.csv                 ranked table on stdout
//   node scripts/product/prioritize.mjs backlog.csv --format md     markdown | csv | json | table (default)
//   node scripts/product/prioritize.mjs backlog.csv --top 10        only the first 10 ranks
//   node scripts/product/prioritize.mjs - < backlog.csv             read stdin
//   flags: --strict (warnings fail too)  --today YYYY-MM-DD (UTC, for repeatable staleness checks)  --stale-days N (default 90)
//
// Model, scales, tie-break and decision rights: docs/product/prioritization.md. Template: docs/product/prioritization-template.csv.
//   score = reach x impact x (confidence / 100) / effort
// All arithmetic is exact integer (BigInt) arithmetic, so equal scores are detected exactly and never by float luck.
// Exit codes: 0 ranked, 1 the data is invalid (or warnings under --strict), 2 usage / unreadable input.
// Tests: scripts/product/prioritize.test.mjs

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const REQUIRED_COLUMNS = ['id', 'title', 'owner', 'reach', 'impact', 'confidence', 'effort']
export const OPTIONAL_COLUMNS = ['gate', 'evidence', 'scored_on', 'notes']
/** Impact scale -> quarters, so the arithmetic stays integral (0.25 = 1 quarter). */
export const IMPACT_SCALE = new Map([[0.25, 1], [0.5, 2], [1, 4], [2, 8], [3, 12]])
export const CONFIDENCE_TIERS = [50, 80, 100]
export const GATES = ['none', 'security', 'legal', 'data_loss', 'commitment']
export const TIE_BREAK_ORDER = ['score', 'confidence', 'effort', 'reach', 'id']
export const DEFAULT_STALE_DAYS = 90
export const MAX_EFFORT_WEEKS = 520
const DAY_MS = 86_400_000
const FORMATS = ['table', 'md', 'csv', 'json']

export class CsvError extends Error {
  constructor(message, line) {
    super(`line ${line}: ${message}`)
    this.line = line
  }
}

// ---------------------------------------------------------------------------------------------------------------
// CSV (RFC 4180 subset: quotes, doubled quotes, CRLF/LF/CR, embedded newlines, UTF-8 BOM)
// ---------------------------------------------------------------------------------------------------------------
export function parseCsv(input) {
  const text = String(input ?? '').replace(/^\uFEFF/, '')
  const records = []
  let cells = []
  let cell = ''
  let inQuotes = false
  let quoteOpenedAt = 0
  let line = 1
  let recordLine = 1
  let afterQuote = false // just closed a quoted cell: only , or a line break may follow
  const endCell = () => { cells.push(cell); cell = ''; afterQuote = false }
  const endRecord = () => {
    endCell()
    if (!(cells.length === 1 && cells[0].trim() === '')) records.push({ line: recordLine, cells })
    cells = []
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else { inQuotes = false; afterQuote = true }
      } else {
        if (ch === '\n') line++
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      if (cell !== '' || afterQuote) throw new CsvError('unexpected quote inside an unquoted cell', line)
      inQuotes = true
      quoteOpenedAt = line
    } else if (ch === ',') {
      endCell()
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRecord()
      line++
      recordLine = line
    } else {
      if (afterQuote) throw new CsvError('text after a closing quote', line)
      cell += ch
    }
  }
  if (inQuotes) throw new CsvError('unterminated quoted cell', quoteOpenedAt)
  if (cell !== '' || cells.length > 0 || afterQuote) endRecord()
  return records
}

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DECIMAL_RE = /^\d+(\.\d+)?$/

function parseIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(t)
  const ok = d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
  return ok ? t : null
}

export function utcToday(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

/**
 * Turns CSV text into validated items. Never throws for data problems: every problem is returned with its line number
 * so the author can fix the whole file in one pass. Only malformed CSV structure aborts (reported as one error).
 * @returns {{ items: Item[], errors: string[], warnings: string[] }}
 */
export function parseItems(input, { today = utcToday(), staleDays = DEFAULT_STALE_DAYS } = {}) {
  const errors = []
  const warnings = []
  let records
  try {
    records = parseCsv(input)
  } catch (e) {
    return { items: [], errors: [e instanceof Error ? e.message : String(e)], warnings }
  }
  if (records.length === 0) return { items: [], errors: ['the file is empty: expected a header row'], warnings }

  const header = records[0].cells.map((h) => h.trim().toLowerCase())
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c))
  if (missing.length) return { items: [], errors: [`line ${records[0].line}: missing required column(s): ${missing.join(', ')}`], warnings }
  const seenHeader = new Set()
  for (const h of header) {
    if (seenHeader.has(h)) return { items: [], errors: [`line ${records[0].line}: duplicate column "${h}"`], warnings }
    seenHeader.add(h)
  }
  for (const h of header) {
    if (!REQUIRED_COLUMNS.includes(h) && !OPTIONAL_COLUMNS.includes(h)) warnings.push(`line ${records[0].line}: unknown column "${h}" is ignored`)
  }
  if (records.length === 1) return { items: [], errors: ['the file has a header but no items'], warnings }

  const todayMs = parseIsoDate(today)
  if (todayMs === null) return { items: [], errors: [`invalid --today value "${today}" (expected YYYY-MM-DD)`], warnings }

  const items = []
  const ids = new Map()
  for (const rec of records.slice(1)) {
    const where = `line ${rec.line}`
    const problems = []
    if (rec.cells.length > header.length) {
      errors.push(`${where}: has ${rec.cells.length} cells but the header has ${header.length} (a comma inside a value must be quoted)`)
      continue
    }
    const get = (name) => {
      const idx = header.indexOf(name)
      return idx === -1 ? '' : (rec.cells[idx] ?? '').trim()
    }

    const id = get('id')
    if (!ID_RE.test(id)) problems.push('id must be 1-64 chars: letters, digits, ".", "_", "-" (start with a letter or digit)')
    else if (ids.has(id.toLowerCase())) problems.push(`duplicate id "${id}" (first used on line ${ids.get(id.toLowerCase())})`)
    else ids.set(id.toLowerCase(), rec.line)

    const title = get('title')
    if (!title) problems.push('title is required')
    else if (title.length > 200) problems.push('title is longer than 200 characters')

    const owner = get('owner')
    if (!owner) problems.push('owner is required')

    let reach = null
    const reachRaw = get('reach')
    if (/^\d{1,9}$/.test(reachRaw)) reach = Number(reachRaw)
    else problems.push(`reach must be a whole number of 0-999999999 (accounts affected in the next 90 days), got "${reachRaw}"`)

    let impactQ = null
    let impact = null
    const impactRaw = get('impact')
    if (DECIMAL_RE.test(impactRaw) && IMPACT_SCALE.has(Number(impactRaw))) { impact = Number(impactRaw); impactQ = IMPACT_SCALE.get(impact) }
    else problems.push(`impact must be one of ${[...IMPACT_SCALE.keys()].join(', ')}, got "${impactRaw}"`)

    let confidence = null
    const confRaw = get('confidence').replace(/%$/, '')
    if (/^\d{1,3}$/.test(confRaw) && CONFIDENCE_TIERS.includes(Number(confRaw))) confidence = Number(confRaw)
    else problems.push(`confidence must be one of ${CONFIDENCE_TIERS.join(', ')} (percent), got "${get('confidence')}". Below 50 means "do discovery first", not "score it low"`)

    let effortHalves = null
    let effort = null
    const effortRaw = get('effort')
    if (DECIMAL_RE.test(effortRaw)) {
      const n = Number(effortRaw)
      if (n <= 0 || n > MAX_EFFORT_WEEKS) problems.push(`effort must be greater than 0 and at most ${MAX_EFFORT_WEEKS} person-weeks`)
      else if (!Number.isInteger(n * 2)) problems.push('effort is estimated in steps of 0.5 person-week (finer precision is false precision)')
      else { effort = n; effortHalves = n * 2 }
    } else problems.push(`effort must be a number of person-weeks, got "${effortRaw}"`)

    const gateRaw = get('gate').toLowerCase()
    const gate = gateRaw === '' ? 'none' : gateRaw
    if (!GATES.includes(gate)) problems.push(`gate must be one of ${GATES.join(', ')} (or empty), got "${gateRaw}"`)

    const evidence = get('evidence')
    if (confidence !== null && confidence >= 80 && !evidence) problems.push('evidence is required when confidence is 80 or 100 (link or one-line source)')

    const scoredOn = get('scored_on')
    if (scoredOn) {
      const ms = parseIsoDate(scoredOn)
      if (ms === null) problems.push(`scored_on must be a real date as YYYY-MM-DD, got "${scoredOn}"`)
      else if (ms > todayMs) problems.push(`scored_on ${scoredOn} is in the future`)
      else if (Math.floor((todayMs - ms) / DAY_MS) > staleDays) warnings.push(`${where}: ${id || '(no id)'} was scored on ${scoredOn}, more than ${staleDays} days ago: re-score it`)
    } else {
      warnings.push(`${where}: ${id || '(no id)'} has no scored_on date, so staleness cannot be checked`)
    }
    if (/^EXAMPLE-/i.test(id)) warnings.push(`${where}: "${id}" looks like a template example row: delete it`)
    if (reach === 0) warnings.push(`${where}: ${id || '(no id)'} has reach 0, so its score is 0`)

    if (problems.length) {
      for (const p of problems) errors.push(`${where}: ${p}`)
      continue
    }
    const num = BigInt(reach) * BigInt(impactQ) * BigInt(confidence)
    const den = 200n * BigInt(effortHalves)
    items.push({
      id, title, owner, gate, reach, impact, confidence, effort, effortHalves,
      evidence, scoredOn: scoredOn || '', notes: get('notes'), line: rec.line,
      num, den,
    })
  }
  return { items, errors, warnings }
}

// ---------------------------------------------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------------------------------------------
const cmpBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const cmpId = (a, b) => a.id.localeCompare(b.id, 'en', { numeric: true, sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Negative when `a` ranks before `b`. Gated items form their own block first; then the documented tie-break order. */
export function compareItems(a, b) {
  const ga = a.gate !== 'none'
  const gb = b.gate !== 'none'
  if (ga !== gb) return ga ? -1 : 1
  return (
    -cmpBig(a.num * b.den, b.num * a.den) ||
    b.confidence - a.confidence ||
    a.effortHalves - b.effortHalves ||
    b.reach - a.reach ||
    cmpId(a, b)
  )
}

/** The first tie-break rule that separates two items of the same block, or null when the scores already differ. */
export function tieBreakBetween(prev, next) {
  if (prev.num * next.den !== next.num * prev.den) return null
  if (prev.confidence !== next.confidence) return 'confidence'
  if (prev.effortHalves !== next.effortHalves) return 'effort'
  if (prev.reach !== next.reach) return 'reach'
  return 'id'
}

export function scoreOf(item) {
  return Number(item.num) / Number(item.den)
}

export function rankItems(items) {
  const sorted = [...items].sort(compareItems)
  return sorted.map((item, i) => {
    const prev = sorted[i - 1]
    const sameBlock = prev && (prev.gate !== 'none') === (item.gate !== 'none')
    return {
      rank: i + 1,
      block: item.gate !== 'none' ? 'gated' : 'scored',
      score: Math.round(scoreOf(item) * 100) / 100,
      tieBreak: sameBlock ? tieBreakBetween(prev, item) : null,
      ...item,
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const fmtScore = (n) => n.toFixed(2)

export function renderTable(rows) {
  const cols = [
    ['#', (r) => String(r.rank)], ['id', (r) => r.id], ['score', (r) => fmtScore(r.score)],
    ['gate', (r) => (r.gate === 'none' ? '' : r.gate)], ['reach', (r) => String(r.reach)],
    ['impact', (r) => String(r.impact)], ['conf', (r) => `${r.confidence}%`], ['effort', (r) => String(r.effort)],
    ['tie', (r) => r.tieBreak ?? ''], ['title', (r) => trunc(r.title, 60)],
  ]
  const widths = cols.map(([h, f]) => Math.max(h.length, ...rows.map((r) => f(r).length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()
  return [line(cols.map(([h]) => h)), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map(([, f]) => f(r))))].join('\n') + '\n'
}

const mdCell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function renderMarkdown(rows) {
  const head = '| # | ID | Score | Gate | Reach | Impact | Confidence | Effort (pw) | Tie-break | Owner | Title |'
  const sep = '|---:|---|---:|---|---:|---:|---:|---:|---|---|---|'
  const body = rows.map((r) => `| ${r.rank} | ${mdCell(r.id)} | ${fmtScore(r.score)} | ${r.gate === 'none' ? '' : r.gate} | ${r.reach} | ${r.impact} | ${r.confidence}% | ${r.effort} | ${r.tieBreak ?? ''} | ${mdCell(r.owner)} | ${mdCell(r.title)} |`)
  return [head, sep, ...body].join('\n') + '\n'
}

/** A spreadsheet treats a cell starting with = + - @ (or tab/CR) as a formula: neutralise it before quoting. */
export function csvCell(value) {
  let s = String(value ?? '')
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function renderCsv(rows) {
  const head = ['rank', 'id', 'title', 'owner', 'gate', 'reach', 'impact', 'confidence', 'effort', 'score', 'tie_break']
  const body = rows.map((r) => [r.rank, r.id, r.title, r.owner, r.gate, r.reach, r.impact, r.confidence, r.effort, fmtScore(r.score), r.tieBreak ?? ''].map(csvCell).join(','))
  return [head.join(','), ...body].join('\n') + '\n'
}

export function renderJson(rows) {
  return JSON.stringify(
    rows.map((r) => ({
      rank: r.rank, id: r.id, title: r.title, owner: r.owner, block: r.block, gate: r.gate, reach: r.reach, impact: r.impact,
      confidence: r.confidence, effort: r.effort, score: r.score, scoreExact: `${r.num}/${r.den}`, tieBreak: r.tieBreak,
      evidence: r.evidence, scoredOn: r.scoredOn || null, notes: r.notes,
    })),
    null,
    2,
  ) + '\n'
}

export function render(rows, format) {
  if (format === 'md') return renderMarkdown(rows)
  if (format === 'csv') return renderCsv(rows)
  if (format === 'json') return renderJson(rows)
  return renderTable(rows)
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------
export const USAGE = `Usage: node scripts/product/prioritize.mjs <backlog.csv | -> [--format table|md|csv|json] [--top N] [--strict] [--today YYYY-MM-DD] [--stale-days N]`

export function parseArgs(argv) {
  const opts = { file: null, format: 'table', top: null, strict: false, today: null, staleDays: DEFAULT_STALE_DAYS, help: false }
  const takeValue = (i, flag) => {
    const v = argv[i + 1]
    if (v === undefined || (v.startsWith('--') && v !== '-')) throw new Error(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--strict') opts.strict = true
    else if (a === '--format') { opts.format = takeValue(i, a); i++ }
    else if (a === '--top') { opts.top = takeValue(i, a); i++ }
    else if (a === '--today') { opts.today = takeValue(i, a); i++ }
    else if (a === '--stale-days') { opts.staleDays = takeValue(i, a); i++ }
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`)
    else if (opts.file === null) opts.file = a
    else throw new Error(`unexpected argument "${a}" (only one input file)`)
  }
  if (!FORMATS.includes(opts.format)) throw new Error(`--format must be one of ${FORMATS.join(', ')}`)
  if (opts.top !== null) {
    if (!/^[1-9]\d{0,5}$/.test(opts.top)) throw new Error('--top must be a positive whole number')
    opts.top = Number(opts.top)
  }
  if (typeof opts.staleDays === 'string') {
    if (!/^\d{1,5}$/.test(opts.staleDays)) throw new Error('--stale-days must be a whole number of days')
    opts.staleDays = Number(opts.staleDays)
  }
  return opts
}

/** @returns exit code. `io` is injectable so tests need no child process. */
export function main(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s))
  const err = io.stderr ?? ((s) => process.stderr.write(s))
  const read = io.readInput ?? ((file) => readFileSync(file === '-' ? 0 : file, 'utf8'))
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    err(`${e.message}\n${USAGE}\n`)
    return 2
  }
  if (opts.help) { out(`${USAGE}\n`); return 0 }
  if (!opts.file) { err(`${USAGE}\n`); return 2 }
  let text
  try {
    text = read(opts.file)
  } catch (e) {
    err(`cannot read ${opts.file}: ${e.code ?? e.message}\n`)
    return 2
  }
  const { items, errors, warnings } = parseItems(text, { today: opts.today ?? utcToday(io.now), staleDays: opts.staleDays })
  if (errors.length) {
    err(`${errors.length} error(s), nothing ranked:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`)
    if (warnings.length) err(`${warnings.length} warning(s):\n${warnings.map((w) => `  - ${w}`).join('\n')}\n`)
    return 1
  }
  if (warnings.length) err(`${warnings.length} warning(s):\n${warnings.map((w) => `  - ${w}`).join('\n')}\n`)
  if (opts.strict && warnings.length) {
    err('--strict: warnings are treated as errors, nothing ranked\n')
    return 1
  }
  let ranked = rankItems(items)
  if (opts.top !== null) ranked = ranked.slice(0, opts.top)
  out(render(ranked, opts.format))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
