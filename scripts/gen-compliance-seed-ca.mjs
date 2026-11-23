#!/usr/bin/env node
// Regenerates supabase/migrations/20290306000100_canada_rule_pack.sql from caSeedRules.ts.
// Run: node --experimental-strip-types scripts/gen-compliance-seed-ca.mjs
//      node --experimental-strip-types scripts/gen-compliance-seed-ca.mjs --check   # CI: fail if the file is stale
// Seeded versions are "in_review": nothing is enforced until staff approve them with counsel.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { CA_SEED_RULES, CA_SEED_EFFECTIVE_FROM } from '../supabase/functions/_shared/compliance-rules/caSeedRules.ts';

const OUT = 'supabase/migrations/20290306000100_canada_rule_pack.sql';
const TEMPLATE = 'scripts/templates/canada_rule_pack.sql.tpl';

export function render() {
  const rows = CA_SEED_RULES.map((r) => JSON.stringify(r)).join(',\n');
  const tpl = readFileSync(TEMPLATE, 'utf8');
  return tpl.replace('/*@SEED_ROWS@*/', rows).replace('/*@SEED_EFFECTIVE_FROM@*/', CA_SEED_EFFECTIVE_FROM);
}

if (process.argv[1] && process.argv[1].endsWith('gen-compliance-seed-ca.mjs')) {
  const sql = render();
  if (process.argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== sql) { console.error(`${OUT} is stale — regenerate with scripts/gen-compliance-seed-ca.mjs`); process.exit(1); }
    console.log('OK: Canada seed migration is up to date.');
  } else {
    writeFileSync(OUT, sql);
    console.log(`wrote ${CA_SEED_RULES.length} Canadian rules to ${OUT}`);
  }
}
