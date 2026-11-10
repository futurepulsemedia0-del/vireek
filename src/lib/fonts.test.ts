// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const size = (p: string) => statSync(join(root, p)).size;
const THIRD_PARTY = [['fonts', 'googleapis', 'com'].join('.'), ['fonts', 'gstatic', 'com'].join('.')];
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

describe('self-hosted fonts', () => {
  it('references no third-party font host in app code, HTML or headers', () => {
    const files = [
      ...walk('src').filter((f) => /\.(css|ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)),
      'index.html',
      'public/offline.html',
    ];
    const offenders = files.filter((f) => THIRD_PARTY.some((h) => read(f).includes(h)));
    expect(offenders).toEqual([]);
    const vercel = read('vercel.json');
    for (const h of THIRD_PARTY) expect(vercel).not.toContain(h);
  });

  it('ships every font file that CSS, preloads and the signature loader point at', () => {
    const refs = [
      ...read('src/styles/fonts.css').matchAll(/url\('(\/fonts\/[^']+)'\)/g),
      ...read('index.html').matchAll(/href="(\/fonts\/[^"]+)"/g),
      ...read('src/lib/loadSignatureFonts.ts').matchAll(/url: '(\/fonts\/[^']+)'/g),
    ].map((m) => m[1]);
    expect(refs.length).toBeGreaterThanOrEqual(9);
    for (const ref of refs) expect(existsSync(join(root, 'public', ref)), ref).toBe(true);
    expect(refs.every((r) => r.endsWith('.woff2'))).toBe(true);
  });

  it('uses font-display: swap everywhere and has metric-compatible Latin-only fallbacks', () => {
    const css = read('src/styles/fonts.css');
    const faces = css.match(/@font-face\s*{[^}]*}/g) ?? [];
    expect(faces.length).toBe(4);
    for (const f of faces) expect(f).toContain('font-display: swap');
    const gen = read('src/styles/fonts.fallbacks.generated.css');
    for (const name of ['Inter Fallback', 'Source Serif 4 Fallback']) {
      const face = gen.split('@font-face').find((b) => b.includes(`'${name}'`)) ?? '';
      expect(face, name).toMatch(/size-adjust:\d/);
      expect(face).toContain('ascent-override');
      expect(face).toContain('unicode-range'); // must not shadow Arabic/CJK glyphs of Arial
    }
  });

  it('ships a licence file naming every family', () => {
    const lic = read('public/fonts/LICENSES.txt');
    expect(lic).toContain('SIL Open Font License');
    for (const n of ['Inter', 'Source Serif 4', 'Dancing Script', 'Caveat', 'Great Vibes']) expect(lic).toContain(n);
  });

  it('stays inside the font size budget', () => {
    const critical = size('public/fonts/inter-latin-wght-normal.woff2') + size('public/fonts/source-serif-4-latin-wght-normal.woff2');
    expect(critical).toBeLessThanOrEqual(130 * 1024);
    const all = walk('public/fonts').filter((f) => f.endsWith('.woff2'));
    for (const f of all) expect(size(f), f).toBeLessThanOrEqual(80 * 1024);
    expect(all.reduce((n, f) => n + size(f), 0)).toBeLessThanOrEqual(340 * 1024);
  });

  it('defines a native stack and rhythm for every non-Latin locale', () => {
    const css = read('src/styles/fonts.css');
    for (const l of ['ar', 'fa', 'hi', 'ja', 'zh']) expect(css).toContain(`html:lang(${l})`);
    expect(read('src/index.css')).toContain('html:lang(hi) *, html:lang(ja) *, html:lang(zh) *');
  });

  it('serves fonts with a cache header', () => {
    expect(read('vercel.json')).toContain('"source": "/fonts/(.*)"');
  });
});
