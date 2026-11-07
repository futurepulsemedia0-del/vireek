import { describe, expect, it } from 'vitest';
import { DISPLAY_ICON_MIN_PX, ICON_SIZE_PX, iconClass, iconSizeForPx } from './iconScale';
// @ts-expect-error -- plain ESM script shared with the codemod; it ships no type declarations
import { DISPLAY_MIN_PX, ICON_TOKENS, tokenForPx } from '../../../scripts/a11y/icon-scale.mjs';

describe('icon scale', () => {
  it('has exactly the four documented sizes', () => {
    expect(ICON_SIZE_PX).toEqual({ micro: 12, sm: 16, md: 20, lg: 24 });
    expect(iconClass('md')).toBe('icon-md');
  });
  it('stays in lockstep with the codemod copy (scripts/a11y/icon-scale.mjs)', () => {
    expect(ICON_TOKENS).toEqual(ICON_SIZE_PX);
    expect(DISPLAY_MIN_PX).toBe(DISPLAY_ICON_MIN_PX);
    for (let px = 0; px <= 64; px++) expect(iconSizeForPx(px)).toBe(tokenForPx(px));
  });
  it('maps legacy sizes: 14 -> sm, 18 -> md, 22 -> lg, 26+ -> display (null)', () => {
    expect([11, 14, 18, 22].map(iconSizeForPx)).toEqual(['micro', 'sm', 'md', 'lg']);
    expect(iconSizeForPx(26)).toBeNull();
    expect(iconSizeForPx(Number.NaN)).toBeNull();
  });
});
