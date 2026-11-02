#!/usr/bin/env node
// Static database audit over supabase/migrations + client query scan. Needs no database.
//   node scripts/db-audit.mjs                  print report
//   node scripts/db-audit.mjs --write          also write docs/DB_AUDIT.md and docs/DB_ERD.md
//   node scripts/db-audit.mjs --check          exit 1 if any metric is worse than scripts/db-audit.baseline.json
//   node scripts/db-audit.mjs --write-baseline accept the current numbers as the baseline
// Static = approximate. The authoritative checks against a live database are the perf.* views.

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const DIR = 'supabase/migrations'
const BASELINE = 'scripts/db-audit.baseline.json'
const args = new Set(process.argv.slice(2))
const NAME_RE = /^\d{14}_[a-z0-9_]+\.sql$/

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
const norm = (s) => s.replace(/"/g, '').replace(/\bpublic\./gi, '').trim().toLowerCase()
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
const badNames = files.filter((f) => !NAME_RE.test(f))
const applied = files.filter((f) => NAME_RE.test(f))
const versions = new Map()
for (const f of applied) versions.set(f.slice(0, 14), [...(versions.get(f.slice(0, 14)) ?? []), f])
const duplicateVersions = [...versions].filter(([, v]) => v.length > 1).map(([k]) => k)

function splitTop(s) {
  const out = []
  let d = 0, cur = ''
  for (const c of s) {
    if (c === '(') d++
    if (c === ')') d--
    if (c === ',' && d === 0) { out.push(cur); cur = '' } else cur += c
  }
  if (cur.trim()) out.push(cur)
  return out
}
function matchParen(s, from) {
  let d = 1, i = from
  while (i < s.length && d > 0) { const c = s[i++]; if (c === '(') d++; else if (c === ')') d-- }
  return i
}
const cols = (s) => splitTop(s).map((c) => norm(c).split(/\s+/)[0]).filter((c) => c && !c.includes('('))

// ---- walk migrations in order ------------------------------------------------------------------
const vol = new Map()          // fn name -> 's' | 'i' | 'v'
const regressions = []
const idxDefs = new Map()      // index name -> Set(def)
const idxByTable = new Map()   // table -> [cols[]]
const tables = new Map()       // table -> { fks:[{cols,ref}], keys:[cols[]] }
let policies = 0, unwrapped = 0, concurrently = 0, indexStmts = 0

for (const f of applied) {
  const sql = strip(readFileSync(join(DIR, f), 'utf8'))

  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w."]+)\s*\(/gi)) {
    const end = matchParen(sql, m.index + m[0].length)
    const rest = sql.slice(end)
    const cut = rest.search(/\bas\s+(?:\$|')/i)
    const header = (cut < 0 ? rest.slice(0, 400) : rest.slice(0, cut)).toLowerCase()
    const name = norm(m[1])
    const v = /\bimmutable\b/.test(header) ? 'i' : /\bstable\b/.test(header) ? 's' : 'v'
    const prev = vol.get(name)
    if (prev && prev !== 'v' && v === 'v') regressions.push({ fn: name, file: f, was: prev })
    vol.set(name, v)
  }
  for (const m of sql.matchAll(/alter\s+function\s+([\w."]+)\s*\([^)]*\)\s+(stable|immutable|volatile)\b/gi)) {
    vol.set(norm(m[1]), m[2][0].toLowerCase())
  }

  for (const m of sql.matchAll(/create\s+policy\b[\s\S]*?;/gi)) {
    policies++
    const bare = m[0].replace(/\(\s*select\s+(?:public\.)?(?:auth\.(?:uid|jwt|role)|get_account_owner_id)\(\)(?:\s+as\s+\w+)?\s*\)/gi, '')
    if (/\b(?:auth\.(?:uid|jwt|role)|get_account_owner_id)\s*\(\)/i.test(bare)) unwrapped++
  }

  for (const m of sql.matchAll(/create\s+(unique\s+)?index\s+(concurrently\s+)?(?:if\s+not\s+exists\s+)?([\w."]+)\s+on\s+(?:only\s+)?([\w."]+)\s*(?:using\s+(\w+)\s*)?\(([^;]*?)\)\s*(where[^;]*)?;/gi)) {
    indexStmts++
    if (m[2]) concurrently++
    const name = norm(m[3]), table = norm(m[4])
    const def = `${table}|${m[5] ?? 'btree'}|${norm(m[6]).replace(/\s+/g, ' ')}|${norm(m[7] ?? '')}|${m[1] ? 'u' : ''}`
    idxDefs.set(name, (idxDefs.get(name) ?? new Set()).add(def))
    if (!m[7] && (!m[5] || /btree/i.test(m[5]))) idxByTable.set(table, [...(idxByTable.get(table) ?? []), cols(m[6])])
  }

  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(/gi)) {
    const name = norm(m[1])
    if (tables.has(name)) continue
    const body = sql.slice(m.index + m[0].length, matchParen(sql, m.index + m[0].length) - 1)
    const t = { fks: [], keys: [] }
    for (const part of splitTop(body)) {
      const p = part.trim().replace(/\s+/g, ' ')
      let x
      if ((x = /^(?:constraint \S+ )?foreign key \(([^)]*)\) references ([\w."]+)/i.exec(p))) t.fks.push({ cols: cols(x[1]), ref: norm(x[2]) })
      else if ((x = /^(?:constraint \S+ )?(?:primary key|unique) \(([^)]*)\)/i.exec(p))) t.keys.push(cols(x[1]))
      else if (!/^(?:constraint|check|exclude|like)\b/i.test(p)) {
        const col = norm(p).split(' ')[0]
        if (/\bprimary key\b|\bunique\b/i.test(p)) t.keys.push([col])
        if ((x = /\breferences ([\w."]+)/i.exec(p))) t.fks.push({ cols: [col], ref: norm(x[1]) })
      }
    }
    tables.set(name, t)
  }
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)[^;,]*?\breferences\s+([\w."]+)/gi)) {
    const t = tables.get(norm(m[1])); if (t) t.fks.push({ cols: [norm(m[2])], ref: norm(m[3]) })
  }
}

const shadowed = [...idxDefs].filter(([, d]) => d.size > 1).map(([n, d]) => ({ name: n, defs: [...d] }))
const volatileFinal = regressions.filter((r) => vol.get(r.fn) === 'v')
const fkNoIndex = []
for (const [tn, t] of tables) {
  const have = [...t.keys, ...(idxByTable.get(tn) ?? [])]
  for (const fk of t.fks) {
    const covered = have.some((c) => c.length >= fk.cols.length && fk.cols.every((x) => c.slice(0, fk.cols.length).includes(x)))
    if (!covered) fkNoIndex.push(`${tn}(${fk.cols.join(',')}) -> ${fk.ref}`)
  }
}

// ---- client query scan (heuristic) ---------------------------------------------------------------
const unbounded = new Map()
function walk(d, out = []) {
  for (const e of readdirSync(d)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (['.ts', '.tsx'].includes(extname(p)) && !/\.(test|spec)\./.test(p)) out.push(p)
  }
  return out
}
for (const root of ['src', 'supabase/functions']) {
  if (!existsSync(root)) continue
  for (const p of walk(root)) {
    const src = readFileSync(p, 'utf8')
    for (const m of src.matchAll(/\.from\(\s*['"`](\w+)['"`]\s*\)([\s\S]{0,700}?)(?:;|\n\s*\n)/g)) {
      const body = m[2]
      if (!/\.select\(/.test(body)) continue
      if (/\.(limit|range|single|maybeSingle|insert|update|delete|upsert)\(|head:\s*true/.test(body)) continue
      unbounded.set(m[1], (unbounded.get(m[1]) ?? 0) + 1)
    }
  }
}
const unboundedTop = [...unbounded].sort((a, b) => b[1] - a[1])

// ---- report ----------------------------------------------------------------------------------------
const metrics = {
  badMigrationNames: badNames.length,
  duplicateVersions: duplicateVersions.length,
  volatilityRegressions: volatileFinal.map((r) => r.fn).sort(),
  unwrappedPolicies: unwrapped,
  shadowedIndexNames: shadowed.length,
  fkWithoutIndexStatic: fkNoIndex.length,
  unboundedClientSelects: [...unbounded.values()].reduce((a, b) => a + b, 0),
}
const md = [
  '# DB static audit (generated by scripts/db-audit.mjs; do not edit)',
  '',
  `Migrations: ${applied.length} applied-format files, tables parsed: ${tables.size}, policies: ${policies}, index statements: ${indexStmts} (CONCURRENTLY: ${concurrently}).`,
  '',
  '| Metric | Value |', '|---|---|',
  `| Non-canonical migration file names (never applied) | ${badNames.length}${badNames.length ? ': ' + badNames.join(', ') : ''} |`,
  `| Duplicate migration versions | ${duplicateVersions.length}${duplicateVersions.length ? ': ' + duplicateVersions.join(', ') : ''} |`,
  `| Functions whose STABLE/IMMUTABLE was reset to VOLATILE by a later CREATE OR REPLACE | ${volatileFinal.length ? volatileFinal.map((r) => `${r.fn} (${r.file})`).join('; ') : 'none'} |`,
  `| RLS policy statements with unwrapped auth.uid()/auth.jwt()/get_account_owner_id() | ${unwrapped} of ${policies} |`,
  `| Index names defined more than once with different definitions (later ones are silently skipped by IF NOT EXISTS) | ${shadowed.length} |`,
  `| Foreign keys with no covering index (approximate) | ${fkNoIndex.length} |`,
  `| Client selects with no limit/range/single (heuristic; PostgREST silently caps at max_rows, default 1000) | ${metrics.unboundedClientSelects} |`,
  '',
  '## Shadowed index definitions (first 25)',
  ...shadowed.slice(0, 25).map((s) => `- \`${s.name}\`: ${s.defs.join('  vs  ')}`),
  '',
  '## Foreign keys without covering index (first 40, approximate)',
  ...fkNoIndex.slice(0, 40).map((s) => `- ${s}`),
  '',
  '## Tables with most unbounded client selects (top 20)',
  ...unboundedTop.slice(0, 20).map(([t, n]) => `- ${t}: ${n}`),
  '',
].join('\n')

const deg = new Map()
for (const [tn, t] of tables) for (const fk of t.fks) { deg.set(tn, (deg.get(tn) ?? 0) + 1); deg.set(fk.ref, (deg.get(fk.ref) ?? 0) + 1) }
const top = new Set([...deg].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k]) => k))
const erd = ['# ERD: 40 most connected tables (generated by scripts/db-audit.mjs)', '', '```mermaid', 'erDiagram']
for (const [tn, t] of tables) for (const fk of t.fks) if (top.has(tn) && top.has(fk.ref)) erd.push(`  ${fk.ref.replace(/\W/g, '_')} ||--o{ ${tn.replace(/\W/g, '_')} : "${fk.cols.join('_')}"`)
erd.push('```', '')

console.log(md)
if (args.has('--write')) { writeFileSync('docs/DB_AUDIT.md', md); writeFileSync('docs/DB_ERD.md', erd.join('\n')) }
if (args.has('--write-baseline')) writeFileSync(BASELINE, JSON.stringify(metrics, null, 2) + '\n')
if (args.has('--check')) {
  if (!existsSync(BASELINE)) { console.error(`missing ${BASELINE}; run with --write-baseline`); process.exit(1) }
  const b = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const fails = []
  for (const k of ['badMigrationNames', 'duplicateVersions', 'unwrappedPolicies', 'shadowedIndexNames', 'fkWithoutIndexStatic', 'unboundedClientSelects']) {
    if (metrics[k] > b[k]) fails.push(`${k}: ${metrics[k]} > baseline ${b[k]}`)
  }
  for (const fn of metrics.volatilityRegressions) if (!b.volatilityRegressions.includes(fn)) fails.push(`new volatility regression: ${fn}`)
  if (fails.length) { console.error('db-audit: worse than baseline\n- ' + fails.join('\n- ')); process.exit(1) }
  console.log('db-audit: no regression vs baseline')
}
