import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSkips } from './assert-no-auth-skips.mjs';

const t = (status, annotations = []) => ({ status, annotations, results: [{ status }] });
const report = { suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [
  { title: 'needs login', file: 'a.spec.ts', tests: [t('skipped', [{ type: 'skip', description: 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set' }])] },
  { title: 'webkit only', file: 'a.spec.ts', tests: [t('skipped', [{ type: 'skip', description: 'Chromium only' }])] },
  { title: 'passes', file: 'a.spec.ts', tests: [t('expected')] },
], suites: [{ title: 'nested', specs: [{ title: 'member', file: 'a.spec.ts', tests: [t('skipped', [{ type: 'skip', description: 'E2E_MEMBER_EMAIL not set' }])] }] }] }] };

test('finds skipped tests and flags only credential-related ones', () => {
  const s = collectSkips(report);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => x.credential), [true, false, true]);
  assert.equal(s[2].title, 'a.spec.ts › nested › member');
});
test('empty or passing report has no skips', () => {
  assert.deepEqual(collectSkips({ suites: [] }), []);
  assert.deepEqual(collectSkips({}), []);
});
