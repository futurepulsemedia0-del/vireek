// scripts/color/surface-lib.test.ts — regression tests for the surface-contrast GATE itself: it must catch the known-bad
// patterns found in the audit (also behind hover:/placeholder:/dark: variants and across ternary branches) and accept the
// canonical token pairs that replaced them.
import { describe, it, expect } from 'vitest';
import { parseLiteral, evaluate, fails, expandTemplate } from './surface-lib.mjs';

const measure = (cls: string) => evaluate(parseLiteral(cls));
const bad = (cls: string): boolean => fails(measure(cls));

describe('surface-lib: patterns the audit found must FAIL', () => {
  it.each([
    ['tint at 20% with plain family text', 'bg-danger/20 text-danger'],
    ['cobalt→copper gradient with white (dark 2.32:1)', 'bg-gradient-to-br from-accent to-cta text-white'],
    ['white on a theme surface tint (codemod damage)', 'bg-bg-secondary/10 text-white'],
    ['black on a theme surface (dark = 1:1)', 'bg-bg-secondary text-black'],
    ['faded secondary text', 'bg-bg-tertiary text-text-secondary/40'],
    ['legacy dark: override on a solid fill (dark 4.12:1)', 'bg-accent text-on-accent dark:text-bg-primary'],
    ['faded placeholder (placeholder: variant)', 'bg-bg-primary placeholder:text-text-secondary/60'],
    ['hover tint with plain family text', 'bg-bg-tertiary text-text-secondary hover:bg-danger/10 hover:text-danger'],
    ['hover fill that kills the label in high-contrast', 'bg-bg-tertiary text-text-secondary hover:bg-border'],
    ['white on warning in dark (banner icon)', 'flex h-12 w-12 items-center justify-center text-white bg-warning'],
  ])('%s', (_n, cls) => {
    expect(measure(cls)).not.toBeNull();
    expect(bad(cls)).toBe(true);
  });
});

describe('surface-lib: canonical pairs must PASS', () => {
  it.each([
    'bg-accent text-on-accent',
    'bg-danger text-on-danger hover:brightness-110',
    'bg-danger/10 text-danger-strong',
    'bg-danger-subtle text-danger',
    'bg-gradient-to-br from-brand-from to-brand-to text-on-brand',
    'bg-static-white/10 text-static-white hover:bg-static-white/25',
    'bg-bg-tertiary text-text-muted',
    'bg-bg-primary placeholder:text-text-muted',
    'bg-bg-tertiary text-text-secondary hover:bg-border/30',
  ])('%s', (cls) => {
    expect(measure(cls)).not.toBeNull();
    expect(bad(cls)).toBe(false);
  });
});

describe('surface-lib: thresholds and expansion', () => {
  it('icon-only containers (square, no text size) need 3:1, text needs 4.5:1', () => {
    // warning-graphic on the page is 3.55:1 worst-case: fine as an icon (3:1), not as text (4.5:1)
    expect(measure('h-6 w-6 bg-bg-primary text-warning-graphic')!.min).toBe(3);
    expect(bad('h-6 w-6 bg-bg-primary text-warning-graphic')).toBe(false);
    expect(measure('px-2 text-xs bg-bg-primary text-warning-graphic')!.min).toBe(4.5);
    expect(bad('px-2 text-xs bg-bg-primary text-warning-graphic')).toBe(true);
  });
  it('template literals are expanded over their ${…} branches so cross-branch pairs are judged', () => {
    const combos = expandTemplate("flex text-white ${ok ? 'bg-success' : 'bg-danger'}");
    expect(combos.some((c) => c.includes('bg-success') && c.includes('text-white'))).toBe(true);
    expect(combos.some((c) => c.includes('bg-danger') && c.includes('text-white'))).toBe(true);
    expect(combos.some((c) => bad(c))).toBe(true);
  });
});
