#!/usr/bin/env node
// Verifies code ownership. Exit 0 = ok, 1 = errors.
//  - ownership-map.json is structurally valid
//  - .github/CODEOWNERS and docs/governance/service-ownership.md are exactly what the map renders (no hand edits / drift)
//  - every edge function, src area and top-level directory resolves to a rule
//  - placeholder owners (@OWNER_*, @BACKUP_*): warnings while "enforcePlaceholders" is false, ERRORS once it is true (or with --strict)
//  - primary and backup differ (unless the role sets allowSamePrimaryBackup)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  CODEOWNERS_FILE, DOC_FILE, MAP_FILE, buildRules, isPlaceholder, loadMap, renderCodeowners, renderDoc, resolveOwner, validateMap, walk,
} from './ownership-lib.mjs';

const strictFlag = process.argv.includes('--strict');
const errors = [];
const warnings = [];
const notices = [];

if (!existsSync(MAP_FILE)) {
  console.log(`::error::${MAP_FILE} is missing`);
  process.exit(1);
}

const map = loadMap();
const structural = validateMap(map);
errors.push(...structural);

if (!structural.length) {
  const enforce = strictFlag || map.enforcePlaceholders === true;
  const placeholderIssues = [];

  // 1. generated files are in sync with the map
  const fresh = [[CODEOWNERS_FILE, renderCodeowners(map)], [DOC_FILE, renderDoc(map)]];
  for (const [file, expected] of fresh) {
    if (!existsSync(file)) errors.push(`${file} is missing - run: npm run owners:generate`);
    else if (readFileSync(file, 'utf8') !== expected) errors.push(`${file} is out of date with ${MAP_FILE} - run: npm run owners:generate`);
  }

  // 2. owners per role
  const unfilled = [];
  for (const [name, r] of Object.entries(map.roles)) {
    for (const kind of ['primary', 'backup']) if (isPlaceholder(r[kind])) unfilled.push(`${name}.${kind}`);
    if (!isPlaceholder(r.primary) && r.primary === r.backup && r.allowSamePrimaryBackup !== true) {
      errors.push(`role ${name}: primary and backup are the same owner (${r.primary}); assign a different backup or set allowSamePrimaryBackup`);
    }
  }
  if (unfilled.length) {
    placeholderIssues.push(`${unfilled.length} placeholder owner(s) still in ${MAP_FILE}: ${unfilled.join(', ')}`);
  } else if (!enforce) {
    warnings.push(`no placeholder owners left: set "enforcePlaceholders": true in ${MAP_FILE} so CI fails if one is ever reintroduced`);
  }
  (enforce ? errors : warnings).push(...placeholderIssues);

  // 3. coverage: every function / src area / top-level entry must resolve to a rule, ideally a non-fallback one
  const rules = buildRules(map);
  const fallbackRule = rules.find((r) => r.pattern === '*');
  const coreRule = rules.find((r) => r.pattern === '/supabase/functions/');
  const dirs = (p) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);

  const genericFns = [];
  for (const fn of dirs('supabase/functions')) {
    const hit = resolveOwner(rules, `supabase/functions/${fn}/index.ts`);
    if (!hit || hit === fallbackRule) errors.push(`edge function "${fn}" has no owner rule`);
    else if (hit === coreRule) genericFns.push(fn);
  }
  for (const d of dirs('src')) {
    if (!resolveOwner(rules, `src/${d}/x`) || resolveOwner(rules, `src/${d}/x`) === fallbackRule) errors.push(`src/${d}/ has no owner rule`);
  }
  const fallbackTop = [];
  for (const name of readdirSync('.', { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'dist-home', 'coverage'].includes(name.name)) continue;
    const probe = name.isDirectory() ? `${name.name}/x` : name.name;
    const hit = resolveOwner(rules, probe);
    if (hit === fallbackRule) fallbackTop.push(name.isDirectory() ? `${name.name}/` : name.name);
  }
  if (genericFns.length) notices.push(`${genericFns.length} edge function(s) are only covered by the generic core group; classify them in ${MAP_FILE} when convenient`);
  if (fallbackTop.length) notices.push(`${fallbackTop.length} top-level entr${fallbackTop.length === 1 ? 'y falls' : 'ies fall'} back to the repository default owner: ${fallbackTop.slice(0, 12).join(' ')}${fallbackTop.length > 12 ? ' ...' : ''}`);

  // 4. rules that match nothing (informational: the working tree may legitimately not contain them yet)
  const files = walk('.');
  const dead = rules.filter((r) => r.pattern !== '*' && !files.some((f) => r.re.test(`/${f}`))).map((r) => r.pattern);
  if (dead.length) notices.push(`${dead.length} rule(s) currently match no file: ${dead.slice(0, 8).join(' ')}${dead.length > 8 ? ' ...' : ''}`);
}

for (const e of errors) console.log(`::error::${e}`);
for (const w of warnings) console.log(`::warning::${w}`);
for (const n of notices) console.log(`::notice::${n}`);
if (!errors.length) console.log(`OWNERSHIP check passed${warnings.length ? ' (with warnings)' : ''}.`);
process.exit(errors.length ? 1 : 0);
