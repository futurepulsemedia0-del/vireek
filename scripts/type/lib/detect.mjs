// scripts/type/lib/detect.mjs
//
// The ONE detector for "text sizes that are not a type-scale token". Imported by
//   • scripts/type/measure-text-sizes.mjs  (Phase 0 audit)
//   • scripts/type/check-text-sizes.mjs    (Phase 4 guard / CI)
//   • the tests
// so the audit and the gate can never disagree about what counts.
//
// Detected forms (kind):
//   tailwind-arbitrary  text-[11px], md:text-[0.65rem], !text-[10px], text-[0.9em]
//   inline-style        style={{ fontSize: 11 }}  /  fontSize: '10px'            (React number = px)
//   svg-attr            <text fontSize="10"> / fontSize={11}                      (SVG user units, scaled by the viewBox)
//   css                 font-size: 11px  (also the smallest absolute length inside clamp()/min()/max())
//   font-shorthand      font: 400 10px system-ui  /  ctx.font = '10px …'
//
// Comments are masked first, so prose that merely mentions a size can never trip the guard.

export const ROOT_PX = 16;

export function toPx(value, unit) {
  const n = parseFloat(value);
  if (unit === 'px' || unit === '' || unit === undefined) return n;
  if (unit === 'rem' || unit === 'em') return n * ROOT_PX;
  if (unit === 'pt') return (n * 96) / 72;
  return NaN;
}

/**
 * Replace comment characters with spaces (newlines kept) so offsets and line numbers are unchanged.
 * String-aware: `path="/dashboard/*"` or "https://x" is NOT a comment. Quote handling is deliberately conservative —
 * a quote that is never closed ends at the line break (JSX text like "Don't"), which can only UNDER-mask comments
 * (a possible false positive) and never hide real code (a false negative in the guard).
 */
export function maskComments(text, ext) {
  const out = text.split('');
  const n = text.length;
  const lineComments = ext !== '.css';
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      for (let k = i; k < j; k++) if (out[k] !== '\n') out[k] = ' ';
      i = j;
    } else if (lineComments && c === '/' && d === '/' && (i === 0 || /[\s;,{}(]/.test(text[i - 1]))) {
      let j = text.indexOf('\n', i);
      j = j === -1 ? n : j;
      for (let k = i; k < j; k++) out[k] = ' ';
      i = j;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === c) break;
        if (c !== '`' && text[j] === '\n') break; // unterminated quote: stop at EOL
        j++;
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

const RE_TW = /(?<![\w-])((?:[\w-]+:)*)(!?)text-\[(-?[0-9]*\.?[0-9]+)(px|rem|em|pt)\]/g;
const RE_STYLE = /fontSize\s*[:=]\s*\{?\s*(['"]?)([0-9]*\.?[0-9]+)(px|rem|em|pt)?\1\s*\}?/g;
const RE_CSS_DECL = /font-size\s*:\s*([^;}\n]+)/g;
const RE_LENGTH = /(-?[0-9]*\.?[0-9]+)(px|rem|pt)\b/g;
const RE_FONT_SHORTHAND = /(?:(?<![\w-])font\s*:\s*['"`]?|\.font\s*=\s*['"`])[^;'"`}]*?\b([0-9]*\.?[0-9]+)(px|rem|em|pt)\b/g;

/**
 * @param {string} text raw file text
 * @param {string} ext  '.ts' | '.tsx' | '.css'
 * @returns {{ kind: string, raw: string, px: number, relative: boolean, unit: string, index: number }[]}
 */
export function detectSizes(text, ext) {
  const src = maskComments(text, ext);
  const hits = [];
  if (ext === '.css') {
    for (const m of src.matchAll(RE_CSS_DECL)) {
      const lens = [...m[1].matchAll(RE_LENGTH)].map((l) => ({ px: toPx(l[1], l[2]), unit: l[2] }));
      if (!lens.length) {
        // em / % / keywords: relative, not an absolute floor violation by itself.
        const em = m[1].match(/([0-9]*\.?[0-9]+)em\b/);
        if (em) hits.push({ kind: 'css', raw: m[0].trim(), px: toPx(em[1], 'em'), relative: true, unit: 'em', index: m.index });
        continue;
      }
      const min = lens.reduce((a, b) => (b.px < a.px ? b : a));
      hits.push({ kind: 'css', raw: m[0].trim(), px: min.px, relative: false, unit: min.unit, index: m.index });
    }
    for (const m of src.matchAll(RE_FONT_SHORTHAND)) {
      hits.push({ kind: 'font-shorthand', raw: m[0].trim(), px: toPx(m[1], m[2]), relative: m[2] === 'em', unit: m[2], index: m.index });
    }
    return hits;
  }
  for (const m of src.matchAll(RE_TW)) {
    hits.push({ kind: 'tailwind-arbitrary', raw: `${m[1]}${m[2]}text-[${m[3]}${m[4]}]`, px: toPx(m[3], m[4]), relative: m[4] === 'em', unit: m[4], index: m.index });
  }
  for (const m of src.matchAll(RE_STYLE)) {
    const unit = m[3] ?? 'px';
    // `fontSize={11}` / `fontSize="10"` on a JSX <text>/<tspan> is an SVG user unit (scales with the viewBox), not a CSS px.
    const isSvg = /^fontSize\s*=/.test(m[0]) || /<(text|tspan)\b[^>]*$/.test(src.slice(Math.max(0, m.index - 300), m.index));
    hits.push({ kind: isSvg ? 'svg-attr' : 'inline-style', raw: m[0].trim(), px: toPx(m[2], unit), relative: unit === 'em', unit, index: m.index });
  }
  for (const m of src.matchAll(RE_FONT_SHORTHAND)) {
    hits.push({ kind: 'font-shorthand', raw: m[0].trim().slice(0, 60), px: toPx(m[1], m[2]), relative: m[2] === 'em', unit: m[2], index: m.index });
  }
  return hits.sort((a, b) => a.index - b.index);
}

export function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
