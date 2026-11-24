#!/usr/bin/env node
// Dark-pattern checker. Run: node scripts/check-dark-patterns.mjs [--json]. Exit 1 on any non-allowlisted finding.
// Rules and rationale: docs/design/dark-patterns.md. Allowlist (each entry needs a reason): scripts/dark-patterns.allowlist.json
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { scanFiles } from './lib/darkPatterns.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) { if (!['node_modules', 'dist', '.git'].includes(e)) walk(p); }
    else if (/\.(tsx|ts|json)$/.test(e)) files.push({ path: relative(ROOT, p).split(sep).join('/'), text: readFileSync(p, 'utf8') });
  }
})(join(ROOT, 'src'));

const allowPath = join(ROOT, 'scripts/dark-patterns.allowlist.json');
const allowlist = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')) : [];
const bad = allowlist.filter((a) => !a.reason || String(a.reason).trim().length < 20);
if (bad.length) { console.error('Allowlist entries need a real reason (20+ chars):', JSON.stringify(bad)); process.exit(2); }

const { findings, suppressed } = scanFiles(files, allowlist);
if (process.argv.includes('--json')) console.log(JSON.stringify({ findings, suppressed }, null, 2));
else {
  for (const f of findings) console.log(`${f.rule} ${f.path}:${f.line}  ${f.message}${f.match ? `  [${f.match}]` : ''}`);
  console.log(`dark-patterns: ${findings.length} finding(s), ${suppressed.length} allowlisted, ${files.length} files scanned`);
}
process.exit(findings.length ? 1 : 0);
