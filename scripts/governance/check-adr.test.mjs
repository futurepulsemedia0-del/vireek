// scripts/governance/check-adr.test.mjs
// Run: node --test scripts/governance/check-adr.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkAdrs, parseFrontMatter } from './check-adr.mjs'

const GOOD_BODY = `
# ADR-0004 — Example

## Context
The situation today, described in enough words to be real.

## Decision
We will do the specific thing described here.

## Alternatives considered
Do nothing; or a heavier option.

## Consequences
Some things get easier and some harder.

## Evidence
The repo file shows the current behaviour in detail.
`

function adr(overrides = {}, body = GOOD_BODY) {
  const fm = {
    id: 'ADR-0004',
    title: 'Use the thing',
    status: 'accepted',
    date: '2026-11-20',
    deciders: '[OWNER_PLATFORM]',
    confidence: 'medium',
    review_by: '2027-05-20',
    evidence: ['repo:docs/adr/0001-feature-store-pilot.md'],
    ...overrides,
  }
  const lines = ['---']
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue
    if (Array.isArray(v)) { lines.push(`${k}:`); v.forEach((x) => lines.push(`  - ${x}`)) } else lines.push(`${k}: ${v}`)
  }
  lines.push('---', body)
  return lines.join('\n')
}

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'adr-'))
  mkdirSync(join(root, 'docs/adr'), { recursive: true })
  mkdirSync(join(root, 'docs/research'), { recursive: true })
  writeFileSync(join(root, 'docs/adr/0001-feature-store-pilot.md'), '# legacy\n')
  writeFileSync(join(root, 'docs/adr/0002-watch-companion-apps.md'), '# legacy\n')
  writeFileSync(join(root, 'docs/research/F-001.md'), '# finding\n')
  writeFileSync(join(root, 'docs/adr/README.md'), '# readme\n')
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content)
  return root
}

function run(files) {
  const root = repo(files)
  try { return checkAdrs({ root, now: new Date('2026-11-20T00:00:00Z') }) } finally { rmSync(root, { recursive: true, force: true }) }
}
const has = (r, text) => r.errors.some((e) => e.includes(text))

test('a complete ADR passes and legacy ADRs only warn', () => {
  const r = run({ 'docs/adr/0004-example.md': adr() })
  assert.deepEqual(r.errors, [])
  assert.equal(r.checked, 1)
  assert.equal(r.warnings.filter((w) => w.includes('legacy')).length, 2)
})

test('handles CRLF line endings and a BOM (Windows editors)', () => {
  const r = run({ 'docs/adr/0004-example.md': '\uFEFF' + adr().replace(/\n/g, '\r\n') })
  assert.deepEqual(r.errors, [])
})

test('missing front matter is an error', () => {
  assert.ok(has(run({ 'docs/adr/0004-example.md': '# no front matter\n' }), 'missing front matter'))
})

for (const field of ['title', 'status', 'date', 'deciders', 'confidence', 'review_by', 'evidence']) {
  test(`missing required field: ${field}`, () => {
    assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ [field]: undefined }) }), `missing required field "${field}"`))
  })
}

test('id must match the file name', () => {
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ id: 'ADR-0009' }) }), 'id must be ADR-0004'))
})

test('rejects unknown status and confidence', () => {
  const r = run({ 'docs/adr/0004-example.md': adr({ status: 'done', confidence: 'certain' }) })
  assert.ok(has(r, 'status must be one of'))
  assert.ok(has(r, 'confidence must be one of'))
})

test('rejects impossible dates and review_by before date', () => {
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ date: '2026-02-30' }) }), 'real YYYY-MM-DD'))
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ review_by: '2026-01-01' }) }), 'review_by cannot be earlier'))
})

test('template placeholders are rejected', () => {
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ title: '<short decision title>' }) }), 'placeholder'))
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ title: 'TBD' }) }), 'placeholder'))
})

test('evidence must point at a file that exists', () => {
  const r = run({ 'docs/adr/0004-example.md': adr({ evidence: ['repo:src/does-not-exist.ts'] }) })
  assert.ok(has(r, 'file not found'))
})

test('evidence cannot escape the repository', () => {
  for (const bad of ['repo:../secrets.txt', 'repo:/etc/passwd', 'repo:docs/../../x', 'repo:C:/Windows/win.ini', 'repo:docs\\adr\\x.md']) {
    assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ evidence: [bad] }) }), 'inside the repository'), bad)
  }
})

test('anchors on evidence paths are ignored when resolving', () => {
  const r = run({ 'docs/adr/0004-example.md': adr({ evidence: ['repo:docs/adr/0001-feature-store-pilot.md#L10'] }) })
  assert.deepEqual(r.errors, [])
})

test('research evidence must live under docs/research/', () => {
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ evidence: ['research:docs/adr/0001-feature-store-pilot.md'] }) }), 'docs/research/'))
  assert.deepEqual(run({ 'docs/adr/0004-example.md': adr({ evidence: ['research:docs/research/F-001.md'] }) }).errors, [])
})

test('external evidence must be https; [VERIFY] suffix is allowed', () => {
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ status: 'proposed', evidence: ['external:http://x.test'] }) }), 'https://'))
  const ok = run({ 'docs/adr/0004-example.md': adr({ evidence: ['repo:docs/adr/0001-feature-store-pilot.md', 'external:https://example.test/a [VERIFY]'] }) })
  assert.deepEqual(ok.errors, [])
})

test('unknown evidence kind is rejected', () => {
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ evidence: ['blog:https://x.test'] }) }), 'must start with one of'))
})

test('accepted needs grounded evidence; proposed does not', () => {
  const weak = ['external:https://example.test/a', 'assumption:We believe customers want this to be faster.']
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ evidence: weak }) }), 'accepted decision needs at least one'))
  assert.deepEqual(run({ 'docs/adr/0004-example.md': adr({ status: 'proposed', evidence: weak }) }).errors, [])
})

test('required sections are enforced; headings inside code fences do not count', () => {
  const body = GOOD_BODY.replace('## Alternatives considered', '```\n## Alternatives considered\n```')
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({}, body) }), 'missing required section "## Alternatives considered"'))
})

test('numbered section headings are accepted', () => {
  const body = GOOD_BODY.replace('## Context', '## 1. Context')
  assert.deepEqual(run({ 'docs/adr/0004-example.md': adr({}, body) }).errors, [])
})

test('empty Evidence section is an error', () => {
  const body = GOOD_BODY.replace(/## Evidence[\s\S]*$/, '## Evidence\n\n')
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({}, body) }), '"## Evidence" is empty'))
})

test('bad file names and duplicate numbers are errors', () => {
  assert.ok(has(run({ 'docs/adr/ADR-4-example.md': adr() }), 'file name must look like'))
  const r = run({ 'docs/adr/0004-one.md': adr(), 'docs/adr/0004-two.md': adr() })
  assert.ok(has(r, 'already used'))
})

test('supersession must be consistent', () => {
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ status: 'superseded' }) }), 'requires superseded_by'))
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ superseded_by: '[ADR-0005]' }) }), 'superseded_by is set but status'))
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ supersedes: '[ADR-0099]' }) }), 'does not exist'))
  assert.ok(has(run({ 'docs/adr/0004-example.md': adr({ supersedes: '[ADR-0004]' }) }), 'cannot supersede itself'))
  const ok = run({
    'docs/adr/0004-old.md': adr({ status: 'superseded', superseded_by: '[ADR-0005]' }),
    'docs/adr/0005-new.md': adr({ id: 'ADR-0005', supersedes: '[ADR-0004]' }),
  })
  assert.deepEqual(ok.errors, [])
})

test('an overdue review is a warning, never an error', () => {
  const r = run({ 'docs/adr/0004-example.md': adr({ date: '2025-01-01', review_by: '2025-06-01' }) })
  assert.deepEqual(r.errors, [])
  assert.ok(r.warnings.some((w) => w.includes('review_by 2025-06-01 has passed')))
})

test('parseFrontMatter: inline lists, quotes, and unclosed blocks', () => {
  const ok = parseFrontMatter('---\na: "x y"\nb: [1, 2]\nc:\n  - one\n  - two\n---\nbody')
  assert.deepEqual(ok.data, { a: 'x y', b: ['1', '2'], c: ['one', 'two'] })
  assert.ok(parseFrontMatter('---\na: 1\nbody').error)
  assert.ok(parseFrontMatter('---\na: 1\na: 2\n---\n').error)
})
