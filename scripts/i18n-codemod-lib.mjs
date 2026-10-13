/* Pure transforms used by scripts/i18n-codemod.mjs (and unit-tested). */

const B = String.raw`(?<![A-Za-z0-9_-])`; // not part of a longer class token

const RTL_RULES = [
  // margin / padding (keeps a leading "-" for negatives and any "md:" style prefix)
  [new RegExp(`${B}(-?)ml-(?=[\\w\\[./])`, 'g'), '$1ms-'],
  [new RegExp(`${B}(-?)mr-(?=[\\w\\[./])`, 'g'), '$1me-'],
  [new RegExp(`${B}pl-(?=[\\w\\[./])`, 'g'), 'ps-'],
  [new RegExp(`${B}pr-(?=[\\w\\[./])`, 'g'), 'pe-'],
  // alignment / float
  [new RegExp(`${B}text-left(?![A-Za-z0-9_-])`, 'g'), 'text-start'],
  [new RegExp(`${B}text-right(?![A-Za-z0-9_-])`, 'g'), 'text-end'],
  [new RegExp(`${B}float-left(?![A-Za-z0-9_-])`, 'g'), 'float-start'],
  [new RegExp(`${B}float-right(?![A-Za-z0-9_-])`, 'g'), 'float-end'],
  // borders & radius
  [new RegExp(`${B}border-l(?![A-Za-z])`, 'g'), 'border-s'],
  [new RegExp(`${B}border-r(?![A-Za-z])`, 'g'), 'border-e'],
  [new RegExp(`${B}rounded-l(?![A-Za-z])`, 'g'), 'rounded-s'],
  [new RegExp(`${B}rounded-r(?![A-Za-z])`, 'g'), 'rounded-e'],
  [new RegExp(`${B}rounded-tl(?![A-Za-z])`, 'g'), 'rounded-ss'],
  [new RegExp(`${B}rounded-tr(?![A-Za-z])`, 'g'), 'rounded-se'],
  [new RegExp(`${B}rounded-bl(?![A-Za-z])`, 'g'), 'rounded-es'],
  [new RegExp(`${B}rounded-br(?![A-Za-z])`, 'g'), 'rounded-ee'],
];

// left-/right- offsets are only safe to flip when nothing else on the line
// positions the element physically (translate / origin / rotate / transform).
const OFFSET_RULES = [
  [new RegExp(`${B}(-?)left-(?=[\\w\\[./])`, 'g'), '$1start-'],
  [new RegExp(`${B}(-?)right-(?=[\\w\\[./])`, 'g'), '$1end-'],
];
const PHYSICAL_GUARD = /translate-x|origin-(left|right)|rotate-|-scale-x|scale-x/;

// translate-x-N slides (toggle thumbs, drawers, hover nudges) must move the other
// way in RTL. Adds a paired `rtl:` token; the centering idiom (left-1/2 + translate-x-1/2)
// is direction-agnostic and left untouched.
const TRANSLATE_RE = new RegExp(
  `${B}((?:[A-Za-z0-9_\\[\\]-]+:)*)(-?)translate-x-([\\w./\\[\\]-]+)`,
  'g',
);
const CENTERING_POS = /(?:left|right)-1\/2/;
const CENTERING = { test: (l) => CENTERING_POS.test(l) && /translate-x-1\/2/.test(l) };
const HAS_RTL_TRANSLATE = /rtl:(?:[\w-]+:)*-?translate-x-/;

function mirrorTranslate(line, onChange) {
  if (HAS_RTL_TRANSLATE.test(line)) return line;
  return line.replace(TRANSLATE_RE, (full, variants, sign, val) => {
    if (val === '1/2' || val === '0') return full;
    onChange();
    return `${full} rtl:${variants}${sign ? '' : '-'}translate-x-${val}`;
  });
}

/** @returns {{code:string, changes:number, skipped:{line:number,text:string}[]}} */
export function transformRtl(source) {
  let changes = 0;
  const skipped = [];
  const out = source.split('\n').map((line, i) => {
    if (line.includes('i18n-codemod-ignore')) return line;
    let next = line;
    for (const [re, rep] of RTL_RULES) {
      next = next.replace(re, (...a) => {
        changes++;
        return rep.replace(/\$1/g, a[1] ?? '');
      });
    }
    next = mirrorTranslate(next, () => changes++);
    const hasOffset = OFFSET_RULES.some(([re]) => new RegExp(re.source).test(next));
    if (hasOffset) {
      if (CENTERING.test(next)) {
        // left-1/2 + translate-x-1/2 centers in both directions — leave untouched, nothing to review.
      } else if (PHYSICAL_GUARD.test(next)) {
        skipped.push({ line: i + 1, text: next.trim().slice(0, 140) });
      } else {
        for (const [re, rep] of OFFSET_RULES) {
          next = next.replace(re, (...a) => {
            changes++;
            return rep.replace(/\$1/g, a[1] ?? '');
          });
        }
      }
    }
    return next;
  });
  return { code: out.join('\n'), changes, skipped };
}

const LOCALE_ARG = String.raw`\(\s*(?:'en-US'|"en-US"|undefined|\[\])\s*([,)])`;
const LOCALE_RULES = [
  [/\.(toLocale(?:Date|Time)?String)\(\s*\)/g, '.$1(getActiveLocale())'],
  [new RegExp(String.raw`\.(toLocale(?:Date|Time)?String)${LOCALE_ARG}`, 'g'), '.$1(getActiveLocale()$2'],
  [new RegExp(String.raw`(new Intl\.(?:NumberFormat|DateTimeFormat))${LOCALE_ARG}`, 'g'), '$1(getActiveLocale()$2'],
];

function lastImportEnd(lines) {
  let last = -1;
  let inImport = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!inImport && /^import\s/.test(l)) {
      inImport = true;
    }
    if (inImport && /(?:from\s+)?['"][^'"]+['"];?\s*$/.test(l) && (/^import\s+['"]/.test(l) || /from\s+['"]/.test(l))) {
      inImport = false;
      last = i;
    }
  }
  return last;
}

/** @returns {{code:string, changes:number}} */
export function transformLocale(source) {
  let changes = 0;
  let code = source;
  for (const [re, rep] of LOCALE_RULES) {
    code = code.replace(re, (...a) => {
      changes++;
      return rep.replace('$1', a[1]).replace('$2', a[2] ?? '');
    });
  }
  if (changes > 0 && !/\bgetActiveLocale\b[^(]*from\s+['"]@\/lib\/format['"]/.test(code) && !/import\s*\{[^}]*\bgetActiveLocale\b/.test(code)) {
    const lines = code.split('\n');
    const idx = lastImportEnd(lines);
    lines.splice(idx + 1, 0, "import { getActiveLocale } from '@/lib/format';");
    code = lines.join('\n');
  }
  return { code, changes };
}
