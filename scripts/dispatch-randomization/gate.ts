// Phase 0 gate CLI (read-only, offline). Input: JSON array exported by gate-queries.sql (query 2).
// Usage: npx tsx scripts/dispatch-randomization/gate.ts --input rows.json --baseline 0.85 [--eps 0,0.5,1,2,3,5] [--k 3] [--out docs/dispatch-randomization/gate-report.md]
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_THRESHOLDS, evaluateGate, nearTieStats, powerPlan, type DecisionLite } from '../../src/lib/dispatchTies';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const input = arg('input');
if (!input) { console.error('Missing --input <rows.json>'); process.exit(2); }
const rows = JSON.parse(readFileSync(input, 'utf8')) as DecisionLite[];
if (!Array.isArray(rows)) { console.error('Input must be a JSON array'); process.exit(2); }

const eps = (arg('eps') ?? '0,0.5,1,2,3,5').split(',').map(Number);
const k = Number(arg('k') ?? 3);
const baselineArg = arg('baseline');
const baseline = baselineArg === undefined ? 0.5 : Number(baselineArg);
if (![...eps, k, baseline].every(Number.isFinite) || baseline <= 0 || baseline >= 1) { console.error('Invalid numeric argument'); process.exit(2); }

const summary = nearTieStats(rows, eps, k);
const gate = evaluateGate(summary, baseline, DEFAULT_THRESHOLDS);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const lines: string[] = [
  '# Dispatch randomization — Phase 0 gate report', '',
  `**Verdict: ${gate.verdict}**${gate.epsChosen !== null ? ` (ε = ${gate.epsChosen})` : ''}`, '', gate.reason, '',
  '## Data', `- Auto decisions: ${summary.autoDecisions} over ${summary.windowDays} days`,
  `- Usable (≥1 eligible candidate): ${summary.withEligible}; unparseable snapshots: ${summary.unparseable}`,
  `- Baseline first-time-fix rate used for power: ${baseline}${baselineArg === undefined ? ' (NOT supplied — 0.5 worst case)' : ''}`, '',
  '## Near-tie rate by ε (top-' + k + ' eligible, after rule gates; DB-gate-skipped decisions excluded)', '',
  '| ε (points) | Denominator | Tied | Rate | 95% CI | Mean tie size | Gate-skipped |', '|---|---|---|---|---|---|---|',
  ...summary.stats.map((s) => `| ${s.eps} | ${s.denominator} | ${s.tied.successes} | ${pct(s.tied.rate)} | ${pct(s.tied.ciLow)}–${pct(s.tied.ciHigh)} | ${s.meanTieSize.toFixed(2)} | ${s.gateSkipped} |`), '',
  '## Power (pooled two-arm contrast among tied jobs, α=0.05, 80% power)', '',
  '| ε | Tied jobs/month | MDE (pp) | Per arm | Tied jobs needed | Months |', '|---|---|---|---|---|---|',
];
for (const s of summary.stats) {
  const perMonth = summary.windowDays > 0 ? (s.tied.successes / summary.windowDays) * 30.4375 : 0;
  for (const r of powerPlan({ tiedJobsPerMonth: perMonth, baselineRate: baseline, mdeGrid: [0.02, 0.05, 0.1] })) {
    lines.push(`| ${s.eps} | ${perMonth.toFixed(1)} | ${r.mde * 100} | ${r.perArm ?? 'n/a'} | ${r.tiedJobsNeeded ?? 'n/a'} | ${r.monthsNeeded === null ? 'n/a' : r.monthsNeeded.toFixed(1)} |`);
  }
}
lines.push('', '## Thresholds', '```json', JSON.stringify(DEFAULT_THRESHOLDS), '```', '');
const out = arg('out');
if (out) writeFileSync(out, lines.join('\n')); else console.log(lines.join('\n'));
process.exit(gate.verdict === 'PASS' ? 0 : 1);
