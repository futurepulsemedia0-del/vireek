#!/usr/bin/env node
// scripts/a11y/codemod-icons.mjs
//
// Phase 3 codemod. For every lucide icon element:
//   size={14} / className="h-4 w-4" / size-4   ->   className="icon-sm"   (token class, see src/index.css)
//   strokeWidth={N}                            ->   removed (stroke is constant via the token class)
// Display icons (> 24px) are left untouched. Dynamic / responsive / conflicting cases are SKIPPED and reported.
// Second pass (--targets): adds `hit-area` (+ `relative` when needed) to icon-only native <button>/<a>.
//
//   node scripts/a11y/codemod-icons.mjs [--write] [--targets] [--only <path-substring>] [--report out.json]
// Default is a dry run. Idempotent: running twice changes nothing.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import ts from 'typescript';
import { parse, lucideNames, openingOf, tagOf, attrMap, literalsIn, isIconOnly, splitTokens, SIZE_TOKEN, hasSpread } from './ast-lib.mjs';
import { tokenForPx, tokenForTw } from './icon-scale.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const POSITIONED = /^(absolute|fixed|sticky|relative)$/;

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { if (e !== 'node_modules') yield* walk(full); }
    else if (extname(e) === '.tsx' && !/\.(test|spec)\.tsx$/.test(e)) yield full;
  }
}

/** Rewrite one class segment: drop the given tokens (+1 adjacent whitespace), optionally add a token. Open edges (touching ${}) are never edited. */
function editSegment(seg, kind, drop, add) {
  const parts = splitTokens(seg);
  const leftOpen = kind === 'middle' || kind === 'tail';
  const rightOpen = kind === 'head' || kind === 'middle';
  const removed = [];
  parts.forEach((p, i) => {
    if (i % 2 === 1 || p === '') return;
    const first = i === 0 || (i === 2 && parts[0] === '');
    const last = i === parts.length - 1 || (i === parts.length - 2 && parts[parts.length - 1] === '');
    if ((first && leftOpen) || (last && rightOpen)) return;
    if (drop(p)) { removed.push(p); parts[i] = null; if (parts[i + 1] !== undefined && parts[i + 1] !== null && i + 1 < parts.length) parts[i + 1] = null; else if (i > 0 && parts[i - 1] != null) parts[i - 1] = null; }
  });
  let out = parts.filter((p) => p !== null).join('');
  if (add) out = kind === 'head' ? `${add} ${out}` : kind === 'plain' || kind === 'tail' ? (out.trim() ? `${out.replace(/\s+$/, '')} ${add}` : add) : out;
  return { out, removed };
}

export const newStats = () => ({ files: 0, filesChanged: 0, changed: 0, hitArea: 0, icons: {}, skipped: {}, preExistingSyntaxErrors: [], syntaxErrorsAfter: [] });

export function transform(text, file, opts, stats) {
  const sf = parse(text, file);
  const lucide = lucideNames(sf);
  if (lucide.size === 0) return text;
  const edits = [];
  const skip = (why) => { stats.skipped[why] = (stats.skipped[why] ?? 0) + 1; };

  const visit = (n) => {
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      const tag = n.tagName.getText();
      if (lucide.has(tag)) handleIcon(n);
    }
    if (opts.targets && ts.isJsxElement(n)) handleTarget(n);
    ts.forEachChild(n, visit);
  };

  function handleIcon(op) {
    const am = attrMap(op);
    const cls = am.get('className');
    const size = am.get('size');
    const stroke = am.get('strokeWidth');
    if (hasSpread(op)) return skip('spread-props');
    const lits = cls?.initializer ? literalsIn(cls.initializer) : [];
    const already = lits.some((l) => /\bicon-(micro|sm|md|lg)\b/.test(l.node.text ?? ''));
    // collect unprefixed size tokens from class literals
    const found = [];
    for (const l of lits) for (const t of (l.node.text ?? '').split(/\s+/)) { const m = SIZE_TOKEN.exec(t); if (m) found.push({ axis: m[1], n: m[2] }); }
    const prefixedSize = lits.some((l) => /(^|\s)[a-z0-9-]+:(h|w|size)-\d/.test(l.node.text ?? ''));
    if (prefixedSize) return skip('responsive-size-class');
    let token = null;
    if (found.length) {
      const hs = found.filter((f) => f.axis !== 'w'), ws = found.filter((f) => f.axis !== 'h');
      const hset = new Set(hs.map((f) => f.n)), wset = new Set(ws.map((f) => f.n));
      if (hset.size > 1 || wset.size > 1 || (hset.size === 1 && wset.size === 1 && [...hset][0] !== [...wset][0]) || hset.size + wset.size === 0 || hset.size !== wset.size) return skip('conflicting-or-nonsquare-class');
      token = tokenForTw([...hset][0]);
      if (!token) return skip('display-or-large-class');
    } else if (size) {
      const init = size.initializer; const expr = init && ts.isJsxExpression(init) ? init.expression : init;
      if (!expr || !ts.isNumericLiteral(expr)) return skip('dynamic-size');
      token = tokenForPx(Number(expr.text));
      if (!token) return skip('display-size');
    } else if (already) return; else return; // no explicit size: lucide default 24 -> leave
    if (cls && lits.length === 0) return skip('dynamic-className');
    if (cls?.initializer && !ts.isStringLiteral(cls.initializer) && !(ts.isJsxExpression(cls.initializer) && cls.initializer.expression && /[?:|&(`]/.test(cls.initializer.expression.getText()) === false && !ts.isStringLiteral(cls.initializer.expression) && !ts.isNoSubstitutionTemplateLiteral(cls.initializer.expression))) {
      // allowed: string literal, or expression containing literals (cn(), template, ternary). A bare identifier has no literals -> handled by lits.length===0 above.
    }
    const add = `icon-${token}`;
    // 1) class edits
    if (cls && !already) {
      let inserted = false;
      const target = lits.find((l) => l.kind === 'plain' && found.length && (l.node.text ?? '').split(/\s+/).some((t) => SIZE_TOKEN.test(t))) ?? lits.find((l) => l.kind === 'plain') ?? lits.find((l) => l.kind === 'head');
      for (const l of lits) {
        const seg = l.node.text ?? '';
        const isTarget = l === target;
        const { out } = editSegment(seg, l.kind, (t) => SIZE_TOKEN.test(t), isTarget ? add : null);
        inserted ||= isTarget;
        if (out !== seg) edits.push({ start: l.start, end: l.end, text: out });
      }
      if (!inserted) return skip('no-safe-literal-for-token');
    } else if (!cls && !already) {
      edits.push({ start: op.tagName.getEnd(), end: op.tagName.getEnd(), text: ` className="${add}"` });
    }
    // 2) drop size / strokeWidth attrs
    if (size) edits.push({ start: size.getFullStart(), end: size.getEnd(), text: '' });
    if (stroke) {
      const init = stroke.initializer; const expr = init && ts.isJsxExpression(init) ? init.expression : init;
      if (expr && (ts.isNumericLiteral(expr) || ts.isStringLiteral(expr))) edits.push({ start: stroke.getFullStart(), end: stroke.getEnd(), text: '' });
      else skip('dynamic-strokeWidth-kept');
    }
    stats.icons[token] = (stats.icons[token] ?? 0) + 1;
    stats.changed++;
  }

  function handleTarget(el) {
    const tag = tagOf(el);
    if (tag !== 'button' && tag !== 'a') return;
    if (!isIconOnly(el, lucide)) return;
    const op = openingOf(el); const am = attrMap(op); const cls = am.get('className');
    if (hasSpread(op)) return skip('target-spread-props');
    const lits = cls?.initializer ? literalsIn(cls.initializer) : [];
    const text = lits.map((l) => l.node.text ?? '').join(' ');
    if (/\bhit-area\b/.test(text)) return;
    if (/\boverflow-(hidden|clip)\b/.test(text)) return skip('target-overflow-hidden');
    if (cls && lits.length === 0) return skip('target-dynamic-className');
    const positioned = text.split(/\s+/).some((t) => POSITIONED.test(t.replace(/^[a-z0-9-]+:/, '')));
    const add = positioned ? 'hit-area' : 'relative hit-area';
    if (!cls) edits.push({ start: op.tagName.getEnd(), end: op.tagName.getEnd(), text: ` className="${add}"` });
    else {
      const l = lits.find((x) => x.kind === 'plain') ?? lits.find((x) => x.kind === 'head');
      if (!l) return skip('target-no-safe-literal');
      const seg = l.node.text ?? '';
      edits.push({ start: l.start, end: l.end, text: l.kind === 'head' ? `${add} ${seg}` : `${seg.replace(/\s+$/, '')} ${add}`.trim() });
    }
    stats.hitArea++;
  }

  visit(sf);
  // apply edits back-to-front; drop overlapping edits defensively
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text, lastStart = Infinity;
  for (const e of edits) { if (e.end > lastStart) continue; out = out.slice(0, e.start) + e.text + out.slice(e.end); lastStart = e.start; }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const opts = { write: args.includes('--write'), targets: args.includes('--targets') };
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const stats = newStats();
  const SRC = join(ROOT, 'src');
  const parseErrors = (t, f) => parse(t, f).parseDiagnostics.length;
  for (const f of walk(SRC)) {
    if (only && !f.includes(only)) continue;
    const before = readFileSync(f, 'utf8');
    stats.files++;
    // Never touch a file that does not parse to begin with (the codemod cannot reason about a broken AST).
    if (parseErrors(before, f) > 0) { stats.preExistingSyntaxErrors.push(relative(ROOT, f)); continue; }
    const after = transform(before, f, opts, stats);
    if (after === before) continue;
    // safety net: the output must still parse with zero syntax errors, otherwise the file is left untouched
    if (parseErrors(after, f) > 0) { stats.syntaxErrorsAfter.push(relative(ROOT, f)); continue; }
    stats.filesChanged++;
    if (opts.write) writeFileSync(f, after);
  }
  console.log(JSON.stringify(stats, null, 2));
  if (args.includes('--report')) writeFileSync(args[args.indexOf('--report') + 1], JSON.stringify(stats, null, 2));
  if (stats.syntaxErrorsAfter.length) process.exit(1);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
