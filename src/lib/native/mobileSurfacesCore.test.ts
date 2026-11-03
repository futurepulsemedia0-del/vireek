import { describe, expect, it } from 'vitest';
import { DEFAULT_MOBILE_SURFACE_PREFS, normalizeMobileSurfacePrefs } from './mobileSurfacesCore';

describe('normalizeMobileSurfacePrefs', () => {
  it('returns privacy-first defaults for missing or malformed input', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(normalizeMobileSurfacePrefs(bad)).toEqual(DEFAULT_MOBILE_SURFACE_PREFS);
    }
    expect(DEFAULT_MOBILE_SURFACE_PREFS.hide_customer_names).toBe(true);
  });

  it('keeps real booleans and ignores everything else', () => {
    const p = normalizeMobileSurfacePrefs({ hide_customer_names: false, widgets_enabled: 'no', watch_enabled: 0, user_id: 'u' });
    expect(p.hide_customer_names).toBe(false);
    expect(p.widgets_enabled).toBe(true);
    expect(p.watch_enabled).toBe(true);
    expect(Object.keys(p)).not.toContain('user_id');
  });
});
