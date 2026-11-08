// Pure functions for scripts/codemod-motion.mjs (unit-tested in codemod-lib.test.mjs).

const STATE_VARIANT = '(?:hover|focus|focus-visible|focus-within|active|group-hover|group-focus|aria-[a-z-]+|peer-[a-z-]+|open|checked|disabled|selected)';
const LAYOUT_UTIL = '-?(?:w|h|min-w|min-h|max-w|max-h|size|inset|inset-x|inset-y|top|bottom|left|right|start|end|m|mx|my|mt|mb|ml|mr|ms|me|p|px|py|pt|pb|pl|pr|ps|pe|gap|basis|grid-rows|grid-cols)-';
const STATE_LAYOUT_RE = new RegExp(`${STATE_VARIANT}:${LAYOUT_UTIL}`);
const STYLE_RE = /style=\{\{.*\b(?:width|height|maxHeight|minHeight|left|right|top|bottom|inset)\b/;
const SIZE_TOKEN_RE = /(?:^|[\s'"`])-?(?:max-h|h|w|grid-rows)-/;

/** Cheap, linear-time check on ±radius lines for state-driven size changes (ternary class swaps, inline style). */
function layoutHint(lines, i, radius = 4) {
  const w = lines.slice(Math.max(0, i - radius), i + radius + 1);
  const joined = w.join('\n');
  return STYLE_RE.test(joined) || (joined.includes(' ? ') && w.some((l) => l.includes(' ? ') && SIZE_TOKEN_RE.test(l)));
}

/** transition-all -> transition-interactive (colour/opacity/shadow/transform) or transition-layout (also size/spacing). Line based, O(n). */
export function rewriteTransitionAll(src) {
  let simple = 0, layout = 0;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('transition-all')) continue;
    if (!/(^|[^\w-])(?:[a-z0-9-]+:)*transition-all(?![\w-])/.test(line)) continue;
    const needsLayout = STATE_LAYOUT_RE.test(line) || layoutHint(lines, i);
    const target = needsLayout ? 'transition-layout' : 'transition-interactive';
    lines[i] = line.replace(/(^|[^\w-])((?:[a-z0-9-]+:)*)transition-all(?![\w-])/g, (_m, pre, v) => {
      if (needsLayout) layout++; else simple++;
      return `${pre}${v}${target}`;
    });
  }
  return { out: lines.join('\n'), simple, layout };
}

/** behavior: 'smooth' -> behavior: scrollBehavior(); adds the import when missing. */
export function rewriteSmoothScroll(src, importPath = '@/lib/motionPolicy') {
  let count = 0;
  let out = src.replace(/behavior\s*:\s*(['"])smooth\1/g, () => { count++; return 'behavior: scrollBehavior()'; });
  if (count > 0 && !/\bscrollBehavior\b[^\n]*from\s+['"][^'"]*motionPolicy['"]/.test(out)) {
    const importRe = /^import[\s\S]*?(?:from\s+)?['"][^'"]+['"];?[ \t]*$/gm;
    let lastEnd = -1, m;
    while ((m = importRe.exec(out)) !== null) lastEnd = m.index + m[0].length;
    const line = `import { scrollBehavior } from '${importPath}';`;
    out = lastEnd === -1 ? `${line}\n${out}` : `${out.slice(0, lastEnd)}\n${line}${out.slice(lastEnd)}`;
  }
  return { out, count };
}
