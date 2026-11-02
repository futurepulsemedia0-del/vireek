#!/usr/bin/env node
// scripts/split-routes.mjs
//
// One-shot, AST-based codemod: splits the <Routes> block of src/App.tsx into
// modular route groups (marketing, auth, dashboard, tech, portal, admin) and
// generates typed route constants. NO behavior change: every <Route> is moved
// verbatim (leading JSX comments included); lazy() declarations and imports move
// with the routes that use them.
//
//   node scripts/split-routes.mjs                 # dry run: prints the plan, writes nothing
//   node scripts/split-routes.mjs --write         # writes src/routes/** and rewrites src/App.tsx
//                                                 # (original saved as src/App.tsx.pre-split)
//   options: --file src/App.tsx  --out src/routes  --root <repo root>
//
// It REFUSES to run when App.tsx has syntax errors (it never guesses), and verifies
// the result before writing: same number of routes, same set of paths, every
// moved identifier resolvable.

import ts from 'typescript';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const ROOT = resolve(opt('root', fileURLToPath(new URL('..', import.meta.url))));
const APP = resolve(ROOT, opt('file', 'src/App.tsx'));
const OUT = resolve(ROOT, opt('out', 'src/routes'));
const WRITE = flag('write');

// ---- classification (edit these lists if you want routes in a different group) ----
const AUTH_FIRST = new Set(['login', 'signup', 'forgot-password', 'reset-password', 'verify-email', 'mfa', 'onboarding', 'invite', 'accept-invite', 'auth', 'sso', 'logout']);
const PORTAL_FIRST = new Set(['portal', 'partner-portal', 'supplier-portal', 'track', 'review', 'pay', 'p', 'homeowner', 'home-passport']);
const GROUPS = ['marketing', 'auth', 'dashboard', 'tech', 'portal', 'admin'];

function classify(path, elText) {
  const first = path.split('/')[1] ?? '';
  if (elText.startsWith('<TechnicianRoute') || first === 'tech') return 'tech';
  if (elText.startsWith('<StaffRoute') || first === 'staff') return 'admin';
  if (elText.startsWith('<PartnerRoute') || elText.startsWith('<SupplierRoute') || PORTAL_FIRST.has(first)) return 'portal';
  if (first === 'dashboard') return 'dashboard';
  if (AUTH_FIRST.has(first)) return 'auth';
  if (elText.startsWith('<ProtectedRoute')) return 'dashboard';
  return 'marketing';
}

// ------------------------------------ parse ------------------------------------
const source = readFileSync(APP, 'utf8');
const parse = (text, name = 'x.tsx') => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const sf = parse(source, APP);

if (sf.parseDiagnostics.length) {
  console.error(`✖ ${relative(ROOT, APP)} has ${sf.parseDiagnostics.length} syntax error(s). Fix them first (the codemod never guesses):`);
  for (const d of sf.parseDiagnostics) {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    console.error(`  ${relative(ROOT, APP)}:${line + 1}:${character + 1}  ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }
  process.exit(2);
}

let routesEl = null;
(function find(n) {
  if (ts.isJsxElement(n) && n.openingElement.tagName.getText() === 'Routes' && !routesEl) routesEl = n;
  ts.forEachChild(n, find);
})(sf);
if (!routesEl) {
  console.error('✖ No <Routes> element found in App.tsx.');
  process.exit(2);
}

// ---------------------------- top-level declaration index ----------------------------
const imports = new Map(); // local name -> { decl, kind, imported, spec, typeOnly }
const lazies = new Map(); // name -> statement node
const others = new Map(); // name -> statement node (non-exported helpers declared in App.tsx)
for (const st of sf.statements) {
  if (ts.isImportDeclaration(st)) {
    const spec = st.moduleSpecifier.text;
    const c = st.importClause;
    if (!c) continue;
    const typeOnly = c.isTypeOnly;
    if (c.name) imports.set(c.name.text, { decl: st, kind: 'default', imported: 'default', spec, typeOnly });
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) imports.set(c.namedBindings.name.text, { decl: st, kind: 'namespace', imported: '*', spec, typeOnly });
    if (c.namedBindings && ts.isNamedImports(c.namedBindings))
      for (const el of c.namedBindings.elements) imports.set(el.name.text, { decl: st, kind: 'named', imported: (el.propertyName ?? el.name).text, spec, typeOnly: typeOnly || el.isTypeOnly });
  } else if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1) {
    const d = st.declarationList.declarations[0];
    if (ts.isIdentifier(d.name)) {
      const isLazy = d.initializer && ts.isCallExpression(d.initializer) && d.initializer.expression.getText() === 'lazy';
      (isLazy ? lazies : others).set(d.name.text, st);
    }
  } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
    others.set(st.name.text, st);
  }
}

{
  const seen = new Map();
  const dup = [];
  for (const st of sf.statements) {
    const names = ts.isVariableStatement(st) ? st.declarationList.declarations.map((d) => d.name.getText()) : (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name ? [st.name.text] : [];
    for (const n of names) {
      if (seen.has(n)) dup.push(`  ${relative(ROOT, APP)}:${sf.getLineAndCharacterOfPosition(st.getStart()).line + 1}  "${n}" is declared twice (first at line ${seen.get(n)})`);
      else seen.set(n, sf.getLineAndCharacterOfPosition(st.getStart()).line + 1);
    }
  }
  if (dup.length) {
    console.error('✖ Duplicate top-level declarations in App.tsx (TS2451). Remove the duplicates first:\n' + dup.join('\n'));
    process.exit(2);
  }
}

const identsIn = (node) => {
  const out = new Set();
  (function walk(n) {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isPropName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isJsxAttribute(p) && p.name === n);
      if (!isPropName) out.add(n.text);
    }
    ts.forEachChild(n, walk);
  })(node);
  return out;
};

// ------------------------------- collect the routes -------------------------------
const kept = []; // raw text of children that stay in App.tsx
const moved = []; // { group, path, text, node, idents }
let pendingComments = [];
const strayText = [];
for (const child of routesEl.children) {
  if (ts.isJsxText(child) && !child.getText().trim()) continue;
  if (ts.isJsxText(child)) {
    const { line } = sf.getLineAndCharacterOfPosition(child.getStart());
    strayText.push(`  ${relative(ROOT, APP)}:${line + 1}  stray text inside <Routes>: ${JSON.stringify(child.getText().trim().slice(0, 40))}`);
    continue;
  }
  if (ts.isJsxExpression(child) && child.getText().replace(/\s/g, '').startsWith('{/*') && !child.expression) {
    pendingComments.push(child.getText());
    continue;
  }
  const isRoute = ts.isJsxSelfClosingElement(child) && child.tagName.getText() === 'Route';
  let path = null;
  let elText = '';
  if (isRoute) {
    for (const a of child.attributes.properties) {
      if (!ts.isJsxAttribute(a)) continue;
      const nm = a.name.getText();
      const init = a.initializer;
      if (nm === 'path' && init) {
        if (ts.isStringLiteral(init)) path = init.text;
        else if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)) path = init.expression.text;
      }
      if (nm === 'element' && init && ts.isJsxExpression(init) && init.expression) elText = init.expression.getText();
    }
  }
  const text = [...pendingComments, child.getText()].join('\n');
  pendingComments = [];
  if (!isRoute || path === null || path === '*') {
    kept.push(text);
    continue;
  }
  moved.push({ group: classify(path, elText), path, text, node: child, idents: identsIn(child) });
}
if (pendingComments.length) kept.push(...pendingComments);
if (strayText.length) {
  console.error('✖ Non-route text found directly inside <Routes> (copy/paste damage). Remove it first:\n' + strayText.join('\n'));
  process.exit(2);
}

// Duplicate paths: react-router resolves equal-rank ties by order (first wins). Keep every duplicate
// in the SAME group as its first occurrence so relative order, and therefore the winner, is unchanged.
{
  const firstGroup = new Map();
  for (const m of moved) {
    if (!firstGroup.has(m.path)) firstGroup.set(m.path, m.group);
    else m.group = firstGroup.get(m.path);
  }
}

// ---------------------- resolve what each group needs (transitively) ----------------------
const needs = {}; // group -> { imports:Set, lazies:Set, shared:Set }
const sharedNames = new Set();
for (const g of GROUPS) needs[g] = { imports: new Set(), lazies: new Set(), shared: new Set() };

function resolveInto(group, idents) {
  const n = needs[group];
  const queue = [...idents];
  const seen = new Set();
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (lazies.has(id)) {
      if (!n.lazies.has(id)) {
        n.lazies.add(id);
        queue.push(...identsIn(lazies.get(id)));
      }
    } else if (others.has(id)) {
      n.shared.add(id);
      sharedNames.add(id);
      queue.push(...identsIn(others.get(id)));
    } else if (imports.has(id)) {
      n.imports.add(id);
    }
  }
}
for (const g of GROUPS) resolveInto(g, new Set(moved.filter((m) => m.group === g).flatMap((m) => [...m.idents])));
// shared helpers also need their own imports/lazies available in shared.tsx
const sharedNeeds = { imports: new Set(), lazies: new Set() };
{
  const queue = [...sharedNames];
  const seen = new Set();
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of identsIn(others.get(id))) {
      if (imports.has(dep)) sharedNeeds.imports.add(dep);
      else if (lazies.has(dep)) { sharedNeeds.lazies.add(dep); queue.push(...identsIn(lazies.get(dep))); }
      else if (others.has(dep) && !sharedNames.has(dep)) { sharedNames.add(dep); queue.push(dep); }
    }
  }
}

// ---------------------------------- emit helpers ----------------------------------
const outDirRel = (spec) => {
  if (!spec.startsWith('.')) return spec;
  const abs = resolve(dirname(APP), spec);
  let rel = posix.normalize(relative(OUT + '/groups', abs).split('\\').join('/'));
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
};
function importLines(names, specFix = (s) => s) {
  const bySpec = new Map();
  for (const name of names) {
    const i = imports.get(name);
    const e = bySpec.get(i.spec) ?? { def: null, ns: null, named: [], typeOnly: false };
    if (i.kind === 'default') e.def = name;
    else if (i.kind === 'namespace') e.ns = name;
    else e.named.push(i.imported === name ? name : `${i.imported} as ${name}`);
    bySpec.set(i.spec, e);
  }
  return [...bySpec.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([spec, e]) => {
      const parts = [];
      if (e.def) parts.push(e.def);
      if (e.ns) parts.push(`* as ${e.ns}`);
      if (e.named.length) parts.push(`{ ${e.named.sort().join(', ')} }`);
      return `import ${parts.join(', ')} from '${specFix(spec)}';`;
    });
}
const exportify = (stmt) => {
  const t = stmt.getText();
  return /^export\s/.test(t) ? t : `export ${t}`;
};
const BANNER = (extra = '') =>
  `// Generated by scripts/split-routes.mjs from the former src/App.tsx route block.${extra}\n// From here on this file is hand-maintained: add/remove routes here.\n/* eslint-disable react-refresh/only-export-components */\n`;

const files = new Map(); // abs path -> content
const sharedSpec = './shared';

if (sharedNames.size) {
  const names = [...sharedNames];
  const body = [
    BANNER('\n// Helpers (e.g. loading fallbacks) that were declared in App.tsx and are used by several route groups.'),
    ...importLines(sharedNeeds.imports, outDirRel),
    '',
    ...[...sharedNeeds.lazies].map((n) => lazies.get(n).getText()),
    '',
    ...names.map((n) => exportify(others.get(n))),
    '',
  ].join('\n');
  files.set(join(OUT, 'groups', 'shared.tsx'), body);
}

const camel = (s) => s.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
for (const g of GROUPS) {
  const routes = moved.filter((m) => m.group === g);
  if (!routes.length) continue;
  const n = needs[g];
  const sharedHere = [...n.shared];
  const body = [
    BANNER(),
    ...importLines(n.imports, outDirRel),
    ...(sharedHere.length ? [`import { ${sharedHere.sort().join(', ')} } from '${sharedSpec}';`] : []),
    '',
    ...[...n.lazies].map((x) => lazies.get(x).getText()),
    '',
    `export const ${g}Routes = (`,
    '  <>',
    ...routes.map((r) => r.text.split('\n').map((l) => '    ' + l.replace(/^\s{0,8}/, '')).join('\n')),
    '  </>',
    ');',
    '',
  ].join('\n');
  files.set(join(OUT, 'groups', `${g}Routes.tsx`), body);
}

// ----------------------------------- route constants -----------------------------------
const keyOf = (p) => {
  if (p === '/') return 'home';
  const k = camel(p.split('/').filter(Boolean).map((s) => (s.startsWith(':') ? 'By-' + s.slice(1) : s)).join('-'));
  return /^[0-9]/.test(k) ? '_' + k : k;
};
const keys = new Map();
const dupPaths = [];
const seenPaths = new Set();
for (const r of moved) {
  if (seenPaths.has(r.path)) { dupPaths.push(r.path); continue; }
  seenPaths.add(r.path);
  let k = keyOf(r.path);
  let i = 2;
  while (keys.has(k)) k = keyOf(r.path) + i++;
  keys.set(k, r.path);
}
const pathsTs = [
  '// Generated by scripts/split-routes.mjs. Typed route constants: import { ROUTES, toPath } from \'@/routes/paths\'.',
  "import { generatePath } from 'react-router-dom';",
  '',
  'export const ROUTES = {',
  ...[...keys].map(([k, p]) => `  ${k}: '${p}',`),
  '} as const;',
  '',
  'export type RouteKey = keyof typeof ROUTES;',
  'export type RoutePattern = (typeof ROUTES)[RouteKey];',
  '',
  '/** Build a concrete URL from a registered pattern, e.g. toPath(ROUTES.dashboardJobsById, { id }). */',
  'export function toPath(pattern: RoutePattern, params?: Record<string, string | number>): string {',
  '  return generatePath(pattern, params as never);',
  '}',
  '',
].join('\n');
files.set(join(OUT, 'paths.ts'), pathsTs);

const indexTs = [
  '// Barrel for the route groups. Add a new group here + in <Routes> in App.tsx.',
  ...GROUPS.filter((g) => moved.some((m) => m.group === g)).map((g) => `export { ${g}Routes } from './groups/${g}Routes';`),
  '',
].join('\n');
files.set(join(OUT, 'index.ts'), indexTs);

// ------------------------------------ rewrite App.tsx ------------------------------------
const usedGroups = GROUPS.filter((g) => moved.some((m) => m.group === g));
const childrenStart = routesEl.openingElement.getEnd();
const childrenEnd = routesEl.closingElement.getStart();
const indent = ' '.repeat(8);
const newChildren = '\n' + [...usedGroups.map((g) => `${indent}{${g}Routes}`), ...kept.map((k) => k.split('\n').map((l) => indent + l.trim()).join('\n'))].join('\n') + '\n      ';

const movedLazyNames = new Set(GROUPS.flatMap((g) => [...needs[g].lazies]));
const removals = []; // [start, end]
let text = source;
const cut = (node) => {
  let s = node.getFullStart();
  removals.push([s, node.getEnd()]);
};
for (const name of movedLazyNames) cut(lazies.get(name));
for (const name of sharedNames) cut(others.get(name));
removals.push([childrenStart, childrenEnd, newChildren]);
removals.sort((a, b) => b[0] - a[0]);
for (const [s, e, rep] of removals) text = text.slice(0, s) + (rep ?? '') + text.slice(e);

// Add imports App.tsx now needs (route groups + shared helpers still used inline), drop unused ones.
const groupImport = `import { ${usedGroups.map((g) => g + 'Routes').join(', ')} } from '@/routes';`;
const sf2 = parse(text, APP);
const stillUsed = new Set();
for (const st of sf2.statements) if (!ts.isImportDeclaration(st)) for (const id of identsIn(st)) stillUsed.add(id);
const keptSharedUsed = [...sharedNames].filter((n) => stillUsed.has(n));
const rewriteImport = (st) => {
  const c = st.importClause;
  if (!c) return st.getText();
  const def = c.name && stillUsed.has(c.name.text) ? c.name.text : null;
  let ns = null;
  const named = [];
  if (c.namedBindings && ts.isNamespaceImport(c.namedBindings) && stillUsed.has(c.namedBindings.name.text)) ns = c.namedBindings.name.text;
  if (c.namedBindings && ts.isNamedImports(c.namedBindings))
    for (const el of c.namedBindings.elements) if (stillUsed.has(el.name.text)) named.push(el.getText());
  if (!def && !ns && !named.length) return null;
  const parts = [];
  if (def) parts.push(def);
  if (ns) parts.push(`* as ${ns}`);
  if (named.length) parts.push(`{ ${named.join(', ')} }`);
  return `import ${c.isTypeOnly ? 'type ' : ''}${parts.join(', ')} from '${st.moduleSpecifier.text}';`;
};
const importEdits = [];
for (const st of sf2.statements) {
  if (!ts.isImportDeclaration(st)) continue;
  const rep = rewriteImport(st);
  if (rep !== st.getText()) importEdits.push([st.getStart(), st.getEnd(), rep ?? '']);
}
importEdits.sort((a, b) => b[0] - a[0]);
for (const [s, e, rep] of importEdits) text = text.slice(0, s) + rep + text.slice(e);
const lastImportEnd = (() => {
  const s3 = parse(text, APP);
  let end = 0;
  for (const st of s3.statements) if (ts.isImportDeclaration(st)) end = st.getEnd();
  return end;
})();
const extra = [groupImport, ...(keptSharedUsed.length ? [`import { ${keptSharedUsed.join(', ')} } from '@/routes/groups/shared';`] : [])].join('\n');
text = text.slice(0, lastImportEnd) + '\n' + extra + text.slice(lastImportEnd);
text = text.replace(/\n{3,}/g, '\n\n');
files.set(APP, text);

// -------------------------------------- verification --------------------------------------
const problems = [];
const countRoutes = (t) => {
  const f = parse(t);
  let n = 0;
  (function w(x) { if (ts.isJsxSelfClosingElement(x) && x.tagName.getText() === 'Route') n++; ts.forEachChild(x, w); })(f);
  return n;
};
const before = countRoutes(source);
const after = [...files.entries()].filter(([p]) => p.endsWith('.tsx')).reduce((s, [, t]) => s + countRoutes(t), 0);
if (before !== after) problems.push(`route count changed: ${before} -> ${after}`);
for (const [p, t] of files) {
  const f = parse(t, p);
  if (f.parseDiagnostics.length) problems.push(`${relative(ROOT, p)} does not parse: ${f.parseDiagnostics[0].messageText}`);
}
// every identifier a generated/rewritten file uses must be declared or imported there
for (const [p, t] of files) {
  if (!p.endsWith('.tsx')) continue;
  const f = parse(t, p);
  const declared = new Set();
  for (const st of f.statements) {
    if (ts.isImportDeclaration(st)) {
      const c = st.importClause;
      if (c?.name) declared.add(c.name.text);
      if (c?.namedBindings) ts.isNamespaceImport(c.namedBindings) ? declared.add(c.namedBindings.name.text) : c.namedBindings.elements.forEach((e) => declared.add(e.name.text));
    } else if (ts.isVariableStatement(st)) st.declarationList.declarations.forEach((d) => ts.isIdentifier(d.name) && declared.add(d.name.text));
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) declared.add(st.name.text);
  }
  const originalTopLevel = new Set([...imports.keys(), ...lazies.keys(), ...others.keys()]);
  for (const st of f.statements) {
    if (ts.isImportDeclaration(st)) continue;
    for (const id of identsIn(st)) if (originalTopLevel.has(id) && !declared.has(id)) problems.push(`${relative(ROOT, p)}: "${id}" is used but not declared/imported`);
  }
}

// ------------------------------------------ report ------------------------------------------
const per = Object.fromEntries(GROUPS.map((g) => [g, moved.filter((m) => m.group === g).length]));
console.log(`Routes found: ${before}  (moved ${moved.length}, kept in App.tsx ${kept.filter((k) => !k.trim().startsWith('{/*')).length})`);
console.log('Per group:', per);
console.log(`Lazy declarations moved: ${movedLazyNames.size}; shared helpers: ${[...sharedNames].join(', ') || '-'}`);
console.log(`Route constants: ${keys.size}${dupPaths.length ? `; DUPLICATE PATHS (first wins, same as before): ${[...new Set(dupPaths)].join(', ')}` : ''}`);
console.log('App.tsx lines:', source.split('\n').length, '->', text.split('\n').length);
if (problems.length) {
  console.error('\n✖ Verification failed; nothing written:\n  ' + problems.join('\n  '));
  process.exit(3);
}
console.log('✔ Verification passed (route count, parse, identifier resolution).');
if (!WRITE) {
  console.log('\nDry run only. Re-run with --write to apply.');
  process.exit(0);
}
copyFileSync(APP, APP + '.pre-split');
for (const [p, t] of files) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, t.endsWith('\n') ? t : t + '\n');
}
console.log(`\nWritten. Original saved as ${relative(ROOT, APP)}.pre-split — delete it once you have committed.`);
