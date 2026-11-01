import { describe, expect, it } from 'vitest';
import { fitTagline, fitTitle, sanitize } from './og-layout.mjs';
import { checkPage, pngSize } from './validate-meta.mjs';
import { checkManifest } from './check-pwa.mjs';
import { extractHead } from '../seo/html-meta.mjs';

const png = (w, h) => {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const page = (o = {}) =>
  `<html lang="en"><head><link rel="canonical" href="${o.canon ?? 'https://vireek.com/pricing'}"><meta property="og:title" content="${o.t ?? 'Pricing'}"><meta property="og:description" content="${o.d ?? 'Plans'}"><meta property="og:image" content="${o.img ?? 'https://vireek.com/og/pricing.png'}"><meta name="twitter:card" content="${o.card ?? 'summary_large_image'}"></head><body><div id="root"></div></body></html>`;
const run = (o, read = () => png(1200, 630)) => checkPage({ routePath: '/pricing', head: extractHead(page(o)), readOg: read });

describe('fitTitle / fitTagline', () => {
  it('short titles use the largest size on one line', () => {
    expect(fitTitle('Pricing')).toMatchObject({ size: 76, lines: 1, truncated: false });
  });
  it('long titles shrink to fit 3 lines before truncating', () => {
    const r = fitTitle('How HVAC companies stop losing after-hours emergency calls to the competition across the whole country every single winter');
    expect(r.lines).toBeLessThanOrEqual(3);
    expect(r.size).toBeLessThan(76);
  });
  it('pathological input is truncated with an ellipsis, never overflows', () => {
    const r = fitTitle('A'.repeat(400));
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith('\u2026')).toBe(true);
  });
  it('drops glyphs the card fonts cannot draw; trims taglines at 120 chars', () => {
    expect(sanitize('Caf\u00e9 \u2014 Vireek\u2122 \u65e5\u672c\u8a9e')).toBe('Caf\u00e9 \u2014 Vireek\u2122');
    expect(fitTagline('word '.repeat(100)).length).toBeLessThanOrEqual(120);
  });
});

describe('validate-meta checkPage', () => {
  it('passes a complete page', () => expect(run({})).toEqual([]));
  it.each([
    [{ t: '' }, /og:title/],
    [{ d: '' }, /og:description/],
    [{ card: 'summary' }, /twitter:card/],
    [{ canon: 'https://vireek.com/' }, /canonical/],
    [{ img: '/og/x.png' }, /absolute/],
  ])('fails %j', (o, re) => expect(run(o).join()).toMatch(re));
  it('fails when the image is missing, not a PNG, or the old 1424x752 default', () => {
    expect(run({}, () => null).join()).toMatch(/not in dist/);
    expect(run({}, () => Buffer.from('<html>')).join()).toMatch(/not a PNG/);
    expect(run({}, () => png(1424, 752)).join()).toMatch(/1424x752/);
    expect(pngSize(png(1200, 630))).toEqual({ w: 1200, h: 630 });
  });
});

describe('check-pwa checkManifest', () => {
  const m = () => ({
    id: '/dashboard', name: 'Vireek', short_name: 'Vireek', start_url: '/dashboard?source=pwa', scope: '/',
    description: 'Vireek is an AI voice receptionist and operations dashboard for home service businesses.',
    display: 'standalone', display_override: ['standalone'], launch_handler: { client_mode: ['auto'] },
    theme_color: '#FDFCFA', background_color: '#090A0D', categories: ['business'],
    icons: [
      { src: '/a192.png', sizes: '192x192', purpose: 'any' }, { src: '/a512.png', sizes: '512x512', purpose: 'any' },
      { src: '/m512.png', sizes: '512x512', purpose: 'maskable' }, { src: '/mono.png', sizes: '512x512', purpose: 'monochrome' },
    ],
    screenshots: [
      { src: '/w.png', sizes: '1280x720', form_factor: 'wide', label: 'w' }, { src: '/n.png', sizes: '720x1280', form_factor: 'narrow', label: 'n' },
    ],
    shortcuts: [
      { name: 'Jobs', url: '/dashboard/jobs', icons: [{ src: '/s1.png', sizes: '96x96' }] },
      { name: 'Calls', url: '/dashboard/calls', icons: [{ src: '/s2.png', sizes: '96x96' }] },
    ],
  });
  const html = '<link rel="manifest" href="/site.webmanifest"><meta name="theme-color" content="#FDFCFA"><link rel="apple-touch-icon" href="/x.png">';
  const sizes = { '/a192.png': [192, 192], '/a512.png': [512, 512], '/m512.png': [512, 512], '/mono.png': [512, 512], '/w.png': [1280, 720], '/n.png': [720, 1280], '/s1.png': [96, 96], '/s2.png': [96, 96] };
  const read = (src) => (sizes[src] ? png(...sizes[src]) : null);
  it('accepts a correct manifest', () => expect(checkManifest(m(), html, read)).toEqual([]));
  it('rejects legacy colors, combined purposes, shared shortcut icons, missing form factor', () => {
    const bad = m();
    bad.theme_color = '#4F46E5';
    bad.icons[0].purpose = 'any maskable';
    bad.shortcuts[1].icons = bad.shortcuts[0].icons;
    bad.screenshots = bad.screenshots.slice(0, 1);
    const e = checkManifest(bad, html, read).join('\n');
    expect(e).toMatch(/banned legacy color/);
    expect(e).toMatch(/any maskable/);
    expect(e).toMatch(/distinct icon/);
    expect(e).toMatch(/narrow screenshot/);
  });
});
