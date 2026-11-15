#!/usr/bin/env node
// scripts/a11y/codemod-names.mjs
//
// Gives every icon-only interactive element that has NO accessible name an `aria-label`, derived from its icon.
// Mirrors the definition in audit-targets.mjs (targets.iconOnlyNoName): a native <button>/<a>/<summary>, <Button>,
// <IconButton> or role=button/menuitem/tab/switch/link whose only content is a lucide icon (or <Icon>), with no
// aria-label / aria-labelledby / title (IconButton: `label`).
//
//   node scripts/a11y/codemod-names.mjs                   # dry run, prints a summary + every unmapped icon
//   node scripts/a11y/codemod-names.mjs --write           # apply
//   node scripts/a11y/codemod-names.mjs --only src/pages  # limit to a path substring
//   node scripts/a11y/codemod-names.mjs --report out.json
//
// Guarantees: AST-based (TypeScript), idempotent, never touches an element that spreads props ({...props} may carry
// a name), skips icons it has no confident label for (reported, never guessed), and leaves a file untouched if the
// output would not parse. Labels are generic English verbs; refine contextual ones ("Delete budget") by hand.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import ts from 'typescript';
import { parse, openingOf, tagOf, attrMap, hasSpread } from './ast-lib.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;

/** Canonical lucide name -> accessible name. Only icons with an unambiguous action meaning are listed. */
export const LABELS = Object.freeze({
  X: 'Close', XCircle: 'Dismiss', CircleX: 'Dismiss', XSquare: 'Close', SquareX: 'Close',
  Trash: 'Delete', Trash2: 'Delete',
  Pencil: 'Edit', PencilLine: 'Edit', Edit: 'Edit', Edit2: 'Edit', Edit3: 'Edit', SquarePen: 'Edit', PenLine: 'Edit', FilePen: 'Edit',
  Plus: 'Add', PlusCircle: 'Add', CirclePlus: 'Add', Minus: 'Remove', MinusCircle: 'Remove', CircleMinus: 'Remove',
  Copy: 'Copy', Clipboard: 'Copy', ClipboardCopy: 'Copy', Check: 'Confirm', CheckCircle: 'Confirm', CircleCheck: 'Confirm',
  ChevronDown: 'Expand', ChevronUp: 'Collapse', ChevronLeft: 'Previous', ChevronRight: 'Next',
  ChevronsLeft: 'First', ChevronsRight: 'Last', ArrowLeft: 'Back', ArrowRight: 'Next', ArrowUp: 'Move up', ArrowDown: 'Move down',
  MoreHorizontal: 'More actions', MoreVertical: 'More actions', Ellipsis: 'More actions', EllipsisVertical: 'More actions',
  Settings: 'Settings', Settings2: 'Settings', SlidersHorizontal: 'Adjust settings',
  RefreshCw: 'Refresh', RefreshCcw: 'Refresh', RotateCw: 'Refresh', RotateCcw: 'Undo',
  Download: 'Download', Upload: 'Upload', Search: 'Search',
  Eye: 'Show', EyeOff: 'Hide', ExternalLink: 'Open in new tab',
  Bell: 'Notifications', Info: 'More information', HelpCircle: 'Help', CircleHelp: 'Help',
  Send: 'Send', Play: 'Play', Pause: 'Pause', Square: 'Stop', Save: 'Save', Printer: 'Print',
  Share: 'Share', Share2: 'Share', Maximize: 'Expand', Maximize2: 'Expand', Minimize: 'Collapse', Minimize2: 'Collapse',
  Filter: 'Filter', Link: 'Copy link', Link2: 'Copy link', Menu: 'Open menu', Star: 'Favorite',
  Mic: 'Microphone', MicOff: 'Mute microphone', Volume2: 'Sound on', VolumeX: 'Sound off', Phone: 'Call', Mail: 'Email',
  Archive: 'Archive', Undo: 'Undo', Undo2: 'Undo', Redo: 'Redo', Redo2: 'Redo', LogOut: 'Sign out',
});

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) { if (e !== 'node_modules') yield* walk(full); }
    else if (extname(e) === '.tsx' && !/\.(test|spec)\.tsx$/.test(e)) yield full;
  }
}

/** local binding -> imported lucide name (handles `TriangleAlert as AlertTriangle`). */
function lucideImports(sf) {
  const map = new Map();
  sf.forEachChild((n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === 'lucide-react'
      && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) {
      for (const el of n.importClause.namedBindings.elements) map.set(el.name.text, (el.propertyName ?? el.name).text);
    }
  });
  return map;
}

const NATIVE = new Set(['button', 'a', 'summary']);
const COMPONENTS = new Set(['Button', 'IconButton']);
const ROLES = new Set(['button', 'menuitem', 'tab', 'switch', 'link']);

/** The single icon child of an icon-only element: { local } for <Trash2/>, { local } for <Icon icon={Trash2}/>. */
function soleIcon(el, lucide) {
  if (!ts.isJsxElement(el)) return null;
  let found = null;
  for (const c of el.children) {
    if (ts.isJsxText(c)) { if (c.text.trim()) return null; continue; }
    if (ts.isJsxExpression(c)) { if (c.expression) return null; continue; }
    if (!(ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c))) return null;
    const t = tagOf(c);
    let local = null;
    if (lucide.has(t)) local = t;
    else if (t === 'Icon') {
      const a = attrMap(openingOf(c)).get('icon');
      const ex = a?.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : null;
      if (ex && ts.isIdentifier(ex) && lucide.has(ex.text)) local = ex.text;
    }
    if (!local || found) return null; // not an icon, or more than one icon
    found = local;
  }
  return found;
}

export function transform(text, file, stats) {
  const sf = parse(text, file);
  const lucide = lucideImports(sf);
  if (lucide.size === 0) return text;
  const edits = [];
  const visit = (n) => {
    if (ts.isJsxElement(n)) {
      const opening = n.openingElement;
      const tag = tagOf(n);
      const am = attrMap(opening);
      const roleAttr = am.get('role')?.initializer;
      const role = roleAttr && ts.isStringLiteral(roleAttr) ? roleAttr.text : null;
      const interactive = NATIVE.has(tag) || COMPONENTS.has(tag) || (role && ROLES.has(role));
      if (interactive) {
        const named = am.has('aria-label') || am.has('aria-labelledby') || am.has('title') || (tag === 'IconButton' && am.has('label'));
        const local = named ? null : soleIcon(n, lucide);
        if (local) {
          if (hasSpread(opening)) stats.skipped.spread = (stats.skipped.spread ?? 0) + 1;
          else {
            const label = LABELS[lucide.get(local)];
            if (!label) stats.unmapped[lucide.get(local)] = (stats.unmapped[lucide.get(local)] ?? 0) + 1;
            else {
              const attr = tag === 'IconButton' ? `label="${label}"` : `aria-label="${label}"`;
              edits.push({ at: opening.tagName.getEnd(), text: ` ${attr}` });
              stats.fixed++;
            }
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  edits.sort((a, b) => b.at - a.at);
  let out = text;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const stats = { files: 0, filesChanged: 0, fixed: 0, unmapped: {}, skipped: {}, syntaxErrorsAfter: [] };
  for (const f of walk(join(ROOT, 'src'))) {
    if (only && !f.includes(only)) continue;
    const before = readFileSync(f, 'utf8');
    stats.files++;
    if (parse(before, f).parseDiagnostics.length > 0) continue; // never touch a file that does not parse
    const after = transform(before, f, stats);
    if (after === before) continue;
    if (parse(after, f).parseDiagnostics.length > 0) { stats.syntaxErrorsAfter.push(relative(ROOT, f)); continue; }
    stats.filesChanged++;
    if (write) writeFileSync(f, after);
  }
  console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', ...stats }, null, 2));
  if (args.includes('--report')) writeFileSync(args[args.indexOf('--report') + 1], JSON.stringify(stats, null, 2));
  if (stats.syntaxErrorsAfter.length) process.exit(1);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
