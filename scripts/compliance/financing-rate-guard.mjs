#!/usr/bin/env node
/**
 * Vireek — financing rate guard (TILA / Reg Z, roadmap item 110).
 *
 * Fails when customer-visible financing copy or code could state a rate, APR or payment that did not
 * come from a provider. Static, line-level regex scan (same style as check-erasure-coverage.mjs).
 *
 *   node scripts/compliance/financing-rate-guard.mjs --check     exit 1 on any violation
 *   node scripts/compliance/financing-rate-guard.mjs --json      machine-readable report
 *
 * Rules
 *   R1 hardcoded-rate-default   a numeric APR / rate default in code (param default, constant, object literal).
 *   R2 rate-claim-copy          user-visible text that claims a rate ("0% APR", "9.99% APR", "no interest",
 *                               "interest-free", "as low as $", "low monthly payments").
 *   R3 planning-rate-leak       PLANNING_APR (internal planning table) imported by a customer-facing file.
 *
 * Allowlist entries need a reason; an allowlist hit that no longer matches anything is itself an error
 * (stale exemptions cannot accumulate). Not legal advice: see docs/compliance/tila-regz-disclosures.md.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_DIRS = ['src', 'supabase/functions'];
const EXTS = new Set(['.ts', '.tsx', '.json']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', '__snapshots__']);

/** Files whose job is to render or hand text to customers. R3 applies here. */
export const CUSTOMER_FACING = [
  /^src\/pages\/SalesPresentationPage\.tsx$/,
  /^src\/pages\/FinancingOfferPage\.tsx$/,
  /^src\/components\/sales\//,
  /^src\/components\/quotes\//,
  /^src\/components\/technician\/EstimateDraftCard\.tsx$/,
  /^src\/lib\/inHomeSales\.ts$/,
  /^src\/lib\/estimates\.ts$/,
  /^src\/lib\/financing(Partners)?(Api)?\.ts$/,
];

/**
 * Exemptions. `path` is a repo-relative file, `rule` the rule id, `match` a substring of the offending line.
 * Every entry is a human decision with a reason; keep this list short.
 */
export const ALLOWLIST = [
  { path: 'src/lib/serviceFinance.ts', rule: 'R1', match: 'loan: 0.',
    reason: 'Rows of PLANNING_APR: owner-only planning model, labelled "planning estimate", never imported by customer-facing files (rule R3).' },
  { path: 'src/lib/serviceFinance.ts', rule: 'R1', match: 'lease: 0.',
    reason: 'Rows of PLANNING_APR (see above).' },
];

const R1 = [
  { re: /\b(?:apr_?bps|aprBps|rate_?bps|rateBps)\s*[:=]\s*[1-9]\d*/, what: 'numeric APR (bps) literal' },
  { re: /\b(?:annualRatePercent|aprPercent|annualRate|interestRate|apr)\s*(?::\s*number\s*)?=\s*[0-9]*\.?[0-9]*[1-9]/, what: 'numeric APR default' },
  { re: /\b(?:loan|lease|apr)\s*:\s*0?\.[0-9]*[1-9]\d*\b/, what: 'decimal APR in object literal' },
];
const R2 = [
  { re: /\b\d{1,2}(?:\.\d+)?\s*%\s*(?:APR|interest|financing|fixed)\b/i, what: 'percentage rate claim' },
  { re: /\b(?:0|zero)\s*%\s*(?:APR|interest|financing)\b/i, what: '0% financing claim' },
  { re: /\b(?:no|zero)[- ]interest\b/i, what: '"no interest" claim' },
  { re: /\binterest[- ]free\b/i, what: '"interest-free" claim' },
  { re: /\bas low as \$?\s*\d/i, what: '"as low as" payment claim' },
  { re: /\blow monthly payments?\b/i, what: '"low monthly payment" claim' },
];
/** Payment estimates are only a problem where a customer reads them (or in financing locale keys). */
const R2_PAYMENT = { re: /\b(?:roughly|about|approximately|around)\s+\$?\{?[^ ]*\}?\s*(?:\/|per\s+)month\b/i, what: 'estimated payment stated without lender terms' };

function* walk(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (SKIP_DIR.has(n)) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.has(p.slice(p.lastIndexOf('.')))) yield p;
  }
}

const isTest = (rel) => /\.(test|spec)\.(ts|tsx|mjs)$/.test(rel) || rel.includes('/__tests__/') || rel.startsWith('src/test/') || /\/fixtures?\.ts$/.test(rel); // fixtures = test data, never shipped to users
const isLocale = (rel) => rel.startsWith('src/locales/');
/** Non-English locales are scanned too: a rate claim is a rate claim in any language (patterns are English-biased; see docs). */
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

export function scanText(rel, text) {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    const customer = CUSTOMER_FACING.some((r) => r.test(rel));
    const r2 = customer || (isLocale(rel) && /financ/i.test(line)) ? [...R2, R2_PAYMENT] : R2;
    const rules = isLocale(rel) ? [['R2', r2]] : [['R1', R1], ['R2', r2]];
    for (const [rule, set] of rules) {
      for (const { re, what } of set) {
        if (re.test(line)) out.push({ file: rel, line: i + 1, rule, what, text: line.trim().slice(0, 160) });
      }
    }
    if (/\bPLANNING_APR\b/.test(line) && /\bimport\b|from\s+['"]/.test(line) && CUSTOMER_FACING.some((r) => r.test(rel))) {
      out.push({ file: rel, line: i + 1, rule: 'R3', what: 'PLANNING_APR imported by a customer-facing file', text: line.trim().slice(0, 160) });
    }
  });
  return out;
}

export function applyAllowlist(findings, allow = ALLOWLIST) {
  const used = new Set();
  const kept = findings.filter((f) => {
    const idx = allow.findIndex((a) => a.path === f.file && a.rule === f.rule && f.text.includes(a.match));
    if (idx >= 0) { used.add(idx); return false; }
    return true;
  });
  const stale = allow.map((a, i) => ({ a, i })).filter(({ i }) => !used.has(i)).map(({ a }) => a);
  return { kept, stale };
}

export function scanRepo(root = ROOT) {
  const findings = [];
  for (const d of SCAN_DIRS) {
    for (const abs of walk(join(root, d))) {
      const rel = relative(root, abs).split(sep).join('/');
      if (isTest(rel)) continue;
      findings.push(...scanText(rel, readFileSync(abs, 'utf8')));
    }
  }
  return findings;
}

function main() {
  const json = process.argv.includes('--json');
  const { kept, stale } = applyAllowlist(scanRepo());
  if (json) console.log(JSON.stringify({ violations: kept, staleAllowlist: stale }, null, 2));
  else {
    for (const f of kept) console.error(`✖ ${f.file}:${f.line} [${f.rule}] ${f.what}\n    ${f.text}`);
    for (const a of stale) console.error(`✖ stale allowlist entry (matches nothing): ${a.path} ${a.rule} "${a.match}"`);
    if (!kept.length && !stale.length) console.log('✔ financing-rate-guard: no unsourced rates found');
  }
  if ((kept.length || stale.length) && process.argv.includes('--check')) process.exit(1);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
