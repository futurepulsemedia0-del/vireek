// scripts/color/surface-contrast.test.ts
// Ties the REAL class strings of the shared surface recipes to the token contrast gate. contrast.test.ts proves the
// token pairs; this proves the components actually USE them (a stray `dark:text-bg-primary` once bypassed it).
import { describe, it, expect } from 'vitest';
import { SURFACES } from '../../src/lib/ui/interaction';
import { THEMES, buildTheme } from './palette.mjs';
import { contrast } from './oklch.mjs';

const FAMILIES = ['accent', 'cta', 'success', 'danger', 'warning', 'info'] as const;
const classesOf = (recipe: string): string[] => recipe.split(/\s+/).filter(Boolean);
const textClasses = (recipe: string): string[] => classesOf(recipe).filter((c) => /(^|:)text-[a-z]/.test(c) && !/(^|:)text-(xs|sm|base|lg|xl|center|left|right|start|end|\[)/.test(c));

describe('SURFACES: solid fills only carry text-on-<family>', () => {
  for (const [kind, recipe] of Object.entries(SURFACES)) {
    const rest = classesOf(recipe.rest);
    const fam = FAMILIES.find((f) => rest.includes(`bg-${f}`));
    if (!fam) continue;
    it(`${kind}: every text colour (any variant) is text-on-${fam}`, () => {
      const texts = textClasses(Object.values(recipe).join(' '));
      expect(texts.length).toBeGreaterThan(0);
      for (const c of texts) expect(c.replace(/^(?:[^:]+:)+/, '')).toBe(`text-on-${fam}`);
    });
    describe.each(THEMES)(`${kind} on-${fam} / ${fam}-fill in %s`, (theme) => {
      it('>= 4.5:1', () => {
        const t = buildTheme(theme).tok;
        expect(contrast(t[`on-${fam}`], t[`${fam}-fill`])).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});
