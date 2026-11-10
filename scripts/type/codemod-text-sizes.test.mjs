// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { nearestTokenClass, transformText } from './codemod-text-sizes.mjs';

describe('nearestTokenClass', () => {
  it.each([
    [8, 'text-caption'], [9, 'text-caption'], [10, 'text-caption'], [11, 'text-caption'], [11.5, 'text-caption'], [12, 'text-caption'],
    [12.5, 'text-caption'], [13, 'text-small'], [13.5, 'text-small'], [14, 'text-small'], [15, 'text-body'], [16, 'text-body'],
    [17, 'text-lg'], [18, 'text-lg'], [20, 'text-xl'], [28, 'text-3xl'], [44, 'text-display'], [56, 'text-display-lg'], [144, 'text-9xl'],
  ])('%ipx → %s', (px, cls) => expect(nearestTokenClass(px)).toBe(cls));
  it('ties round UP (readability wins) and everything < 12px lands on caption', () => {
    expect(nearestTokenClass(13)).toBe('text-small');
    expect(nearestTokenClass(15)).toBe('text-body');
    for (let px = 1; px < 12; px += 0.5) expect(nearestTokenClass(px)).toBe('text-caption');
  });
});

describe('transformText', () => {
  it('rewrites sizes and preserves variants + important', () => {
    const { text, changes } = transformText('<p className="text-[11px] md:text-[0.65rem] !text-[10px] dark:hover:text-[13px]">');
    expect(text).toBe('<p className="text-caption md:text-caption !text-caption dark:hover:text-small">');
    expect(changes).toHaveLength(4);
  });
  it('is idempotent', () => {
    const once = transformText('a text-[11px] b').text;
    expect(transformText(once).changes).toHaveLength(0);
  });
  it('touches nothing but the size token', () => {
    const src = 'const x = `text-[10px] ${a ? "font-bold" : ""}`; // text-[10px] kept in comment? no: codemod is regex-level';
    const out = transformText(src).text;
    expect(out.replace(/text-caption/g, 'text-[10px]')).toBe(src);
  });
  it('never touches colours, length hints or existing tokens', () => {
    const src = 'text-[#111827] text-[color:red] text-xs text-caption text-sm';
    expect(transformText(src)).toMatchObject({ text: src, changes: [] });
  });
  it('em: floor-safe type-inline for plain 0.75–0.99em, manual review otherwise, untouched when allowlisted', () => {
    expect(transformText('text-[0.9em]').text).toBe('type-inline');
    expect(transformText('md:text-[0.9em]').manual).toHaveLength(1);
    expect(transformText('text-[1.4em]').manual).toHaveLength(1);
    expect(transformText('text-[0.7em]', { emAllowed: true })).toMatchObject({ text: 'text-[0.7em]', changes: [], manual: [] });
  });
});
