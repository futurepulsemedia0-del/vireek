#!/usr/bin/env node
// scripts/dev/syntax-scan.mjs — parse every .ts/.tsx under src/ and list files with SYNTAX errors
// (the kind a stray pasted placeholder or half-applied edit leaves behind). Uses the project's own `typescript`.
//   node scripts/dev/syntax-scan.mjs          # list
//   node scripts/dev/syntax-scan.mjs --detail # first error line per file
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const detail = process.argv.includes('--detail');
const bad = [];
let n = 0;
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) { if (e !== 'node_modules') walk(f); continue; }
    if (!/\.(ts|tsx)$/.test(e)) continue;
    n += 1;
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.ES2022, false, e.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const d = sf.parseDiagnostics;
    if (d.length) {
      const p = sf.getLineAndCharacterOfPosition(d[0].start);
      bad.push(`${f}  (${d.length})${detail ? `  L${p.line + 1}: ${ts.flattenDiagnosticMessageText(d[0].messageText, '\n')}` : ''}`);
    }
  }
})('src');
console.log(`${n} files scanned, ${bad.length} with syntax errors`);
bad.forEach((b) => console.log(' - ' + b));
process.exit(bad.length ? 1 : 0);
