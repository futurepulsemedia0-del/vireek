import test from 'node:test';
import assert from 'node:assert/strict';
import { countViolations, ratcheted, regressions } from './lib/ratchet.mjs';

const v = (rule, file, line = 1) => ({ rule, file, line, snippet: '' });

test('counts per (rule,file), ignoring line numbers', () => {
  assert.deepEqual(countViolations([v('a', 'x.tsx', 1), v('a', 'x.tsx', 99), v('b', 'x.tsx')]), { 'a|x.tsx': 2, 'b|x.tsx': 1 });
});
test('same or fewer violations pass; moved lines pass', () => {
  assert.deepEqual(regressions({ 'a|x.tsx': 2 }, { 'a|x.tsx': 2 }), []);
  assert.deepEqual(regressions({ 'a|x.tsx': 1 }, { 'a|x.tsx': 2 }), []);
});
test('more violations in a known file fail', () => {
  assert.deepEqual(regressions({ 'a|x.tsx': 3 }, { 'a|x.tsx': 2 }), [{ key: 'a|x.tsx', allowed: 2, actual: 3 }]);
});
test('any violation in a new file or new rule fails', () => {
  assert.equal(regressions({ 'a|new.tsx': 1 }, { 'a|x.tsx': 5 }).length, 1);
  assert.equal(regressions({ 'z|x.tsx': 1 }, { 'a|x.tsx': 5 }).length, 1);
});
test('ratchet only lowers and drops zeros; never adds entries', () => {
  assert.deepEqual(ratcheted({ 'a|x.tsx': 1, 'a|new.tsx': 9 }, { 'a|x.tsx': 3, 'b|y.tsx': 2 }), { 'a|x.tsx': 1 });
});
