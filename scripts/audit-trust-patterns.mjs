#!/usr/bin/env node
// Report-only audit of the "trust" UI patterns. Run: node scripts/audit-trust-patterns.mjs [--json] [--list]
//  - <EmptyState>: missing primary CTA, missing variant for filter/permission/error contexts, hard-coded English
//  - <ConfirmDialog>: destructive wording without a typed phrase (candidates for the tier policy)
// Exit code is always 0; use the numbers as a ratchet in CI if you want.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules') walk(p); }
    else if (['.tsx'].includes(extname(e)) && !/\.test\.tsx$/.test(e)) files.push(p);
  }
})(join(ROOT, 'src'));

/** Extract every `<Tag ... />` / `<Tag ...>` opening tag, honouring braces and quotes. */
function tags(src, name) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf(`<${name}`, i)) !== -1) {
    const next = src[i + name.length + 1];
    if (next && /[A-Za-z0-9_]/.test(next)) { i += 1; continue; } // e.g. <EmptyStateError
    let depth = 0, q = null, j = i + name.length + 1;
    for (; j < src.length; j += 1) {
      const c = src[j];
      if (q) { if (c === q && src[j - 1] !== '\\') q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    out.push({ text: src.slice(i, j + 1), line: src.slice(0, i).split('\n').length });
    i = j + 1;
  }
  return out;
}

const rep = { empty: [], confirm: [] };
let emptyTotal = 0, confirmTotal = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(ROOT, f);
  if (/components\/(EmptyState|ConfirmDialog)\.tsx$/.test(rel)) continue;
  for (const t of tags(src, 'EmptyState')) {
    emptyTotal += 1;
    const has = (p) => new RegExp(`\\b${p}=`).test(t.text);
    const issues = [];
    if (!has('action') && !has('onClearFilters') && !has('onRetry') && !/variant="no-permission"/.test(t.text)) issues.push('no-primary-cta');
    if (/(filter|search|no results|no matches)/i.test(t.text) && !has('variant')) issues.push('looks-like-no-results-without-variant');
    if (/title="[^"{]+"/.test(t.text) || /title=\{'[^']+'\}/.test(t.text)) issues.push('hardcoded-title');
    if (issues.length) rep.empty.push({ file: rel, line: t.line, issues });
  }
  for (const t of tags(src, 'ConfirmDialog')) {
    confirmTotal += 1;
    const destructive = /(delet|remov|permanent|disconnect|cancel (subscription|plan)|void|purge|erase)/i.test(t.text);
    if (destructive && !/confirmPhrase=/.test(t.text)) rep.confirm.push({ file: rel, line: t.line, issue: 'destructive-wording-without-typed-phrase' });
  }
}

const count = (arr, k) => arr.filter((x) => (x.issues ?? [x.issue]).includes(k)).length;
const summary = {
  emptyStateUsages: emptyTotal,
  emptyStateWithIssues: rep.empty.length,
  noPrimaryCta: count(rep.empty, 'no-primary-cta'),
  noResultsWithoutVariant: count(rep.empty, 'looks-like-no-results-without-variant'),
  hardcodedTitle: count(rep.empty, 'hardcoded-title'),
  confirmDialogUsages: confirmTotal,
  destructiveWithoutTypedPhrase: rep.confirm.length,
};
if (process.argv.includes('--json')) console.log(JSON.stringify({ summary, ...(process.argv.includes('--list') ? rep : {}) }, null, 2));
else {
  console.log(summary);
  if (process.argv.includes('--list')) for (const r of [...rep.empty, ...rep.confirm]) console.log(`${r.file}:${r.line}  ${(r.issues ?? [r.issue]).join(', ')}`);
}
