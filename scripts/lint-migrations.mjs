#!/usr/bin/env node
// Lints supabase/migrations.
// Legacy files -> warnings only. Files ADDED since BASE_SHA (or origin/main) -> strict.
// No usable git base -> everything is legacy, unless --all-strict.
//
// Errors (new files): bad name, duplicate version, empty file, destructive SQL
//   (DROP TABLE/COLUMN/SCHEMA/TYPE/DATABASE, TRUNCATE, DELETE without WHERE,
//    ALTER COLUMN TYPE, RENAME) -> opt out: -- lint:allow-destructive <reason>
// Warnings (new files): CREATE TABLE without ENABLE ROW LEVEL SECURITY
//   (opt out: -- lint:allow-no-rls <reason>), SECURITY DEFINER without SET search_path

import { readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const DIR = 'supabase/migrations'
const NAME_RE = /^(\d{14})_[a-z0-9_]+\.sql$/
const strictAll = process.argv.includes('--all-strict')

const all = readdirSync(DIR).filter((f) => !f.startsWith('.')).sort()

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}
function newFiles() {
  if (strictAll) return new Set(all)
  const raw = process.env.BASE_SHA
  const base = raw && !/^0+$/.test(raw) ? raw : 'origin/main'
  try {
    const out = git(['diff', '--name-only', '--diff-filter=AR', `${base}...HEAD`, '--', DIR])
    return new Set(out.split('\n').filter(Boolean).map((p) => p.split('/').pop()))
  } catch {
    console.log(`::notice::No git base (${base}) available — all migrations treated as legacy (warnings only).`)
    return new Set()
  }
}
const added = newFiles()

let errors = 0
const err = (f, msg) => { errors++; console.log(`::error file=${DIR}/${f},title=Migration lint::${msg}`) }
const warn = (f, msg) => console.log(`::warning file=${DIR}/${f},title=Migration lint::${msg}`)
const report = (f, msg) => (added.has(f) ? err(f, msg) : warn(f, `(legacy) ${msg}`))

// version -> files
let legacyDupes = 0
const legacyDupeList = []
const versions = new Map()
for (const f of all) {
  const m = NAME_RE.exec(f)
  if (!m) { report(f, 'file name must match YYYYMMDDHHMMSS_snake_case.sql (a non-.sql file is never applied)'); continue }
  versions.set(m[1], [...(versions.get(m[1]) ?? []), f])
}
for (const [v, fs] of versions) {
  if (fs.length < 2) continue
  const fresh = fs.filter((f) => added.has(f))
  if (fresh.length) {
    for (const f of fresh) err(f, `duplicate migration version ${v} shared with: ${fs.filter((x) => x !== f).join(', ')}`)
  } else {
    legacyDupes++
    legacyDupeList.push(`${v} (${fs.length} files)`)
  }
}
if (legacyDupes) {
  console.log(`::warning title=Migration lint::${legacyDupes} legacy duplicate version(s) — \`supabase db push\` rejects duplicate versions. First few: ${legacyDupeList.slice(0, 5).join(', ')}`)
}

// --- SQL helpers -----------------------------------------------------------
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
const stripStrings = (s) => s.replace(/'(?:[^']|'')*'/g, "''")
const stripDollar = (s) => s.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' $$ ')

const DESTRUCTIVE = [
  [/\bdrop\s+table\b/i, 'DROP TABLE'],
  [/\bdrop\s+column\b/i, 'DROP COLUMN'],
  [/\bdrop\s+schema\b/i, 'DROP SCHEMA'],
  [/\bdrop\s+database\b/i, 'DROP DATABASE'],
  [/\bdrop\s+type\b/i, 'DROP TYPE'],
  [/\btruncate\b/i, 'TRUNCATE'],
  [/\balter\s+table\b[^;]*\balter\s+column\b[^;]*\b(?:set\s+data\s+)?type\b/i, 'ALTER COLUMN TYPE'],
  [/\balter\s+table\b[^;]*\brename\s+(?:column\b|to\b)/i, 'RENAME TABLE/COLUMN'],
]

for (const f of all) {
  if (!added.has(f) || !f.endsWith('.sql')) continue
  const raw = readFileSync(join(DIR, f), 'utf8')
  if (!raw.trim()) { err(f, 'migration file is empty'); continue }

  const allowDestructive = /--\s*lint:allow-destructive\b/i.test(raw)
  const allowNoRls = /--\s*lint:allow-no-rls\b/i.test(raw)
  const code = stripStrings(stripComments(raw))
  const outsideBodies = stripDollar(code)

  if (!allowDestructive) {
    for (const [re, label] of DESTRUCTIVE) {
      if (re.test(code)) err(f, `destructive statement (${label}). If intentional add a comment: -- lint:allow-destructive <reason>`)
    }
    for (const stmt of outsideBodies.split(';')) {
      if (/^\s*delete\s+from\b/i.test(stmt) && !/\bwhere\b/i.test(stmt)) {
        err(f, 'DELETE without WHERE. If intentional add: -- lint:allow-destructive <reason>')
      }
    }
  }

  if (!allowNoRls) {
    const created = [...code.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi)].map((m) => m[1].toLowerCase())
    for (const t of new Set(created)) {
      const rls = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:public\\.)?"?${t}"?\\s+enable\\s+row\\s+level\\s+security`, 'i')
      if (!rls.test(code)) warn(f, `table "${t}" created without ENABLE ROW LEVEL SECURITY in the same file (opt out: -- lint:allow-no-rls <reason>)`)
    }
  }

  for (const m of code.matchAll(/\bcreate\s+(?:or\s+replace\s+)?function\b[\s\S]*?\$([A-Za-z_]*)\$/gi)) {
    const header = m[0]
    if (/\bsecurity\s+definer\b/i.test(header) && !/\bset\s+search_path\b/i.test(header)) {
      warn(f, 'SECURITY DEFINER function without SET search_path')
    }
  }
}

console.log(`Migrations: ${all.length} total, ${added.size} new/renamed checked strictly, ${errors} error(s).`)
process.exit(errors ? 1 : 0)
