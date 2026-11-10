/**
 * Runtime text-size audit: finds rendered text smaller than `minPx` CSS pixels.
 *
 * Self-contained on purpose (no imports, no closures): Playwright passes it to `page.evaluate`, and the
 * /dev/design-system page calls it directly, so the e2e gate and the in-app checker are the same code.
 * It measures COMPUTED size, so it also catches SVG text scaled by a viewBox only if the caller measures rects —
 * see `scaledSvgTextPx` below for that case.
 */
export interface SmallTextHit {
  selector: string;
  text: string;
  px: number;
}

export function findSmallText(root: ParentNode = document, minPx = 12): SmallTextHit[] {
  const hits: SmallTextHit[] = [];
  const describe = (el: Element): string => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const all = root.querySelectorAll('*');
  for (const el of Array.from(all)) {
    // Never rendered as visible text: tooltips (<title>/<desc> inside SVG), metadata, code and templates.
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'DESC', 'METADATA'].includes(el.tagName.toUpperCase())) continue;
    const hasOwnText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
    if (!hasOwnText) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    let px = parseFloat(cs.fontSize);
    if (el instanceof SVGElement) {
      // SVG text: CSS px are user units, so multiply by the cumulative on-screen scale of the nearest <svg>.
      const svg = el.ownerSVGElement;
      const vb = svg?.viewBox?.baseVal;
      if (svg && vb && vb.width > 0 && vb.height > 0) {
        const r = svg.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) px *= Math.min(r.width / vb.width, r.height / vb.height);
      }
    }
    if (Number.isFinite(px) && px < minPx - 0.01) {
      hits.push({ selector: describe(el), text: (el.textContent ?? '').trim().slice(0, 40), px: Math.round(px * 100) / 100 });
    }
  }
  return hits;
}
