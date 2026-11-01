#!/usr/bin/env node
// Stamps dist/sw.js with a per-deploy build id so caches are versioned and old ones are pruned.
// Run right after `vite build`. The placeholder stays literal in dev (harmless).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2] ?? 'dist/sw.js'
if (!existsSync(file)) {
  console.error(`${file} not found — run vite build first.`)
  process.exit(2)
}
const id = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || String(Date.now())).slice(0, 12)
const src = readFileSync(file, 'utf8')
if (!src.includes('__BUILD_ID__')) {
  console.error('sw.js has no __BUILD_ID__ placeholder — did you apply the sw.js edit?')
  process.exit(1)
}
writeFileSync(file, src.replaceAll('__BUILD_ID__', id))
console.log(`sw.js stamped with build id ${id}`)
