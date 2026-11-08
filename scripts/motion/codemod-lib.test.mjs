import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteSmoothScroll, rewriteTransitionAll } from './codemod-lib.mjs';

test('plain interactive element -> transition-interactive', () => {
  const r = rewriteTransitionAll(`<button className="px-4 transition-all hover:bg-accent active:scale-[0.97]" />`);
  assert.equal(r.simple, 1); assert.equal(r.layout, 0);
  assert.match(r.out, /transition-interactive/); assert.doesNotMatch(r.out, /transition-all/);
});
test('state-driven size in the same literal -> transition-layout', () => {
  const r = rewriteTransitionAll(`<div className="transition-all group-hover:max-h-40" />`);
  assert.equal(r.layout, 1); assert.match(r.out, /transition-layout/);
});
test('inline style width nearby -> transition-layout', () => {
  const r = rewriteTransitionAll(`<div className="h-2 transition-all" style={{ width: pct + '%' }} />`);
  assert.equal(r.layout, 1);
});
test('keeps variant prefixes and never touches transition-all-like words', () => {
  const r = rewriteTransitionAll(`const a = 'md:transition-all'; const b = 'my-transition-all-x';`);
  assert.match(r.out, /md:transition-interactive/); assert.match(r.out, /my-transition-all-x/);
});
test('smooth scroll rewrite adds one import after the last import', () => {
  const src = `import a from 'a';\nimport {\n  b,\n} from 'b';\n\nel.scrollIntoView({ behavior: 'smooth', block: 'start' });\nwindow.scrollTo({ top: 0, behavior: "smooth" });\n`;
  const r = rewriteSmoothScroll(src);
  assert.equal(r.count, 2);
  assert.equal((r.out.match(/import \{ scrollBehavior \}/g) ?? []).length, 1);
  assert.ok(r.out.indexOf("from 'b';") < r.out.indexOf('scrollBehavior }'));
  assert.doesNotMatch(r.out, /'smooth'|"smooth"/);
});
test('idempotent', () => {
  const once = rewriteSmoothScroll(`import a from 'a';\nx({ behavior: 'smooth' });`).out;
  const twice = rewriteSmoothScroll(once);
  assert.equal(twice.count, 0); assert.equal(twice.out, once);
  assert.equal(rewriteTransitionAll(rewriteTransitionAll('"transition-all"').out).simple, 0);
});
