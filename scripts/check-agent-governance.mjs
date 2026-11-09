#!/usr/bin/env node
// scripts/check-agent-governance.mjs
//
// Static ratchet: every Edge Function / shared module that performs a customer-facing or
// money-moving side effect must either
//   (a) go through the governed path  (authorizeAgentAction( / runTool( / runPlan( in the same file), or
//   (b) carry an explicit, reviewed marker:  // agent-governance: exempt(<category>) <reason>
//       categories: human_initiated | safety_critical | system_notice | provider_adapter | tooling
//   (c) be listed in scripts/agent-governance.baseline.json (known pre-existing debt).
//
// The check FAILS when a file NOT in the baseline performs a side effect without (a) or (b),
// so a new unguarded send/charge/book cannot be merged. It also reports baseline entries that
// became guarded (shrink the baseline!) and with --strict fails on them too.
//
// Usage:  node scripts/check-agent-governance.mjs [--update-baseline] [--strict] [--json]

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const FUNCTIONS = join(ROOT, "supabase", "functions");
const BASELINE = join(ROOT, "scripts", "agent-governance.baseline.json");

const args = new Set(process.argv.slice(2));

/** Patterns that are real outbound side effects. */
const SIDE_EFFECTS = [
  { id: "sms", re: /\bsendCompliantSms\s*\(/ },
  { id: "sms", re: /\bsendSms\s*\(/ },
  { id: "sms_provider", re: /api\.twilio\.com\/[^"'`]*\/Messages/ },
  { id: "call", re: /api\.vapi\.ai\/call\b/ },
  { id: "payment", re: /\bpaymentIntents\.(create|confirm)\s*\(/ },
  { id: "payment", re: /\bcheckout\.sessions\.create\s*\(/ },
  { id: "refund", re: /\brefunds\.create\s*\(/ },
  { id: "refund", re: /api\.stripe\.com\/v1\/(refunds|charges|payment_intents)\b/ },
];

/** Evidence the file uses the governed path. */
const GOVERNED = [/\bauthorizeAgentAction\s*\(/, /\brunTool\s*\(/, /\brunPlan\s*\(/, /\bsendSmsGoverned\s*\(/, /\brunGovernedFollowup\s*\(/];
const EXEMPT_RE = /agent-governance:\s*exempt\((human_initiated|safety_critical|system_notice|provider_adapter|tooling)\)\s*\S+/;

/** Provider adapters / the governed path itself legitimately contain raw calls. */
const ALWAYS_SKIP = [
  /\.test\.ts$/, /\.spec\.ts$/, /testkit\.ts$/, /memoryPorts\.ts$/, /\/eval\//,
  /_shared\/messaging\//, /_shared\/governance\//, /_shared\/agent-run\//,
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

if (!existsSync(FUNCTIONS)) {
  console.error(`check-agent-governance: ${FUNCTIONS} not found (run from repo root)`);
  process.exit(2);
}

/** Evidence-based trigger mode (NOT name-based): how is this function reached? */
function triggerMode(src) {
  if (!/Deno\.serve\(/.test(src)) return "library";
  const jwt = /getUser\(/.test(src) && /authorization/i.test(src);
  const cron = /CRON_SECRET|x-cron-secret|isCronRequest|verifyCron/i.test(src);
  if (jwt && cron) return "operator_or_cron";
  if (cron) return "cron";
  if (jwt) return "operator";
  if (/signature|X-Twilio-Signature|webhook/i.test(src)) return "webhook";
  return "other";
}

const findings = [];
for (const file of walk(FUNCTIONS)) {
  const rel = relative(ROOT, file).split(sep).join("/");
  if (ALWAYS_SKIP.some((re) => re.test(rel))) continue;
  const src = readFileSync(file, "utf8");
  const effects = [...new Set(SIDE_EFFECTS.filter((s) => s.re.test(src)).map((s) => s.id))];
  if (!effects.length) continue;
  const governed = GOVERNED.some((re) => re.test(src));
  const exempt = EXEMPT_RE.exec(src)?.[1] ?? null;
  findings.push({ file: rel, effects, governed, exempt, mode: triggerMode(src) });
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : { files: {} };
const unguarded = findings.filter((f) => !f.governed && !f.exempt);

if (args.has("--update-baseline")) {
  const files = {};
  for (const f of unguarded.sort((a, b) => a.file.localeCompare(b.file))) files[f.file] = { effects: f.effects, mode: f.mode };
  writeFileSync(BASELINE, JSON.stringify({ note: "Pre-existing unguarded side-effect files. Shrink only: never add to this list by hand — wire the file to the governed path or add a reviewed exempt marker.", files }, null, 2) + "\n");
  console.log(`baseline written: ${unguarded.length} files`);
  process.exit(0);
}

const newViolations = unguarded.filter((f) => !(f.file in baseline.files));
const nowGuarded = Object.keys(baseline.files).filter((p) => {
  const f = findings.find((x) => x.file === p);
  return !f || f.governed || f.exempt;
});

if (args.has("--json")) {
  console.log(JSON.stringify({ scanned_with_effects: findings.length, governed: findings.filter((f) => f.governed).length, exempt: findings.filter((f) => f.exempt).length, baseline_debt: unguarded.length, new_violations: newViolations, baseline_now_guarded: nowGuarded }, null, 2));
} else {
  console.log(`files with side effects : ${findings.length}`);
  console.log(`  governed path         : ${findings.filter((f) => f.governed).length}`);
  console.log(`  reviewed exemptions   : ${findings.filter((f) => f.exempt).length}`);
  console.log(`  unguarded (baseline)  : ${unguarded.length - newViolations.length}`);
  console.log(`  NEW unguarded         : ${newViolations.length}`);
  const byMode = {};
  for (const f of unguarded) byMode[f.mode] = (byMode[f.mode] ?? 0) + 1;
  console.log(`  unguarded by trigger  : ${JSON.stringify(byMode)}  (cron/operator_or_cron = autonomous → must be wired to the runtime)`);
  for (const v of newViolations) console.error(`  ✗ ${v.file}  [${v.effects.join(",")}]  → call authorizeAgentAction/runTool, or add "// agent-governance: exempt(<category>) <reason>"`);
  if (nowGuarded.length) console.log(`  baseline entries now guarded (remove them): ${nowGuarded.join(", ")}`);
}

if (newViolations.length || (args.has("--strict") && nowGuarded.length)) process.exit(1);
