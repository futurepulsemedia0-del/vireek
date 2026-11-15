// scripts/testing/mutation-summary.test.mjs — run with: npm run test:scripts:mutation
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatScore, scoreOf, summarize, tally, toMarkdown } from './mutation-summary.mjs'

const m = (status) => ({ status })

test('tally counts every known status and buckets unknown ones', () => {
  const c = tally([m('Killed'), m('Killed'), m('Timeout'), m('Survived'), m('NoCoverage'), m('CompileError'), m('RuntimeError'), m('Ignored'), m('Pending'), m('Weird')])
  assert.equal(c.Killed, 2)
  assert.equal(c.Timeout, 1)
  assert.equal(c.Other, 1)
})

test('score = (killed + timeout) / (killed + timeout + survived + noCoverage)', () => {
  const r = scoreOf(tally([m('Killed'), m('Timeout'), m('Survived'), m('NoCoverage')]))
  assert.equal(r.detected, 2)
  assert.equal(r.valid, 4)
  assert.equal(r.score, 50)
})

test('compile errors, runtime errors, ignored and pending mutants never move the score', () => {
  const r = scoreOf(tally([m('Killed'), m('CompileError'), m('RuntimeError'), m('Ignored'), m('Pending')]))
  assert.equal(r.valid, 1)
  assert.equal(r.score, 100)
})

test('score is null (not 0 or 100) when there are no valid mutants', () => {
  assert.equal(scoreOf(tally([m('Ignored')])).score, null)
  assert.equal(scoreOf(tally([])).score, null)
  assert.equal(formatScore(null), 'n/a')
  assert.equal(formatScore(83.3333), '83.33%')
})

test('summarize sums files into a total and sorts by path', () => {
  const s = summarize({
    files: {
      'b.ts': { mutants: [m('Killed'), m('Survived')] },
      'a.ts': { mutants: [m('Killed'), m('Killed'), m('NoCoverage')] },
    },
  })
  assert.deepEqual(s.files.map((f) => f.path), ['a.ts', 'b.ts'])
  assert.equal(s.total.counts.Killed, 3)
  assert.equal(s.total.valid, 5)
  assert.equal(s.total.score, 60)
})

test('summarize tolerates an empty or malformed report', () => {
  assert.equal(summarize({}).total.score, null)
  assert.equal(summarize(null).files.length, 0)
  assert.equal(summarize({ files: { 'x.ts': {} } }).total.score, null)
})

test('toMarkdown renders a header, one row per file and a total row', () => {
  const md = toMarkdown(summarize({ files: { 'a.ts': { mutants: [m('Killed'), m('Survived')] } } }), 'Money')
  assert.match(md, /### Money/)
  assert.match(md, /\| `a\.ts` \| 50\.00% \| 1 \| 0 \| 1 \| 0 \| 0 \| 0 \|/)
  assert.match(md, /\| \*\*Total\*\* \| 50\.00% \|/)
})
