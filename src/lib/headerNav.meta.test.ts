import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '@/lib/headerNav';

/** Two lines at ~33 characters per line fit the narrowest mega-menu column and the mobile drawer. */
const MAX_DESCRIPTION_LENGTH = 60;

const allLinks = NAV_ITEMS.flatMap((item) =>
  (item.panel?.groups ?? []).flatMap((group) => group.links.map((link) => ({ itemId: item.id, group, link }))),
);

describe('headerNav metadata (icons and descriptions)', () => {
  it('gives every top-level item an icon for the mobile menu', () => {
    for (const item of NAV_ITEMS) expect(item.icon, item.id).toBeDefined();
  });

  it('gives every panel link an icon', () => {
    for (const { itemId, link } of allLinks) expect(link.icon, `${itemId}:${link.label}`).toBeDefined();
  });

  it('gives every link in a non-compact group a short, non-empty description', () => {
    for (const { itemId, group, link } of allLinks) {
      if (group.compact) continue;
      const where = `${itemId}:${group.title}:${link.label}`;
      expect(link.description?.trim().length ?? 0, where).toBeGreaterThan(0);
      expect(link.description!.length, where).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    }
  });

  it('keeps compact groups label-only (dense lists must stay dense)', () => {
    for (const { itemId, group, link } of allLinks) {
      if (group.compact) expect(link.description, `${itemId}:${link.label}`).toBeUndefined();
    }
  });

  it('keeps every featured card complete', () => {
    for (const item of NAV_ITEMS) {
      const f = item.panel?.featured;
      if (!f) continue;
      expect(f.icon, item.id).toBeDefined();
      for (const field of [f.eyebrow, f.title, f.description, f.cta.label]) expect(field.trim().length, item.id).toBeGreaterThan(0);
    }
  });
});
