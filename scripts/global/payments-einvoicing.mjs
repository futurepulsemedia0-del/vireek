#!/usr/bin/env node
// Payments / e-invoicing matrix: validate, render the doc, report completeness, print the pack hash.
//
//   node --experimental-strip-types --no-warnings scripts/global/payments-einvoicing.mjs <mode> [flags]
//
// Modes (exactly one):
//   --check            validate config + confirm docs/global/payments-einvoicing.md is in sync (CI)
//   --write            regenerate the table block inside the doc
//   --report           completeness per pack (default mode)
//   --hash <PACK>      print the sha256 staff must supply when clearing the pack in the database
// Flags: --pack <PACK>  --strict (report: exit 3 if a selected GATED pack is incomplete)  --json  --today YYYY-MM-DD
// Exit: 0 ok | 2 usage/invalid config | 3 --strict incomplete | 4 doc out of date.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluatePacks, extractBlock, injectBlock, renderStatus, renderTables, validateMatrix } from '../lib/paymentsEinvoicing.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONFIG = 'config/global/payments-einvoicing.json'
const DOC = 'docs/global/payments-einvoicing.md'

export function parseArgs(argv) {
  const o = { mode: null, pack: null, strict: false, json: false, today: null, hashPack: null }
  const setMode = (m) => { if (o.mode) throw new Error('choose one mode'); o.mode = m }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`); return v }
    if (a === '--check') setMode('check')
    else if (a === '--write') setMode('write')
    else if (a === '--report') setMode('report')
    else if (a === '--hash') { setMode('hash'); o.hashPack = val().toUpperCase() }
    else if (a === '--pack') o.pack = val().toUpperCase()
    else if (a === '--strict') o.strict = true
    else if (a === '--json') o.json = true
    else if (a === '--today') o.today = val()
    else throw new Error(`unknown flag ${a}`)
  }
  if (o.today !== null && !/^\d{4}-\d{2}-\d{2}$/.test(o.today)) throw new Error('--today must be YYYY-MM-DD')
  o.mode ??= 'report'
  return o
}

const load = (rel) => import(pathToFileURL(resolve(ROOT, rel)).href)

export async function run(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), root = ROOT, configPath = CONFIG, docPath = DOC } = {}) {
  let o
  try { o = parseArgs(argv) } catch (e) { err(`${e.message}\n`); return 2 }
  const data = await load('src/lib/regionalPacks/packData.ts')
  const packs = Object.fromEntries(Object.entries(data.PACKS).map(([c, p]) => [c, { name: p.name, countries: [...p.countries] }]))
  for (const p of [o.pack, o.hashPack]) if (p && !packs[p]) { err(`Unknown pack ${p}. Known: ${Object.keys(packs).join(', ')}\n`); return 2 }

  let cfg
  try { cfg = JSON.parse(readFileSync(resolve(root, configPath), 'utf8')) } catch (e) { err(`Cannot read ${configPath}: ${e.message}\n`); return 2 }
  const errors = validateMatrix(cfg, { packs })
  if (errors.length) { err(`${configPath} is invalid (${errors.length}):\n${errors.map((e) => ` - ${e}`).join('\n')}\n`); return 2 }

  const knownMethods = Object.keys(data.PAYMENT_METHODS)
  const today = o.today ?? new Date().toISOString().slice(0, 10)
  const block = `${renderTables(cfg, { packs, knownMethods })}`

  if (o.mode === 'write' || o.mode === 'check') {
    const docFile = resolve(root, docPath)
    const current = readFileSync(docFile, 'utf8')
    let next
    try { next = injectBlock(current, block) } catch (e) { err(`${docPath}: ${e.message}\n`); return 2 }
    if (o.mode === 'write') { writeFileSync(docFile, next); out(`Updated ${docPath}\n`); return 0 }
    if (next !== current || extractBlock(next) !== extractBlock(current)) { err(`${docPath} is out of date. Run: npm run payments-einvoicing:write\n`); return 4 }
    out(`OK: ${configPath} valid (${cfg.rows.length} rows) and ${docPath} in sync.\n`)
    return 0
  }

  const all = evaluatePacks(cfg, { packs, today })
  if (o.mode === 'hash') { out(`${all.find((p) => p.code === o.hashPack).hash}\n`); return 0 }

  const sel = o.pack ? all.filter((p) => p.code === o.pack) : all
  if (o.json) out(`${JSON.stringify({ today, packs: sel }, null, 2)}\n`)
  else {
    out(`${renderStatus(sel)}\n`)
    for (const p of sel) for (const r of p.rows.filter((x) => !x.complete)) out(`  ${p.code}/${r.country}: ${r.missing.join(', ')}\n`)
  }
  return o.strict && sel.some((p) => p.gated && !p.complete) ? 3 : 0
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run(process.argv.slice(2)).then((c) => { process.exitCode = c })
}
