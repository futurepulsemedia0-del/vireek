// Run: node --test scripts/seo/assert-prerendered.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertDist } from './assert-prerendered.mjs';

function fakeDist({ robots = 'User-agent: *\nDisallow: /dashboard/\nSitemap: https://vireek.com/sitemap.xml\n', sitemap, failures = [] } = {}) {
  const d = mkdtempSync(path.join(tmpdir(), 'dist-'));
  const w = (rel, body) => {
    mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    writeFileSync(path.join(d, rel), body);
  };
  const routes = [{ path: '/' }, { path: '/pricing' }];
  w('routes.json', JSON.stringify({ routes }));
  w('_prerender-report.json', JSON.stringify({ failures, pages: routes }));
  w('index.html', '<html></html>');
  w('pricing/index.html', '<html></html>');
  w('_spa.html', '<html></html>');
  w('robots.txt', robots);
  w('app-routes.json', JSON.stringify({ patterns: Array.from({ length: 12 }, (_, i) => `/p${i}`) }));
  w('sitemap.xml', sitemap ?? '<?xml version="1.0"?>\n<urlset><url><loc>https://vireek.com/</loc></url><url><loc>https://vireek.com/pricing</loc></url></urlset>');
  return d;
}

test('a complete build passes', () => assert.deepEqual(assertDist(fakeDist()), []));

test('missing prerender report is explained', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'dist-'));
  const p = assertDist(d);
  assert.ok(p.some((x) => x.includes('prerender did not run')));
});

test('prerender failures, nested sitemap and robots-blocked URLs are caught', () => {
  assert.ok(assertDist(fakeDist({ failures: [{ path: '/pricing', error: 'x' }] })).some((x) => x.includes('failed to prerender')));
  assert.ok(assertDist(fakeDist({ sitemap: '<?xml version="1.0"?><urlset><url><url><loc>https://vireek.com/</loc></url></urlset>' })).some((x) => x.includes('malformed')));
  assert.ok(
    assertDist(fakeDist({ robots: 'User-agent: *\nDisallow: /pricing\nSitemap: https://vireek.com/sitemap.xml\n' })).some((x) => x.includes('blocks 1 sitemap')),
  );
});
