#!/usr/bin/env node
// scripts/apply-headers.mjs
//
// Inserts a header comment (purpose / auth / inputs-outputs) at the top of source files that have none.
// Header text lives in scripts/data/function-headers.mjs (edge functions) and scripts/data/lib-headers.mjs
// (src/lib modules). Idempotent: a file that already has a comment in its first lines is skipped.
// Preserves a shebang and leading directives (// @ts-*, /// <reference>, // deno-lint-ignore).
//
// Usage:  node scripts/apply-headers.mjs            apply
//         node scripts/apply-headers.mjs --check    exit 1 when a mapped file still lacks a header

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const CHECK = process.argv.includes('--check')
const sets = [
  ['scripts/data/function-headers.mjs', (rel, h) => [`${rel.split('/')[2]} — ${h.p}`, `Auth: ${h.a}`, `I/O:  ${h.io}`]],
  ['scripts/data/lib-headers.mjs', (rel, h) => [h.p, ...(h.n ? [`Notes: ${h.n}`] : [])]],
]
const wrap = (text, width = 100) => {
  const out = []
  let line = ''
  for (const w of text.split(/\s+/)) {
    if ((line + ' ' + w).trim().length > width) { out.push(line); line = '    ' + w } else line = (line + ' ' + w).trim()
  }
  if (line) out.push(line)
  return out
}
const DIRECTIVE = /^(#!|\/\/\s*@ts-|\/\/\/\s*<reference|\/\/\s*deno-lint-ignore)/
let changed = 0
let missing = 0
for (const [file, build] of sets) {
  if (!existsSync(file)) continue
  const map = (await import(new URL('../' + file, import.meta.url))).default
  for (const [rel, h] of Object.entries(map)) {
    if (!existsSync(rel)) { console.error(`skip (not found): ${rel}`); continue }
    const src = readFileSync(rel, 'utf8')
    const lines = src.split('\n')
    let i = 0
    while (i < lines.length && DIRECTIVE.test(lines[i])) i++
    const head = lines.slice(i, i + 5)
    if (head.some((l) => /^\s*(\/\/|\/\*|\*)/.test(l))) continue
    missing++
    if (CHECK) { console.error(`missing header: ${rel}`); continue }
    const header = build(rel, h).flatMap((t) => wrap(t)).map((l) => `// ${l}`.trimEnd())
    lines.splice(i, 0, ...header, '')
    writeFileSync(rel, lines.join('\n'))
    changed++
  }
}
if (CHECK && missing) process.exit(1)
console.log(CHECK ? 'all mapped files have headers' : `added ${changed} headers`)
