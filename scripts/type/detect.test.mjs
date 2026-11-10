// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { detectSizes, maskComments, toPx } from './lib/detect.mjs';

const raws = (t, ext = '.tsx') => detectSizes(t, ext).map((h) => h.raw);

describe('detectSizes', () => {
  it('finds tailwind arbitrary sizes with variants and important', () => {
    expect(raws('<p className="text-[11px] md:text-[0.65rem] !text-[10px] hover:dark:text-[9pt]">')).toEqual(['text-[11px]', 'md:text-[0.65rem]', '!text-[10px]', 'hover:dark:text-[9pt]']);
  });
  it('does not match colours or length: hints', () => {
    expect(raws('className="text-[#111827] text-[color:red] text-[length:var(--x)] text-caption text-xs"')).toEqual([]);
  });
  it('resolves rem/pt/em to px at a 16px root', () => {
    expect(toPx('0.65', 'rem')).toBeCloseTo(10.4);
    expect(toPx('9', 'pt')).toBeCloseTo(12);
    expect(detectSizes('text-[0.9em]', '.tsx')[0].relative).toBe(true);
  });
  it('separates SVG user units from CSS px inline styles', () => {
    const k = (t) => detectSizes(t, '.tsx').map((h) => h.kind);
    expect(k('<text fontSize="10">a</text>')).toEqual(['svg-attr']);
    expect(k('<text x={1} y={2} fontSize={11}>a</text>')).toEqual(['svg-attr']);
    expect(k('<span style={{ fontSize: 11 }}>a</span>')).toEqual(['inline-style']);
    expect(k("<span style={{ fontSize: '10px' }}>a</span>")).toEqual(['inline-style']);
  });
  it('does not flag fontSize driven by a function/variable (already floor-safe)', () => {
    expect(raws('<text fontSize={svgSize(10)}>a</text>')).toEqual([]);
    expect(raws('<text fontSize={size}>a</text>')).toEqual([]);
  });
  it('evaluates the smallest absolute length inside clamp()/min()/max() in CSS', () => {
    const h = detectSizes('a{font-size:clamp(10px,2vw,16px)}', '.css')[0];
    expect(h.px).toBe(10);
    expect(detectSizes('a{font-size:clamp(0.875rem,2vw,1.25rem)}', '.css')[0].px).toBe(14);
  });
  it('detects font shorthand and canvas fonts', () => {
    expect(raws("style={{ font: '400 10px system-ui' }}")).toHaveLength(1);
    expect(detectSizes('ctx.font = `64px ${f}`;', '.ts')[0].px).toBe(64);
    expect(detectSizes('a{font: 600 11px/1.2 Inter}', '.css')[0].px).toBe(11);
    expect(raws('const f = { fontFamily: "Inter" }')).toEqual([]);
  });
});

describe('maskComments', () => {
  it('ignores sizes that only appear in comments', () => {
    expect(raws('// text-[9px] in a line comment\n/* font-size: 8px */\n<p className="text-caption"/>')).toEqual([]);
    expect(detectSizes('/* font-size: 8px */ a{font-size:0.75rem}', '.css').map((h) => h.px)).toEqual([12]);
  });
  it('does NOT let a route glob or URL swallow real code (no false negatives)', () => {
    expect(raws('<Route path="/dashboard/*" /><p className="text-[11px]"/>')).toEqual(['text-[11px]']);
    expect(raws('const u = "https://x.y/z"; const c = "text-[10px]";')).toEqual(['text-[10px]']);
  });
  it('keeps offsets and newlines intact so line numbers stay correct', () => {
    const t = 'a\n/* x\ny */\n<p className="text-[11px]"/>';
    expect(maskComments(t, '.tsx').length).toBe(t.length);
    expect(maskComments(t, '.tsx').split('\n').length).toBe(t.split('\n').length);
  });
});
