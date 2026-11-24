// supabase/functions/_shared/governance/commitThresholds.test.mjs
// Run: node --experimental-strip-types --no-warnings --test supabase/functions/_shared/governance/commitThresholds.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_DISCLOSURE, DEFAULT_POLICY, evaluateCommit, gateAiCommit, heldInstruction,
  holdBookingIfNeeded, holdPriceQuoteIfNeeded, loadCommitPolicy, policyFromRow, recordCommitDecision,
} from './commitThresholds.ts'

const NOW = new Date('2026-11-20T12:00:00Z')
const policy = (o = {}) => ({ ...DEFAULT_POLICY, mode: 'enforce', ...o })
const inMin = (m) => new Date(NOW.getTime() + m * 60000).toISOString()
const inDays = (d) => inMin(d * 1440)
const rules = (r) => r.breaches.map((b) => b.rule)

// ---------- evaluateCommit: price ----------
test('price: at the threshold passes, one cent above breaches', () => {
  const p = policy({ priceThresholdCents: 50000 })
  assert.equal(evaluateCommit(p, { kind: 'price', amountCents: 50000 }, NOW).requiresApproval, false)
  const over = evaluateCommit(p, { kind: 'price', amountCents: 50001 }, NOW)
  assert.deepEqual(rules(over), ['price_above_threshold'])
  assert.deepEqual(over.breaches[0], { rule: 'price_above_threshold', limit: 50000, actual: 50001 })
})

test('price: threshold 0 means the AI may never state a non-zero price', () => {
  const p = policy({ priceThresholdCents: 0 })
  assert.equal(evaluateCommit(p, { kind: 'price', amountCents: 0 }, NOW).requiresApproval, false)
  assert.equal(evaluateCommit(p, { kind: 'price', amountCents: 1 }, NOW).requiresApproval, true)
})

test('price: unverifiable amounts are breaches (NaN, Infinity, negative, string, undefined)', () => {
  for (const bad of [NaN, Infinity, -1, '500', undefined, null]) {
    assert.deepEqual(rules(evaluateCommit(policy(), { kind: 'price', amountCents: bad }, NOW)), ['unverifiable_amount'], String(bad))
  }
})

// ---------- evaluateCommit: schedule ----------
test('schedule: within every limit passes', () => {
  const r = evaluateCommit(policy({ scheduleMinNoticeMinutes: 60 }), { kind: 'schedule', startsAt: inDays(3), durationMinutes: 120 }, NOW)
  assert.equal(r.requiresApproval, false)
})

test('schedule: min notice 0 is "rule off", even for a time in the past or right now', () => {
  assert.equal(evaluateCommit(policy({ scheduleMinNoticeMinutes: 0 }), { kind: 'schedule', startsAt: inMin(0) }, NOW).requiresApproval, false)
})

test('schedule: sooner than the minimum notice breaches; exactly the minimum passes', () => {
  const p = policy({ scheduleMinNoticeMinutes: 120 })
  assert.deepEqual(rules(evaluateCommit(p, { kind: 'schedule', startsAt: inMin(119) }, NOW)), ['notice_too_short'])
  assert.equal(evaluateCommit(p, { kind: 'schedule', startsAt: inMin(120) }, NOW).requiresApproval, false)
})

test('schedule: further out than max days breaches; exactly max passes', () => {
  const p = policy({ scheduleMaxDaysAhead: 30 })
  assert.deepEqual(rules(evaluateCommit(p, { kind: 'schedule', startsAt: inDays(31) }, NOW)), ['too_far_ahead'])
  assert.equal(evaluateCommit(p, { kind: 'schedule', startsAt: inDays(30) }, NOW).requiresApproval, false)
})

test('schedule: duration over the max breaches; unknown duration is not a breach', () => {
  const p = policy({ scheduleMaxDurationMinutes: 240 })
  assert.deepEqual(rules(evaluateCommit(p, { kind: 'schedule', startsAt: inDays(1), durationMinutes: 241 }, NOW)), ['duration_too_long'])
  assert.equal(evaluateCommit(p, { kind: 'schedule', startsAt: inDays(1), durationMinutes: 240 }, NOW).requiresApproval, false)
  assert.equal(evaluateCommit(p, { kind: 'schedule', startsAt: inDays(1), durationMinutes: null }, NOW).requiresApproval, false)
  assert.equal(evaluateCommit(p, { kind: 'schedule', startsAt: inDays(1) }, NOW).requiresApproval, false)
})

test('schedule: several breaches are all reported', () => {
  const p = policy({ scheduleMinNoticeMinutes: 600, scheduleMaxDurationMinutes: 60 })
  assert.deepEqual(rules(evaluateCommit(p, { kind: 'schedule', startsAt: inMin(30), durationMinutes: 90 }, NOW)), ['notice_too_short', 'duration_too_long'])
})

test('schedule: unverifiable times are breaches', () => {
  for (const bad of ['tomorrow-ish', '', null, undefined, NaN, new Date('nope')]) {
    assert.deepEqual(rules(evaluateCommit(policy(), { kind: 'schedule', startsAt: bad }, NOW)), ['unverifiable_time'], String(bad))
  }
})

test('schedule: accepts Date, epoch ms and ISO strings equally', () => {
  const t = NOW.getTime() + 5 * 86400000
  const p = policy({ scheduleMaxDaysAhead: 1 })
  for (const v of [new Date(t), t, new Date(t).toISOString()]) assert.deepEqual(rules(evaluateCommit(p, { kind: 'schedule', startsAt: v }, NOW)), ['too_far_ahead'])
})

// ---------- gateAiCommit with fakes ----------
function harness({ pol, recordOk = true, loadSource = 'stored' } = {}) {
  const records = []
  const deps = {
    loadPolicy: async () => ({ policy: pol, source: loadSource }),
    record: async (_a, args) => { records.push(args); return recordOk ? { logId: `log-${records.length}`, ok: true } : { logId: null, ok: false } },
  }
  return { records, deps }
}
const gate = (h, proposal, extra = {}) => gateAiCommit({}, { userId: 'u1', agentSource: 't', proposal, correlationId: 'c1', now: NOW, ...extra }, h.deps)

test('enforce + breach: not allowed, held for approval, instruction forbids stating the amount', async () => {
  const h = harness({ pol: policy({ priceThresholdCents: 1000 }) })
  const r = await gate(h, { kind: 'price', amountCents: 5000 })
  assert.equal(r.allow, false)
  assert.equal(r.breachedPolicy, true)
  assert.equal(h.records.length, 1)
  assert.equal(h.records[0].decision, 'pending_approval')
  assert.match(r.assistantInstruction, /Do NOT state/)
  assert.ok(!/1000|5000|threshold limit of/i.test(r.assistantInstruction.replace(/threshold/g, '')), 'must not leak numbers')
  assert.match(r.assistantInstruction, /Never mention limits, thresholds or approval rules/)
})

test('enforce + within limits: allowed, audited as auto_approved, no instruction', async () => {
  const h = harness({ pol: policy({ priceThresholdCents: 10000 }) })
  const r = await gate(h, { kind: 'price', amountCents: 9000 })
  assert.equal(r.allow, true)
  assert.equal(r.assistantInstruction, null)
  assert.equal(h.records[0].decision, 'auto_approved')
  assert.equal(h.records[0].payload.shadow_would_hold, false)
})

test('shadow + breach: allowed, but audited as "would have held"', async () => {
  const h = harness({ pol: policy({ mode: 'shadow', priceThresholdCents: 1000 }) })
  const r = await gate(h, { kind: 'price', amountCents: 5000 })
  assert.equal(r.allow, true)
  assert.equal(r.breachedPolicy, true)
  assert.equal(h.records[0].decision, 'auto_approved')
  assert.equal(h.records[0].payload.shadow_would_hold, true)
  assert.equal(r.assistantInstruction, null)
})

test('off: allowed and nothing recorded', async () => {
  const h = harness({ pol: policy({ mode: 'off', priceThresholdCents: 0 }) })
  const r = await gate(h, { kind: 'price', amountCents: 999999 })
  assert.equal(r.allow, true)
  assert.equal(h.records.length, 0)
})

test('FAIL CLOSED: enforce + breach is still blocked when the hold record cannot be written', async () => {
  const h = harness({ pol: policy({ priceThresholdCents: 1 }), recordOk: false })
  const r = await gate(h, { kind: 'price', amountCents: 100 })
  assert.equal(r.allow, false)
  assert.equal(r.logId, null)
  assert.ok(r.assistantInstruction)
})

test('enforce + within limits is still allowed when the audit write fails (best-effort audit)', async () => {
  const h = harness({ pol: policy({ priceThresholdCents: 100000 }), recordOk: false })
  assert.equal((await gate(h, { kind: 'price', amountCents: 5 })).allow, true)
})

test('FAIL CLOSED: an unverifiable amount is held in enforce mode', async () => {
  const h = harness({ pol: policy() })
  assert.equal((await gate(h, { kind: 'price', amountCents: NaN })).allow, false)
})

test('schedule hold: instruction forbids "booked/confirmed" and the audit row carries the proposal and policy', async () => {
  const h = harness({ pol: policy({ scheduleMaxDaysAhead: 10 }) })
  const r = await gate(h, { kind: 'schedule', startsAt: inDays(20), durationMinutes: 60 }, { context: { service: 'AC repair', phone: '+49 1', big: 'x'.repeat(1000) } })
  assert.equal(r.allow, false)
  assert.match(r.assistantInstruction, /booked, confirmed or reserved/)
  const rec = h.records[0]
  assert.equal(rec.kind, 'schedule')
  assert.equal(rec.payload.policy_applied.scheduleMaxDaysAhead, 10)
  assert.equal(rec.payload.policy_applied.source, 'stored')
  assert.equal(rec.payload.breaches[0].rule, 'too_far_ahead')
  assert.equal(rec.payload.context.big.length, 300, 'context strings are truncated')
  assert.equal(rec.payload.proposal.duration_minutes, 60)
})

test('customer-visible disclosure: tenant text wins, default otherwise, and it is in the instruction and the audit row', async () => {
  const custom = 'Ich bin ein KI-Assistent und kann das nicht bestätigen.'
  const h1 = harness({ pol: policy({ priceThresholdCents: 0, disclosureText: custom }) })
  const r1 = await gate(h1, { kind: 'price', amountCents: 1 })
  assert.equal(r1.disclosure, custom)
  assert.ok(r1.assistantInstruction.includes(custom))
  assert.equal(h1.records[0].payload.disclosure_text, custom)
  const h2 = harness({ pol: policy({ priceThresholdCents: 0 }) })
  const r2 = await gate(h2, { kind: 'price', amountCents: 1 })
  assert.equal(r2.disclosure, DEFAULT_DISCLOSURE)
  assert.match(heldInstruction('price', DEFAULT_DISCLOSURE), /automated AI assistant/)
})

test('holdPriceQuoteIfNeeded / holdBookingIfNeeded: null when allowed, instruction when held', async () => {
  const held = harness({ pol: policy({ priceThresholdCents: 0, scheduleMaxDaysAhead: 0 }) })
  assert.ok(await holdPriceQuoteIfNeeded({}, { userId: 'u', amountCents: 1, correlationId: 'a' }, held.deps))
  assert.ok(await holdBookingIfNeeded({}, { userId: 'u', startsAt: inDays(2), correlationId: 'b' }, held.deps))
  const open = harness({ pol: policy() })
  assert.equal(await holdPriceQuoteIfNeeded({}, { userId: 'u', amountCents: 1, correlationId: 'a' }, open.deps), null)
  assert.equal(await holdBookingIfNeeded({}, { userId: 'u', startsAt: inDays(2), correlationId: 'b' }, open.deps), null)
})

test('booking without a time promises nothing, so nothing is evaluated or recorded', async () => {
  const h = harness({ pol: policy({ scheduleMaxDaysAhead: 0 }) })
  assert.equal(await holdBookingIfNeeded({}, { userId: 'u', startsAt: null, correlationId: 'b' }, h.deps), null)
  assert.equal(h.records.length, 0)
})

// ---------- policy loading ----------
const fakeAdmin = (result) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => result() }) }) }) })
const quiet = async (fn) => { const orig = console.error; console.error = () => {}; try { return await fn() } finally { console.error = orig } }

test('loadCommitPolicy: stored row, no row, missing table, DB error, invalid row, thrown error', async () => {
  const row = { mode: 'enforce', price_threshold_cents: 2500, schedule_min_notice_minutes: 30, schedule_max_days_ahead: 14, schedule_max_duration_minutes: 120, disclosure_text: ' hi ' }
  const stored = await loadCommitPolicy(fakeAdmin(() => ({ data: row, error: null })), 'u')
  assert.equal(stored.source, 'stored')
  assert.deepEqual(stored.policy, { mode: 'enforce', priceThresholdCents: 2500, scheduleMinNoticeMinutes: 30, scheduleMaxDaysAhead: 14, scheduleMaxDurationMinutes: 120, disclosureText: 'hi' })

  const none = await loadCommitPolicy(fakeAdmin(() => ({ data: null, error: null })), 'u')
  assert.deepEqual([none.source, none.policy.mode], ['default', 'shadow'])

  const missing = await loadCommitPolicy(fakeAdmin(() => ({ data: null, error: { code: '42P01', message: 'no table' } })), 'u')
  assert.deepEqual([missing.source, missing.policy.mode], ['default', 'shadow'])

  for (const bad of [() => ({ data: null, error: { code: '57P01', message: 'db down' } }), () => ({ data: { ...row, mode: 'yolo' }, error: null }), () => ({ data: { ...row, price_threshold_cents: 'abc' }, error: null }), () => { throw new Error('boom') }]) {
    const r = await quiet(() => loadCommitPolicy(fakeAdmin(bad), 'u'))
    assert.deepEqual([r.source, r.policy.mode], ['load_failed', 'enforce'])
  }
})

test('policyFromRow rejects out-of-range values and accepts numeric strings', () => {
  const ok = { mode: 'shadow', price_threshold_cents: '100', schedule_min_notice_minutes: 0, schedule_max_days_ahead: 1, schedule_max_duration_minutes: 1, disclosure_text: null }
  assert.equal(policyFromRow(ok).priceThresholdCents, 100)
  assert.equal(policyFromRow({ ...ok, price_threshold_cents: -1 }), null)
  assert.equal(policyFromRow({ ...ok, schedule_max_duration_minutes: 0 }), null)
})

test('recordCommitDecision maps an RPC error to ok:false and never throws', async () => {
  const bad = { rpc: async () => ({ data: null, error: { message: 'x' } }) }
  const thrown = { rpc: async () => { throw new Error('net') } }
  const good = { rpc: async (name, args) => { assert.equal(name, 'record_ai_commit_decision'); assert.equal(args.p_kind, 'price'); return { data: { log_id: 'L9' }, error: null } } }
  const a = { userId: 'u', kind: 'price', agentSource: 's', decision: 'pending_approval', correlationId: 'c', reasoning: 'r', payload: {} }
  assert.deepEqual(await quiet(() => recordCommitDecision(bad, a)), { logId: null, ok: false })
  assert.deepEqual(await quiet(() => recordCommitDecision(thrown, a)), { logId: null, ok: false })
  assert.deepEqual(await recordCommitDecision(good, a), { logId: 'L9', ok: true })
})

// ---------- drift guards: TS defaults vs SQL, and the migration's security shape ----------
const sql = readFileSync(new URL('../../../migrations/20290311000000_ai_commit_controls.sql', import.meta.url), 'utf8')

test('SQL column defaults equal DEFAULT_POLICY', () => {
  const d = (col) => Number(new RegExp(`${col}\\s+integer\\s+NOT NULL\\s+DEFAULT\\s+(\\d+)`).exec(sql)?.[1])
  assert.equal(d('price_threshold_cents'), DEFAULT_POLICY.priceThresholdCents)
  assert.equal(d('schedule_min_notice_minutes'), DEFAULT_POLICY.scheduleMinNoticeMinutes)
  assert.equal(d('schedule_max_days_ahead'), DEFAULT_POLICY.scheduleMaxDaysAhead)
  assert.equal(d('schedule_max_duration_minutes'), DEFAULT_POLICY.scheduleMaxDurationMinutes)
  assert.equal(/mode text NOT NULL DEFAULT '(\w+)'/.exec(sql)?.[1], DEFAULT_POLICY.mode)
})

test('SQL: the writer is service-role only, the policy writer is owner-only, quoted prices never use amount_cents', () => {
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.record_ai_commit_decision\([^)]*\) FROM PUBLIC, anon, authenticated;\s*GRANT EXECUTE ON FUNCTION public\.record_ai_commit_decision\([^)]*\) TO service_role;/)
  assert.match(sql, /v_uid IS DISTINCT FROM public\.get_account_owner_id\(\)/)
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.upsert_ai_commit_policy\([^)]*\) FROM PUBLIC, anon;/)
  const insertBlock = /INSERT INTO agent_action_log \(([\s\S]*?)\) VALUES/.exec(sql)[1]
  assert.ok(!/amount_cents/.test(insertBlock), 'a quoted price must not be written to amount_cents (it would consume global spending limits)')
  for (const t of ['ai_commit_policies', 'ai_commit_policy_changes']) assert.match(sql, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`))
  assert.ok(!/FOR (INSERT|UPDATE|DELETE|ALL)/i.test(sql.replace(/AFTER INSERT OR UPDATE/g, '')), 'no client write policies')
})
