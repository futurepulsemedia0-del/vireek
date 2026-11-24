#!/usr/bin/env node
// Market-entry readiness report per regional pack (read-only, no network, no secrets).
//
//   node --experimental-strip-types --no-warnings scripts/global/market-entry-report.mjs [flags]
//
// Flags:
//   --pack US|CA|GB|EU|AU   one pack (default: all five)
//   --format md|json|text   output format (default md)
//   --detail                md only: per-country item tables (long for EU)
//   --out <path>            write to a file instead of stdout
//   --strict                exit 3 when any selected pack is not ready
//   --check                 validate the config only (exit 2 on errors), print nothing else
//   --today YYYY-MM-DD      override the date (tests, reproducible reports)
//   --config <path>         alternative checklist file
//
// Exit codes: 0 ok | 2 usage or invalid config | 3 --strict and not ready.
// Reads: config/global/market-entry.json plus facts from packData.ts, regionalMethods.ts,
// locales.config.ts and packHolidays.ts. The TS files are loaded with Node's type stripping.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PROBES, evaluate, renderMarkdown, renderText, validateConfig } from '../lib/marketEntry.mjs'
import { rowMissing } from '../lib/paymentsEinvoicing.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_CONFIG = 'config/global/market-entry.json'

class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { format: 'md', detail: false, strict: false, check: false, pack: null, out: null, today: null, config: DEFAULT_CONFIG }
  const need = (i, flag) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--detail') o.detail = true
    else if (a === '--strict') o.strict = true
    else if (a === '--check') o.check = true
    else if (a === '--pack') { o.pack = need(i, a).toUpperCase(); i++ }
    else if (a === '--format') { o.format = need(i, a); i++ }
    else if (a === '--out') { o.out = need(i, a); i++ }
    else if (a === '--today') { o.today = need(i, a); i++ }
    else if (a === '--config') { o.config = need(i, a); i++ }
    else throw new UsageError(`unknown flag ${a}`)
  }
  if (!['md', 'json', 'text'].includes(o.format)) throw new UsageError('--format must be md, json or text')
  if (o.today !== null && !/^\d{4}-\d{2}-\d{2}$/.test(o.today)) throw new UsageError('--today must be YYYY-MM-DD')
  return o
}

const load = (rel) => import(pathToFileURL(resolve(ROOT, rel)).href)

async function loadFacts(today) {
  const [data, methods, loc, hol] = await Promise.all([
    load('src/lib/regionalPacks/packData.ts'),
    load('supabase/functions/_shared/payments/regionalMethods.ts'),
    load('src/i18n/locales.config.ts'),
    load('src/lib/regionalPacks/packHolidays.ts'),
  ])
  const packs = {}
  for (const [code, p] of Object.entries(data.PACKS)) {
    packs[code] = {
      name: p.name,
      countries: [...p.countries],
      dataVerifiedAt: p.dataVerifiedAt,
      countryNames: Object.fromEntries(p.countries.map((c) => [c, data.COUNTRY_PROFILES[c]?.name ?? c])),
    }
  }
  let billingRows = {}
  try {
    const m = JSON.parse(readFileSync(resolve(ROOT, 'config/global/payments-einvoicing.json'), 'utf8'))
    billingRows = Object.fromEntries(m.rows.map((r) => {
      const missing = rowMissing(r, { today, maxAgeDays: m.verificationMaxAgeDays })
      return [r.country, { complete: missing.length === 0, missing }]
    }))
  } catch { /* no matrix file: the probe reports "not_started" */ }
  return {
    packs,
    probeCtx: {
      billingRows,
      countries: data.COUNTRY_PROFILES,
      locales: loc.LOCALES,
      chargeCurrencies: [...methods.CHARGE_CURRENCIES],
      paymentMethodsFor: data.paymentMethodsFor,
      calendarInfo: hol.calendarInfo,
    },
  }
}

export async function run(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let o
  try { o = parseArgs(argv) } catch (e) { stderr.write(`${e.message}\n`); return 2 }

  const today = o.today ?? new Date().toISOString().slice(0, 10)
  let cfg
  try { cfg = JSON.parse(readFileSync(resolve(ROOT, o.config), 'utf8')) } catch (e) {
    stderr.write(`Cannot read ${o.config}: ${e.message}\n`); return 2
  }
  const facts = await loadFacts(today)
  if (o.pack && !facts.packs[o.pack]) { stderr.write(`Unknown pack ${o.pack}. Known: ${Object.keys(facts.packs).join(', ')}\n`); return 2 }

  const { errors } = validateConfig(cfg, { packs: facts.packs, today, fileExists: (rel) => existsSync(resolve(ROOT, rel)) })
  if (errors.length) {
    stderr.write(`${o.config} is invalid (${errors.length}):\n${errors.map((e) => ` - ${e}`).join('\n')}\n`)
    return 2
  }
  if (o.check) { stdout.write(`OK: ${o.config} is valid (${cfg.items.length} items, ${Object.keys(facts.packs).length} packs).\n`); return 0 }

  const report = evaluate(cfg, { packs: facts.packs, probes: PROBES, probeCtx: facts.probeCtx, today, onlyPack: o.pack })
  const text = o.format === 'json' ? `${JSON.stringify(report, null, 2)}\n`
    : o.format === 'text' ? `${renderText(report)}\n`
    : renderMarkdown(report, { detail: o.detail })

  if (o.out) {
    const target = resolve(ROOT, o.out)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
    stdout.write(`Wrote ${o.out}\n`)
  } else stdout.write(text)

  return o.strict && !report.allReady ? 3 : 0
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code })
}
