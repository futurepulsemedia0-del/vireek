#!/usr/bin/env node
// CI gate: every cron-style edge function must appear in a schedule (or carry a reviewed exemption).
//
// "Cron-style" = machine-triggered: it authenticates with a cron/dispatch secret, or its header comment says it is
// cron-driven. Override per function with a marker in the first 40 lines:  // @cron   or   // @not-cron
// "Scheduled" = referenced by a NON-comment SQL schedule in supabase/migrations
//    (public.cron_dispatch('<fn>'), public.synthetic_cron_tick('<fn>'), or a net.http_post URL inside a cron.schedule call)
//    or by a GitHub Actions workflow that has a `schedule:` trigger and calls /functions/v1/<fn>.
// Exemptions (docs/governance/cron-exemptions.json) need a kind and a real reason. A baseline
// (scripts/governance/baselines/cron-coverage.json) freezes today's unscheduled functions: it may only shrink.
//
// Usage: node scripts/governance/check-cron-coverage.mjs [--write-baseline]
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIGNALS = /x-[a-z-]*cron-secret|\b(?:[A-Z][A-Z0-9_]*_)?CRON_SECRET\b|PUSH_DISPATCH_SECRET|x-push-dispatch-secret|isCronAuthorized|cronSecretMatches/i;
const HEADER_CRON = /\b(?:pg_cron|cron-driven|cron-triggered|cron job|cron:|scheduled (?:job|fallback|sweep)|nightly|hourly|daily job|weekly digest)\b/i;
export const EXEMPTION_KINDS = ['covered-by-sql', 'one-off', 'external-scheduler', 'dashboard-schedule', 'not-cron'];
export const EXEMPTIONS_FILE = 'docs/governance/cron-exemptions.json';
export const BASELINE_FILE = 'scripts/governance/baselines/cron-coverage.json';

const readJson = (root, rel, fallback) => {
  const p = join(root, rel);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
};

export const stripSqlComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*--.*$/gm, ' ');

function headerOf(src) {
  return src.split('\n').slice(0, 40).join('\n');
}

export function isCronStyle(src) {
  const head = headerOf(src);
  if (/@not-cron\b/.test(head)) return false;
  if (/@cron\b/.test(head)) return true;
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  if (SIGNALS.test(code)) return true;
  const comments = head.split('\n').filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  return HEADER_CRON.test(comments);
}

function scheduledNames(root) {
  const names = new Set();
  const migDir = join(root, 'supabase/migrations');
  if (existsSync(migDir)) {
    for (const f of readdirSync(migDir)) {
      if (!f.endsWith('.sql')) continue;
      const sql = stripSqlComments(readFileSync(join(migDir, f), 'utf8'));
      for (const m of sql.matchAll(/cron_dispatch\(\s*'([a-z0-9-]+)'/g)) names.add(m[1]);
      for (const m of sql.matchAll(/synthetic_cron_tick\(\s*'([a-z0-9-]+)'/g)) names.add(m[1]);
      let i = sql.indexOf('cron.schedule(');
      while (i !== -1) {
        const slice = sql.slice(i, i + 900);
        for (const m of slice.matchAll(/(?:functions\/v1\/|\|\|\s*'\/)([a-z0-9][a-z0-9-]*)/g)) names.add(m[1]);
        i = sql.indexOf('cron.schedule(', i + 14);
      }
    }
  }
  const wfDir = join(root, '.github/workflows');
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const y = readFileSync(join(wfDir, f), 'utf8');
      if (!/^\s*schedule:/m.test(y)) continue;
      for (const m of y.matchAll(/functions\/v1\/([a-z0-9][a-z0-9-]*)/g)) names.add(m[1]);
    }
  }
  return names;
}

export function analyze(root = '.') {
  const fnDir = join(root, 'supabase/functions');
  const functions = existsSync(fnDir)
    ? readdirSync(fnDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(fnDir, d.name, 'index.ts')))
        .map((d) => d.name)
    : [];
  const fnSet = new Set(functions);
  const cronStyle = functions.filter((f) => isCronStyle(readFileSync(join(fnDir, f, 'index.ts'), 'utf8')));
  const scheduled = scheduledNames(root);

  const exFile = readJson(root, EXEMPTIONS_FILE, { exemptions: [] });
  const baseFile = readJson(root, BASELINE_FILE, { functions: [] });
  const errors = [];

  const exempt = new Map();
  for (const [i, e] of (exFile.exemptions ?? []).entries()) {
    const where = `${EXEMPTIONS_FILE} entry #${i + 1} (${e?.function ?? '?'})`;
    if (!e?.function || !fnSet.has(e.function)) { errors.push(`${where}: function does not exist under supabase/functions`); continue; }
    if (!EXEMPTION_KINDS.includes(e.kind)) errors.push(`${where}: kind must be one of ${EXEMPTION_KINDS.join(', ')}`);
    if (typeof e.reason !== 'string' || e.reason.trim().length < 30) errors.push(`${where}: "reason" must explain why it is not scheduled (30+ characters)`);
    if (e.kind === 'covered-by-sql' && !(typeof e.evidence === 'string' && existsSync(join(root, e.evidence.split(/\s/)[0])))) {
      errors.push(`${where}: covered-by-sql needs "evidence" starting with an existing migration path`);
    }
    if (e.kind === 'dashboard-schedule' && !(typeof e.evidence === 'string' && e.evidence.trim())) errors.push(`${where}: dashboard-schedule needs "evidence" (where the schedule lives)`);
    if (scheduled.has(e.function)) errors.push(`${where}: now scheduled in the repo - delete this exemption`);
    if (exempt.has(e.function)) errors.push(`${where}: duplicate exemption`);
    exempt.set(e.function, e);
  }

  const baseline = new Set(baseFile.functions ?? []);
  const offenders = cronStyle.filter((f) => !scheduled.has(f) && !exempt.has(f));
  const newOffenders = offenders.filter((f) => !baseline.has(f));
  for (const f of newOffenders) {
    errors.push(`cron-style function "${f}" is not in any schedule. Schedule it (see docs/runbooks/scheduled-jobs.md), add a reviewed entry to ${EXEMPTIONS_FILE}, or mark it "// @not-cron" if it is not machine-triggered`);
  }
  for (const f of baseline) {
    if (!fnSet.has(f)) errors.push(`${BASELINE_FILE}: "${f}" no longer exists - remove it from the baseline`);
    else if (scheduled.has(f) || exempt.has(f) || !cronStyle.includes(f)) errors.push(`${BASELINE_FILE}: "${f}" is now scheduled, exempted or not cron-style - remove it from the baseline (it may only shrink)`);
  }
  return { functions, cronStyle, scheduled, exempt, offenders, newOffenders, baseline, errors };
}

function main() {
  const write = process.argv.includes('--write-baseline');
  const r = analyze('.');
  if (write) {
    const dir = dirname(BASELINE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(BASELINE_FILE, `${JSON.stringify({
      _comment: 'Cron-style edge functions that are NOT yet in a schedule and NOT exempted. Legacy backlog to triage: schedule, exempt with a reason, or mark "// @not-cron". This list may only shrink; new offenders fail CI.',
      functions: r.offenders.sort(),
    }, null, 2)}\n`);
    console.log(`baseline written: ${r.offenders.length} function(s)`);
    return;
  }
  for (const e of r.errors) console.log(`::error::${e}`);
  const legacy = r.offenders.filter((f) => r.baseline.has(f)).length;
  console.log(`cron coverage: ${r.functions.length} functions, ${r.cronStyle.length} cron-style, ${r.exempt.size} exempted, ${legacy} legacy unscheduled (baseline), ${r.newOffenders.length} new offenders`);
  if (legacy) console.log(`::notice::${legacy} legacy cron-style function(s) are still unscheduled (see ${BASELINE_FILE}); triage them to shrink the baseline`);
  process.exit(r.errors.length ? 1 : 0);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
