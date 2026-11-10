import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['src', 'worker', 'supabase/functions', 'packages'];
const skip = new Set(['node_modules', 'dist', '.git']);
const bad = [];
let total = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(name)) check(p);
  }
}

function check(file) {
  total++;
  const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
  const errs = sf.parseDiagnostics || [];
  if (errs.length) {
    const first = errs[0];
    const { line } = sf.getLineAndCharacterOfPosition(first.start);
    bad.push(`${file}:${line + 1}  TS${first.code}  ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}  (${errs.length})`);
  }
}

for (const r of roots) { try { walk(r); } catch {} }
console.log(`parsed: ${total}  broken: ${bad.length}\n`);
console.log(bad.join('\n'));
