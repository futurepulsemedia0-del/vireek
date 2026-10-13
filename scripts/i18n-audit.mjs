#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  i18n audit — finds hard-coded user-facing strings                   */
/*                                                                      */
/*    node scripts/i18n-audit.mjs                 top 40 files          */
/*    node scripts/i18n-audit.mjs --top 100                             */
/*    node scripts/i18n-audit.mjs src/pages/AccountPage.tsx --verbose   */
/*                                                                      */
/*  Uses the TypeScript parser (no regex guessing). It counts:          */
/*   - JSX text, e.g. <h1>My Account</h1>                               */
/*   - placeholder/title/aria-label/alt/label string attributes         */
/*   - toast('…') messages                                              */
/*  Files with 0 findings are fully extracted.                          */
/* ------------------------------------------------------------------ */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const topIdx = args.indexOf('--top');
const top = topIdx >= 0 ? Number(args[topIdx + 1]) : 40;
const targets = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--top');

const ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label', 'aria-description']);
const hasLetters = (s) => /[A-Za-z]{2,}/.test(s);
// Attribute values like title="btn-primary" are identifiers, not copy.
const looksLikeCopy = (s) => hasLetters(s) && !/^[\w./:#@-]+$/.test(s.trim());

function* walk(p) {
  const st = fs.statSync(p);
  if (st.isFile()) { if (/\.tsx$/.test(p) && !/\.test\./.test(p)) yield p; return; }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    yield* walk(path.join(p, e.name));
  }
}

function audit(file) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const add = (node, kind, text) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    found.push({ line: line + 1, kind, text: text.trim().replace(/\s+/g, ' ').slice(0, 90) });
  };
  const visit = (n) => {
    if (ts.isJsxText(n)) {
      const t = n.getText();
      if (hasLetters(t) && !/^\s*[{}&;·•|—–-]+\s*$/.test(t)) add(n, 'text', t);
    } else if (ts.isJsxAttribute(n) && ATTRS.has(n.name.getText()) && n.initializer && ts.isStringLiteral(n.initializer)) {
      if (looksLikeCopy(n.initializer.text)) add(n, `attr:${n.name.getText()}`, n.initializer.text);
    } else if (ts.isCallExpression(n) && n.expression.getText() === 'toast' && n.arguments[0]) {
      const a = n.arguments[0];
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) || ts.isTemplateExpression(a)) add(a, 'toast', a.getText());
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { file, found, usesT: /useTranslation\(/.test(src) };
}

const results = [];
for (const t of targets.length ? targets : ['src/pages', 'src/components']) {
  for (const f of walk(t)) results.push(audit(f));
}
results.sort((a, b) => b.found.length - a.found.length);

const withStrings = results.filter((r) => r.found.length > 0);
console.log(`Scanned ${results.length} files • ${withStrings.length} still have hard-coded strings • ${results.length - withStrings.length} clean`);
console.log(`Total hard-coded strings: ${withStrings.reduce((n, r) => n + r.found.length, 0)}\n`);
for (const r of withStrings.slice(0, verbose ? withStrings.length : top)) {
  console.log(`${String(r.found.length).padStart(4)}  ${r.file}${r.usesT ? '  (partly translated)' : ''}`);
  if (verbose) r.found.forEach((f) => console.log(`        L${f.line} [${f.kind}] ${f.text}`));
}
