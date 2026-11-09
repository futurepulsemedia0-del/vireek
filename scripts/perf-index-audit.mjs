#!/usr/bin/env node
// Usage: node scripts/perf-index-audit.mjs [--json]   (read-only; exits 0 always — it is a review list, not a gate)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scan, findGaps } from './lib/indexAudit.mjs';

const DIR = 'supabase/migrations';
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(join(DIR, f), 'utf8'));
const { scopedCount, gaps } = findGaps(scan(files));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ scopedCount, gapCount: gaps.length, gaps }, null, 2));
} else {
  console.log(`Tenant-scoped tables: ${scopedCount}; without a leading tenant-column index/key: ${gaps.length}`);
  for (const g of gaps) console.log(`  ${g.table} (${g.column})`);
  console.log('\nHeuristic only (dynamic SQL is invisible). Confirm with EXPLAIN on real data before adding indexes.');
}
