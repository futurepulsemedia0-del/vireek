#!/usr/bin/env node
// Fails CI on stale / unowned / unregistered feature flags.  Usage: node scripts/check-flag-lifecycle.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checkRegistry, usedKeys, crossCheck } from './lib/flagLifecycle.mjs'

const registry = JSON.parse(readFileSync('config/flags.registry.json', 'utf8'))
const today = process.env.FLAG_LINT_TODAY || new Date().toISOString().slice(0, 10)

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.endsWith('hooks/useFeatureFlag.ts')) out.push(p)
  }
  return out
}
const files = [...walk('src'), ...walk('supabase/functions')].map((path) => ({ path, text: readFileSync(path, 'utf8') }))

const a = checkRegistry(registry, today)
const b = crossCheck(registry, usedKeys(files))
for (const w of [...a.warnings, ...b.warnings]) console.log(`::warning title=Flag lifecycle::${w}`)
for (const e of [...a.errors, ...b.errors]) console.log(`::error title=Flag lifecycle::${e}`)
console.log(`Flags: ${registry.flags.length} registered, ${a.errors.length + b.errors.length} error(s).`)
process.exit(a.errors.length + b.errors.length ? 1 : 0)
