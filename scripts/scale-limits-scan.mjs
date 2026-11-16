#!/usr/bin/env node
// Static scan: scheduled functions that read a FIXED number of rows (.limit(N), N >= 100) and so
// silently stop processing tenants beyond N. Informational unless --max=<n> (ratchet).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = 'supabase/functions';
const maxArg = process.argv.find((a) => a.startsWith('--max='));
const max = maxArg ? Number(maxArg.slice(6)) : null;
const findings = [];
if (!existsSync(root)) { console.error(`${root} not found — run from the repo root`); process.exit(2); }
for (const dir of readdirSync(root)) {
  if (!/(-tick|-sweep|-runner|-run)$/.test(dir)) continue;
  const f = join(root, dir, 'index.ts');
  if (!existsSync(f)) continue;
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    const m = line.match(/\.limit\((\d+)\)/);
    if (m && Number(m[1]) >= 100) findings.push({ fn: dir, line: i + 1, limit: Number(m[1]) });
  });
}
console.log(`${findings.length} fixed-cap reads in scheduled functions:`);
for (const x of findings) console.log(`  ${x.fn}:${x.line}  .limit(${x.limit})`);
if (max !== null && findings.length > max) { console.log(`::error::${findings.length} > allowed ${max}`); process.exit(1); }
