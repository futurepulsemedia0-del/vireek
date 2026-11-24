#!/usr/bin/env node
// scripts/compliance/gen-vendor-review-seed.mjs
//
// Seeds and guards the vendor review register (public.vendor_reviews) from what this repository actually contains.
// It never invents vendor facts, contracts, reviews or evidence.
//
//   Sources (all read-only):
//     scripts/compliance/gen-vendor-exit.mjs   PROVIDERS: every external provider found in supabase/functions
//     docs/vendor-exit/<slug>.md               "Criticality tier (proposed)" -> tier 1 / 2 / 3
//     src/lib/subprocessors.ts                 the published sub-processor list -> is_subprocessor
//
//   Criticality is a PROPOSAL derived from the vendor-exit tier (management decides): tier 1 -> critical,
//   tier 2 -> high, tier 3 -> medium; tenant-chosen connectors (kind customer) and public data APIs -> low.
//   Vendors with no tier (outside the vendor-exit scan) -> medium, source "proposed". Staff can change it
//   in the register; the database then records criticality_source = 'manual'.
//
// Usage:
//   node scripts/compliance/gen-vendor-review-seed.mjs --print            INSERT block for ALL vendors in code
//   node scripts/compliance/gen-vendor-review-seed.mjs --check            exit 1 if a vendor in code has no seed row in any
//                                                                         supabase/migrations/*vendor_review*.sql
//   node scripts/compliance/gen-vendor-review-seed.mjs --emit-missing     print the idempotent INSERT for the missing vendors
//                                                                         (paste into a NEW migration; never edit a shipped one)
//
// What this proves: what the checked-out source tree references. It does NOT prove that a vendor is contracted,
// reviewed, or configured in production.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOC_DIR, PROVIDERS, parseDocMeta } from './gen-vendor-exit.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SUBPROCESSORS_FILE = 'src/lib/subprocessors.ts'
export const MIGRATIONS_DIR = 'supabase/migrations'
export const SEED_BEGIN = '-- BEGIN GENERATED:vendor_seed'
export const SEED_END = '-- END GENERATED:vendor_seed'

/**
 * Vendors that are published as sub-processors (src/lib/subprocessors.ts) but are NOT a PROVIDERS entry of the
 * vendor-exit scan (browser-side or outside edge-function code). Kept explicit so nothing is guessed.
 */
export const EXTRA_VENDORS = [
  { slug: 'sentry', name: 'Sentry (Functional Software, Inc.)', kind: 'supplier' },
  { slug: 'zapier', name: 'Zapier', kind: 'customer' },
]

/**
 * Published sub-processor name -> vendor slug. A new sub-processor in subprocessors.ts MUST be added here
 * (the unit test fails otherwise), so the register can never silently omit a published vendor.
 */
export const SUBPROCESSOR_SLUG = {
  'Supabase, Inc.': 'supabase',
  'Vercel Inc.': 'vercel',
  'Vapi Inc.': 'vapi',
  'Google LLC (Gemini API)': 'gemini',
  'Groq, Inc.': 'groq',
  'Cerebras Systems Inc.': 'cerebras',
  'Cloudflare, Inc. (Workers AI)': 'cloudflare',
  'OpenRouter, Inc.': 'openrouter',
  'Stripe, Inc.': 'stripe',
  Resend: 'resend',
  'Sentry (Functional Software, Inc.)': 'sentry',
  'Google LLC (Google Analytics)': 'google',
  'Google LLC (Google Calendar)': 'google',
  'Intuit Inc. (QuickBooks)': 'quickbooks',
  'Zapier, Inc.': 'zapier',
}

const read = (p) => readFileSync(p, 'utf8')

/** Names of every processor in src/lib/subprocessors.ts (literal `name: '...'` entries only). */
export function readSubprocessorNames(root = ROOT) {
  const text = read(join(root, SUBPROCESSORS_FILE))
  return [...text.matchAll(/\bname:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"))
}

export function criticalityFor({ kind, tier }) {
  if (kind === 'customer' || kind === 'public') return { criticality: 'low', source: tier ? 'vendor_exit_tier' : 'proposed' }
  if (tier === 1) return { criticality: 'critical', source: 'vendor_exit_tier' }
  if (tier === 2) return { criticality: 'high', source: 'vendor_exit_tier' }
  if (tier === 3) return { criticality: 'medium', source: 'vendor_exit_tier' }
  return { criticality: 'medium', source: 'proposed' }
}

/** @returns {{slug:string,name:string,kind:string,tier:number|null,criticality:string,source:string,isSubprocessor:boolean}[]} */
export function buildSeedRows(root = ROOT) {
  const subSlugs = new Set(readSubprocessorNames(root).map((n) => SUBPROCESSOR_SLUG[n]).filter(Boolean))
  const rows = []
  for (const p of PROVIDERS) {
    const doc = join(root, DOC_DIR, `${p.slug}.md`)
    const tier = existsSync(doc) ? parseDocMeta(read(doc)).tier : null
    rows.push({ slug: p.slug, name: p.name, kind: p.kind, tier, ...criticalityFor({ kind: p.kind, tier }) })
  }
  for (const e of EXTRA_VENDORS) {
    if (rows.some((r) => r.slug === e.slug)) continue
    rows.push({ slug: e.slug, name: e.name, kind: e.kind, tier: null, ...criticalityFor({ kind: e.kind, tier: null }) })
  }
  return rows.map((r) => ({ ...r, isSubprocessor: subSlugs.has(r.slug) }))
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`

export function renderSeedSql(rows) {
  const lines = rows.map((r, i) => {
    const comma = i === rows.length - 1 ? '' : ','
    return `  (${q(r.slug)}, ${q(r.name)}, ${q(r.kind)}, ${q(r.criticality)}, ${q(r.source)}, ${r.isSubprocessor ? 'true' : 'false'})${comma}`
  })
  return [
    SEED_BEGIN,
    'INSERT INTO public.vendor_reviews (vendor_key, vendor_name, vendor_kind, criticality, criticality_source, is_subprocessor)',
    'VALUES',
    ...lines,
    'ON CONFLICT (vendor_key) DO NOTHING;',
    SEED_END,
  ].join('\n')
}

/** Vendor keys present in any seed block (or INSERT into vendor_reviews) of the vendor-review migrations. */
export function seededKeys(root = ROOT) {
  const dir = join(root, MIGRATIONS_DIR)
  if (!existsSync(dir)) return new Set()
  const keys = new Set()
  for (const f of readdirSync(dir).filter((x) => /vendor_review.*\.sql$/.test(x))) {
    const text = read(join(dir, f))
    for (const blk of text.matchAll(/INSERT\s+INTO\s+public\.vendor_reviews\b[\s\S]*?(?:ON\s+CONFLICT[^;]*;)/gi)) {
      for (const m of blk[0].matchAll(/^\s*\(\s*'([a-z0-9][a-z0-9-]*)'\s*,/gm)) keys.add(m[1])
    }
  }
  return keys
}

export function findMissing(root = ROOT) {
  const have = seededKeys(root)
  const rows = buildSeedRows(root)
  return {
    missing: rows.filter((r) => !have.has(r.slug)),
    // A vendor that left the code is NOT deleted (review history stays); the owner retires it in the register.
    orphaned: [...have].filter((k) => !rows.some((r) => r.slug === k)).sort(),
  }
}

function main(argv, root = ROOT) {
  const has = (f) => argv.includes(f)
  if (has('--print')) {
    console.log(renderSeedSql(buildSeedRows(root)))
    return 0
  }
  if (has('--emit-missing')) {
    const { missing } = findMissing(root)
    if (!missing.length) {
      console.error('nothing missing: every vendor in code already has a seed row')
      return 0
    }
    console.log(renderSeedSql(missing))
    return 0
  }
  if (has('--check')) {
    const { missing, orphaned } = findMissing(root)
    for (const o of orphaned) console.warn(`warning: "${o}" is seeded in the register but no longer found in code — retire it in the register if it is gone`)
    if (missing.length) {
      console.error(`✘ ${missing.length} vendor(s) in code have no row in the vendor review register seed: ${missing.map((m) => m.slug).join(', ')}`)
      console.error('  Run: node scripts/compliance/gen-vendor-review-seed.mjs --emit-missing   and put the output in a NEW migration.')
      return 1
    }
    console.log(`✔ vendor review seed covers all ${buildSeedRows(root).length} vendors found in code (${orphaned.length} orphaned warning(s)).`)
    return 0
  }
  console.error('usage: gen-vendor-review-seed.mjs --print | --check | --emit-missing')
  return 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
