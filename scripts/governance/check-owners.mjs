#!/usr/bin/env node
// Verifies docs/OWNERS.md: every required area has a row and a real owner (not "TBD").
// Default: warn-only (exit 0, GitHub ::warning:: annotations). --strict: exit 1 on any problem.
import { readFileSync, existsSync } from 'node:fs';

const REQUIRED = ['security', 'voice', 'billing', 'integrations', 'support', 'compliance'];
const strict = process.argv.includes('--strict');
const file = 'docs/OWNERS.md';
const problems = [];

if (!existsSync(file)) {
  problems.push(`${file} is missing`);
} else {
  const rows = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/);
    if (!m || /^-+$/.test(m[1]) || m[1].toLowerCase() === 'area') continue;
    rows.set(m[1].toLowerCase(), m[2]);
  }
  for (const area of REQUIRED) {
    const owner = rows.get(area);
    if (owner === undefined) problems.push(`area "${area}" has no row in ${file}`);
    else if (/tbd/i.test(owner) || owner === '' || owner === '—') problems.push(`area "${area}" has no assigned owner`);
  }
}

for (const p of problems) console.log(strict ? `::error::${p}` : `::warning::${p}`);
if (!problems.length) console.log('OWNERS check passed: every required area has an owner.');
process.exit(strict && problems.length ? 1 : 0);
