#!/usr/bin/env node
// Asset budget gate: fails when an image/font/media file in public/ or src/ exceeds its limit.
//  - "maxKB":       default limit per extension.
//  - "prefixMaxKB": limit for generated folders (public/img/ holds the 1600w AVIF/WebP output of
//                   scripts/optimize-images.mjs), overriding "maxKB" for files under that prefix.
//  - "ceilingKB":   known legacy offenders. They may only SHRINK (ratchet): growing past the ceiling
//                   fails; dropping under the normal limit fails until the entry is removed.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const cfg = JSON.parse(readFileSync(new URL('./perf-budgets.json', import.meta.url), 'utf8'))
const prefixLimits = Object.entries(cfg.prefixMaxKB ?? {})
const SKIP = new Set(['node_modules', '.git'])

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return []
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

const limitFor = (path) => {
  const ext = extname(path).toLowerCase()
  if (cfg.maxKB[ext] === undefined) return undefined
  const prefix = prefixLimits.find(([p]) => path.startsWith(p))
  return prefix ? prefix[1] : cfg.maxKB[ext]
}

const rows = []
let failed = false
for (const root of ['public', 'src']) {
  if (!existsSync(root)) continue
  for (const file of walk(root)) {
    const path = file.replaceAll('\\', '/')
    const limit = limitFor(path)
    if (limit === undefined) continue
    const kb = statSync(file).size / 1024
    const ceiling = cfg.ceilingKB[path]
    if (ceiling === undefined) {
      if (kb > limit) {
        failed = true
        rows.push({ path, kb, limit, status: 'OVER' })
      }
    } else if (kb > ceiling) {
      failed = true
      rows.push({ path, kb, limit: ceiling, status: 'GREW' })
    } else if (kb <= limit) {
      failed = true
      rows.push({ path, kb, limit, status: 'FIXED (remove from ceilingKB)' })
    } else {
      rows.push({ path, kb, limit, status: 'LEGACY' })
    }
  }
}

const lines = ['| Asset | KB | Limit KB | Status |', '|---|---:|---:|:---|']
for (const r of rows.sort((a, b) => b.kb - a.kb)) {
  lines.push(`| ${r.path} | ${r.kb.toFixed(0)} | ${r.limit} | ${r.status} |`)
  if (r.status !== 'LEGACY') {
    console.error(`::error file=${r.path},title=Asset budget::${r.path} is ${r.kb.toFixed(0)} KB (${r.status}, limit ${r.limit} KB)`)
  }
}
const report = rows.length ? lines.join('\n') : 'All assets within budget.'
console.log(report)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n')
process.exit(failed ? 1 : 0)
