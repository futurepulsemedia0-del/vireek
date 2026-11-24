#!/usr/bin/env node
/**
 * Replaces @OWNER_<AREA> placeholders in .github/CODEOWNERS with the owners YOU specify. Never invents a handle.
 *
 *   node scripts/governance/apply-owners.mjs --map owners.json            dry run (prints the plan, writes nothing)
 *   node scripts/governance/apply-owners.mjs --map owners.json --write    writes the file
 *   node scripts/governance/apply-owners.mjs --set PLATFORM=@acme/platform --set DATA=@acme/data ... [--write]
 *   --file <path> (default .github/CODEOWNERS)   --allow-partial  (leave tokens without a mapping untouched)
 *
 * owners.json:  { "PLATFORM": "@acme/platform", "SECURITY": "@acme/security", ... }   (keys with or without the OWNER_ prefix)
 * A value may list several owners separated by spaces. Exit 0 ok · 1 refused (missing/invalid mapping) · 2 usage/I-O.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isValidOwner, isPlaceholder } from './check-codeowners.mjs'

const TOKEN_RE = /@OWNER_([A-Z0-9_]*[A-Z0-9])\b/g

export function findTokens(text) {
  const out = new Set()
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    for (const m of line.matchAll(TOKEN_RE)) out.add(m[1])
  }
  return [...out].sort()
}

/** map: { PLATFORM: '@acme/platform' | '@a @b' }. Returns { text, replaced:{token:count}, missing:[], invalid:[] } */
export function applyOwners(text, map, { allowPartial = false } = {}) {
  const norm = {}
  for (const [k, v] of Object.entries(map)) norm[k.replace(/^@?OWNER_/i, '').toUpperCase()] = String(v).trim()
  const tokens = findTokens(text)
  const missing = tokens.filter((t) => !norm[t])
  const invalid = []
  for (const [k, v] of Object.entries(norm)) {
    const owners = v.split(/\s+/).filter(Boolean)
    if (!owners.length || owners.some((o) => !isValidOwner(o) || isPlaceholder(o))) invalid.push(`${k}=${v}`)
  }
  if (invalid.length || (missing.length && !allowPartial)) return { text, replaced: {}, missing, invalid }
  const replaced = {}
  const lines = text.split(/(\r?\n)/).map((seg) => {
    if (/^\s*#/.test(seg)) return seg
    return seg.replace(TOKEN_RE, (all, t) => {
      if (!norm[t]) return all
      replaced[t] = (replaced[t] ?? 0) + 1
      return norm[t]
    })
  })
  return { text: lines.join(''), replaced, missing, invalid }
}

function main(argv) {
  const o = { file: '.github/CODEOWNERS', map: {}, write: false, allowPartial: false }
  let mapFile = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--write') o.write = true
    else if (a === '--allow-partial') o.allowPartial = true
    else if (a === '--file') o.file = argv[++i]
    else if (a === '--map') mapFile = argv[++i]
    else if (a === '--set') { const [k, ...v] = String(argv[++i]).split('='); o.map[k] = v.join('=') }
    else { console.error(`unknown argument ${a}`); return 2 }
  }
  if (!existsSync(o.file)) { console.error(`${o.file} not found`); return 2 }
  if (mapFile) {
    try { Object.assign(o.map, JSON.parse(readFileSync(mapFile, 'utf8'))) } catch (e) { console.error(`cannot read ${mapFile}: ${e.message}`); return 2 }
  }
  const text = readFileSync(o.file, 'utf8')
  const r = applyOwners(text, o.map, { allowPartial: o.allowPartial })
  console.log(`tokens in file: ${findTokens(text).join(', ') || '(none)'}`)
  if (r.invalid.length) { console.error(`✖ invalid owner value(s): ${r.invalid.join('; ')} (use @user, @org/team or an e-mail)`); return 1 }
  if (r.missing.length && !o.allowPartial) { console.error(`✖ no owner given for: ${r.missing.join(', ')} (supply it, or pass --allow-partial)`); return 1 }
  console.log(Object.entries(r.replaced).map(([k, n]) => `  OWNER_${k} -> ${o.map[k] ?? o.map[`OWNER_${k}`]} (${n} line(s))`).join('\n'))
  if (!o.write) { console.log('dry run — nothing written. Re-run with --write.'); return 0 }
  writeFileSync(o.file, r.text)
  console.log(`wrote ${o.file}. Next: node scripts/governance/check-codeowners.mjs --strict`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)))
