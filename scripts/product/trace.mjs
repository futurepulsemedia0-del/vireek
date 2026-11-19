#!/usr/bin/env node
// scripts/product/trace.mjs
//
// Strategy-to-roadmap traceability: goal -> key results -> bets -> shipped features (routes / edge functions).
// Reads docs/product/okrs.json and compares it with what the repo actually ships, then reports:
//   1. features (routes, edge functions) that no goal links to        -> "orphan features"
//   2. goals (not dropped) with no shipped work linked                 -> "goals without shipped work"
//   3. structural problems (dangling refs, duplicate ids, bad enums)   -> "errors"
//
// Static scan only (regex over src/App.tsx, src/routes/groups/*Routes.tsx, supabase/functions/*). It proves a route
// or function exists in source, not that it works. Plain Node 18+, no dependencies.
//
// Usage:  npm run product:trace                 report only, exit 0
//         npm run product:trace -- --check      exit 1 on structural errors only
//         npm run product:trace -- --strict     exit 1 on errors, orphan features, empty/placeholder goals
//         --update-baseline   accept today's orphan features into docs/product/okrs.baseline.json (ratchet: only NEW orphans fail --strict;
//                             baseline entries that got linked, exempted or deleted must be removed, so the list only shrinks)
//         --json   machine-readable report     --all   do not truncate lists     --limit N   list length (default 40)
//
// Ref syntax in okrs.json (bets[].shipped[] and exempt[].ref):  route:/path  |  fn:function-name
// `*` matches any characters, so `route:/dashboard/jobs*` and `fn:voice-*` link whole families.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const OKR_PATH = 'docs/product/okrs.json'
export const BASELINE_PATH = 'docs/product/okrs.baseline.json'

const GUARDS = ['ProtectedRoute', 'StaffRoute', 'TechnicianRoute', 'PartnerRoute']
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const REF_RE = /^(route|fn):(\S+)$/
const GOAL_STATUS = ['placeholder', 'active', 'achieved', 'dropped']
const BET_STATUS = ['proposed', 'in-progress', 'shipped', 'dropped']

export const isPlaceholder = (s) => typeof s === 'string' && /^\s*(TODO|TBD)\b/.test(s)

// ---------------------------------------------------------------- feature universe
/** Extract `<Route path>` entries from a TSX source string. Redirect-only routes and the catch-all are not features. */
export function parseRoutes(text) {
  const paths = new Set()
  let unresolved = 0
  for (const chunk of text.split(/<Route\b/).slice(1)) {
    const head = chunk.slice(0, 900)
    const m = head.match(/\bpath=(?:"([^"]+)"|\{'([^']+)'\}|\{ROUTES\.([A-Za-z0-9_]+)\})/)
    if (!m) continue
    if (m[3]) { unresolved++; continue }
    const raw = m[1] ?? m[2]
    if (raw === '*' || /element=\{\s*<Navigate\b/.test(head)) continue
    paths.add(raw.startsWith('/') ? raw : `/${raw}`)
  }
  return { paths: [...paths], unresolved }
}

const walk = (d) =>
  !existsSync(d)
    ? []
    : readdirSync(d).flatMap((n) => {
        const p = join(d, n)
        return statSync(p).isDirectory() ? (n === 'node_modules' || n === 'dist' ? [] : walk(p)) : [p]
      })

/** Every routed path and every edge-function folder found in the source tree under `root`. */
export function loadUniverse(root = ROOT) {
  const sources = [join(root, 'src/App.tsx'), ...walk(join(root, 'src/routes/groups')).filter((f) => /Routes\.tsx$/.test(f))].filter(existsSync)
  const routes = new Set()
  let unresolvedRoutes = 0
  for (const f of sources) {
    const r = parseRoutes(readFileSync(f, 'utf8'))
    r.paths.forEach((p) => routes.add(p))
    unresolvedRoutes += r.unresolved
  }
  const fnDir = join(root, 'supabase/functions')
  const fns = existsSync(fnDir)
    ? readdirSync(fnDir).filter((n) => !n.startsWith('_') && !n.startsWith('.') && statSync(join(fnDir, n)).isDirectory())
    : []
  return {
    features: [...[...routes].sort().map((p) => `route:${p}`), ...fns.sort().map((n) => `fn:${n}`)],
    unresolvedRoutes,
    routeSources: sources.length,
  }
}

// ---------------------------------------------------------------- matching
const globToRegex = (g) => new RegExp(`^${g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)

/** Features (e.g. "route:/x", "fn:y") matched by a ref. Returns null when the ref syntax is invalid. */
export function matchRef(ref, features) {
  const m = typeof ref === 'string' ? ref.match(REF_RE) : null
  if (!m) return null
  const re = globToRegex(m[2])
  return features.filter((f) => f.startsWith(`${m[1]}:`) && re.test(f.slice(m[1].length + 1)))
}

// ---------------------------------------------------------------- analysis
export function analyze(doc, features) {
  const errors = []
  const warnings = []
  const err = (s) => errors.push(s)
  const warn = (s) => warnings.push(s)
  const ids = new Set()
  const claim = (id, where) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return err(`${where}: invalid id ${JSON.stringify(id)} (letters, digits, . _ -)`)
    if (ids.has(id)) return err(`${where}: duplicate id "${id}"`)
    ids.add(id)
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { errors: ['okrs.json must be a JSON object'], warnings, orphans: [], goalsWithoutWork: [], placeholderGoals: [], goals: [], features, exempt: [], multiGoal: [] }
  }
  if (doc.schemaVersion !== 1) err(`schemaVersion must be 1 (got ${JSON.stringify(doc.schemaVersion)})`)
  if (!Array.isArray(doc.goals)) err('goals must be an array')

  const linkedBy = new Map() // feature -> Set(goal ids)
  const goals = []
  for (const g of Array.isArray(doc.goals) ? doc.goals : []) {
    const gid = g?.id
    claim(gid, 'goal')
    const where = `goal ${gid}`
    if (typeof g?.title !== 'string' || !g.title.trim()) err(`${where}: title is required`)
    if (!GOAL_STATUS.includes(g?.status)) err(`${where}: status must be one of ${GOAL_STATUS.join(', ')}`)
    if (!Array.isArray(g?.keyResults) || !g.keyResults.length) warn(`${where}: no key results`)
    for (const kr of Array.isArray(g?.keyResults) ? g.keyResults : []) {
      claim(kr?.id, `${where} key result`)
      if (typeof kr?.metric !== 'string' || !kr.metric.trim()) err(`${where} key result ${kr?.id}: metric is required`)
    }
    const work = new Set()
    for (const b of Array.isArray(g?.bets) ? g.bets : []) {
      claim(b?.id, `${where} bet`)
      const bw = `bet ${b?.id}`
      if (typeof b?.title !== 'string' || !b.title.trim()) err(`${bw}: title is required`)
      if (!BET_STATUS.includes(b?.status)) err(`${bw}: status must be one of ${BET_STATUS.join(', ')}`)
      const refs = Array.isArray(b?.shipped) ? b.shipped : []
      if (b?.shipped !== undefined && !Array.isArray(b.shipped)) err(`${bw}: shipped must be an array`)
      if (b?.status === 'shipped' && !refs.length) warn(`${bw}: status is "shipped" but it links no routes/functions`)
      for (const ref of refs) {
        const hit = matchRef(ref, features)
        if (hit === null) { err(`${bw}: invalid ref ${JSON.stringify(ref)} (use route:/path or fn:name)`); continue }
        if (!hit.length) { err(`${bw}: ref "${ref}" matches nothing in the repo`); continue }
        for (const f of hit) {
          work.add(f)
          if (!linkedBy.has(f)) linkedBy.set(f, new Set())
          linkedBy.get(f).add(gid)
        }
      }
    }
    goals.push({ id: gid, title: g?.title, status: g?.status, placeholder: g?.status === 'placeholder' || isPlaceholder(g?.title), work: [...work] })
  }

  const exempt = new Set()
  for (const e of Array.isArray(doc.exempt) ? doc.exempt : []) {
    const hit = matchRef(e?.ref, features)
    if (hit === null) { err(`exempt: invalid ref ${JSON.stringify(e?.ref)}`); continue }
    if (!hit.length) { err(`exempt: ref "${e.ref}" matches nothing in the repo`); continue }
    if (typeof e.reason !== 'string' || !e.reason.trim() || isPlaceholder(e.reason)) warn(`exempt: "${e.ref}" has no real reason`)
    hit.forEach((f) => exempt.add(f))
  }

  return {
    errors,
    warnings,
    goals,
    features,
    orphans: features.filter((f) => !linkedBy.has(f) && !exempt.has(f)),
    goalsWithoutWork: goals.filter((g) => g.status !== 'dropped' && !g.work.length).map((g) => g.id),
    placeholderGoals: goals.filter((g) => g.placeholder).map((g) => g.id),
    multiGoal: [...linkedBy].filter(([, s]) => s.size > 1).map(([f, s]) => ({ feature: f, goals: [...s] })),
    exempt: [...exempt],
  }
}

/** Split orphans against an accepted baseline: new (fail), baselined (accepted), stale (baseline entry no longer an orphan). */
export function applyBaseline(orphans, baseline) {
  const accepted = new Set(Array.isArray(baseline?.orphans) ? baseline.orphans : [])
  const now = new Set(orphans)
  return {
    newOrphans: orphans.filter((f) => !accepted.has(f)),
    baselined: orphans.filter((f) => accepted.has(f)),
    stale: [...accepted].filter((f) => !now.has(f)).sort(),
  }
}

// ---------------------------------------------------------------- CLI
const area = (f) => {
  if (f.startsWith('fn:')) return `fn:${f.slice(3).split('-')[0]}-*`
  const seg = f.slice(6).split('/').filter(Boolean)
  return seg.length ? `route:/${seg[0]}` : 'route:/'
}

export function parseArgs(argv) {
  const o = { check: false, strict: false, json: false, all: false, updateBaseline: false, limit: 40, file: OKR_PATH, baseline: BASELINE_PATH }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') o.check = true
    else if (a === '--strict') o.strict = true
    else if (a === '--json') o.json = true
    else if (a === '--all') o.all = true
    else if (a === '--update-baseline') o.updateBaseline = true
    else if (a === '--baseline') { o.baseline = argv[++i]; if (!o.baseline) throw new Error('--baseline needs a path') }
    else if (a === '--limit') { o.limit = Number(argv[++i]); if (!Number.isInteger(o.limit) || o.limit < 1) throw new Error('--limit needs a positive integer') }
    else if (a === '--file') { o.file = argv[++i]; if (!o.file) throw new Error('--file needs a path') }
    else throw new Error(`unknown argument ${a}`)
  }
  return o
}

export function main(argv = process.argv.slice(2), { root = ROOT, log = console.log } = {}) {
  let opts
  try { opts = parseArgs(argv) } catch (e) { log(`product:trace: ${e.message}`); return 2 }
  const path = resolve(root, opts.file)
  if (!existsSync(path)) { log(`product:trace: ${opts.file} not found`); return 2 }
  let doc
  try { doc = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { log(`product:trace: ${opts.file} is not valid JSON (${e.message})`); return 2 }

  const uni = loadUniverse(root)
  if (!uni.features.length) { log('product:trace: no routes or edge functions found; run from the repo root'); return 2 }
  const r = analyze(doc, uni.features)

  const bpath = resolve(root, opts.baseline)
  let baseline = null
  if (existsSync(bpath)) {
    try { baseline = JSON.parse(readFileSync(bpath, 'utf8')) } catch (e) { log(`product:trace: ${opts.baseline} is not valid JSON (${e.message})`); return 2 }
    if (baseline?.schemaVersion !== 1 || !Array.isArray(baseline.orphans)) { log(`product:trace: ${opts.baseline} must be {"schemaVersion":1,"orphans":[...]}`); return 2 }
  }
  if (opts.updateBaseline) {
    if (r.errors.length) { log(`product:trace: refusing to write a baseline while okrs.json has ${r.errors.length} error(s); run --check first`); return 1 }
    mkdirSync(dirname(bpath), { recursive: true })
    writeFileSync(bpath, `${JSON.stringify({ schemaVersion: 1, orphans: [...r.orphans].sort() }, null, 2)}\n`)
    log(`product:trace: wrote ${opts.baseline} with ${r.orphans.length} accepted orphan feature(s)`)
    return 0
  }
  const b = baseline ? applyBaseline(r.orphans, baseline) : { newOrphans: r.orphans, baselined: [], stale: [] }
  const fail = r.errors.length > 0 || (opts.strict && (b.newOrphans.length > 0 || b.stale.length > 0 || r.goalsWithoutWork.length > 0 || r.placeholderGoals.length > 0))
  const code = (opts.check || opts.strict) && fail ? 1 : 0

  if (opts.json) {
    log(JSON.stringify({ ...r, newOrphans: b.newOrphans, baselined: b.baselined, staleBaseline: b.stale, features: undefined, featureCount: r.features.length, unresolvedRoutes: uni.unresolvedRoutes }, null, 2))
    return code
  }

  const cap = (xs) => (opts.all ? xs : xs.slice(0, opts.limit))
  const more = (xs) => (!opts.all && xs.length > opts.limit ? [`  … ${xs.length - opts.limit} more (use --all)`] : [])
  const nRoutes = uni.features.filter((f) => f.startsWith('route:')).length
  const out = [`Features: ${uni.features.length} (${nRoutes} routes, ${uni.features.length - nRoutes} edge functions) · goals: ${r.goals.length} · exempt: ${r.exempt.length}`]
  if (uni.unresolvedRoutes) out.push(`Note: ${uni.unresolvedRoutes} route(s) use a ROUTES.* constant and are not resolved by this scan.`)
  if (r.errors.length) out.push('', `Errors (${r.errors.length}):`, ...r.errors.map((e) => `  ✖ ${e}`))
  if (r.warnings.length) out.push('', `Warnings (${r.warnings.length}):`, ...r.warnings.map((w) => `  ! ${w}`))
  out.push('', `Goals with no shipped work (${r.goalsWithoutWork.length}):`, ...(r.goalsWithoutWork.length ? r.goalsWithoutWork.map((g) => `  - ${g}${r.placeholderGoals.includes(g) ? '  (placeholder)' : ''}`) : ['  none']))
  const byArea = new Map()
  r.orphans.forEach((f) => byArea.set(area(f), (byArea.get(area(f)) ?? 0) + 1))
  out.push('', `Features with no linked goal (${r.orphans.length} of ${r.features.length}${baseline ? `; ${b.baselined.length} baselined, ${b.newOrphans.length} new` : ''}):`)
  if (b.stale.length) out.push(`  ! ${b.stale.length} stale baseline entr${b.stale.length === 1 ? 'y' : 'ies'} (linked, exempted or deleted since): remove them with --update-baseline`, ...cap(b.stale).map((f) => `    ~ ${f}`))
  if (b.newOrphans.length) {
    byArea.clear()
    b.newOrphans.forEach((f) => byArea.set(area(f), (byArea.get(area(f)) ?? 0) + 1))
    out.push(baseline ? '  new orphans by area:' : '  by area:', ...[...byArea].sort((a, b) => b[1] - a[1]).slice(0, opts.all ? undefined : 15).map(([a, n]) => `    ${String(n).padStart(4)}  ${a}`), '  list:', ...cap(b.newOrphans).map((f) => `  - ${f}`), ...more(b.newOrphans))
  } else if (!b.stale.length) out.push('  none')
  if (r.multiGoal.length) out.push('', `Info: ${r.multiGoal.length} feature(s) linked to more than one goal (allowed).`)
  out.push('', code ? 'RESULT: FAIL' : 'RESULT: ok' + (opts.check || opts.strict ? '' : ' (report only; use --check or --strict to gate)'))
  log(out.join('\n'))
  return code
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main())
