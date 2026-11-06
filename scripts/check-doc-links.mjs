#!/usr/bin/env node
// scripts/check-doc-links.mjs
// Fails when a relative markdown link in the repo's documentation points to a file that does not exist.
// Scope: root *.md, docs/**/*.md, .github/*.md, packages/*/README.md. External (http/mailto) and #anchor-only links are skipped.
// Usage: npm run docs:links

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

const walk = (d) =>
  !existsSync(d) ? [] : readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : [p]
  })
const targets = [
  ...readdirSync('.').filter((f) => f.endsWith('.md')),
  ...walk('docs').filter((f) => f.endsWith('.md')),
  ...walk('.github').filter((f) => f.endsWith('.md')),
  ...walk('packages').filter((f) => /README\.md$/.test(f)),
]
const bad = []
for (const f of targets) {
  const text = readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '')
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const raw = m[1]
    if (/^(https?:|mailto:|#|tel:)/.test(raw)) continue
    const t = decodeURIComponent(raw.split('#')[0])
    if (!t) continue
    const resolved = normalize(t.startsWith('/') ? t.slice(1) : join(dirname(f), t))
    if (!existsSync(resolved)) bad.push(`${f}: ${raw}`)
  }
}
if (bad.length) { console.error(`Broken documentation links (${bad.length}):\n${bad.map((b) => ' - ' + b).join('\n')}`); process.exit(1) }
console.log(`OK: ${targets.length} markdown files, no broken relative links.`)
