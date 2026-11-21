import { describe, expect, it } from 'vitest';
import { LayoutDashboard } from 'lucide-react';
import { NAV_ICON_OVERRIDES, navIcon } from './navIcons';

describe('navIcons', () => {
  it('every override is a defined icon for a dashboard route', () => {
    for (const [href, icon] of Object.entries(NAV_ICON_OVERRIDES)) {
      expect(href.startsWith('/dashboard/')).toBe(true);
      expect(icon).toBeDefined();
    }
  });

  it('falls back to the item icon when there is no override', () => {
    expect(navIcon('/dashboard/does-not-exist', LayoutDashboard)).toBe(LayoutDashboard);
  });

  it('uses the override when present', () => {
    const [href, icon] = Object.entries(NAV_ICON_OVERRIDES)[0];
    expect(navIcon(href, LayoutDashboard)).toBe(icon);
  });
});
