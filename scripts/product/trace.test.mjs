// Tests for scripts/product/trace.mjs. No network, no database: fixtures are written to a temp dir.
// Run: node --test scripts/product/trace.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyze, applyBaseline, BASELINE_PATH, isPlaceholder, loadUniverse, main, matchRef, parseArgs, parseRoutes, ROOT, OKR_PATH } from './trace.mjs'

const APP = `
<Route path="/" element={<HomePage />} />
<Route path="/login" element={<LoginPage />} />
<Route path="/old" element={<Navigate to="/new" replace />} />
<Route path={'/single'} element={<SinglePage />} />
<Route path={ROUTES.JOBS} element={<ProtectedRoute><JobsPage /></ProtectedRoute>} />
<Route path="/dashboard/jobs" element={<ProtectedRoute><JobsPage /></ProtectedRoute>} />
<Route path="/dashboard/jobs/:id" element={<ProtectedRoute><JobPage /></ProtectedRoute>} />
<Route path="*" element={<NotFound />} />
<Route path="/login" element={<LoginPage />} />
`
const FEATURES = ['route:/', 'route:/dashboard/jobs', 'route:/dashboard/jobs/:id', 'route:/login', 'fn:voice-call', 'fn:voice-tts', 'fn:send-sms']

function goal(over = {}) {
  return {
    id: 'G1', title: 'Real goal', status: 'active',
    keyResults: [{ id: 'G1-KR1', metric: 'm' }],
    bets: [{ id: 'G1-B1', title: 'b', status: 'in-progress', shipped: ['route:/dashboard/jobs*', 'fn:voice-*'] }],
    ...over,
  }
}
const doc = (over = {}) => ({ schemaVersion: 1, goals: [goal()], exempt: [], ...over })

function fixture(okrs) {
  const root = mkdtempSync(join(tmpdir(), 'trace-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/App.tsx'), APP)
  for (const f of ['voice-call', 'send-sms', '_shared']) mkdirSync(join(root, 'supabase/functions', f), { recursive: true })
  mkdirSync(join(root, 'docs/product'), { recursive: true })
  writeFileSync(join(root, OKR_PATH), typeof okrs === 'string' ? okrs : JSON.stringify(okrs))
  return root
}
const run = (root, ...argv) => { const out = []; const code = main(argv, { root, log: (s) => out.push(s) }); return { code, out: out.join('\n') } }

test('parseRoutes: dedupes, skips redirect, catch-all and ROUTES.* constants (counted)', () => {
  const r = parseRoutes(APP)
  assert.deepEqual(r.paths.sort(), ['/', '/dashboard/jobs', '/dashboard/jobs/:id', '/login', '/single'])
  assert.equal(r.unresolved, 1)
})

test('loadUniverse: routes + edge functions, _shared excluded', () => {
  const root = fixture(doc())
  try {
    const u = loadUniverse(root)
    assert.ok(u.features.includes('route:/single') && u.features.includes('fn:voice-call') && u.features.includes('fn:send-sms'))
    assert.ok(!u.features.some((f) => f.includes('_shared')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('matchRef: glob, kind separation, invalid syntax', () => {
  assert.deepEqual(matchRef('route:/dashboard/jobs*', FEATURES), ['route:/dashboard/jobs', 'route:/dashboard/jobs/:id'])
  assert.deepEqual(matchRef('route:/dashboard/jobs', FEATURES), ['route:/dashboard/jobs'])
  assert.deepEqual(matchRef('fn:voice-*', FEATURES), ['fn:voice-call', 'fn:voice-tts'])
  assert.deepEqual(matchRef('fn:/', FEATURES), [])
  assert.equal(matchRef('jobs', FEATURES), null)
  assert.equal(matchRef(42, FEATURES), null)
  assert.deepEqual(matchRef('route:/a.b', ['route:/aXb']), [], 'regex metacharacters are literal')
})

test('analyze: orphan features and goals without shipped work are flagged', () => {
  const r = analyze(doc({ goals: [goal(), goal({ id: 'G2', bets: [{ id: 'G2-B1', title: 'x', status: 'proposed', shipped: [] }], keyResults: [{ id: 'G2-KR1', metric: 'm' }] })] }), FEATURES)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.orphans.sort(), ['fn:send-sms', 'route:/', 'route:/login'])
  assert.deepEqual(r.goalsWithoutWork, ['G2'])
})

test('analyze: exempt removes an orphan; dangling exempt is an error', () => {
  const ok = analyze(doc({ exempt: [{ ref: 'route:/login', reason: 'auth shell' }, { ref: 'route:/', reason: 'marketing' }, { ref: 'fn:send-sms', reason: 'infra' }] }), FEATURES)
  assert.deepEqual(ok.orphans, [])
  const bad = analyze(doc({ exempt: [{ ref: 'route:/nope', reason: 'x' }] }), FEATURES)
  assert.match(bad.errors.join('\n'), /matches nothing/)
})

test('analyze: dangling ref, invalid ref, duplicate ids, bad enums, wrong schemaVersion', () => {
  const g = goal({ status: 'wat', bets: [{ id: 'G1', title: 'b', status: 'nope', shipped: ['route:/gone', 'oops'] }] })
  const r = analyze({ schemaVersion: 2, goals: [g, goal()] }, FEATURES)
  const e = r.errors.join('\n')
  for (const re of [/schemaVersion/, /duplicate id "G1"/, /status must be one of placeholder/, /status must be one of proposed/, /route:\/gone" matches nothing/, /invalid ref "oops"/]) assert.match(e, re)
})

test('analyze: non-object input and dropped goals', () => {
  assert.match(analyze([], FEATURES).errors[0], /JSON object/)
  const r = analyze(doc({ goals: [goal({ status: 'dropped', bets: [] })] }), FEATURES)
  assert.deepEqual(r.goalsWithoutWork, [])
})

test('analyze: feature linked to two goals is allowed and reported', () => {
  const g2 = goal({ id: 'G2', keyResults: [{ id: 'G2-KR1', metric: 'm' }], bets: [{ id: 'G2-B1', title: 'b', status: 'shipped', shipped: ['fn:voice-call'] }] })
  const r = analyze(doc({ goals: [goal(), g2] }), FEATURES)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.multiGoal, [{ feature: 'fn:voice-call', goals: ['G1', 'G2'] }])
})

test('placeholders are recognised and never count as real work', () => {
  assert.ok(isPlaceholder('TODO: x') && isPlaceholder(' TBD') && !isPlaceholder('Todo list app'))
  const r = analyze(doc({ goals: [goal({ title: 'TODO: goal', status: 'placeholder' })] }), FEATURES)
  assert.deepEqual(r.placeholderGoals, ['G1'])
})

test('main: report-only exits 0; --check gates errors only; --strict gates orphans too', () => {
  const clean = fixture(doc())
  try {
    assert.equal(run(clean).code, 0)
    assert.equal(run(clean, '--check').code, 0)
    const s = run(clean, '--strict')
    assert.equal(s.code, 1)
    assert.match(s.out, /Features with no linked goal \(4 of 7\)/)
  } finally { rmSync(clean, { recursive: true, force: true }) }
  const broken = fixture(doc({ goals: [goal({ bets: [{ id: 'B', title: 'b', status: 'proposed', shipped: ['fn:missing'] }] })] }))
  try {
    assert.equal(run(broken).code, 0)
    assert.equal(run(broken, '--check').code, 1)
  } finally { rmSync(broken, { recursive: true, force: true }) }
})

test('main: --json output parses; bad file / bad args exit 2', () => {
  const root = fixture(doc())
  try {
    const j = JSON.parse(run(root, '--json').out)
    assert.equal(j.featureCount, 7)
    assert.deepEqual(j.orphans.sort(), ["fn:send-sms", "route:/login", "route:/", "route:/single"].sort())
  } finally { rmSync(root, { recursive: true, force: true }) }
  const bad = fixture('{ nope')
  try { assert.equal(run(bad).code, 2) } finally { rmSync(bad, { recursive: true, force: true }) }
  assert.equal(run('/definitely/not/here').code, 2)
  assert.equal(run(ROOT, '--bogus').code, 2)
  assert.throws(() => parseArgs(['--limit', '0']))
})

test('committed docs/product/okrs.json is structurally valid against the real repo', () => {
  const doc = JSON.parse(readFileSync(join(ROOT, OKR_PATH), 'utf8'))
  const r = analyze(doc, loadUniverse(ROOT).features)
  assert.deepEqual(r.errors, [])
})

test('applyBaseline: new / baselined / stale split', () => {
  const r = applyBaseline(['a', 'b', 'c'], { orphans: ['b', 'gone'] })
  assert.deepEqual(r, { newOrphans: ['a', 'c'], baselined: ['b'], stale: ['gone'] })
  assert.deepEqual(applyBaseline(['a'], null), { newOrphans: ['a'], baselined: [], stale: [] })
})

test('main: baseline ratchet (--update-baseline, strict passes on baselined, fails on new or stale)', () => {
  const okDoc = doc({ goals: [goal()] })
  const root = fixture(okDoc)
  try {
    assert.equal(run(root, '--strict').code, 1)
    const u = run(root, '--update-baseline')
    assert.equal(u.code, 0)
    const saved = JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8'))
    assert.deepEqual(saved, { schemaVersion: 1, orphans: ['fn:send-sms', 'route:/', 'route:/login', 'route:/single'] })
    assert.equal(run(root, '--strict').code, 0, 'all orphans baselined')
    // a new feature appears -> fails
    mkdirSync(join(root, 'supabase/functions/brand-new'))
    const n = run(root, '--strict')
    assert.equal(n.code, 1)
    assert.match(n.out, /1 new/)
    // a baselined feature gets linked -> stale entry fails until baseline is refreshed
    rmSync(join(root, 'supabase/functions/brand-new'), { recursive: true })
    writeFileSync(join(root, OKR_PATH), JSON.stringify(doc({ goals: [goal({ bets: [{ id: 'G1-B1', title: 'b', status: 'in-progress', shipped: ['route:/dashboard/jobs*', 'fn:*'] }] })] })))
    const st = run(root, '--strict')
    assert.equal(st.code, 1)
    assert.match(st.out, /stale baseline/)
    assert.equal(run(root, '--update-baseline').code, 0)
    assert.equal(run(root, '--strict').code, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('main: --update-baseline refuses on errors; malformed baseline exits 2', () => {
  const root = fixture(doc({ goals: [goal({ bets: [{ id: 'B', title: 'b', status: 'proposed', shipped: ['fn:missing'] }] })] }))
  try {
    assert.equal(run(root, '--update-baseline').code, 1)
    mkdirSync(join(root, 'docs/product'), { recursive: true })
    writeFileSync(join(root, BASELINE_PATH), '{"schemaVersion":2}')
    assert.equal(run(root).code, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
