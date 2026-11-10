// @vitest-environment node
// Invariant for the em-based dispatch-TV wallboard (see scripts/type/text-size-allowlist.json):
//   smallest root font-size  x  smallest em multiplier  >=  12px
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
const panels = readFileSync(`${root}src/components/wallboard/WallboardPanels.tsx`, 'utf8');
const page = readFileSync(`${root}src/pages/WallboardPage.tsx`, 'utf8');
// Parsed, not imported: importing the page pulls the whole app graph (supabase client, router, …) into a unit test.
const WALLBOARD_ROOT_FONT_SIZE = page.match(/export const WALLBOARD_ROOT_FONT_SIZE\s*=\s*'([^']+)'/)![1];

const multipliers = (src: string) => [...src.matchAll(/text-\[([0-9.]+)em\]/g)].map((m) => parseFloat(m[1]));

describe('wallboard type floor', () => {
  const minRootPx = parseFloat(WALLBOARD_ROOT_FONT_SIZE.match(/clamp\(\s*([0-9.]+)rem/)![1]) * 16;
  it('the root is rem-based and the page actually uses the exported constant', () => {
    expect(WALLBOARD_ROOT_FONT_SIZE).toMatch(/^clamp\([0-9.]+rem,/);
    expect(page).toContain('fontSize: WALLBOARD_ROOT_FONT_SIZE');
  });
  it('smallest em multiplier in the panels and the page keeps text >= 12px at the smallest root', () => {
    const all = [...multipliers(panels), ...multipliers(page)];
    expect(all.length).toBeGreaterThan(20);
    expect(Math.min(...all) * minRootPx).toBeGreaterThanOrEqual(12);
  });
  it('is tight: the root minimum is not wastefully larger than necessary (<= 1px headroom)', () => {
    const smallest = Math.min(...multipliers(panels), ...multipliers(page));
    expect(minRootPx - 12 / smallest).toBeLessThan(1);
  });
});
