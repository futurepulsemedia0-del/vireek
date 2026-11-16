import { describe, expect, it } from 'vitest';
import en from '@/locales/en/common.json';
import { NAV_ITEMS, isInternalHref, isNavItemActive } from '@/lib/headerNav';

const lookup = (key: string): unknown =>
  key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);

describe('headerNav', () => {
  it('uses unique ids and only existing i18n keys', () => {
    expect(new Set(NAV_ITEMS.map((i) => i.id)).size).toBe(NAV_ITEMS.length);
    for (const item of NAV_ITEMS) {
      expect(typeof lookup(item.labelKey), item.labelKey).toBe('string');
    }
  });

  it('keeps every panel within the layout limits (1–3 groups, no empty group)', () => {
    for (const item of NAV_ITEMS) {
      if (!item.panel) continue;
      expect(item.panel.groups.length, item.id).toBeGreaterThanOrEqual(1);
      expect(item.panel.groups.length, item.id).toBeLessThanOrEqual(3);
      for (const g of item.panel.groups) expect(g.links.length, `${item.id}:${g.title}`).toBeGreaterThan(0);
    }
  });

  it('has no duplicate links inside a panel and only valid hrefs', () => {
    for (const item of NAV_ITEMS) {
      if (!item.panel) continue;
      const hrefs = item.panel.groups.flatMap((g) => g.links.map((l) => l.href));
      expect(new Set(hrefs).size, item.id).toBe(hrefs.length);
      for (const h of [...hrefs, item.panel.overview.href, item.panel.featured?.cta.href ?? '/']) {
        expect(/^(\/|tel:|mailto:|https:)/.test(h), h).toBe(true);
      }
    }
  });

  it('matches active routes by exact path or prefix only', () => {
    const industries = NAV_ITEMS.find((i) => i.id === 'industries')!;
    expect(isNavItemActive(industries, '/industries')).toBe(true);
    expect(isNavItemActive(industries, '/industries/hvac')).toBe(true);
    expect(isNavItemActive(industries, '/industriesx')).toBe(false);
    expect(isNavItemActive(industries, '/')).toBe(false);
  });

  it('treats only absolute paths as internal', () => {
    expect(isInternalHref('/pricing')).toBe(true);
    expect(isInternalHref('tel:+10000000000')).toBe(false);
  });
});
