import test from 'node:test';
import assert from 'node:assert/strict';
import { transform, LABELS } from './codemod-names.mjs';

const run = (src) => {
  const stats = { fixed: 0, unmapped: {}, skipped: {} };
  return { out: transform(src, 'x.tsx', stats), stats };
};
const imp = "import { Trash2, X as Close, ArrowUp, Sparkles } from 'lucide-react';\n";

test('names an unnamed icon-only native button from its icon', () => {
  const { out, stats } = run(`${imp}export const A = () => <button onClick={f}><Trash2 size={14} /></button>;`);
  assert.match(out, /<button aria-label="Delete" onClick/);
  assert.equal(stats.fixed, 1);
});

test('resolves aliased lucide imports and <Button>', () => {
  const { out } = run(`${imp}export const A = () => <Button variant="ghost"><Close size={16} /></Button>;`);
  assert.match(out, /<Button aria-label="Close" variant/);
});

test('uses label= for IconButton and reads <Icon icon={...}>', () => {
  const { out } = run(`${imp}export const A = () => <IconButton onClick={f}><Icon icon={ArrowUp} /></IconButton>;`);
  assert.match(out, /<IconButton label="Move up" onClick/);
});

test('leaves already-named, text-bearing, spread and unknown-icon elements alone', () => {
  for (const jsx of [
    '<button aria-label="x"><Trash2 /></button>',
    '<button title="x"><Trash2 /></button>',
    '<button aria-labelledby="x"><Trash2 /></button>',
    '<button><Trash2 /> Delete</button>',
    '<button {...props}><Trash2 /></button>',
    '<button><Sparkles /></button>',
    '<div><Trash2 /></div>',
  ]) {
    const src = `${imp}export const A = () => ${jsx};`;
    assert.equal(run(src).out, src, jsx);
  }
});

test('is idempotent and reports unmapped icons instead of guessing', () => {
  const once = run(`${imp}export const A = () => <button><Trash2 /></button>;`).out;
  assert.equal(run(once).out, once);
  const { stats } = run(`${imp}export const A = () => <button><Sparkles /></button>;`);
  assert.deepEqual(stats.unmapped, { Sparkles: 1 });
});

test('every label is a non-empty string', () => {
  for (const [k, v] of Object.entries(LABELS)) assert.ok(typeof v === 'string' && v.trim(), k);
});
