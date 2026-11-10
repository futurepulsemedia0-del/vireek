import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useSvgTextSize, svgScale, svgTextUnits, parseViewBox, applyScrollFloor, MIN_CHART_SCALE, SVG_TEXT_FLOOR_REM } from './useSvgTextSize';

describe('svgScale', () => {
  it('is the "meet" scale of a viewBox drawn into a rect', () => {
    expect(svgScale({ width: 360, height: 110 }, 720, 220)).toBe(0.5);
    expect(svgScale({ width: 1440, height: 440 }, 720, 220)).toBe(2);
    // constrained by the shorter axis
    expect(svgScale({ width: 720, height: 110 }, 720, 220)).toBe(0.5);
  });
  it('falls back to 1 for unmeasurable input (jsdom, display:none)', () => {
    expect(svgScale({ width: 0, height: 0 }, 720, 220)).toBe(1);
    expect(svgScale({ width: 100, height: 100 }, 0, 0)).toBe(1);
  });
});

describe('svgTextUnits — the rendered size must be >= the floor', () => {
  it('enlarges user units when the chart is shrunk', () => {
    // 11 design units at half scale would render 5.5px; we need 24 units to render 12px.
    expect(svgTextUnits(11, 0.5, 12)).toBe(24);
    expect(svgTextUnits(11, 0.5, 12) * 0.5).toBeGreaterThanOrEqual(12);
  });
  it('never makes text smaller than the design size', () => {
    expect(svgTextUnits(18, 2, 12)).toBe(18);
    expect(svgTextUnits(14, 1, 12)).toBe(14);
  });
  it('lifts a sub-floor design size at scale 1', () => {
    expect(svgTextUnits(9, 1, 12)).toBe(12);
  });
  it('holds the floor for every scale 0.2…3 and every design size 8…12', () => {
    for (let s = 0.2; s <= 3; s += 0.05) {
      for (let d = 8; d <= 12; d++) expect(svgTextUnits(d, s, 12) * s, `scale ${s.toFixed(2)} design ${d}`).toBeGreaterThanOrEqual(12 - 1e-9);
    }
  });
  it('tolerates a nonsensical scale', () => {
    expect(svgTextUnits(10, 0, 12)).toBe(12);
    expect(svgTextUnits(10, NaN, 12)).toBe(12);
  });
  it('the floor constant matches the caption token (0.75rem)', () => expect(SVG_TEXT_FLOOR_REM).toBe(0.75));
});

describe('scroll instead of squash', () => {
  it('keeps the drawing at >= MIN_CHART_SCALE and makes the container scroll', () => {
    document.body.innerHTML = '<div id="p" style="overflow-x:hidden"><svg viewBox="0 0 720 220"></svg></div>';
    const svg = document.querySelector('svg') as SVGSVGElement;
    applyScrollFloor(svg, 720);
    expect(svg.style.minWidth).toBe(`${Math.ceil(720 * MIN_CHART_SCALE)}px`);
    expect((document.getElementById('p') as HTMLElement).style.overflowX).toBe('auto');
  });
  it('never downgrades a scroller the page already has', () => {
    document.body.innerHTML = '<div id="p" style="overflow-x:scroll"><svg viewBox="0 0 640 220"></svg></div>';
    applyScrollFloor(document.querySelector('svg') as SVGSVGElement, 640);
    expect((document.getElementById('p') as HTMLElement).style.overflowX).toBe('scroll');
  });
  it('is idempotent', () => {
    document.body.innerHTML = '<div><svg viewBox="0 0 100 50"></svg></div>';
    const svg = document.querySelector('svg') as SVGSVGElement;
    applyScrollFloor(svg, 100);
    const once = document.body.innerHTML;
    applyScrollFloor(svg, 100);
    expect(document.body.innerHTML).toBe(once);
  });
  it('MIN_CHART_SCALE is a sane fraction', () => expect(MIN_CHART_SCALE).toBeGreaterThan(0.5));
});

describe('parseViewBox', () => {
  it('parses space/comma separated and rejects junk', () => {
    expect(parseViewBox('0 0 720 220')).toEqual({ width: 720, height: 220 });
    expect(parseViewBox('-12,-12, 300 ,200')).toEqual({ width: 300, height: 200 });
    expect(parseViewBox('0 0 0 0')).toBeNull();
    expect(parseViewBox('a b c d')).toBeNull();
    expect(parseViewBox(null)).toBeNull();
  });
});

describe('useSvgTextSize (rendered)', () => {
  const realRO = globalThis.ResizeObserver;
  const realRect = SVGElement.prototype.getBoundingClientRect;
  afterEach(() => {
    globalThis.ResizeObserver = realRO;
    SVGElement.prototype.getBoundingClientRect = realRect;
    document.documentElement.style.fontSize = '';
  });

  function Probe({ vb = '0 0 720 220' }: { vb?: string }) {
    const { ref, size } = useSvgTextSize();
    return (
      <svg ref={ref} viewBox={vb}>
        <text data-testid="t" fontSize={size(10)}>x</text>
      </svg>
    );
  }
  const fs = (el: HTMLElement) => Number(el.querySelector('text')!.getAttribute('font-size'));

  it('renders at the floor at scale 1 when nothing can be measured', () => {
    const { container } = render(<Probe />);
    expect(fs(container)).toBe(12);
  });

  it('re-sizes when the observed width changes', () => {
    let cb: () => void = () => {};
    let width = 360;
    globalThis.ResizeObserver = class { constructor(c: () => void) { cb = c; } observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
    SVGElement.prototype.getBoundingClientRect = () => ({ width, height: width * (220 / 720), x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, toJSON() {} }) as DOMRect;
    const { container } = render(<Probe />);
    expect(fs(container)).toBe(24); // scale 0.5
    width = 720;
    act(() => cb());
    expect(fs(container)).toBe(12); // scale 1
    width = 1440;
    act(() => cb());
    // scale 2: the design size (10 units) already renders at 20px, so it is kept — the hook never shrinks design sizes.
    expect(fs(container)).toBe(10);
    expect(fs(container) * 2).toBeGreaterThanOrEqual(12);
  });

  it('follows the user text size: a larger root raises the floor', () => {
    document.documentElement.style.fontSize = '32px'; // 200%
    const { container } = render(<Probe />);
    expect(fs(container)).toBe(24); // 0.75 × 32 = 24px at scale 1
  });

  it('re-reads the root size when the text-size setting changes (no chart resize involved)', async () => {
    const { container } = render(<Probe />);
    expect(fs(container)).toBe(12);
    await act(async () => {
      document.documentElement.style.fontSize = '32px';
      await Promise.resolve();
    });
    expect(fs(container)).toBe(24);
  });

  it('quantises the measured scale DOWN so the rendered size can never fall under the floor', () => {
    let cb: () => void = () => {};
    globalThis.ResizeObserver = class { constructor(c: () => void) { cb = c; } observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
    // scale 0.8349…: rounding to nearest would give 0.83; but 0.8351 would give 0.84 (too big) — it must floor to 0.83.
    SVGElement.prototype.getBoundingClientRect = () => ({ width: 601.2, height: 183.7, x: 0, y: 0, top: 0, left: 0, right: 601.2, bottom: 0, toJSON() {} }) as DOMRect;
    const { container } = render(<Probe />);
    act(() => cb());
    const real = Math.min(601.2 / 720, 183.7 / 220);
    expect(fs(container) * real).toBeGreaterThanOrEqual(12);
  });

  it('cleans up its observers', () => {
    const disconnect = vi.fn();
    globalThis.ResizeObserver = class { observe() {} disconnect = disconnect; } as unknown as typeof ResizeObserver;
    const { unmount } = render(<Probe />);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
