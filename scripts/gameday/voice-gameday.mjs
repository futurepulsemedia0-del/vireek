#!/usr/bin/env node
// Staging-only voice game-day runner. Drives voice-resilience-admin `set_chaos` and measures how long the platform
// ladder takes to react and recover. It changes NO vendor state: faults are injected as failing outcomes inside
// voice-health-tick, which only honors them when the staging function env has VOICE_CHAOS_ENABLED=true.
//
// Usage: STAGING_FUNCTIONS_URL=https://<staging-ref>.supabase.co/functions/v1 STAGING_STAFF_JWT=<jwt> \
//        node scripts/gameday/voice-gameday.mjs --i-am-on-staging [--drill engine_down]
// STATUS: written but NOT RUN (no staging environment was available when this was authored).
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = process.env.STAGING_FUNCTIONS_URL
const JWT = process.env.STAGING_STAFF_JWT
if (!process.argv.includes('--i-am-on-staging') || !BASE || !JWT) {
  console.error('Refusing to run: pass --i-am-on-staging and set STAGING_FUNCTIONS_URL + STAGING_STAFF_JWT.')
  process.exit(2)
}
const DRILLS = {
  engine_down: { expect: 2, note: 'engine webhook/API dead: voicemail + alert path' },
  engine_slow: { expect: 1, note: 'engine p95 latency > threshold: reduced AI' },
  tools_down: { expect: 1, note: 'CRM/calendar/DB tools failing: reduced AI' },
  carrier_down: { expect: 0, note: 'carrier API failing alone (engine fine): breaker opens, ladder stays 0 unless engine also down' },
}
const only = process.argv.includes('--drill') ? process.argv[process.argv.indexOf('--drill') + 1] : null
const call = async (body) => {
  const r = await fetch(`${BASE}/voice-resilience-admin`, { method: 'POST', headers: { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${body.action} -> HTTP ${r.status}`)
  return r.json()
}
const level = async () => (await call({ action: 'status' })).platform_level
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred, maxMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) { if (await pred(await level())) return Math.round((Date.now() - t0) / 1000); await sleep(10_000) }
  return null
}
const results = []
for (const [fault, d] of Object.entries(DRILLS)) {
  if (only && only !== fault) continue
  console.log(`== drill ${fault}: ${d.note}`)
  await call({ action: 'set_chaos', fault, minutes: 15, active: true })
  const detect = await waitFor((l) => l >= d.expect && (d.expect > 0 || true), 8 * 60_000)
  const reacted = d.expect === 0 ? (await level()) === 0 : detect !== null
  await call({ action: 'set_chaos', fault, minutes: 1, active: false })
  const recover = await waitFor((l) => l === 0, 25 * 60_000)
  results.push({ fault, expectedLevel: d.expect, detectSeconds: detect, recoverSeconds: recover, passed: reacted && recover !== null })
  console.log(results.at(-1))
}
mkdirSync('docs/runbooks/gameday-results', { recursive: true })
const file = `docs/runbooks/gameday-results/${new Date().toISOString().slice(0, 10)}.json`
writeFileSync(file, JSON.stringify({ environment: 'staging', results }, null, 2))
console.log('wrote', file)
process.exit(results.every((r) => r.passed) ? 0 : 1)
