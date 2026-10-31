import { describe, expect, it } from 'vitest';
import { SURFACES, surfaceClass, type SurfaceKind } from '@/lib/ui/interaction';

const kinds = Object.keys(SURFACES) as SurfaceKind[];

describe('interaction state matrix', () => {
  it.each(kinds)('%s defines every state key', (kind) => {
    expect(Object.keys(SURFACES[kind]).sort()).toEqual(['active', 'error', 'hover', 'rest', 'selected']);
  });

  it('uses design tokens only (no hex / rgb / hsl literals)', () => {
    const all = JSON.stringify(SURFACES);
    expect(all).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(all).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  it('hover styles only come from hover: variants (so hoverOnlyWhenSupported covers them)', () => {
    for (const kind of kinds) {
      const hover = SURFACES[kind].hover;
      if (!hover) continue;
      for (const token of hover.split(/\s+/)) expect(token, `${kind}: ${token}`).toMatch(/^(dark:)?hover:/);
    }
  });

  it('static surfaces get no hover/active recipe', () => {
    const cls = surfaceClass('card', { interactive: false });
    expect(cls).not.toContain('hover:');
    expect(cls).not.toContain('active:');
  });

  it('error recipe is applied only when error is set', () => {
    expect(surfaceClass('field')).not.toContain('border-danger');
    expect(surfaceClass('field', { error: true })).toContain('border-danger');
  });

  it('solid keeps AA text contrast in dark mode (dark text on the bright accent)', () => {
    expect(SURFACES.solid.rest).toContain('dark:text-bg-primary');
  });
});
