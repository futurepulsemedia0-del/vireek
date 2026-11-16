#!/usr/bin/env node
// Fairness audit CLI — outcome disparities of the AI call reviewer by detected language, region
// (country calling code) and customer type. Methodology + report template:
// docs/ai-governance/fairness-audit.md
//
//   # offline, from a saved RPC payload (or a bare array of cells)
//   node --experimental-strip-types --no-warnings scripts/fairness/audit.mjs --input cells.json
//
//   # live, via the staff-only RPC (service role key comes from the environment ONLY)
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
//     node --experimental-strip-types --no-warnings scripts/fairness/audit.mjs --supabase --days 90 --out report.md
//
// Options: --days N (1-365, default 90)  --low-score N (default 60)  --min-reviewed N (default 30)
//          --min-accounts N (default 3)  --format md|json (default md)  --out FILE  --fail-on-adverse
// Exit codes: 0 ok, 1 error, 2 adverse gaps found and --fail-on-adverse given.
//
// Never infers or accepts protected attributes; see assertAllowedDimension() in the shared engine.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_OPTIONS, evaluate } from '../../supabase/functions/_shared/fairness/audit.ts';

const INT_FLAGS = { '--days': 'days', '--low-score': 'lowScore', '--min-reviewed': 'minReviewed', '--min-accounts': 'minAccounts' };

export function parseArgs(argv) {
  const out = { days: 90, lowScore: 60, minReviewed: DEFAULT_OPTIONS.minReviewed, minAccounts: DEFAULT_OPTIONS.minAccounts, format: 'md', input: null, supabase: false, out: null, failOnAdverse: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in INT_FLAGS) {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) throw new Error(`${a} needs a positive integer`);
      out[INT_FLAGS[a]] = v;
    } else if (a === '--format') {
      const v = argv[++i];
      if (v !== 'md' && v !== 'json') throw new Error('--format must be md or json');
      out.format = v;
    } else if (a === '--input') out.input = argv[++i] ?? null;
    else if (a === '--out') out.out = argv[++i] ?? null;
    else if (a === '--supabase') out.supabase = true;
    else if (a === '--fail-on-adverse') out.failOnAdverse = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (out.days > 365) throw new Error('--days must be 365 or less');
  if (out.lowScore > 100) throw new Error('--low-score must be 100 or less');
  if (out.supabase === Boolean(out.input)) throw new Error('Give exactly one of --input FILE or --supabase');
  return out;
}

export function readCells(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const cells = Array.isArray(parsed) ? parsed : parsed?.cells;
  if (!Array.isArray(cells)) throw new Error('Input must be an array of cells or an object with a "cells" array');
  return { cells, generated_at: parsed?.generated_at ?? null, days: parsed?.days ?? null, low_score_below: parsed?.low_score_below ?? null };
}

export async function fetchOverview({ days, lowScore }, env = process.env, fetchImpl = fetch) {
  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment');
  const url = new URL('/rest/v1/rpc/staff_fairness_overview', base);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('SUPABASE_URL must be https');
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: key, authorization: `Bearer ${key}` },
    body: JSON.stringify({ p_days: days, p_low_score: lowScore }),
  });
  if (!res.ok) throw new Error(`RPC failed: HTTP ${res.status}`); // never echo the body or headers
  return res.json();
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const pts = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
const ppt = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pp`;
const STATUS = { gap_adverse: 'REVIEW (adverse)', gap_favorable: 'note (favorable)', no_material_gap: '—' };

export function renderMarkdown(report, meta = {}) {
  const o = report.options;
  const L = [];
  L.push('# Fairness audit report', '');
  L.push(`- Generated: ${meta.generated_at ?? 'n/a'}`);
  L.push(`- Window: last ${meta.days ?? 'n/a'} days · low score = below ${meta.low_score_below ?? 'n/a'}`);
  L.push(`- Minimum reviewed calls per group: ${o.minReviewed} · minimum accounts per group: ${o.minAccounts}`);
  L.push(`- Material gap: ${o.minMeanGap} score points / ${(o.minRateGap * 100).toFixed(0)} percentage points · family-wise alpha ${o.alpha} (Bonferroni over ${report.comparisons_tested} comparisons, z = ${report.z_critical.toFixed(2)})`);
  const s = report.summary;
  L.push(`- Groups: ${s.groups_total} total, ${s.groups_evaluated} evaluated, ${s.groups_suppressed} suppressed · gaps flagged: ${s.adverse_gaps} adverse, ${s.favorable_gaps} favorable`, '');
  for (const d of report.dimensions) {
    L.push(`## ${d.dimension.replace('_', ' ')}`, '', `Calls: ${d.total_calls} · reviewed: ${d.total_reviewed}`, '');
    if (d.groups.length === 0) { L.push('_No data in this window._', ''); continue; }
    L.push('| Group | Calls | Reviewed | Accounts | Metric | Group | Rest | Gap (CI) | Flag |', '|---|---:|---:|---:|---|---:|---:|---|---|');
    for (const g of d.groups) {
      const name = g.missing_data ? `${g.group} (missing data)` : g.group;
      if (g.suppressed) { L.push(`| ${name} | — | — | — | suppressed: ${g.suppression_reason} | | | | |`); continue; }
      g.metrics.forEach((m, i) => {
        const isMean = m.key === 'mean_score';
        const f = isMean ? (v) => v.toFixed(1) : pct;
        const gap = isMean ? pts : ppt;
        const ci = isMean ? `${pts(m.ci_low)} to ${pts(m.ci_high)}` : `${ppt(m.ci_low)} to ${ppt(m.ci_high)}`;
        L.push(`| ${i === 0 ? name : ''} | ${i === 0 ? g.calls : ''} | ${i === 0 ? g.reviewed : ''} | ${i === 0 ? g.accounts : ''} | ${m.label} | ${f(m.value)} | ${f(m.rest_value)} | ${gap(m.gap)} (${ci}) | ${STATUS[m.status]} |`);
      });
    }
    L.push('');
  }
  L.push('## Caveats', '', ...report.caveats.map((c) => `- ${c}`), '');
  L.push('## Reviewer sign-off', '', '| Item | Value |', '|---|---|', '| Reviewer | |', '| Date | |', '| Decision for each REVIEW row (investigate / accept with reason / no action) | |', '| Follow-up owner and due date | |', '');
  return L.join('\n');
}

export async function run(argv, { env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const args = parseArgs(argv);
  const payload = args.supabase ? await fetchOverview(args, env, fetchImpl) : readCells(args.input);
  const report = evaluate(payload.cells ?? [], { minReviewed: args.minReviewed, minAccounts: args.minAccounts });
  const meta = {
    generated_at: payload.generated_at ?? new Date().toISOString(),
    days: payload.days ?? args.days,
    low_score_below: payload.low_score_below ?? args.lowScore,
  };
  const text = args.format === 'json' ? JSON.stringify({ meta, report }, null, 2) : renderMarkdown(report, meta);
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${text}\n`);
    log(`Wrote ${args.out}`);
  } else log(text);
  return report.summary.adverse_gaps > 0 && args.failOnAdverse ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`fairness audit failed: ${err.message}`); process.exit(1); });
}
