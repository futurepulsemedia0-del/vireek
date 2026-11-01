#!/usr/bin/env node
// Asset budget gate: fails when an image/font/media file in public/ or src/ exceeds
// its limit. Known legacy offenders sit in "ceilingKB" and can only SHRINK (ratchet):
// growing past the ceiling fails; dropping under the normal limit asks you to remove the entry.
import { readdirSync, readFileSync, statSync, appendFileSync } from 'node:fs'
import { join, extname } from 'node:path'

const cfg = JSON.parse(readFileSync(new URL('./perf-budgets.json', import.meta.url), 'utf8'))
const SKIP = new Set(['node_modules', '.git'])
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    if (SKIP.has(n)) return []
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

const rows = []
let failed = false
for (const root of ['public', 'src']) {
  for (const file of walk(root)) {
    const limit = cfg.maxKB[extname(file).toLowerCase()]
    if (limit === undefined) continue
    const path = file.replaceAll('\\', '/')
    const kb = statSync(file).size / 1024
    const ceiling = cfg.ceilingKB[path]
    if (ceiling === undefined) {
      if (kb > limit) { failed = true; rows.push({ path, kb, limit, status: 'OVER' }) }
    } else if (kb > ceiling) {
      failed = true; rows.push({ path, kb, limit: ceiling, status: 'GREW' })
    } else if (kb <= limit) {
      failed = true; rows.push({ path, kb, limit, status: 'FIXED (remove from ceilingKB)' })
    } else {
      rows.push({ path, kb, limit, status: 'LEGACY' })
    }
  }
}
const lines = ['| Asset | KB | Limit KB | Status |', '|---|---:|---:|:---|']
for (const r of rows.sort((a, b) => b.kb - a.kb)) {
  lines.push(`| ${r.path} | ${r.kb.toFixed(0)} | ${r.limit} | ${r.status} |`)
  if (r.status !== 'LEGACY') console.error(`::error file=${r.path},title=Asset budget::${r.path} is ${r.kb.toFixed(0)} KB (${r.status}, limit ${r.limit} KB)`)
}
const report = rows.length ? lines.join('\n') : 'All assets within budget.'
console.log(report)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n')
process.exit(failed ? 1 : 0)
