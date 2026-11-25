// Repair Outcome Ledger — offline evaluation (the first experiment). Node only: seeded, no network, no database.
//
//   node --experimental-strip-types --no-warnings --import ./scripts/ledger/ts-register.mjs \
//        scripts/ledger/evaluate.mjs --input ledger.csv --window 30 --seed 1 --out report.md [--prereg prereg.json] [--json-out m.json]
//
// Input schema: docs/ledger/SCHEMA.md (CSV or JSON array). No PII columns are accepted.
// It does NOT decide whether the hypothesis is supported: without a filled preregistration file it prints NO VERDICT.
import fs from 'node:fs';
import path from 'node:path';
import {
  HYPOTHESIS, MIN_N_CELL, FORBIDDEN_COLUMN_PATTERNS, groupProblems, buildAnnotations, annotationCounts,
  fitDawidSkene, compareReliabilityFits, auc, logLoss, calibration, bootstrapCI, mean,
} from '../../src/lib/ledger/index.ts';

const DAY = 86_400_000;
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const fail = (m) => { console.error(`evaluate: ${m}`); process.exit(2); };

const input = arg('input', null);
if (!input) fail('--input is required');
const W = Number(arg('window', 30));
if (![14, 30, 60].includes(W)) fail('--window must be 14, 30 or 60');
const SEED = Number(arg('seed', 1));
const TEST_FRACTION = Number(arg('test-fraction', 0.3));
const B = Number(arg('bootstrap', 500));
const MIN_TEST = Number(arg('min-test', MIN_N_CELL));
if (!(TEST_FRACTION > 0 && TEST_FRACTION < 1)) fail('--test-fraction must be in (0,1)');

// ------------------------------------------------------------------ input
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}
const raw = fs.readFileSync(input, 'utf8');
const records = input.toLowerCase().endsWith('.json') ? JSON.parse(raw) : parseCsv(raw);
if (!Array.isArray(records) || records.length === 0) fail('input has no rows');

const REQUIRED = ['case_id', 'completed_at', 'trade', 'tech', 'claim_kind', `event_${W}`, `censored_${W}`];
const columns = new Set(Object.keys(records[0]));
for (const c of columns) if (FORBIDDEN_COLUMN_PATTERNS.some((re) => re.test(c))) fail(`column "${c}" looks like PII or a forbidden field; remove it before evaluating`);
for (const c of REQUIRED) if (!columns.has(c)) fail(`missing required column "${c}"`);
const piiValue = /@|\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b/;

const EVENT = { none: 'none_observed', none_observed: 'none_observed', same: 'repeat_visit_same_problem', repeat_visit_same_problem: 'repeat_visit_same_problem', other: 'repeat_visit_other', repeat_visit_other: 'repeat_visit_other' };
const bool = (v) => v === true || v === 'true' || v === '1' || v === 1;
let dropped = 0;
const rows = [];
for (const r of records) {
  const ev = EVENT[String(r[`event_${W}`]).trim()];
  const at = Date.parse(r.completed_at);
  const kind = r.claim_kind;
  if (!ev || Number.isNaN(at) || !['cause', 'unknown', 'multiple', 'no_fault_found'].includes(kind) || !r.case_id || !r.tech || !r.trade) { dropped++; continue; }
  if (piiValue.test(r.tech) || piiValue.test(r.link_key ?? '')) fail('tech / link_key values look like contact details; use stable pseudonymous ids');
  rows.push({
    id: String(r.case_id), type: r.row_type || 'primary', at, trade: String(r.trade), tech: String(r.tech), kind,
    cause: kind === 'cause' ? String(r.claimed_cause ?? '') : '', link: r.link_key ? String(r.link_key) : null,
    syms: (r.symptoms ? String(r.symptoms).split(';').filter(Boolean) : []), arm: r.arm === 'explore' || r.arm === 'exploit' ? r.arm : null,
    event: ev, censored: bool(r[`censored_${W}`]),
  });
}
if (rows.some((r) => r.kind === 'cause' && !r.cause)) fail('claim_kind=cause requires claimed_cause');
rows.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

// ------------------------------------------------------------------ temporal split (never random)
const primary = rows.filter((r) => r.type === 'primary');
if (primary.length < 20) fail(`only ${primary.length} primary rows; too few to split`);
const splitIdx = Math.floor(primary.length * (1 - TEST_FRACTION));
const cutoff = primary[splitIdx].at;
const trainPrimary = primary.filter((r) => r.at < cutoff);
const testPrimary = primary.filter((r) => r.at >= cutoff);
const claimRowsTrain = rows.filter((r) => r.at < cutoff);                         // claims known before the cutoff
const mature = (r) => r.at + W * DAY <= cutoff;                                   // outcome final as of the cutoff
const yNaive = (r) => (r.event === 'none_observed' ? 1 : 0);
const trainMatureNaive = trainPrimary.filter(mature);                              // naive: ignores the observability flag
const trainMatureCensorAware = trainMatureNaive.filter((r) => !r.censored);
const testRows = testPrimary.filter((r) => !r.censored);                           // identical, censor-aware target for every model
const excluded = { trainImmature: trainPrimary.length - trainMatureNaive.length, trainCensored: trainMatureNaive.length - trainMatureCensorAware.length, testCensored: testPrimary.length - testRows.length };

// ------------------------------------------------------------------ reliability model (trained only on the training period)
const trades = [...new Set(rows.map((r) => r.trade))].sort();
const toCase = (r, classes) => ({ caseId: r.id, trade: r.trade, tech: r.tech, claimKind: r.kind, causeClass: r.kind === 'cause' && classes.has(r.cause) ? classes.get(r.cause) : null, linkKey: r.link, symptoms: r.syms, completedAt: new Date(r.at), arm: r.arm });
const tradeModels = new Map();
const dsReport = [];
let randomizedValidation = [];
for (const trade of trades) {
  const tr = claimRowsTrain.filter((r) => r.trade === trade);
  const causes = [...new Set(tr.filter((r) => r.kind === 'cause').map((r) => r.cause))].sort();
  const classes = new Map(causes.map((c, i) => [c, i]));
  if (causes.length < 2) { dsReport.push({ trade, K: causes.length, status: 'skipped (fewer than 2 causes)' }); continue; }
  const cases = tr.map((r) => toCase(r, classes));
  const problems = groupProblems(cases);
  const ann = buildAnnotations(problems, trade);
  const counts = annotationCounts(ann);
  const fit = fitDawidSkene(ann, { K: causes.length, seed: SEED, model: 'auto' });
  const itemOf = new Map(); for (const p of problems) for (const c of p.cases) itemOf.set(c.caseId, p.id);
  const randProblems = problems.filter((p) => p.cases.some((c) => c.arm === 'explore' && rows.find((x) => x.id === c.caseId)?.type === 'primary'));
  const annR = buildAnnotations(randProblems, trade);
  const fitR = fitDawidSkene(annR, { K: causes.length, seed: SEED, model: 'auto' });
  randomizedValidation.push({ trade, ...compareReliabilityFits(fit, fitR) });
  const oks = [...fit.annotators.values()].filter((a) => a.state === 'ok').map((a) => a.accuracy).sort((a, b) => a - b);
  dsReport.push({ trade, K: causes.length, model: fit.model, informative: fit.informativeItems, items: fit.totalItems, converged: fit.converged, monotone: fit.monotone, iterations: fit.iterations, ok: oks.length, insufficient: fit.annotators.size - oks.length, accMin: oks[0] ?? null, accMed: oks.length ? oks[Math.floor(oks.length / 2)] : null, accMax: oks[oks.length - 1] ?? null, randomizedItems: fitR.totalItems });
  tradeModels.set(trade, { causes, classes, fit, itemOf, counts });
}

// soft true-cause distribution for a training case, or null when the technician has too little data
function softClass(trade, r) {
  const m = tradeModels.get(trade);
  if (!m || r.kind !== 'cause' || !m.classes.has(r.cause)) return null;
  const K = m.causes.length, c = m.classes.get(r.cause);
  const item = m.itemOf.get(r.id);
  if ((m.counts.get(item) ?? 0) >= 2) return m.fit.posterior.get(item);
  const a = m.fit.annotators.get(`${trade}:${r.tech}`);
  if (!a || a.state !== 'ok') return null;
  return Array.from({ length: K }, (_, k) => (k === c ? a.accuracy : (1 - a.accuracy) / (K - 1)));
}

// ------------------------------------------------------------------ the three predictors (pre-dispatch features only)
const symsOf = (r) => (r.syms.length ? r.syms : ['__none']);
function buildCauseModel(tradeRows, distOf, outcomeRows, yOf, weightedOutcome) {
  const byTrade = new Map();
  for (const trade of trades) {
    const m = tradeModels.get(trade); if (!m) continue;
    const K = m.causes.length;
    const symCounts = new Map();
    for (const r of tradeRows.filter((x) => x.trade === trade)) {
      const d = distOf(r); if (!d) continue;
      for (const s of symsOf(r)) { const cur = symCounts.get(s) ?? new Array(K).fill(0); for (let k = 0; k < K; k++) cur[k] += d[k] / symsOf(r).length; symCounts.set(s, cur); }
    }
    const num = new Array(K).fill(1), den = new Array(K).fill(2);
    for (const r of outcomeRows.filter((x) => x.trade === trade)) {
      const d = distOf(r); if (!d) continue;
      for (let k = 0; k < K; k++) { const w = weightedOutcome ? d[k] : (d[k] === Math.max(...d) ? 1 : 0); num[k] += w * yOf(r); den[k] += w; }
    }
    byTrade.set(trade, { symCounts, S: num.map((n, k) => n / den[k]), K });
  }
  return byTrade;
}
const hardClaim = (trade) => (r) => { const m = tradeModels.get(trade); if (!m || r.kind !== 'cause' || !m.classes.has(r.cause)) return null; const d = new Array(m.causes.length).fill(0); d[m.classes.get(r.cause)] = 1; return d; };
const globalRate = (rs, y) => (rs.length ? (rs.reduce((s, r) => s + y(r), 0) + 1) / (rs.length + 2) : 0.5);
const gNaive = globalRate(trainMatureNaive, yNaive);
const gWeighted = globalRate(trainMatureCensorAware, yNaive);
function predictCause(model, r, g) {
  const t = model.get(r.trade); if (!t) return g;
  const dist = new Array(t.K).fill(0); let any = false;
  for (const s of symsOf(r)) { const c = t.symCounts.get(s); if (!c) continue; any = true; const tot = c.reduce((a, b) => a + b, 0) + t.K; for (let k = 0; k < t.K; k++) dist[k] += (c[k] + 1) / tot / symsOf(r).length; }
  if (!any) return g;
  const z = dist.reduce((a, b) => a + b, 0);
  return dist.reduce((s, p, k) => s + (p / z) * t.S[k], 0);
}
const naiveModel = new Map(); const weightedModel = new Map();
for (const trade of trades) {
  if (!tradeModels.has(trade)) continue;
  const hc = hardClaim(trade);
  naiveModel.set(trade, buildCauseModel(trainPrimary, hc, trainMatureNaive, yNaive, false).get(trade));
  weightedModel.set(trade, buildCauseModel(trainPrimary, (r) => softClass(trade, r), trainMatureCensorAware, yNaive, true).get(trade));
}
const techStats = new Map();
for (const r of trainMatureCensorAware) { const s = techStats.get(r.tech) ?? { n: 0, k: 0 }; s.n++; s.k += yNaive(r); techStats.set(r.tech, s); }
const SHRINK = 10;
const predTech = (r) => { const s = techStats.get(r.tech); return s ? (s.k + SHRINK * gWeighted) / (s.n + SHRINK) : gWeighted; };

const yTest = testRows.map(yNaive);
const preds = {
  naive: testRows.map((r) => predictCause(naiveModel, r, gNaive)),
  weighted: testRows.map((r) => predictCause(weightedModel, r, gWeighted)),
  tech_baseline: testRows.map(predTech),
};
const NAMES = { naive: '(a) naive labels', weighted: '(b) reliability-weighted', tech_baseline: '(c) technician baseline' };

// ------------------------------------------------------------------ metrics
function liftTop(y, p, frac = 0.2) {
  const n = y.length; if (n === 0) return null;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => p[b] - p[a] || a - b);
  let quota = n * frac, w = 0, s = 0;
  for (let i = 0; i < n && quota > 1e-12; ) {
    let j = i; while (j + 1 < n && p[order[j + 1]] === p[order[i]]) j++;
    const size = j - i + 1, take = Math.min(size, quota);
    let sy = 0; for (let k = i; k <= j; k++) sy += y[order[k]];
    s += (sy / size) * take; w += take; quota -= take; i = j + 1;
  }
  const base = mean(y);
  return base > 0 && w > 0 ? s / w / base : null;
}
const pick = (a, idx) => idx.map((i) => a[i]);
function metricsFor(y, p, seed) {
  const n = y.length;
  if (n < MIN_TEST) return { n, insufficient: true };
  const cal = calibration(y, p, 10);
  return {
    n, insufficient: false,
    logloss: bootstrapCI(n, (ix) => logLoss(pick(y, ix), pick(p, ix)), B, seed),
    auc: bootstrapCI(n, (ix) => auc(pick(y, ix), pick(p, ix)), B, seed + 1),
    lift20: bootstrapCI(n, (ix) => liftTop(pick(y, ix), pick(p, ix)), B, seed + 2),
    ece: cal.ece, bins: cal.bins, baseRate: mean(y),
  };
}
function pairedDelta(y, pb, pa, seed) {
  if (y.length < MIN_TEST) return null;
  return bootstrapCI(y.length, (ix) => logLoss(pick(y, ix), pick(pb, ix)) - logLoss(pick(y, ix), pick(pa, ix)), B, seed);
}
function evaluateSubset(idx, seed0) {
  const y = pick(yTest, idx);
  const out = { n: y.length, models: {}, deltas: {} };
  Object.keys(preds).forEach((k, i) => { out.models[k] = metricsFor(y, pick(preds[k], idx), seed0 + 10 * i); });
  out.deltas.weighted_vs_naive = pairedDelta(y, pick(preds.weighted, idx), pick(preds.naive, idx), seed0 + 100);
  out.deltas.weighted_vs_tech = pairedDelta(y, pick(preds.weighted, idx), pick(preds.tech_baseline, idx), seed0 + 101);
  return out;
}
const allIdx = testRows.map((_, i) => i);
const randIdx = allIdx.filter((i) => testRows[i].arm === 'explore');
const resAll = evaluateSubset(allIdx, SEED * 1000);
const resRand = evaluateSubset(randIdx, SEED * 1000 + 500);

// ------------------------------------------------------------------ preregistered verdict (never self-chosen)
function verdict() {
  const p = arg('prereg', null);
  if (!p) return 'NO VERDICT — no preregistration file supplied (docs/ledger/PREREGISTRATION.md must be filled by a person first).';
  let cfg; try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return 'NO VERDICT — preregistration file unreadable.'; }
  const need = ['min_test_n', 'min_logloss_improvement', 'require_ci_excludes_zero', 'evaluate_on'];
  if (need.some((k) => cfg[k] === null || cfg[k] === undefined || cfg[k] === '')) return 'NO VERDICT — preregistration has unfilled placeholders.';
  const res = cfg.evaluate_on === 'randomized' ? resRand : resAll;
  if (res.n < cfg.min_test_n) return `INCONCLUSIVE — held-out n=${res.n} < preregistered minimum ${cfg.min_test_n}.`;
  const ok = (d) => d && (cfg.require_ci_excludes_zero ? d.hi !== null && d.hi < -cfg.min_logloss_improvement : d.est < -cfg.min_logloss_improvement);
  const kill = (d) => cfg.kill_if_logloss_delta_at_least != null && d && d.lo !== null && d.lo >= cfg.kill_if_logloss_delta_at_least;
  if (ok(res.deltas.weighted_vs_naive) && ok(res.deltas.weighted_vs_tech)) return 'SUPPORTED under the preregistered criteria (beats both comparators).';
  if (kill(res.deltas.weighted_vs_naive) || kill(res.deltas.weighted_vs_tech)) return 'KILL CRITERION MET (preregistered). The hypothesis is not supported.';
  return 'NOT SUPPORTED under the preregistered criteria (answer "no" is a valid result).';
}

// ------------------------------------------------------------------ report (deterministic: no timestamps, no absolute paths)
const f = (x) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : Number(x).toFixed(4));
const ci = (i) => (!i ? 'n/a' : i.est === null ? 'n/a' : i.lo === null ? `${f(i.est)} [CI n/a]` : `${f(i.est)} [${f(i.lo)}, ${f(i.hi)}]`);
const lines = [];
lines.push('# Repair Outcome Ledger — offline evaluation', '', `> Hypothesis under test: "${HYPOTHESIS}"`, '', '> It may be false. This report states numbers and intervals; it does not decide. See the verdict section.', '');
lines.push('## 1. Data and split', '');
lines.push(`- input: \`${path.basename(input)}\`; rows read: ${records.length}; rows dropped as invalid: ${dropped}; window: ${W} days; seed: ${SEED}; bootstrap replicates: ${B}`);
lines.push(`- primary rows: ${primary.length}; temporal split at the ${Math.round((1 - TEST_FRACTION) * 100)}th percentile of completion time (cutoff ${new Date(cutoff).toISOString().slice(0, 10)}); train primary: ${trainPrimary.length}; test primary: ${testPrimary.length}`);
lines.push(`- training outcomes usable by the naive model (window complete at cutoff): ${trainMatureNaive.length}; by the censor-aware models: ${trainMatureCensorAware.length}`);
lines.push(`- excluded: train immature ${excluded.trainImmature}, train censored ${excluded.trainCensored}, test censored ${excluded.testCensored}`);
lines.push(`- held-out evaluation rows (uncensored, identical for all models): ${testRows.length}; of which randomized assignment: ${randIdx.length}; base first-visit success rate: ${f(mean(yTest))}`, '');
lines.push('## 2. Reliability model (fit on the training period only)', '');
lines.push('| trade | K | model | items | informative | converged | monotone | iters | techs ok | techs insufficient | accuracy min / median / max |', '|---|---|---|---|---|---|---|---|---|---|---|');
for (const d of dsReport) lines.push(d.status ? `| ${d.trade} | ${d.K} | ${d.status} | | | | | | | | |` : `| ${d.trade} | ${d.K} | ${d.model} | ${d.items} | ${d.informative} | ${d.converged} | ${d.monotone} | ${d.iterations} | ${d.ok} | ${d.insufficient} | ${f(d.accMin)} / ${f(d.accMed)} / ${f(d.accMax)} |`);
lines.push('', 'Technicians below the minimum number of informative items get no estimate; their claims are excluded from the weighted cause model (never guessed).', '');
lines.push('### Randomized-assignment cross-check of reliability', '', '| trade | verdict | shared technicians | Spearman | mean abs diff |', '|---|---|---|---|---|');
for (const v of randomizedValidation) lines.push(`| ${v.trade} | ${v.verdict} | ${v.sharedTechnicians} | ${f(v.spearman)} | ${f(v.meanAbsDiff)} |`);
lines.push('');
const tbl = (res, title) => {
  lines.push(`## ${title} (n = ${res.n})`, '');
  if (res.n < MIN_TEST) { lines.push(`insufficient data: n < ${MIN_TEST}. No metrics are reported.`, ''); return; }
  lines.push('| model | log loss ↓ | AUC ↑ | ECE ↓ | top-20% lift ↑ |', '|---|---|---|---|---|');
  for (const k of Object.keys(preds)) { const m = res.models[k]; lines.push(`| ${NAMES[k]} | ${ci(m.logloss)} | ${ci(m.auc)} | ${f(m.ece)} | ${ci(m.lift20)} |`); }
  lines.push('', 'Paired log-loss difference (negative = the first model is better), 95% bootstrap interval:', '');
  lines.push(`- (b) − (a): ${ci(res.deltas.weighted_vs_naive)}`, `- (b) − (c): ${ci(res.deltas.weighted_vs_tech)}`, '');
};
tbl(resAll, '3. Held-out results, all uncensored test rows');
tbl(resRand, '4. Held-out results, randomized-assignment rows only (unconfounded subset)');
lines.push('## 5. Calibration data (all test rows; for the reliability plot)', '');
if (resAll.n >= MIN_TEST) {
  for (const k of Object.keys(preds)) {
    lines.push(`**${NAMES[k]}**`, '', '| bin | n | mean predicted | observed rate |', '|---|---|---|---|');
    for (const b of resAll.models[k].bins) lines.push(`| ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | ${b.n} | ${f(b.meanP)} | ${f(b.meanY)} |`);
    lines.push('');
  }
} else lines.push('insufficient data.', '');
lines.push('## 6. Verdict', '', verdict(), '');
lines.push('## 7. Limits of this report', '');
lines.push('- Intervals are percentile bootstrap over held-out rows; they ignore uncertainty in training. Reliability intervals are approximate (empirical coverage on synthetic data was below nominal).');
lines.push('- "Naive" reproduces today\'s behaviour: claims taken at face value, and no repeat within the window counts as success even if the customer was not observable.');
lines.push('- Lift = success rate among the 20% highest-predicted held-out jobs divided by the overall success rate.');
lines.push('- If the input is synthetic, nothing here is evidence about real technicians or jobs.', '');
const report = lines.join('\n');
const out = arg('out', null);
if (out) fs.writeFileSync(out, report); else process.stdout.write(report);
const jsonOut = arg('json-out', null);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ window: W, seed: SEED, split: { cutoff: new Date(cutoff).toISOString(), trainPrimary: trainPrimary.length, testPrimary: testPrimary.length }, excluded, ds: dsReport, randomizedValidation, all: resAll, randomized: resRand }, null, 2));
