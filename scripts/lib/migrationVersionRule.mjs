// Version-window rule for NEW supabase/migrations files (ADR-0010, DECISIONS_NEEDED D-11).
// Pure functions, no I/O, so they are unit-testable (scripts/lib/migrationVersionRule.test.mjs).
//
//   R1  a version is a REAL UTC date-time: YYYYMMDDHHMMSS (Feb 30 / month 13 / hour 25 are rejected)
//   R2  a new version is NOT future-dated:
//         - normal mode  (newest existing version <= now): version <= now + 10 min (clock skew)
//         - frontier mode (legacy future-dated files exist): version <= newest existing + 1 day
//       Frontier mode exists only because ~690 legacy files are dated in the future and monotonic order
//       (version > newest existing) outranks calendar honesty. It switches itself off once those files
//       are repaired (docs/runbooks/migration-versioning.md, Phase 3).
//   R3  monotonic order (version > newest existing) is enforced separately in scripts/lint-migrations.mjs.

export const DAY_MS = 86_400_000
export const CLOCK_SKEW_MS = 10 * 60_000
export const EXCEPTION_KINDS = ['irregular-name']

export function toVersion(date) {
  return date.toISOString().replace(/\D/g, '').slice(0, 14)
}

/** Returns a Date for a real UTC timestamp string, otherwise null. */
export function parseVersion(v) {
  if (typeof v !== 'string' || !/^\d{14}$/.test(v)) return null
  const d = new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(8, 10), +v.slice(10, 12), +v.slice(12, 14)))
  return Number.isNaN(d.getTime()) || toVersion(d) !== v ? null : d
}

/** Highest version a NEW migration may carry. legacyMax = newest version among files already on the base branch. */
export function versionCeiling(legacyMax, now) {
  const nowV = toVersion(now)
  const frontier = legacyMax && legacyMax > nowV ? parseVersion(legacyMax) : null
  return frontier ? toVersion(new Date(frontier.getTime() + DAY_MS)) : toVersion(new Date(now.getTime() + CLOCK_SKEW_MS))
}

/** Messages for a new file's version (empty array = fine). Order (R3) is NOT checked here. */
export function checkVersionWindow({ version, legacyMax, now }) {
  if (!parseVersion(version)) return [`version ${version} is not a real UTC date-time (YYYYMMDDHHMMSS)`]
  const ceiling = versionCeiling(legacyMax, now)
  return version > ceiling
    ? [`version ${version} is future-dated; the latest allowed version is ${ceiling}. Continue the sequence (node scripts/migrations/check-migration-versioning.mjs next) instead of jumping ahead`]
    : []
}

/** Parses scripts/migrations/legacy-exceptions.json text -> { names:Set<string>, problems:string[] }. */
export function parseExceptions(text) {
  const out = { names: new Set(), problems: [] }
  let doc
  try { doc = JSON.parse(text) } catch (e) { out.problems.push(`legacy-exceptions.json is not valid JSON: ${e.message}`); return out }
  if (!doc || !Array.isArray(doc.entries)) { out.problems.push('legacy-exceptions.json needs an "entries" array'); return out }
  for (const [i, e] of doc.entries.entries()) {
    if (!e || typeof e.name !== 'string' || !e.name) { out.problems.push(`entries[${i}] has no "name"`); continue }
    if (!EXCEPTION_KINDS.includes(e.kind)) out.problems.push(`entries[${i}] (${e.name}) has unknown kind "${e.kind}"`)
    if (typeof e.reason !== 'string' || !e.reason.trim()) out.problems.push(`entries[${i}] (${e.name}) needs a "reason"`)
    if (out.names.has(e.name)) out.problems.push(`entries[${i}] duplicates ${e.name}`)
    out.names.add(e.name)
  }
  return out
}
