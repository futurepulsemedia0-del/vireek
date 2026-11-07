#!/usr/bin/env node
// scripts/a11y/audit-targets.mjs
//
// Phase 0 (static half): AST audit of icon sizes + interactive targets in src/**/*.tsx.
// Uses the TypeScript compiler API (already a devDependency) — no regex guessing on JSX.
//
//   node scripts/a11y/audit-targets.mjs              # print summary
//   node scripts/a11y/audit-targets.mjs --json out.json
//   node scripts/a11y/audit-targets.mjs --check      # ratchet vs scripts/a11y/targets-baseline.json (CI)
//   node scripts/a11y/audit-targets.mjs --write-baseline
//
// Reported metrics:
//   icons.sizeProp / icons.sizeClass : every lucide element, bucketed by how its size is set
//   icons.offScale                    : icons whose size is not on the token scale (12/16/20/24) and is not display (>24)
//   targets.iconOnlyNoName            : icon-only <button>/<a>/<Button>/role=button with NO accessible name (hard fail)
//   targets.iconOnlyRaw               : icon-only native <button> that should be <IconButton>
//   targets.squareSmall               : any element with equal h-N w-N (N = 6..9) = 24..36px (not all interactive)

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import ts from 'typescript';
import { parse as parseTsx } from './ast-lib.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const BASELINE = join(ROOT, 'scripts/a11y/targets-baseline.json');

export const SCALE_PX = [12, 16, 20, 24];
const SQUARE_SMALL = new Set(['6', '7', '8', '9']);
const NATIVE_INTERACTIVE = new Set(['button', 'a', 'summary']);
const BUTTON_COMPONENTS = new Set(['Button', 'IconButton']);
const BUTTON_ROLES = new Set(['button', 'menuitem', 'tab', 'switch', 'link']);

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { if (e !== 'node_modules') yield* walk(full); }
    else if (extname(e) === '.tsx' && !/\.(test|spec)\.tsx$/.test(e)) yield full;
  }
}

const attrName = (a) => (ts.isJsxAttribute(a) ? a.name.getText() : null);
function attrMap(el) {
  const m = new Map();
  for (const a of el.attributes.properties) { const n = attrName(a); if (n) m.set(n, a); }
  return m;
}
function staticStrings(node) {
  const out = [];
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) { out.push(n.head.text); n.templateSpans.forEach((s) => out.push(s.literal.text)); }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out.join(' ');
}
const classText = (a) => (a && a.initializer ? staticStrings(a.initializer) : '');
function sizeClass(cls) {
  // returns {h,w} tokens like "4" or "3.5" if both present and equal-ish; supports size-N
  const sz = /(?:^|\s)size-([0-9.]+)(?=\s|$)/.exec(cls);
  if (sz) return { h: sz[1], w: sz[1] };
  const h = /(?:^|\s)h-([0-9.]+)(?=\s|$)/.exec(cls);
  const w = /(?:^|\s)w-([0-9.]+)(?=\s|$)/.exec(cls);
  return h && w ? { h: h[1], w: w[1] } : null;
}
function numericSizeProp(a) {
  if (!a || !a.initializer) return null;
  const init = a.initializer;
  const expr = ts.isJsxExpression(init) ? init.expression : init;
  if (expr && ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr && ts.isStringLiteral(expr) && /^\d+$/.test(expr.text)) return Number(expr.text);
  return undefined; // dynamic
}

export function auditSource(text, fileName = 'x.tsx') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lucide = new Set();
  sf.forEachChild((n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === 'lucide-react' && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) {
      n.importClause.namedBindings.elements.forEach((e) => lucide.add(e.name.text));
    }
  });
  const r = { icons: [], targets: [], squares: [] };
  const lc = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const isIconEl = (n) => {
    const t = ts.isJsxElement(n) ? n.openingElement.tagName.getText() : ts.isJsxSelfClosingElement(n) ? n.tagName.getText() : '';
    return lucide.has(t) || t === 'Icon';
  };
  const nameOf = (el) => (ts.isJsxElement(el) ? el.openingElement.tagName.getText() : el.tagName.getText());

  const iconOnlyChildren = (n) => {
    if (!ts.isJsxElement(n)) return false;
    let icon = false;
    for (const c of n.children) {
      if (ts.isJsxText(c)) { if (c.text.trim()) return false; continue; }
      if (ts.isJsxExpression(c)) { if (c.expression) return false; continue; }
      if ((ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c))) {
        if (isIconEl(c)) { icon = true; continue; }
        const am = attrMap(ts.isJsxElement(c) ? c.openingElement : c);
        if (/\bsr-only\b/.test(classText(am.get('className')))) return false; // has a visually hidden name
        return false; // any other element: not provably icon-only
      }
    }
    return icon;
  };

  const visit = (n) => {
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxElement(n)) {
      const opening = ts.isJsxElement(n) ? n.openingElement : n;
      const tag = nameOf(n);
      const am = attrMap(opening);
      const cls = classText(am.get('className'));

      if (lucide.has(tag)) {
        const sp = numericSizeProp(am.get('size'));
        const sc = sizeClass(cls);
        r.icons.push({ line: lc(n), tag, sizeProp: am.has('size') ? (sp ?? 'dynamic') : null, sizeClass: sc ? `${sc.h}/${sc.w}` : null, strokeWidth: am.has('strokeWidth'), tokenClass: /\bicon-(micro|sm|md|lg)\b/.test(cls) });
      }
      const sc = sizeClass(cls);
      if (sc && sc.h === sc.w && SQUARE_SMALL.has(sc.h)) r.squares.push({ line: lc(n), tag, cls: `h-${sc.h} w-${sc.w}` });

      const role = am.get('role')?.initializer && ts.isStringLiteral(am.get('role').initializer) ? am.get('role').initializer.text : null;
      const interactive = NATIVE_INTERACTIVE.has(tag) || BUTTON_COMPONENTS.has(tag) || (role && BUTTON_ROLES.has(role));
      if (interactive && iconOnlyChildren(n) || (BUTTON_COMPONENTS.has(tag) && am.has('iconOnly'))) {
        const named = am.has('aria-label') || am.has('aria-labelledby') || am.has('title') || (tag === 'IconButton' && am.has('label'));
        r.targets.push({ line: lc(n), tag, named, raw: tag === 'button' || tag === 'a' || tag === 'Button' });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return r;
}

function summarize() {
  const files = [...walk(SRC)];
  const S = { files: files.length, icons: { total: 0, sizeProp: {}, sizeClass: {}, offScale: 0, onTokenClass: 0, dynamic: 0, strokeWidthProps: 0 }, targets: { iconOnly: 0, iconOnlyNoName: 0, iconOnlyRaw: 0, squareSmall: 0 }, offenders: { noName: [], offScale: {} }, preExistingSyntaxErrors: [] };
  const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
  for (const f of files) {
    const rel = relative(ROOT, f);
    const text = readFileSync(f, 'utf8');
    if (parseTsx(text, f).parseDiagnostics.length > 0) { S.preExistingSyntaxErrors.push(rel); continue; } // cannot be audited reliably
    const r = auditSource(text, f);
    for (const i of r.icons) {
      S.icons.total++;
      if (i.tokenClass) S.icons.onTokenClass++;
      if (i.strokeWidth) S.icons.strokeWidthProps++;
      if (i.sizeProp === 'dynamic') S.icons.dynamic++;
      else if (typeof i.sizeProp === 'number') { bump(S.icons.sizeProp, i.sizeProp); if (!SCALE_PX.includes(i.sizeProp) && i.sizeProp <= 24) S.icons.offScale++; }
      if (i.sizeClass) { bump(S.icons.sizeClass, i.sizeClass); if (/^(3\.5|[0-9.]+)\/\1$/.test(i.sizeClass) && !['3', '4', '5', '6'].includes(i.sizeClass.split('/')[0]) && Number(i.sizeClass.split('/')[0]) <= 6) S.icons.offScale++; }
    }
    for (const t of r.targets) {
      S.targets.iconOnly++;
      if (!t.named) { S.targets.iconOnlyNoName++; S.offenders.noName.push(`${rel}:${t.line}`); }
      if (t.raw) S.targets.iconOnlyRaw++;
    }
    S.targets.squareSmall += r.squares.length;
  }
  return S;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const S = summarize();
  const args = process.argv.slice(2);
  const view = { ...S, offenders: { noName: S.offenders.noName.slice(0, 20) }, preExistingSyntaxErrors: S.preExistingSyntaxErrors.length };
  if (args.includes('--json')) { writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify(S, null, 2)); }
  if (args.includes('--write-baseline')) {
    writeFileSync(BASELINE, JSON.stringify({ offScale: S.icons.offScale, iconOnlyNoName: S.targets.iconOnlyNoName, iconOnlyRaw: S.targets.iconOnlyRaw, rawSizeProps: Object.values(S.icons.sizeProp).reduce((a, b) => a + b, 0) - S.icons.onTokenClass }, null, 2) + '\n');
    console.log('baseline written');
  }
  if (args.includes('--check')) {
    const b = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
    if (!b) { console.error('No baseline. Run with --write-baseline first.'); process.exit(2); }
    const bad = [];
    if (S.icons.offScale > b.offScale) bad.push(`offScale ${S.icons.offScale} > ${b.offScale}`);
    if (S.targets.iconOnlyNoName > b.iconOnlyNoName) bad.push(`iconOnlyNoName ${S.targets.iconOnlyNoName} > ${b.iconOnlyNoName}`);
    if (S.targets.iconOnlyRaw > b.iconOnlyRaw) bad.push(`iconOnlyRaw ${S.targets.iconOnlyRaw} > ${b.iconOnlyRaw}`);
    if (bad.length) { console.error('Target/icon ratchet failed:\n - ' + bad.join('\n - ')); process.exit(1); }
    console.log('ratchet OK');
  } else console.log(JSON.stringify(view, null, 2));
}
