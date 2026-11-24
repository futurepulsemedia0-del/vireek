import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkVersionWindow, parseExceptions, parseVersion, toVersion, versionCeiling } from './migrationVersionRule.mjs'

const NOW = new Date('2026-11-23T04:03:03Z')

test('toVersion formats UTC as 14 digits', () => {
  assert.equal(toVersion(NOW), '20261123040303')
})

test('parseVersion accepts only real UTC timestamps', () => {
  assert.ok(parseVersion('20290311000000'))
  assert.ok(parseVersion('20280229235959')) // 2028 is a leap year
  for (const bad of ['20270230000000', '20261301000000', '20261123250000', '20261123006000', '2026112304030', '20261123040303x', '', null, undefined])
    assert.equal(parseVersion(bad), null, String(bad))
  assert.equal(parseVersion('20270229000000'), null) // 2027 is not a leap year
})

test('normal mode: ceiling is now + 10 minutes', () => {
  assert.equal(versionCeiling('20261120000000', NOW), '20261123041303')
  assert.equal(versionCeiling(null, NOW), '20261123041303')
  assert.deepEqual(checkVersionWindow({ version: '20261123040304', legacyMax: '20261120000000', now: NOW }), [])
  assert.equal(checkVersionWindow({ version: '20261123041304', legacyMax: '20261120000000', now: NOW }).length, 1)
  assert.equal(checkVersionWindow({ version: '20271001000000', legacyMax: '20261120000000', now: NOW }).length, 1)
})

test('frontier mode (legacy future-dated files exist): ceiling is newest existing + 1 day', () => {
  assert.equal(versionCeiling('20290311000000', NOW), '20290312000000')
  assert.deepEqual(checkVersionWindow({ version: '20290311000001', legacyMax: '20290311000000', now: NOW }), [])
  assert.deepEqual(checkVersionWindow({ version: '20290312000000', legacyMax: '20290311000000', now: NOW }), [])
  assert.equal(checkVersionWindow({ version: '20290312000001', legacyMax: '20290311000000', now: NOW }).length, 1)
})

test('frontier mode switches itself off once the newest existing version is <= now', () => {
  assert.equal(versionCeiling('20261123040303', NOW), '20261123041303') // equal to now: normal mode
  assert.equal(checkVersionWindow({ version: '20290311000001', legacyMax: '20261123040303', now: NOW }).length, 1)
})

test('an impossible date is reported as such, not as future-dated', () => {
  const [msg] = checkVersionWindow({ version: '20261301000000', legacyMax: null, now: NOW })
  assert.match(msg, /not a real UTC date-time/)
})

test('parseExceptions validates shape, kind, reason and duplicates', () => {
  const ok = JSON.stringify({ entries: [{ name: 'a.sql', kind: 'irregular-name', reason: 'x' }] })
  assert.deepEqual([...parseExceptions(ok).names], ['a.sql'])
  assert.deepEqual(parseExceptions(ok).problems, [])
  assert.match(parseExceptions('{').problems[0], /not valid JSON/)
  assert.match(parseExceptions('{}').problems[0], /"entries" array/)
  const bad = JSON.stringify({ entries: [{ name: 'a.sql', kind: 'weird', reason: '' }, { name: 'a.sql', kind: 'irregular-name', reason: 'r' }, {}] })
  const p = parseExceptions(bad).problems.join('|')
  assert.match(p, /unknown kind/); assert.match(p, /needs a "reason"/); assert.match(p, /duplicates a\.sql/); assert.match(p, /no "name"/)
})
