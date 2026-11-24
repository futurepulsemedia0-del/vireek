// Pure core of the market-entry readiness report (no I/O, no clock, no network).
// CLI: scripts/global/market-entry-report.mjs   Tests: scripts/lib/marketEntry.test.mjs
// Data: config/global/market-entry.json         Doc:   docs/global/market-entry.md
//
// Principles (the tests pin each one):
//   * Nothing counts as done without evidence. VERIFY items also need source + verifiedOn,
//     COUNSEL items also need reviewer + reviewedOn.
//   * Items with a `probe` are derived from the code; a manual entry for them is a config error.
//   * Missing information is "not_started", never a guess.

export const STATES = ['not_started', 'in_progress', 'blocked', 'done', 'not_applicable']
export const TAGS = ['COUNSEL', 'VERIFY']
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
const STALE_PACK_DATA_DAYS = 365

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v.trim() : '')

export function isIsoDay(value) {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS)
}

/**
 * Checks one manual status entry against the rules for its item.
 * @returns {string[]} problems (empty when valid)
 */
export function checkEntry(item, entry, { today, fileExists }) {
  const problems = []
  if (!isObj(entry)) return ['entry must be an object']
  if (!STATES.includes(entry.state)) return [`state must be one of ${STATES.join(', ')}`]
  const tags = item.tags ?? []

  if (entry.state === 'done') {
    if (!str(entry.evidence)) problems.push('done requires non-empty evidence')
    if (tags.includes('VERIFY')) {
      if (!str(entry.source)) problems.push('done on a VERIFY item requires source')
      if (!isIsoDay(entry.verifiedOn)) problems.push('done on a VERIFY item requires verifiedOn (YYYY-MM-DD)')
    }
  }
  if (entry.state === 'done' || entry.state === 'not_applicable') {
    if (tags.includes('COUNSEL')) {
      if (!str(entry.reviewer)) problems.push(`${entry.state} on a COUNSEL item requires reviewer`)
      if (!isIsoDay(entry.reviewedOn)) problems.push(`${entry.state} on a COUNSEL item requires reviewedOn (YYYY-MM-DD)`)
    }
  }
  if (entry.state === 'not_applicable' && !str(entry.note)) problems.push('not_applicable requires a note explaining why')
  if (entry.state === 'blocked' && !str(entry.note)) problems.push('blocked requires a note naming the blocker')

  for (const k of ['verifiedOn', 'reviewedOn']) {
    if (entry[k] === undefined || entry[k] === null) continue
    if (!isIsoDay(entry[k])) problems.push(`${k} must be YYYY-MM-DD`)
    else if (today && entry[k] > today) problems.push(`${k} is in the future`)
  }
  const ev = str(entry.evidence)
  if (ev.startsWith('repo:') && fileExists && !fileExists(ev.slice(5))) problems.push(`evidence file not found: ${ev.slice(5)}`)
  return problems
}

/**
 * @param cfg   parsed config/global/market-entry.json
 * @param ctx   { packs: { [code]: { countries: string[] } }, today: 'YYYY-MM-DD', fileExists?: (rel) => boolean }
 * @returns {{ errors: string[] }}
 */
export function validateConfig(cfg, ctx) {
  const errors = []
  const push = (m) => errors.push(m)
  if (!isObj(cfg)) return { errors: ['config must be an object'] }
  if (cfg.schemaVersion !== 1) push('schemaVersion must be 1')
  if (!Array.isArray(cfg.categories) || cfg.categories.length === 0) push('categories must be a non-empty array')
  if (!Array.isArray(cfg.items) || cfg.items.length === 0) push('items must be a non-empty array')
  if (errors.length) return { errors }

  const catIds = new Set()
  for (const c of cfg.categories) {
    if (!isObj(c) || !str(c.id) || !str(c.label)) push('every category needs id and label')
    else if (catIds.has(c.id)) push(`duplicate category id ${c.id}`)
    else catIds.add(c.id)
  }
  const itemById = new Map()
  for (const it of cfg.items) {
    if (!isObj(it) || !str(it.id)) { push('every item needs an id'); continue }
    if (itemById.has(it.id)) { push(`duplicate item id ${it.id}`); continue }
    itemById.set(it.id, it)
    if (!catIds.has(it.category)) push(`${it.id}: unknown category ${it.category}`)
    if (!str(it.title) || !str(it.description)) push(`${it.id}: title and description are required`)
    if (!Array.isArray(it.tags) || it.tags.some((t) => !TAGS.includes(t))) push(`${it.id}: tags must be a subset of ${TAGS.join(', ')}`)
    if (it.probe !== undefined && !str(it.probe)) push(`${it.id}: probe must be a non-empty string`)
  }

  const checkMap = (where, map) => {
    if (map === undefined) return
    if (!isObj(map)) { push(`${where}: must be an object`); return }
    for (const [itemId, entry] of Object.entries(map)) {
      const item = itemById.get(itemId)
      if (!item) { push(`${where}: unknown item ${itemId}`); continue }
      if (item.probe) { push(`${where}.${itemId}: item is derived from code (probe ${item.probe}); remove the manual entry`); continue }
      for (const p of checkEntry(item, entry, ctx)) push(`${where}.${itemId}: ${p}`)
    }
  }

  const known = ctx.packs
  const countryToPack = new Map()
  for (const [code, p] of Object.entries(known)) for (const c of p.countries) countryToPack.set(c, code)

  if (!isObj(cfg.packs)) push('packs must be an object')
  else {
    for (const code of Object.keys(cfg.packs)) if (!known[code]) push(`packs.${code}: not a regional pack`)
    for (const code of Object.keys(known)) if (!cfg.packs[code]) push(`packs.${code}: missing (every regional pack needs an entry, even if empty)`)
    for (const [code, p] of Object.entries(cfg.packs)) {
      if (!isObj(p)) { push(`packs.${code}: must be an object`); continue }
      checkMap(`packs.${code}.shared`, p.shared)
    }
  }
  if (cfg.markets !== undefined && !isObj(cfg.markets)) push('markets must be an object')
  else for (const [country, map] of Object.entries(cfg.markets ?? {})) {
    if (!countryToPack.has(country)) { push(`markets.${country}: not a country of any regional pack`); continue }
    checkMap(`markets.${country}`, map)
  }
  return { errors }
}

const NEW_ENTRY = Object.freeze({ state: 'not_started' })

/** Resolve one item for one country: probe > country entry > pack-shared entry > not_started. */
export function resolveItem(cfg, item, packCode, country, probes, probeCtx) {
  const base = { id: item.id, category: item.category, title: item.title, tags: item.tags ?? [] }
  if (item.probe) {
    const fn = probes[item.probe]
    if (typeof fn !== 'function') return { ...base, state: 'blocked', derived: true, detail: `unknown probe "${item.probe}"` }
    let r
    try { r = fn(country, probeCtx) } catch (e) { r = { state: 'blocked', detail: `probe failed: ${e instanceof Error ? e.message : String(e)}` } }
    return { ...base, state: STATES.includes(r?.state) ? r.state : 'blocked', derived: true, evidence: r?.evidence ?? null, detail: r?.detail ?? null }
  }
  const entry = cfg.markets?.[country]?.[item.id] ?? cfg.packs?.[packCode]?.shared?.[item.id] ?? NEW_ENTRY
  return { ...base, state: entry.state, derived: false, evidence: entry.evidence ?? null, detail: entry.note ?? null }
}

const RESOLVED = new Set(['done', 'not_applicable'])

export function evaluate(cfg, ctx) {
  const { packs, probes, probeCtx, today, onlyPack } = ctx
  const out = []
  for (const code of Object.keys(packs)) {
    if (onlyPack && onlyPack !== code) continue
    const pack = packs[code]
    const countries = pack.countries.map((country) => {
      const items = cfg.items.map((it) => resolveItem(cfg, it, code, country, probes, probeCtx))
      const counts = { total: items.length, done: 0, not_applicable: 0, in_progress: 0, not_started: 0, blocked: 0 }
      for (const it of items) counts[it.state] += 1
      const blockers = items.filter((it) => !RESOLVED.has(it.state)).map((it) => it.id)
      return {
        code: country,
        name: pack.countryNames?.[country] ?? country,
        ready: blockers.length === 0,
        percent: Math.round(((counts.done + counts.not_applicable) / counts.total) * 100),
        counts, items, blockers,
      }
    })
    const warnings = []
    if (pack.dataVerifiedAt && isIsoDay(pack.dataVerifiedAt) && daysBetween(pack.dataVerifiedAt, today) > STALE_PACK_DATA_DAYS) {
      warnings.push(`Bundled pack data was last verified ${pack.dataVerifiedAt} (more than ${STALE_PACK_DATA_DAYS} days ago).`)
    }
    const total = countries.reduce((n, c) => n + c.counts.total, 0)
    const resolved = countries.reduce((n, c) => n + c.counts.done + c.counts.not_applicable, 0)
    out.push({
      code, name: pack.name, ready: countries.every((c) => c.ready),
      percent: total ? Math.round((resolved / total) * 100) : 0,
      countries,
      byCategory: cfg.categories.map((cat) => {
        const rows = countries.flatMap((c) => c.items.filter((i) => i.category === cat.id))
        return { id: cat.id, label: cat.label, resolved: rows.filter((r) => RESOLVED.has(r.state)).length, total: rows.length }
      }),
      warnings,
    })
  }
  return { generatedFor: today, packs: out, allReady: out.length > 0 && out.every((p) => p.ready) }
}

/* ------------------------------ probes ------------------------------ */

const baseLang = (locale) => String(locale ?? '').split(/[-_]/)[0].toLowerCase()

/**
 * Probes read facts that already live in the repo. Inputs come from the CLI:
 *   probeCtx = { countries, locales, chargeCurrencies, paymentMethodsFor, calendarInfo }
 */
export const PROBES = {
  country_profile(country, { countries }) {
    const c = countries[country]
    if (!c) return { state: 'not_started', detail: `no CountryProfile for ${country}` }
    const ok = c.phone && c.phone.minLen > 0 && c.postal && c.postal.regex
    return ok
      ? { state: 'done', evidence: 'repo:src/lib/regionalPacks/packData.ts', detail: `phone +${c.phone.callingCode}, postal "${c.postal.label}"` }
      : { state: 'in_progress', detail: 'CountryProfile exists but phone/postal rule incomplete' }
  },
  payment_methods(country, { countries, chargeCurrencies, paymentMethodsFor }) {
    const c = countries[country]
    if (!c) return { state: 'not_started', detail: `no CountryProfile for ${country}` }
    const cur = c.currency.toLowerCase()
    if (!chargeCurrencies.includes(cur)) return { state: 'blocked', detail: `${c.currency} is not in CHARGE_CURRENCIES` }
    const methods = paymentMethodsFor(country, c.currency)
    if (methods.length === 0) return { state: 'blocked', detail: `no method can settle in ${c.currency}` }
    return { state: 'done', evidence: 'repo:supabase/functions/_shared/payments/regionalMethods.ts', detail: `${c.currency}: ${methods.map((m) => m.type).join(', ')}` }
  },
  ui_locale(country, { countries, locales }) {
    const c = countries[country]
    if (!c) return { state: 'not_started', detail: `no CountryProfile for ${country}` }
    const lang = baseLang(c.locale)
    const cfg = locales[lang]
    if (!cfg) return { state: 'not_started', detail: `"${lang}" is not a configured UI locale (falls back to English)` }
    if (cfg.beta || cfg.tier === 'C') return { state: 'in_progress', detail: `"${lang}" is Tier ${cfg.tier}${cfg.beta ? ' (Beta)' : ''}, surfaces ${cfg.surfaces.join('/')}` }
    return { state: 'done', evidence: 'repo:src/i18n/locales.config.ts', detail: `"${lang}" is Tier ${cfg.tier}` }
  },
  billing_matrix(country, { billingRows }) {
    const r = billingRows?.[country]
    if (!r) return { state: 'not_started', detail: 'no payments/e-invoicing row' }
    if (r.complete) return { state: 'done', evidence: 'repo:config/global/payments-einvoicing.json', detail: 'row complete and verified' }
    return { state: 'in_progress', detail: `${r.missing.length} field(s) open: ${r.missing.slice(0, 3).join(', ')}${r.missing.length > 3 ? ', ...' : ''}` }
  },
  holiday_calendar(country, { calendarInfo }) {
    const info = calendarInfo(country)
    if (info.coverage === 'full') return { state: 'done', evidence: 'repo:src/lib/regionalPacks/packHolidays.ts', detail: 'full calendar' }
    if (info.coverage === 'national_core') return { state: 'in_progress', detail: info.note ?? 'national core only' }
    return { state: 'not_started', detail: info.note ?? 'minimal coverage' }
  },
}

/* ------------------------------ rendering ---------------------------- */

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
const tagText = (tags) => tags.map((t) => `[${t}]`).join(' ')
const ICON = { done: 'done', not_applicable: 'n/a', in_progress: 'in progress', not_started: 'not started', blocked: 'BLOCKED' }

export function renderMarkdown(report, { detail = false } = {}) {
  const L = []
  L.push('# Market-entry readiness')
  L.push('')
  L.push(`Generated for ${report.generatedFor}. A market is ready only when every item is done (with evidence) or not applicable (with a written reason). Items tagged [COUNSEL] and [VERIFY] are never ready on assertion alone. This report is not legal advice.`)
  L.push('')
  L.push('| Pack | Ready | Progress | Countries ready |')
  L.push('| --- | --- | --- | --- |')
  for (const p of report.packs) {
    L.push(`| ${p.code} ${cell(p.name)} | ${p.ready ? 'yes' : 'no'} | ${p.percent}% | ${p.countries.filter((c) => c.ready).length}/${p.countries.length} |`)
  }
  for (const p of report.packs) {
    L.push('')
    L.push(`## ${p.code} - ${p.name}`)
    L.push('')
    L.push(`Status: **${p.ready ? 'READY' : 'NOT READY'}** (${p.percent}% of checklist items resolved).`)
    for (const w of p.warnings) L.push(`\n> Warning: ${w}`)
    L.push('')
    L.push('| Category | Resolved |')
    L.push('| --- | --- |')
    for (const c of p.byCategory) L.push(`| ${cell(c.label)} | ${c.resolved}/${c.total} |`)
    L.push('')
    L.push('Item coverage across the pack:')
    L.push('')
    L.push('| Item | Tags | Resolved in | Open states |')
    L.push('| --- | --- | --- | --- |')
    const ids = p.countries[0]?.items.map((i) => i.id) ?? []
    for (const id of ids) {
      const rows = p.countries.map((c) => c.items.find((i) => i.id === id))
      const resolved = rows.filter((r) => RESOLVED.has(r.state)).length
      const open = {}
      for (const r of rows) if (!RESOLVED.has(r.state)) open[r.state] = (open[r.state] ?? 0) + 1
      const openText = Object.entries(open).map(([s, n]) => `${ICON[s]} ${n}`).join(', ') || '-'
      L.push(`| \`${id}\` ${cell(rows[0].title)}${rows[0].derived ? ' (derived from code)' : ''} | ${tagText(rows[0].tags)} | ${resolved}/${rows.length} | ${openText} |`)
    }
    if (p.countries.length > 1) {
      L.push('')
      L.push('| Country | Ready | Done | In progress | Not started | Blocked | N/A |')
      L.push('| --- | --- | --- | --- | --- | --- | --- |')
      for (const c of p.countries) L.push(`| ${c.code} ${cell(c.name)} | ${c.ready ? 'yes' : 'no'} | ${c.counts.done} | ${c.counts.in_progress} | ${c.counts.not_started} | ${c.counts.blocked} | ${c.counts.not_applicable} |`)
    }
    if (detail) {
      for (const c of p.countries) {
        L.push('')
        L.push(`### ${c.code} ${c.name}`)
        L.push('')
        L.push('| Item | State | Evidence / detail |')
        L.push('| --- | --- | --- |')
        for (const i of c.items) L.push(`| \`${i.id}\` ${tagText(i.tags)} | ${ICON[i.state]} | ${cell([i.evidence, i.detail].filter(Boolean).join(' - '))} |`)
      }
    }
  }
  L.push('')
  return L.join('\n')
}

export function renderText(report) {
  const L = []
  for (const p of report.packs) {
    L.push(`${p.code.padEnd(3)} ${p.ready ? 'READY    ' : 'NOT READY'} ${String(p.percent).padStart(3)}%  ${p.name} (${p.countries.filter((c) => c.ready).length}/${p.countries.length} countries ready)`)
    for (const w of p.warnings) L.push(`    warning: ${w}`)
  }
  L.push(report.allReady ? 'All selected packs are ready.' : 'Not all selected packs are ready.')
  return L.join('\n')
}
