// scripts/design/lib/radius-classify.mjs
//
// Shared AST scanner + role classifier for the border-radius work. Used by the
// audit (Phase 0), the codemod (Phase 2) and the guard (Phase 3) so all three
// agree on what a "button" or a "card" is.
//
// Strategy: parse each .ts/.tsx file with the TypeScript compiler, find every
// string / template literal that contains a Tailwind radius token, and attach
// context (JSX tag + a few attributes, nearest named declaration, component
// name, file path). A rule list then maps context + class list to a role.

import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { RADIUS_RANK } from '../radius-tokens.mjs';

export const SIZES = ['none', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full', 'control', 'chip', 'surface', 'overlay', 'legacy-md'];
const SIDE = '(?:t|r|b|l|s|e|tl|tr|bl|br|ss|se|es|ee)';
const SIZE = `(?:${SIZES.join('|')}|\\[[^\\]\\s]+\\])`;
/** Matches `[variants:]rounded[-side][-size]`. */
export const RADIUS_RE = new RegExp(`(?<![\\w-])((?:[a-z0-9\\-\\[\\]=&>_*]+:)*)(rounded(?:-(${SIDE}))?(?:-(${SIZE}))?)(?![\\w-])`, 'g');

const CLASSISH = /^(?:[a-z0-9\-\[\]=&>_*]+:)*!?-?(?:p[xytrblse]?|m[xytrblse]?|bg|text|border|flex|grid|w|h|min-[wh]|max-[wh]|size|gap|space-[xy]|items|justify|self|inline|block|hidden|font|shadow|ring|overflow|relative|absolute|fixed|sticky|inset|top|left|right|bottom|z|object|cursor|transition|duration|opacity|truncate|focus-ring|sr-only|animate|divide|outline|backdrop|col|row|order|leading|tracking|underline|uppercase|capitalize|whitespace|break|shrink|grow|basis|aspect|rotate|translate|scale|select|pointer-events|content|group|peer|dark|rtl|ltr)(?:$|[-:\[])/;

export function looksLikeClassList(s) {
  const toks = s.split(/\s+/).filter(Boolean);
  let hits = 0;
  for (const t of toks) if (CLASSISH.test(t)) hits++;
  return hits >= 1;
}

export function parseRadius(match) {
  const [, variants, token, side, size] = match;
  return { token, variants: variants || '', side: side || '', size: size || 'DEFAULT', responsive: !!variants };
}

/** Approximate px for an arbitrary value like [2rem], [0.7em], [27px]. */
export function arbitraryPx(size) {
  const m = /^\[(\d*\.?\d+)(px|rem|em)\]$/.exec(size);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'px' ? n : n * 16;
}

export function rankOf(size) {
  if (size.startsWith('[')) {
    const p = arbitraryPx(size);
    if (p == null) return 4;
    if (p >= 9999) return 7;
    if (p > 16) return 6;
    if (p > 12) return 5;
    if (p > 8) return 4;
    if (p > 6) return 3;
    if (p > 4) return 2;
    return 1;
  }
  return RADIUS_RANK[size] ?? 4;
}

/** Longest side of a fixed-size element in px, or null when not fixed. */
export function fixedDimPx(cls) {
  const dims = [];
  for (const m of cls.matchAll(/(?<![\w-:])(?:h|w|size)-(\d+(?:\.\d+)?)(?![\w.\]-])/g)) dims.push(parseFloat(m[1]) * 4);
  for (const m of cls.matchAll(/(?<![\w-:])(?:h|w|size|min-h|min-w)-\[(\d+(?:\.\d+)?)px\]/g)) dims.push(parseFloat(m[1]));
  return dims.length ? Math.max(...dims) : null;
}
export function squareDim(cls) {
  const s = /(?<![\w-:])size-(\d+(?:\.\d+)?)(?![\w.\]-])/.exec(cls);
  if (s) return parseFloat(s[1]) * 4;
  const h = /(?<![\w-:])h-(\d+(?:\.\d+)?)(?![\w.\]-])/.exec(cls);
  const w = /(?<![\w-:])w-(\d+(?:\.\d+)?)(?![\w.\]-])/.exec(cls);
  if (h && w && h[1] === w[1]) return parseFloat(h[1]) * 4;
  return null;
}

// ---------------------------------------------------------------- roles ----
export const ROLES = ['button', 'input', 'tab', 'chip', 'menu-item', 'tooltip', 'icon-tile', 'avatar', 'dot', 'progress', 'skeleton', 'image', 'callout', 'inset', 'card', 'panel', 'dropdown', 'toast', 'modal', 'sheet', 'focus-ring', 'other'];
/** Roles that are physically small: radius must never exceed `lg`. */
export const SMALL_ROLES = new Set(['tooltip', 'button', 'input', 'tab', 'chip', 'menu-item', 'icon-tile', 'avatar', 'dot', 'progress', 'skeleton', 'callout']);
/** Target token per role (used by the codemod and guard). */
export const ROLE_TARGET = {
  tooltip: 'control', button: 'control', input: 'control', tab: 'control', 'menu-item': 'control',
  'icon-tile': 'inset', callout: 'inset', inset: 'inset', image: 'inset',
  chip: 'chip', card: 'surface', panel: 'surface', dropdown: 'surface', toast: 'surface',
  modal: 'overlay', sheet: 'overlay', progress: 'full',
};


/**
 * THE mapping rule (codemod, projection and guard all call this).
 * Returns the alias to use (`control|inset|chip|surface|overlay|full`) or null = leave the token alone.
 * @param {{role:string,size:string,side:string,file:string}} r
 * @param {{hero3xl?:string[]}} [allow]
 */
export function targetFor(r, allow = {}) {
  const { role, size, side } = r;
  if (size === 'none') return null; // explicit resets (sm:rounded-none) are never rewritten
  if (['tl', 'tr', 'bl', 'br', 'ss', 'se', 'es', 'ee'].includes(side)) return null; // chat-bubble tails / single corners
  if (size === 'full') return null; // circles + pills stay; `full` on a surface is listed by the audit for manual review, never auto-rewritten
  if (size === 'DEFAULT' || size === 'sm') return null; // already <= every alias; sharp corners are deliberate
  if (size.startsWith('[') && /em\]$/.test(size) && !/rem\]$/.test(size)) return null; // em-relative radii scale with font-size on purpose
  if (size === '3xl' && (allow.hero3xl ?? []).includes(r.file)) return null;
  if (role === 'skeleton') return ['2xl', '3xl'].includes(size) ? 'surface' : size === 'xl' ? 'inset' : null; // mirrors card (2xl->xl) and tile (xl->lg)
  if (role === 'progress') return 'full';
  const t = ROLE_TARGET[role];
  if (!t) return null;
  if (side && !['t', 'b', 'l', 'r', 's', 'e'].includes(side)) return null;
  if (side && !['lg', 'xl', '2xl', '3xl'].includes(size)) return null;
  return t;
}

const BTN_TAGS = /^(?:button|Button|IconButton|motion\.button|BackButton|CopyButton)$/;
const LINK_TAGS = /^(?:a|Link|NavLink|motion\.a)$/;
const INPUT_TAGS = /^(?:input|textarea|select|Input|Textarea|Select|SelectTrigger)$/;
const IMG_TAGS = /^(?:img|picture|video|canvas|iframe|Image|Img|RevealImage|AnnotatableImage)$/;

/** Exact roles for the shared primitives (heuristics are for the long tail, not for these). */
export const FILE_ROLE = Object.freeze({
  'src/components/ui/Button.tsx': 'button', 'src/components/ui/IconButton.tsx': 'button', 'src/components/ui/CopyButton.tsx': 'button',
  'src/components/ui/Input.tsx': 'input', 'src/components/ui/Select.tsx': 'input', 'src/components/ui/Textarea.tsx': 'input',
  'src/components/ui/Card.tsx': 'card', 'src/components/ui/Stat.tsx': 'card', 'src/components/ui/Panel.tsx': 'panel',
  'src/components/ui/Tooltip.tsx': 'tooltip',
});

export function classify({ tag = '', attrs = {}, names = '', component = '', file = '', cls = '' }) {
  const ctx = `${names} ${component}`.toLowerCase();
  const role = (attrs.role || '').toLowerCase();
  const dim = fixedDimPx(cls);
  const sq = squareDim(cls);
  const has = (re) => re.test(cls);
  const R = (r, why) => ({ role: r, why });
  if (FILE_ROLE[file]) return R(FILE_ROLE[file], 'file override');

  if (has(/(?<![\w:-])animate-pulse(?![\w-])/) || /skeleton|shimmer/.test(ctx) || /^Skeleton/.test(tag)) return R('skeleton', 'animate-pulse/skeleton');
  if (has(/(?<![\w:-])animate-spin(?![\w-])/)) return R('dot', 'spinner');
  if (/^(?:dialog)$/.test(tag) || role === 'dialog' || role === 'alertdialog' || attrs['aria-modal']) return R('modal', 'role=dialog');
  if (has(/rounded-(?:t|b)-/) && has(/(?<![\w:-])(?:fixed|absolute)(?![\w-])/) && has(/(?<![\w:-])(?:bottom-0|inset-x-0)(?![\w-])/)) return R('sheet', 'bottom sheet');
  const box = (!tag || /^(?:div|motion\.div|form|section|aside|article|ul|nav)$/.test(tag));
  const floating = has(/(?<![\w:-])(?:fixed|absolute)(?![\w-])/) || has(/(?<![\w:-])max-w-(?:xs|sm|md|lg|xl|2xl|3xl|4xl)(?![\w-])/) || has(/(?<![\w:-])max-h-\[?\d+/);
  if (box && floating && has(/(?<![\w:-])(?:bg-|border|shadow)/) && (/(?:^|[^a-z])(?:modal|dialog|sheet|drawer|lightbox|commandpalette|palette)/.test(names.toLowerCase()) || /(?:modal|dialog|drawer|sheet|palette)/i.test(component) || /(?:modal|dialog|drawer|sheet|palette)\.tsx$/i.test(file))) return R(/sheet|drawer/i.test(`${names} ${component}`) || has(/rounded-t-/) ? 'sheet' : 'modal', 'ctx modal/sheet');
  if (/^(?:Tooltip|Popover|DropdownMenu|Menu|Listbox)/.test(tag) || ['menu', 'listbox', 'tooltip', 'combobox'].includes(role) || (box && floating && has(/(?<![\w:-])(?:bg-|border|shadow)/) && /tooltip|popover|dropdown|listbox|combobox|autocomplete|suggestion|menu(?!item)/.test(ctx))) return R('dropdown', 'role/ctx menu-popover');
  if (role === 'menuitem' || role === 'option' || /menuitem|option(?!al)/.test(ctx)) return R('menu-item', 'menuitem/option');
  if (role === 'tab' || /^Tab(?!le)/.test(tag) || /(?:^|[^a-z])tabs?(?:[^a-z]|$)/.test(ctx) && !/table/.test(ctx)) return R('tab', 'tab');
  if (/toast|snackbar/.test(ctx) || role === 'alert' && has(/(?<![\w:-])fixed(?![\w-])/)) return R('toast', 'toast');
  if (/avatar|initials|userpic/.test(ctx) || /^Avatar/.test(tag)) return R('avatar', 'avatar');
  if (IMG_TAGS.test(tag) || has(/(?<![\w:-])object-(?:cover|contain|center)(?![\w-])/) || /(?:image|photo|thumb|cover|poster|screenshot|logo)(?!s?-?\w*(?:card|row))/.test(ctx) && !/card/.test(ctx)) return R('image', 'img');
  if (INPUT_TAGS.test(tag) || /input|textarea|(?:^|[^a-z])select(?!ed)|field(?!set)|searchbox/.test(names.toLowerCase())) return R('input', 'input');
  if (has(/(?<![\w:-])(?:min-h-\[\d+px\]|h-\d+)(?![\w-])/) && has(/(?<![\w:-])w-full(?![\w-])/) && has(/(?<![\w:-])border(?![\w-])/) && has(/(?<![\w:-])focus(?:-visible|-within)?:/) && has(/(?<![\w:-])px-\d/) && !has(/(?<![\w:-])(?:flex|grid)(?![\w-])/) && !BTN_TAGS.test(tag)) return R('input', 'input classes');
  if (/^(?:Badge|Chip|StatusPill|Pill|kbd|code)$/.test(tag) || /(?:badge|chip|(?:^|[^a-z])tags?(?:[^a-z]|$)|pill|kbd|counter|statuspill|statusbadge|label(?:class|s)?)/.test(ctx)) return R('chip', 'badge/chip');
  if (BTN_TAGS.test(tag) || role === 'button' || /btn|button|(?:^|[^a-z])cta|basestyles|sizestyles/.test(ctx) || (LINK_TAGS.test(tag) && has(/(?<![\w:-])(?:px-\d|p-\d|h-\d)/) && has(/(?<![\w:-])(?:inline-flex|flex|justify-center|font-(?:semibold|medium)|bg-(?:cta|accent|primary))/) && !has(/(?<![\w:-])block(?![\w-])/))) return R('button', 'button/link-button');
  if (has(/(?<![\w:-])text-(?:xs|\[1[0-2]px\]|2xs)(?![\w-])/) && has(/(?<![\w:-])px-(?:1|1\.5|2|2\.5|3)(?![\w-\.])/) && has(/(?<![\w:-])py-(?:0|0\.5|1)(?![\w-\.])/) && /^(?:span|small|div|p|li|a|strong|b)$/.test(tag)) return R('chip', 'chip classes');
  if (/^(?:span|code|mark|kbd)$/.test(tag) && has(/(?<![\w:-])px-(?:0\.5|1|1\.5|2)(?![\w.-])/) && has(/(?<![\w:-])py-(?:0|0\.5)(?![\w.-])/) && !has(/(?<![\w:-])(?:w-full|flex-1|block)(?![\w-])/)) return R('chip', 'tiny inline chip');
  if (has(/rounded-full/) && /^(?:span|div|p|a|li|strong|b|small)$/.test(tag) && has(/(?<![\w:-])px-\d/) && has(/(?<![\w:-])py-\d/) && !has(/(?<![\w:-])(?:w-full|flex-col)(?![\w-])/)) return R('chip', 'pill classes');
  if (sq != null && sq >= 20 && sq <= 56 && has(/rounded-full/)) return R('avatar', 'circle');
  if (sq != null && sq >= 20 && sq <= 56 && has(/(?<![\w:-])(?:flex|inline-flex|grid)(?![\w-])/) && has(/(?<![\w:-])(?:items-center|place-items-center|justify-center)(?![\w-])/)) {
    return R(has(/rounded-full/) ? 'avatar' : 'icon-tile', 'square flex tile');
  }
  if (has(/(?<![\w:-])animate-ping(?![\w-])/)) return R('dot', 'ping');
  if (sq != null && sq <= 19 && has(/rounded-full/)) return R('dot', 'tiny circle');
  if (sq != null && sq > 56 && has(/rounded-full/)) return R('avatar', 'large circle');
  if (has(/rounded-full/) && has(/(?<![\w:-])h-full(?![\w-])/)) return R('progress', 'bar fill');
  if ((has(/(?<![\w:-])h-(?:0\.5|1|1\.5|2|2\.5|3)(?![\w-.])/) && has(/(?<![\w:-])(?:w-full|flex-1|overflow-hidden)(?![\w-])/)) || /progress|meter|track|gauge|(?:^|[^a-z])bars?(?:[^a-z]|$)/.test(ctx)) return R('progress', 'bar');
  if (/(?:^|[^a-z])(?:focus-ring|ring)(?:[^a-z]|$)/.test(ctx) || (/^(?:a|Link|NavLink)$/.test(tag) && !has(/(?<![\w:-])(?:border|bg-|p-|px-|py-)/))) return R('focus-ring', 'focus/link');
  if (has(/(?<![\w:-])border-dashed(?![\w-])/)) return R('card', 'dashed empty-state');
  if (!has(/(?<![\w:-])(?:border|bg-)/) && has(/(?<![\w-])hover:bg-/) && has(/(?<![\w:-])px-\d/) && has(/(?<![\w:-])py-\d/)) return R('menu-item', 'hover row');
  const tinted = has(/(?<![\w:-])bg-(?:warning|danger|success|info|accent|cta|bg-primary|bg-tertiary)[\w/.-]*/);
  if (tinted && has(/(?<![\w:-])(?:p-(?:2|2\.5|3|3\.5|4)|px-\d+(?:\.\d+)? py-\d+(?:\.\d+)?)(?![\w-])/) && !has(/(?<![\w:-])shadow-card/)) return R('callout', 'tinted notice');
  if (/^(?:figure|details|pre|code|table|blockquote|summary)$/.test(tag) || has(/(?<![\w:-])overflow-(?:x-auto|auto|hidden)(?![\w-])/) && !has(/(?<![\w:-])p-(?:[4-9]|1\d)(?![\w-])/) && has(/(?<![\w:-])border(?![\w-])/)) return R('inset', 'wrapper/code/table');
  const paddedBig = has(/(?<![\w-:])(?:sm:|md:|lg:)?p-(?:8|10|12|14|16)(?![\w-])/);
  if (/^(?:Panel|section|aside|main|header|footer|nav|form|fieldset)$/.test(tag) || /panel|aside|sidebar|hero|banner|wrapper|container|section|cta(?:block)?|callout|alert/.test(ctx) || paddedBig) return R('panel', 'panel/section');
  if (/^(?:Card|article|li)$/.test(tag) || /card|tile|surface|item|row|box|stat|kpi|widget|block/.test(ctx) || ((has(/(?<![\w:-])border(?![\w-])/) || has(/(?<![\w:-])shadow-(?:card|sm|md)/)) && has(/(?<![\w:-])bg-(?:bg-|surface|card)/))) return R('card', 'card');
  if (/^(?:div|section)$/.test(tag) && has(/(?<![\w:-])(?:p-\d|px-\d)/) && has(/(?<![\w:-])(?:bg-|border)/)) return R('card', 'padded bordered div');
  return R('other', 'unclassified');
}

// --------------------------------------------------------------- scanner ---
const JSX_OPENERS = new Set([ts.SyntaxKind.JsxOpeningElement, ts.SyntaxKind.JsxSelfClosingElement]);

function tagText(node, sf) {
  return node.tagName ? node.tagName.getText(sf) : '';
}
function attrMap(opening, sf) {
  const out = {};
  for (const a of opening.attributes.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    const name = a.name.getText(sf);
    if (name === 'role' || name === 'type' || name === 'aria-modal' || name === 'aria-haspopup') {
      out[name] = a.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : 'true';
    }
  }
  return out;
}
function nameOfDecl(n, sf) {
  if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n) || ts.isPropertySignature(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText(sf).replace(/['"]/g, '');
  return null;
}

/**
 * Scan one file's text. Returns one record per radius token occurrence.
 * @returns {{file:string,line:number,col:number,token:string,size:string,side:string,responsive:boolean,variants:string,
 *   role:string,why:string,tag:string,names:string,component:string,cls:string,inJsx:boolean,pos:number,end:number,jsxId:number|null,parentJsxId:number|null}[]}
 */
export function scanSource(text, file = 'file.tsx') {
  const kind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const records = [];
  const jsxIds = new Map();
  let nextId = 1;
  const idOf = (n) => { if (!jsxIds.has(n)) jsxIds.set(n, nextId++); return jsxIds.get(n); };

  function literalText(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { s: node.text, start: node.getStart(sf) + 1 };
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return { s: node.text, start: node.getStart(sf) + (ts.isTemplateHead(node) ? 1 : 1) };
    return null;
  }
  function context(node) {
    let jsxOpening = null, inClassName = false;
    const names = []; let component = '';
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return null;
      if (!jsxOpening && ts.isJsxAttribute(p)) {
        const n = p.name.getText(sf);
        if (n === 'className' || n === 'class') { inClassName = true; jsxOpening = p.parent.parent; } else { return null; }
      }
      const nm = nameOfDecl(p, sf);
      if (nm && /^[A-Z]/.test(nm) && (ts.isFunctionDeclaration(p) || (ts.isVariableDeclaration(p) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isCallExpression(p.initializer))))) { component = nm; break; }
      if (nm && names.length < 3) names.push(nm);
    }
    return { jsxOpening: inClassName && jsxOpening && JSX_OPENERS.has(jsxOpening.kind) ? jsxOpening : null, names: names.join(' '), component };
  }
  function visit(node) {
    const lt = literalText(node);
    if (lt && lt.s.includes('rounded')) {
      const c = context(node);
      if (c) {
        const matches = [...lt.s.matchAll(RADIUS_RE)];
        if (matches.length && looksLikeClassList(lt.s)) {
          const opening = c.jsxOpening;
          const tag = opening ? tagText(opening, sf) : '';
          const attrs = opening ? attrMap(opening, sf) : {};
          // Whole className text (all literals inside the attribute) gives the best signal for classification.
          let cls = lt.s;
          if (opening) {
            const attr = opening.attributes.properties.find((a) => ts.isJsxAttribute(a) && (a.name.getText(sf) === 'className' || a.name.getText(sf) === 'class'));
            if (attr) cls = attr.getText(sf).replace(/\$\{[^}]*\}/g, ' ');
          }
          const info = classify({ tag, attrs, names: c.names, component: c.component, file, cls });
          let parentJsxId = null;
          if (opening) {
            for (let p = opening.parent.parent; p; p = p.parent) { if (ts.isJsxElement(p)) { parentJsxId = idOf(p.openingElement); break; } if (ts.isJsxFragment(p) || ts.isFunctionLike(p)) break; }
          }
          for (const m of matches) {
            const r = parseRadius(m);
            const pos = lt.start + m.index + m[1].length;
            const { line, character } = sf.getLineAndCharacterOfPosition(pos);
            records.push({ file, line: line + 1, col: character + 1, ...r, ...info, tag, names: c.names, component: c.component, cls: cls.replace(/\s+/g, ' ').slice(0, 220), inJsx: !!opening, pos, end: pos + r.token.length, jsxId: opening ? idOf(opening) : null, parentJsxId });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return records;
}

export function* walkSource(root, { includeTests = false } = {}) {
  const src = join(root, 'src');
  function* rec(dir) {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      const s = statSync(full);
      if (s.isDirectory()) { if (e === 'node_modules' || e === 'locales') continue; yield* rec(full); }
      else if (['.ts', '.tsx'].includes(extname(e)) && !e.endsWith('.d.ts') && (includeTests || !/\.(test|spec)\.tsx?$/.test(e))) yield full;
    }
  }
  yield* rec(src);
}

export function scanProject(root, opts) {
  const all = [];
  for (const f of walkSource(root, opts)) {
    const text = readFileSync(f, 'utf8');
    if (text.includes('rounded')) all.push(...scanSource(text, relative(root, f).split(sep).join('/')));
  }
  return all;
}
