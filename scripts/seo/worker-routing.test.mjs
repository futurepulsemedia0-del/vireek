// Run: node --test scripts/seo/worker-routing.test.mjs   (Node >= 22.18 strips TS types natively)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileAppRoutes, parseAppRoutes, trailingSlashRedirect, wwwRedirect,
} from '../../worker/seo-routing.ts';

test('www -> apex keeps path and query, other hosts untouched', () => {
  assert.equal(wwwRedirect(new URL('https://www.vireek.com/pricing?x=1')), 'https://vireek.com/pricing?x=1');
  assert.equal(wwwRedirect(new URL('https://www.vireek.com/')), 'https://vireek.com/');
  assert.equal(wwwRedirect(new URL('https://vireek.com/pricing')), null);
  assert.equal(wwwRedirect(new URL('https://vireek.workers.dev/pricing')), null);
});

test('trailing slash is stripped except for the root', () => {
  assert.equal(trailingSlashRedirect(new URL('https://vireek.com/pricing/')), 'https://vireek.com/pricing');
  assert.equal(trailingSlashRedirect(new URL('https://vireek.com/blog/a/?utm=1')), 'https://vireek.com/blog/a?utm=1');
  assert.equal(trailingSlashRedirect(new URL('https://vireek.com/')), null);
  assert.equal(trailingSlashRedirect(new URL('https://vireek.com/pricing')), null);
  assert.equal(trailingSlashRedirect(new URL('https://vireek.com//')), null);
});

const known = compileAppRoutes({
  patterns: ['/', '/pricing', '/blog/:slug', '/portal/:token/history', '/home/*', '*'],
  passthroughPrefixes: ['/dashboard', '/tech'],
});

test('known routes pass, unknown routes are rejected', () => {
  for (const p of ['/', '/pricing', '/blog/my-post', '/portal/abc/history', '/home', '/home/a/b', '/dashboard', '/dashboard/x/y', '/tech/jobs']) {
    assert.equal(known(p), true, p);
  }
  for (const p of ['/nope', '/pricing/extra', '/blog', '/blog/a/b', '/portal/abc', '/dashboardx', '/xyz/abc']) {
    assert.equal(known(p), false, p);
  }
});

test('prerendered data patterns: a slug with no static file is a 404', () => {
  const m = compileAppRoutes({
    patterns: ['/blog/:slug', '/book/:slug'],
    passthroughPrefixes: [],
    prerenderedPatterns: ['/blog/:slug'],
  });
  assert.equal(m('/blog/does-not-exist'), false);
  assert.equal(m('/book/some-token'), true);
});

test('regex metacharacters in patterns are escaped', () => {
  const m = compileAppRoutes({ patterns: ['/a.b', '/c+d'], passthroughPrefixes: [] });
  assert.equal(m('/a.b'), true);
  assert.equal(m('/aXb'), false);
  assert.equal(m('/c+d'), true);
});

test('parseAppRoutes rejects malformed or suspiciously small manifests', () => {
  assert.equal(parseAppRoutes(null), null);
  assert.equal(parseAppRoutes({ patterns: ['/a'], passthroughPrefixes: [] }), null);
  assert.equal(parseAppRoutes({ patterns: 'x', passthroughPrefixes: [] }), null);
  const ok = parseAppRoutes({ patterns: Array.from({ length: 12 }, (_, i) => `/p${i}`), passthroughPrefixes: ['/dashboard'] });
  assert.ok(ok);
});
