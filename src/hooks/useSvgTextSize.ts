import { useEffect, useState } from 'react';

/**
 * SVG text is sized in *user units*, not CSS pixels: a `viewBox="0 0 720 220"` chart squeezed into a 360px container
 * is drawn at half scale, so an 11-unit font renders at 5.5px. Bumping the number is therefore not enough to honour
 * the 12px text floor. This hook measures the real rendered scale and returns the user-unit size that renders at a
 * true ≥ 0.75rem (12px at the default root; it follows the user's text-size setting because it reads the root size).
 *
 * It reads the viewBox from the rendered <svg> itself, so callers pass nothing and the hook can sit at the top of a
 * component (before any early return), even when the chart's dimensions are computed later in the body.
 *
 *   const { ref, size } = useSvgTextSize();
 *   <svg ref={ref} viewBox={`0 0 ${W} ${H}`}> <text fontSize={size(10)}>…</text> </svg>
 */

/** Floor as a fraction of the root font size: 0.75rem (the `caption` token). Keep in sync with scripts/type/type-scale.mjs MIN_REM. */
export const SVG_TEXT_FLOOR_REM = 0.75;

/**
 * A chart is never squashed below this scale. Below it, the 12px floor makes axis labels (which are fixed 12px but live in
 * a shrinking coordinate system) collide with each other and get clipped by the fixed plot padding — so instead of
 * shrinking the drawing, the chart keeps `viewBox width × MIN_CHART_SCALE` and its container scrolls horizontally.
 */
export const MIN_CHART_SCALE = 0.8;

/** Scale applied by `preserveAspectRatio="xMidYMid meet"` (the SVG default) to a viewBox drawn into `rect`. */
export function svgScale(rect: { width: number; height: number }, viewBoxWidth: number, viewBoxHeight: number): number {
  if (!(rect.width > 0 && rect.height > 0 && viewBoxWidth > 0 && viewBoxHeight > 0)) return 1;
  return Math.min(rect.width / viewBoxWidth, rect.height / viewBoxHeight);
}

/** User-unit font size that renders at no less than `floorPx`, never smaller than the design size. */
export function svgTextUnits(designUnits: number, scale: number, floorPx: number): number {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1;
  // Round up to 0.1 so the attribute is stable across sub-pixel resize noise.
  return Math.max(designUnits, Math.ceil((floorPx / s) * 10) / 10);
}

/** Parses an SVG viewBox attribute ("minX minY w h", comma or space separated). */
export function parseViewBox(attr: string | null | undefined): { width: number; height: number } | null {
  if (!attr) return null;
  const n = attr.trim().split(/[\s,]+/).map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v)) || n[2] <= 0 || n[3] <= 0) return null;
  return { width: n[2], height: n[3] };
}

/**
 * Scroll instead of squash: keeps the drawing at >= MIN_CHART_SCALE of its viewBox and lets the nearest container scroll.
 * Deliberate DOM side effect (inline min-width on the <svg>, overflow-x on its parent) so every chart gets the same
 * behaviour without a wrapper in each of the ~17 chart components. Idempotent; never removes a scroller the page already has.
 */
export function applyScrollFloor(svg: SVGSVGElement, viewBoxWidth: number): void {
  svg.style.minWidth = `${Math.ceil(viewBoxWidth * MIN_CHART_SCALE)}px`;
  const parent = svg.parentElement;
  if (!parent) return;
  const ox = getComputedStyle(parent).overflowX;
  if (ox === 'visible' || ox === 'hidden' || ox === 'clip') parent.style.overflowX = 'auto';
  // A scrollable region must be reachable by keyboard (WCAG 2.1.1, axe: scrollable-region-focusable).
  if (parent.scrollWidth > parent.clientWidth + 1 && !parent.hasAttribute('tabindex')) parent.setAttribute('tabindex', '0');
}

function rootFloorPx(): number {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return 12;
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return (Number.isFinite(root) && root > 0 ? root : 16) * SVG_TEXT_FLOOR_REM;
}

export interface SvgTextSize {
  /** Callback ref for the chart's <svg> (works when the chart mounts after a loading state). */
  ref: (el: SVGSVGElement | null) => void;
  /** `size(10)` → user-unit font size to use where the design said 10. */
  size: (designUnits: number) => number;
}

export function useSvgTextSize(): SvgTextSize {
  const [el, setEl] = useState<SVGSVGElement | null>(null);
  const [scale, setScale] = useState(1);
  const [floorPx, setFloorPx] = useState(rootFloorPx);

  useEffect(() => {
    if (!el) return undefined;
    const measure = () => {
      const vb = parseViewBox(el.getAttribute('viewBox'));
      if (vb) {
        applyScrollFloor(el, vb.width);
        // Quantise to 0.01 to avoid render loops from sub-pixel jitter — always DOWN: a scale that is too small only
        // makes the text slightly larger, whereas rounding up would render it under the floor (e.g. 11.95px).
        setScale(Math.floor(svgScale(el.getBoundingClientRect(), vb.width, vb.height) * 100) / 100);
      }
      setFloorPx(rootFloorPx());
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    // The viewBox of data-driven charts changes without the element resizing.
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(measure) : null;
    mo?.observe(el, { attributes: true, attributeFilter: ['viewBox'] });
    // The in-app text size (--a11y-font-scale) and the OS font scale change the ROOT size without resizing the chart,
    // and both are applied as an inline style / class on <html> (see lib/a11y/apply.ts, lib/native/textScale.ts).
    const rootMo = typeof MutationObserver !== 'undefined' ? new MutationObserver(measure) : null;
    rootMo?.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => {
      ro?.disconnect();
      mo?.disconnect();
      rootMo?.disconnect();
    };
  }, [el]);

  return { ref: setEl, size: (designUnits: number) => svgTextUnits(designUnits, scale, floorPx) };
}
