#!/usr/bin/env node
// scripts/governance/check-adr.mjs
//
// Fails when an Architecture Decision Record (docs/adr/NNNN-*.md) is missing a required field, links to
// evidence that does not exist, or is internally inconsistent (status vs. evidence, supersession chain).
//
// Scope: ADR 0003 and later. ADR 0001 and 0002 predate the front-matter format; they are reported as
// warnings, never errors (see LEGACY). Zero dependencies on purpose: the CI job runs without `npm ci`.
//
// Usage:  node scripts/governance/check-adr.mjs            (check, exit 1 on any error)
//         node scripts/governance/check-adr.mjs --json     (machine-readable result)

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ADR_DIR = 'docs/adr'
export const FIRST_ENFORCED_NUMBER = 3
export const LEGACY = new Set(['0001-feature-store-pilot.md', '0002-watch-companion-apps.md'])
export const NON_ADR_FILES = new Set(['README.md', 'TEMPLATE.md'])

export const STATUSES = ['proposed', 'accepted', 'rejected', 'superseded', 'deprecated']
export const CONFIDENCE = ['high', 'medium', 'low']
export const EVIDENCE_KINDS = ['repo', 'research', 'metric', 'external', 'assumption']
/** Kinds that count as real evidence for an *accepted* decision. `external` alone is not enough: it is hearsay until checked. */
export const GROUNDING_KINDS = ['repo', 'research', 'metric']
export const REQUIRED_FIELDS = ['id', 'title', 'status', 'date', 'deciders', 'confidence', 'review_by', 'evidence']
export const REQUIRED_HEADINGS = ['Context', 'Decision', 'Alternatives considered', 'Consequences', 'Evidence']

const FILE_RE = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const PLACEHOLDER_RE = /(<[^>\n]+>|\bTODO\b|\bTBD\b|\bFIXME\b|\.\.\.)/

/** Minimal front-matter reader: flat `key: value`, `key: [a, b]`, and `key:` followed by `  - item` lines. */
export function parseFrontMatter(raw) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!text.startsWith('---\n')) return { error: 'missing front matter: the file must start with a line containing only ---' }
  const end = text.indexOf('\n---', 4)
  if (end === -1) return { error: 'front matter is not closed with a line containing only ---' }
  const block = text.slice(4, end)
  const body = text.slice(end + 4).replace(/^\n/, '')
  const data = {}
  let listKey = null
  for (const [i, line] of block.split('\n').entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item) {
      if (!listKey) return { error: `front matter line ${i + 1}: list item without a key` }
      data[listKey].push(unquote(item[1]))
      continue
    }
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line)
    if (!kv) return { error: `front matter line ${i + 1}: cannot parse "${line.trim()}"` }
    const [, key, valueRaw] = kv
    if (key in data) return { error: `front matter: duplicate key "${key}"` }
    const value = valueRaw.trim()
    if (value === '') { data[key] = []; listKey = key; continue }
    listKey = null
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim()
      data[key] = inner === '' ? [] : inner.split(',').map((s) => unquote(s.trim()))
    } else data[key] = unquote(value)
  }
  return { data, body }
}

function unquote(s) {
  return /^(".*"|'.*')$/.test(s) ? s.slice(1, -1) : s
}

function isRealDate(s) {
  const m = DATE_RE.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

function headingsOutsideCode(body) {
  const out = []
  let fenced = false
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m) out.push(m[1].replace(/^\d+[.)]\s*/, ''))
  }
  return out
}

function sectionText(body, heading) {
  const lines = body.split('\n')
  let fenced = false
  let inSection = false
  const buf = []
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const m = !fenced && /^##\s+(.+?)\s*$/.exec(line)
    if (m) { inSection = m[1].replace(/^\d+[.)]\s*/, '') === heading; continue }
    if (inSection) buf.push(line)
  }
  return buf.join('\n').trim()
}

/** Resolve a repo-relative reference safely. Returns null if it escapes the repo root. */
function resolveInside(root, ref) {
  const path = ref.split('#')[0].trim()
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.includes('\\')) return null
  const abs = resolve(root, path)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || rel.split(sep).includes('..')) return null
  return abs
}

export function checkAdrs({ root = '.', now = new Date() } = {}) {
  const errors = []
  const warnings = []
  const dir = join(root, ADR_DIR)
  if (!existsSync(dir)) return { errors: [`${ADR_DIR}/ does not exist`], warnings, checked: 0 }

  const files = readdirSync(dir).filter((f) => !NON_ADR_FILES.has(f)).sort()
  const parsed = new Map() // id -> { file, data }
  const numbers = new Map() // number -> file
  let checked = 0

  for (const file of files) {
    const where = `${ADR_DIR}/${file}`
    if (!file.endsWith('.md')) { errors.push(`${where}: only .md files belong in ${ADR_DIR}/`); continue }
    const nameMatch = FILE_RE.exec(file)
    if (!nameMatch) { errors.push(`${where}: file name must look like 0003-short-kebab-title.md`); continue }
    const num = Number(nameMatch[1])
    if (numbers.has(num)) errors.push(`${where}: number ${nameMatch[1]} is already used by ${numbers.get(num)}`)
    numbers.set(num, file)
    if (LEGACY.has(file) || num < FIRST_ENFORCED_NUMBER) {
      warnings.push(`${where}: legacy ADR (pre front-matter format) — not validated`)
      continue
    }
    checked++

    const raw = readFileSync(join(dir, file), 'utf8')
    const fm = parseFrontMatter(raw)
    if (fm.error) { errors.push(`${where}: ${fm.error}`); continue }
    const { data, body } = fm
    const err = (m) => errors.push(`${where}: ${m}`)

    for (const f of REQUIRED_FIELDS) {
      const v = data[f]
      if (v === undefined || (typeof v === 'string' && v === '') || (Array.isArray(v) && v.length === 0)) err(`missing required field "${f}"`)
    }
    for (const [k, v] of Object.entries(data)) {
      const flat = Array.isArray(v) ? v.join(' ') : v
      if (PLACEHOLDER_RE.test(flat)) err(`field "${k}" still contains a template placeholder: ${flat}`)
    }

    const expectedId = `ADR-${nameMatch[1]}`
    if (data.id && data.id !== expectedId) err(`id must be ${expectedId} to match the file name (found "${data.id}")`)
    if (data.status && !STATUSES.includes(data.status)) err(`status must be one of ${STATUSES.join(', ')} (found "${data.status}")`)
    if (data.confidence && !CONFIDENCE.includes(data.confidence)) err(`confidence must be one of ${CONFIDENCE.join(', ')} (found "${data.confidence}")`)
    if (data.date && !isRealDate(data.date)) err(`date must be a real YYYY-MM-DD date (found "${data.date}")`)
    if (data.review_by && !isRealDate(data.review_by)) err(`review_by must be a real YYYY-MM-DD date (found "${data.review_by}")`)
    if (isRealDate(data.date ?? '') && isRealDate(data.review_by ?? '') && data.review_by < data.date) err('review_by cannot be earlier than date')
    if (Array.isArray(data.deciders) === false && data.deciders) err('deciders must be a list, e.g. deciders: [OWNER_PLATFORM]')

    // Evidence: every entry is "kind:reference", and local references must resolve to a real file.
    const evidence = Array.isArray(data.evidence) ? data.evidence : []
    const kinds = []
    for (const entry of evidence) {
      const m = /^([a-z]+):\s*(\S.*)$/.exec(entry)
      if (!m || !EVIDENCE_KINDS.includes(m[1])) { err(`evidence entry "${entry}" must start with one of ${EVIDENCE_KINDS.map((k) => k + ':').join(' ')}`); continue }
      const [, kind, refRaw] = m
      const ref = refRaw.replace(/\s+\[VERIFY\]\s*$/i, '').trim()
      kinds.push(kind)
      if (kind === 'repo' || kind === 'research') {
        const abs = resolveInside(root, ref)
        if (!abs) err(`evidence "${entry}": path must be repo-relative and stay inside the repository`)
        else if (!existsSync(abs)) err(`evidence "${entry}": file not found`)
        else if (kind === 'research' && !relative(root, abs).split(sep).join('/').startsWith('docs/research/')) err(`evidence "${entry}": research evidence must live under docs/research/`)
      } else if (kind === 'external') {
        if (!/^https:\/\/\S+$/.test(ref)) err(`evidence "${entry}": external evidence must be an https:// URL`)
      } else if (kind === 'metric' && ref.length < 8) err(`evidence "${entry}": describe the metric and where it is measured`)
      else if (kind === 'assumption' && ref.length < 8) err(`evidence "${entry}": state the assumption in a full sentence`)
    }
    const grounded = kinds.filter((k) => GROUNDING_KINDS.includes(k)).length
    if (data.status === 'accepted' && grounded === 0) err('an accepted decision needs at least one repo:, research: or metric: evidence entry (external: and assumption: alone do not count)')
    if (data.status === 'accepted' && data.confidence === 'high' && grounded === 0) err('confidence "high" needs grounded evidence')

    // Body structure.
    const have = headingsOutsideCode(body)
    for (const h of REQUIRED_HEADINGS) if (!have.includes(h)) err(`missing required section "## ${h}"`)
    if (have.includes('Evidence') && sectionText(body, 'Evidence').length < 20) err('section "## Evidence" is empty — explain what each evidence entry shows')
    if (have.includes('Decision') && sectionText(body, 'Decision').length < 20) err('section "## Decision" is empty')

    // Supersession links, resolved after every file has been read.
    parsed.set(expectedId, { file, data, where })
  }

  for (const [id, { data, where }] of parsed) {
    const list = (v) => (Array.isArray(v) ? v : v ? [v] : [])
    for (const t of list(data.supersedes)) {
      if (!/^ADR-\d{4}$/.test(t)) errors.push(`${where}: supersedes entry "${t}" must look like ADR-0004`)
      else if (t === id) errors.push(`${where}: an ADR cannot supersede itself`)
      else if (![...numbers.keys()].some((n) => `ADR-${String(n).padStart(4, '0')}` === t)) errors.push(`${where}: supersedes ${t}, which does not exist`)
    }
    const by = list(data.superseded_by)
    for (const t of by) {
      if (!/^ADR-\d{4}$/.test(t)) errors.push(`${where}: superseded_by entry "${t}" must look like ADR-0004`)
      else if (![...numbers.keys()].some((n) => `ADR-${String(n).padStart(4, '0')}` === t)) errors.push(`${where}: superseded_by ${t}, which does not exist`)
    }
    if (data.status === 'superseded' && by.length === 0) errors.push(`${where}: status superseded requires superseded_by`)
    if (data.status !== 'superseded' && by.length > 0) errors.push(`${where}: superseded_by is set but status is "${data.status}"`)
    if (data.status === 'accepted' && isRealDate(data.review_by ?? '') && data.review_by < now.toISOString().slice(0, 10)) {
      warnings.push(`${where}: review_by ${data.review_by} has passed — re-confirm or supersede this decision`)
    }
  }

  return { errors, warnings, checked }
}

function main() {
  const json = process.argv.includes('--json')
  const result = checkAdrs({ root: process.cwd() })
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    for (const w of result.warnings) console.warn(`warning: ${w}`)
    if (result.errors.length) console.error(`ADR check failed (${result.errors.length}):\n${result.errors.map((e) => ' - ' + e).join('\n')}`)
    else console.log(`OK: ${result.checked} ADR(s) validated, ${result.warnings.length} warning(s).`)
  }
  process.exit(result.errors.length ? 1 : 0)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
