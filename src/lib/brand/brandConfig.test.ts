import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRAND, BRAND_KIT_IMAGES, NAMING_RULES, ogKindFor, ogPathFor, ogUrlFor, pageTitle, stripBrandSuffix, copyrightLine, brandMark,
} from '@/lib/brand/brandConfig';

describe('og routing', () => {
  it('maps public paths to collision-free card files', () => {
    expect(ogPathFor('/')).toBe('/og/home.png');
    expect(ogPathFor('/blog/my-post/')).toBe('/og/blog--my-post.png');
    expect(ogPathFor('/pricing?x=1#y')).toBe('/og/pricing.png');
    expect(ogPathFor('/Bad Path')).toBeNull();
    expect(ogPathFor('/a//b')).toBeNull();
  });
  it('builds absolute URLs; foreign hosts and odd paths get the default card', () => {
    expect(ogUrlFor('https://vireek.com/industries/hvac')).toBe('https://vireek.com/og/industries--hvac.png');
    expect(ogUrlFor('https://vireek.com/pricing?lang=fa')).toBe('https://vireek.com/og/pricing.png');
    expect(ogUrlFor('https://evil.example/x')).toBe('https://vireek.com/og-image.png');
  });
  it('classifies page types', () => {
    expect(ogKindFor('/')).toBe('home');
    expect(ogKindFor('/industries/hvac')).toBe('industry');
    expect(ogKindFor('/blog/x')).toBe('blog');
    expect(ogKindFor('/help/reset')).toBe('help');
    expect(ogKindFor('/changelog')).toBe('changelog');
    expect(ogKindFor('/privacy')).toBe('legal');
  });
});

describe('naming', () => {
  it('formats titles, suffix stripping, trademark and copyright from one place', () => {
    expect(pageTitle('Jobs')).toBe('Jobs \u00B7 Vireek');
    expect(pageTitle('')).toBe('Vireek');
    expect(stripBrandSuffix('Pricing | Vireek')).toBe('Pricing');
    expect(stripBrandSuffix('Reset a password | Vireek Help Center')).toBe('Reset a password');
    expect(brandMark(true)).toBe('Vireek\u2122');
    expect(copyrightLine(2030)).toBe('\u00A9 2030 Vireek. All rights reserved.');
    expect(BRAND.registered).toBe(false);
    expect(NAMING_RULES.length).toBeGreaterThan(4);
  });
  it('kit files are unique and sized sensibly', () => {
    const names = BRAND_KIT_IMAGES.map((f) => f.file);
    expect(new Set(names).size).toBe(names.length);
    expect(BRAND_KIT_IMAGES.every((f) => f.w >= 190 && f.h >= 190)).toBe(true);
  });
});

describe('drift guards (static files must match the config)', () => {
  const index = readFileSync('index.html', 'utf8');
  const manifest = JSON.parse(readFileSync('public/site.webmanifest', 'utf8'));
  it('index.html and manifest use the configured name and colors', () => {
    expect(index).toContain(`content="${BRAND.name}"`);
    expect(index).toContain(BRAND.colors.light.bg);
    expect(index).toContain(BRAND.colors.dark.bg);
    expect(index).not.toMatch(/#4F46E5/i);
    expect(manifest.name).toBe(BRAND.name);
    expect(manifest.theme_color).toBe(BRAND.colors.light.bg);
    expect(manifest.background_color).toBe(BRAND.colors.dark.bg);
  });
});
