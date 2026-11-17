// Run: node --test scripts/seo/lint-index-html.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lintIndexHtml } from './lint-index-html.mjs';

const page = (extra = '') => `<!doctype html><html lang="en"><head><meta charset="UTF-8" />
<style>html{background:#fff}</style>${extra}
<title>T</title><meta name="description" content="d" /><link rel="canonical" href="https://vireek.com/" />
<script type="application/ld+json">{"@type":"Organization"}</script></head><body><div id="root"></div></body></html>`;

test('a well-formed head passes', () => assert.deepEqual(lintIndexHtml(page()), []));

test('the real index.html passes', () => {
  assert.deepEqual(lintIndexHtml(readFileSync(new URL('../../index.html', import.meta.url), 'utf8')), []);
});

test('missing <style> opener is caught (the original bug)', () => {
  const broken = page().replace('<style>html{background:#fff}</style>', 'html{background:#fff}</style>');
  const problems = lintIndexHtml(broken);
  assert.ok(problems.some((p) => p.includes('unbalanced')));
  assert.ok(problems.some((p) => p.includes('stray text')));
});

test('stray text, duplicate title and bad JSON-LD are caught', () => {
  assert.ok(lintIndexHtml(page('hello world')).some((p) => p.includes('stray text')));
  assert.ok(lintIndexHtml(page('<title>2</title>')).some((p) => p.includes('exactly one <title>')));
  assert.ok(lintIndexHtml(page('<script type="application/ld+json">{bad</script>')).some((p) => p.includes('invalid JSON-LD')));
});
