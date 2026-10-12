#!/usr/bin/env node
// Bundle-size budget gate. Run AFTER `npm run build`.
// Budgets (KB, gzip) — override via env: BUDGET_INITIAL_JS_KB, BUDGET_CHUNK_JS_KB,
// BUDGET_TOTAL_JS_KB, BUDGET_TOTAL_CSS_KB. Tighten after the first green run.

import { readdirSync, readFileSync, statSync, appendFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

const DIST = 'dist'
const num = (k, d) => (Number.isFinite(Number(process.env[k])) && process.env[k] ? Number(process.env[k]) : d)
const BUDGET = {
  initialJs: num('BUDGET_INITIAL_JS_KB', 450),
  chunkJs: num('BUDGET_CHUNK_JS_KB', 350),
  totalJs: num('BUDGET_TOTAL_JS_KB', 3000),
  totalCss: num('BUDGET_TOTAL_CSS_KB', 150),
}

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

try {
  statSync(DIST)
} catch {
  console.error('dist/ not found — run `npm run build` first.')
  process.exit(2)
}

const kb = (b) => b / 1024
const files = walk(DIST)
  .filter((f) => /\.(js|mjs|css)$/.test(f))
  .map((f) => {
    const gz = gzipSync(readFileSync(f)).length
    return { path: relative(DIST, f).replaceAll('\\', '/'), gz, type: f.endsWith('.css') ? 'css' : 'js' }
  })

const byPath = new Map(files.map((f) => [f.path, f]))
const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const initialRefs = new Set()
for (const m of html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)=["']\/?([^"']+\.m?js)["'][^>]*>/g)) {
  if (/<link/.test(m[0]) && !/rel=["']modulepreload["']/.test(m[0])) continue
  initialRefs.add(m[1])
}
const initialJs = [...initialRefs].map((p) => byPath.get(p)).filter(Boolean)

const js = files.filter((f) => f.type === 'js')
const css = files.filter((f) => f.type === 'css')
const sum = (a) => a.reduce((s, f) => s + f.gz, 0)
const largest = [...js].sort((a, b) => b.gz - a.gz)[0]

const results = [
  { name: 'Initial JS (gzip)', value: kb(sum(initialJs)), budget: BUDGET.initialJs },
  { name: `Largest JS chunk (gzip) — ${largest?.path ?? 'n/a'}`, value: kb(largest?.gz ?? 0), budget: BUDGET.chunkJs },
  { name: 'Total JS (gzip)', value: kb(sum(js)), budget: BUDGET.totalJs },
  { name: 'Total CSS (gzip)', value: kb(sum(css)), budget: BUDGET.totalCss },
]

let failed = false
const lines = ['| Metric | Size (KB) | Budget (KB) | Status |', '|---|---:|---:|:---:|']
for (const r of results) {
  const ok = r.value <= r.budget
  if (!ok) failed = true
  lines.push(`| ${r.name} | ${r.value.toFixed(1)} | ${r.budget} | ${ok ? 'OK' : 'OVER'} |`)
  if (!ok) console.error(`::error title=Bundle budget exceeded::${r.name}: ${r.value.toFixed(1)} KB > ${r.budget} KB`)
}
const top = [...js].sort((a, b) => b.gz - a.gz).slice(0, 10)
lines.push('', '**Top 10 JS chunks (gzip)**', '', '| Chunk | KB |', '|---|---:|')
for (const f of top) lines.push(`| ${f.path} | ${kb(f.gz).toFixed(1)} |`)

const report = lines.join('\n')
console.log(report)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n')
process.exit(failed ? 1 : 0)
