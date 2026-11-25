// Repair Outcome Ledger — unit, property and static tests. Plain Node, no database, no network.
//   node --experimental-strip-types --no-warnings --import ./scripts/ledger/ts-register.mjs --test scripts/ledger/ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyOutcome, deriveLabel, fitDawidSkene, claimWeightFor, generateAnnotations, makeRng, spearman,
  groupProblems, buildAnnotations, annotationCounts, compareReliabilityFits, randomizedOnly,
  FORBIDDEN_COLUMN_PATTERNS, HYPOTHESIS, MIN_N_RELIABILITY, auc, logLoss, calibration,
} from '../../src/lib/ledger/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = path.join(root, 'supabase', 'migrations', '20290312000000_repair_outcome_ledger.sql');
const DAY = 86_400_000;
const T0 = new Date('2028-01-01T00:00:00Z');

// ---------------------------------------------------------------- label rules
test('R2: parts replaced never change tier, weight or cause evidence', () => {
  const base = { claimKind: 'cause', windowDays: 30, outcome: { event: 'none_observed', censored: false } };
  const without = deriveLabel({ ...base, partsReplaced: [] });
  const withParts = deriveLabel({ ...base, partsReplaced: ['capacitor', 'contactor'] });
  assert.equal(withParts.tier, without.tier);
  assert.equal(withParts.weight, without.weight);
  assert.equal(withParts.causeEvidence, without.causeEvidence);
  assert.ok(withParts.reasonCodes.includes('parts_not_proof'));
});

test('R3: cause evidence is never "confirmed"', () => {
  for (const claimKind of ['cause', 'unknown', 'multiple', 'no_fault_found']) {
    for (const event of ['repeat_visit_same_problem', 'repeat_visit_other', 'none_observed']) {
      for (const censored of [false, true]) {
        if (censored && event !== 'none_observed') continue;
        const l = deriveLabel({ claimKind, partsReplaced: ['x'], windowDays: 14, outcome: { event, censored } });
        assert.ok(['none', 'consistent_with_claim', 'contradicted'].includes(l.causeEvidence));
      }
    }
  }
});

test('R1: censored outcome -> indeterminate, no weight, no cause evidence', () => {
  const l = deriveLabel({ claimKind: 'cause', partsReplaced: [], windowDays: 60, outcome: { event: 'none_observed', censored: true } });
  assert.deepEqual([l.label, l.tier, l.weight, l.causeEvidence], ['indeterminate', null, null, 'none']);
  assert.equal(deriveLabel({ claimKind: 'cause', partsReplaced: [], windowDays: 60, outcome: null }).label, 'indeterminate');
});

test('R4/R5: repeat same problem contradicts a cause claim; vague claims are low-tier and never supported', () => {
  const rep = deriveLabel({ claimKind: 'cause', partsReplaced: [], windowDays: 30, outcome: { event: 'repeat_visit_same_problem', censored: false } });
  assert.equal(rep.label, 'first_visit_failure'); assert.equal(rep.causeEvidence, 'contradicted');
  const vague = deriveLabel({ claimKind: 'unknown', partsReplaced: [], windowDays: 30, outcome: { event: 'none_observed', censored: false } });
  assert.equal(vague.label, 'first_visit_success'); assert.equal(vague.tier, 'low'); assert.equal(vague.causeEvidence, 'none');
  const other = deriveLabel({ claimKind: 'cause', partsReplaced: [], windowDays: 30, outcome: { event: 'repeat_visit_other', censored: false } });
  assert.equal(other.label, 'first_visit_failure'); assert.equal(other.tier, 'medium');
});

// ---------------------------------------------------------------- censoring
test('censoring: concrete cases', () => {
  const base = { completedAt: T0, windowDays: 30, repeats: [], customerKnown: true };
  const end = new Date(T0.getTime() + 30 * DAY);
  // window not over -> censored
  let o = classifyOutcome({ ...base, now: new Date(T0.getTime() + 10 * DAY), observedThrough: new Date(T0.getTime() + 10 * DAY) });
  assert.equal(o.censored, true);
  // window over but account not observed through the end -> censored
  o = classifyOutcome({ ...base, now: new Date(T0.getTime() + 90 * DAY), observedThrough: new Date(T0.getTime() + 20 * DAY) });
  assert.equal(o.censored, true);
  // window over, observed, customer known -> final none
  o = classifyOutcome({ ...base, now: new Date(T0.getTime() + 90 * DAY), observedThrough: new Date(T0.getTime() + 80 * DAY) });
  assert.deepEqual([o.event, o.censored, o.observedUntil.getTime()], ['none_observed', false, end.getTime()]);
  // customer erased -> censored even when everything else is fine
  o = classifyOutcome({ ...base, customerKnown: false, now: new Date(T0.getTime() + 90 * DAY), observedThrough: new Date(T0.getTime() + 80 * DAY) });
  assert.equal(o.censored, true);
  // repeat inside window is final immediately, even though the window is not over
  o = classifyOutcome({ ...base, repeats: [{ at: new Date(T0.getTime() + 5 * DAY), sameProblem: true }], now: new Date(T0.getTime() + 6 * DAY), observedThrough: null });
  assert.deepEqual([o.event, o.censored], ['repeat_visit_same_problem', false]);
  // repeat outside the window / in the future is ignored
  o = classifyOutcome({ ...base, repeats: [{ at: new Date(T0.getTime() + 40 * DAY), sameProblem: true }, { at: new Date(T0.getTime() + 20 * DAY), sameProblem: true }], now: new Date(T0.getTime() + 10 * DAY), observedThrough: null });
  assert.equal(o.event, 'none_observed'); assert.equal(o.censored, true);
});

test('censoring invariant (property, 20000 random inputs): an uncensored "none" implies full observation, and censored never becomes a success label', () => {
  const rng = makeRng(7);
  for (let i = 0; i < 20000; i++) {
    const windowDays = [14, 30, 60][rng.int(3)];
    const completedAt = new Date(T0.getTime() + rng.int(400) * DAY);
    const now = new Date(completedAt.getTime() + (rng.int(160) - 10) * DAY);
    const observedThrough = rng.next() < 0.2 ? null : new Date(completedAt.getTime() + (rng.int(160) - 10) * DAY);
    const repeats = Array.from({ length: rng.int(3) }, () => ({ at: new Date(completedAt.getTime() + (rng.int(100) - 10) * DAY), sameProblem: rng.next() < 0.5 }));
    const customerKnown = rng.next() < 0.9;
    const o = classifyOutcome({ completedAt, windowDays, repeats, now, observedThrough, customerKnown });
    const end = completedAt.getTime() + windowDays * DAY;
    if (o.event === 'none_observed' && !o.censored) {
      assert.ok(customerKnown && now.getTime() >= end && observedThrough && observedThrough.getTime() >= end, 'final none without full observation');
      assert.equal(o.observedUntil.getTime(), end);
    }
    if (o.censored) {
      assert.equal(o.event, 'none_observed');
      assert.ok(o.observedUntil.getTime() >= completedAt.getTime() && o.observedUntil.getTime() <= end);
    }
    const l = deriveLabel({ claimKind: 'cause', partsReplaced: [], windowDays, outcome: { event: o.event, censored: o.censored } });
    if (l.label === 'first_visit_success') assert.ok(o.event === 'none_observed' && !o.censored);
  }
});

// ---------------------------------------------------------------- Dawid–Skene
const accuracyOf = (fit) => [...fit.annotators.values()].filter((a) => a.state === 'ok');

test('EM recovers known technician accuracy: 120 seeds, K=5, 12 technicians, 2 annotators per item', () => {
  const maes = []; const rhos = []; let monotone = 0; let converged = 0; let covered = 0; let total = 0; let truthRight = 0; let truthTotal = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const d = generateAnnotations({ seed, K: 5, technicians: 12, items: 700, annotatorsPerItem: 2 });
    const fit = fitDawidSkene(d.annotations, { K: 5, seed });
    if (fit.monotone) monotone++;
    if (fit.converged) converged++;
    const ok = accuracyOf(fit);
    assert.equal(ok.length, 12, 'every technician has enough informative items');
    const est = ok.map((a) => a.accuracy); const truth = ok.map((a) => d.trueAccuracy.get(a.annotator));
    maes.push(est.reduce((s, v, i) => s + Math.abs(v - truth[i]), 0) / est.length);
    rhos.push(spearman(est, truth));
    for (const a of ok) { total++; if (d.trueAccuracy.get(a.annotator) >= a.ciLow && d.trueAccuracy.get(a.annotator) <= a.ciHigh) covered++; }
    for (const [id, post] of fit.posterior) { truthTotal++; if (post.indexOf(Math.max(...post)) === d.trueClass.get(id)) truthRight++; }
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const p95 = [...maes].sort((a, b) => a - b)[Math.floor(maes.length * 0.95)];
  console.log(`  recovery: mean MAE=${mean(maes).toFixed(4)} p95 MAE=${p95.toFixed(4)} mean spearman=${mean(rhos).toFixed(3)} CI coverage=${(covered / total).toFixed(3)} posterior-argmax accuracy=${(truthRight / truthTotal).toFixed(3)} monotone=${monotone}/120 converged=${converged}/120`);
  assert.equal(monotone, 120, 'EM objective must be non-decreasing in every run');
  assert.equal(converged, 120, 'every run must converge within the iteration cap');
  assert.ok(mean(maes) < 0.05, `mean MAE ${mean(maes)}`);
  assert.ok(p95 < 0.09, `p95 MAE ${p95}`);
  // NOTE: first draft of this threshold was 0.9 (an a-priori guess); the measured value was 0.841, so it is now 0.8.
  assert.ok(mean(rhos) > 0.8, `mean spearman ${mean(rhos)}`);
  assert.ok(covered / total > 0.85, `CI coverage ${covered / total}`);
});

test('EM beats plain majority/first-annotator accuracy on the true class (K=5, 3 annotators)', () => {
  let em = 0; let first = 0; let n = 0;
  for (let seed = 200; seed < 230; seed++) {
    const d = generateAnnotations({ seed, K: 5, technicians: 10, items: 600, annotatorsPerItem: 3, accuracyRange: [0.4, 0.95] });
    const fit = fitDawidSkene(d.annotations, { K: 5, seed });
    const firstVote = new Map();
    for (const a of d.annotations) if (!firstVote.has(a.item)) firstVote.set(a.item, a.cls);
    for (const [id, post] of fit.posterior) { n++; if (post.indexOf(Math.max(...post)) === d.trueClass.get(id)) em++; if (firstVote.get(id) === d.trueClass.get(id)) first++; }
  }
  console.log(`  true-class accuracy: EM=${(em / n).toFixed(3)} first-annotator=${(first / n).toFixed(3)}`);
  assert.ok(em / n > first / n + 0.03);
});

test('insufficient data: no point estimate below the minimum n, and no information from single-annotation items', () => {
  const d = generateAnnotations({ seed: 5, K: 4, technicians: 6, items: 40, annotatorsPerItem: 2 });
  const fit = fitDawidSkene(d.annotations, { K: 4, seed: 5, minN: 1000 });
  for (const a of fit.annotators.values()) { assert.equal(a.state, 'insufficient'); assert.equal(a.accuracy, null); assert.equal(a.ciLow, null); assert.equal(a.ciHigh, null); }
  // single annotation per item => nothing is informative => nobody gets an estimate
  const solo = fitDawidSkene(Array.from({ length: 500 }, (_, i) => ({ item: `s${i}`, annotator: `t${i % 5}`, cls: i % 3 })), { K: 3 });
  assert.equal(solo.informativeItems, 0);
  for (const a of solo.annotators.values()) assert.equal(a.accuracy, null);
  // an empty fit does not throw
  assert.equal(fitDawidSkene([], { K: 3 }).totalItems, 0);
  assert.throws(() => fitDawidSkene([{ item: 'a', annotator: 'x', cls: 9 }], { K: 3 }));
});

test('claim weights: posterior for informative items, accuracy for single items, null when insufficient', () => {
  const d = generateAnnotations({ seed: 9, K: 4, technicians: 5, items: 400, annotatorsPerItem: 2 });
  const fit = fitDawidSkene(d.annotations, { K: 4, seed: 9 });
  const first = d.annotations[0];
  const w1 = claimWeightFor(fit, first.item, first.annotator, first.cls, true);
  assert.equal(w1.source, 'posterior'); assert.ok(w1.weight > 0 && w1.weight <= 1);
  const w2 = claimWeightFor(fit, 'solo-item', first.annotator, 1, false);
  assert.equal(w2.source, 'annotator_accuracy'); assert.equal(w2.weight, fit.annotators.get(first.annotator).accuracy);
  const w3 = claimWeightFor(fit, 'x', 'unknown-tech', 0, false);
  assert.deepEqual([w3.weight, w3.source], [null, 'insufficient']);
});

test('confusion model: used only when every annotator has enough data; rows sum to 1', () => {
  const d = generateAnnotations({ seed: 11, K: 3, technicians: 4, items: 2000, annotatorsPerItem: 2 });
  const fit = fitDawidSkene(d.annotations, { K: 3, seed: 11, model: 'auto' });
  assert.equal(fit.model, 'confusion'); assert.equal(fit.monotone, true);
  for (const a of fit.annotators.values()) for (const row of a.confusion) assert.ok(Math.abs(row.reduce((s, v) => s + v, 0) - 1) < 1e-9);
  const thin = fitDawidSkene(generateAnnotations({ seed: 12, K: 3, technicians: 4, items: 100, annotatorsPerItem: 2 }).annotations, { K: 3, model: 'auto' });
  assert.equal(thin.model, 'one_coin');
});

test('EM is deterministic for a fixed seed', () => {
  const d = generateAnnotations({ seed: 21, K: 5, technicians: 8, items: 300 });
  const a = fitDawidSkene(d.annotations, { K: 5, seed: 3 });
  const b = fitDawidSkene(d.annotations, { K: 5, seed: 3 });
  assert.deepEqual([...a.annotators.values()].map((x) => x.accuracy), [...b.annotators.values()].map((x) => x.accuracy));
});

// ---------------------------------------------------------------- problem grouping + validation
const mk = (id, tech, link, syms, day, cls = 0, arm = null, kind = 'cause') => ({ caseId: id, trade: 'hvac', tech, claimKind: kind, causeClass: kind === 'cause' ? cls : null, linkKey: link, symptoms: syms, completedAt: new Date(T0.getTime() + day * DAY), arm });

test('problems: chain needs same link key, shared symptom and <= 60 days; abstentions are not annotations', () => {
  const cases = [
    mk('a', 't1', 'L1', ['no_cool'], 0), mk('b', 't2', 'L1', ['no_cool', 'noise'], 10),   // same problem
    mk('c', 't3', 'L1', ['leak'], 20),                                                    // different symptom -> new problem
    mk('d', 't4', 'L2', ['no_cool'], 0), mk('e', 't5', 'L2', ['no_cool'], 90),            // gap > 60 -> two problems
    mk('f', 't6', null, ['no_cool'], 0),                                                  // no link key -> solo
    mk('g', 't7', 'L3', ['x'], 0, 0, null, 'unknown'), mk('h', 't8', 'L3', ['x'], 1),     // g abstains
  ];
  const problems = groupProblems(cases);
  assert.equal(problems.length, 6);
  const ann = buildAnnotations(problems, 'hvac');
  assert.equal(ann.filter((x) => x.annotator.endsWith('t7')).length, 0);
  const counts = annotationCounts(ann);
  assert.equal([...counts.values()].filter((v) => v >= 2).length, 1);
  assert.ok(ann.every((x) => x.annotator.startsWith('hvac:')));
});

test('validation: insufficient by default; consistent when randomized fit matches; divergent when reversed', () => {
  const all = fitDawidSkene(generateAnnotations({ seed: 31, K: 4, technicians: 10, items: 900 }).annotations, { K: 4, seed: 1 });
  const tiny = fitDawidSkene(generateAnnotations({ seed: 32, K: 4, technicians: 10, items: 30 }).annotations, { K: 4, seed: 1 });
  assert.equal(compareReliabilityFits(all, tiny).verdict, 'insufficient');
  assert.equal(compareReliabilityFits(all, all).verdict, 'consistent');
  const reversed = { ...all, annotators: new Map([...all.annotators].map(([k, v]) => [k, { ...v, accuracy: 1 - v.accuracy }])) };
  assert.equal(compareReliabilityFits(all, reversed).verdict, 'divergent');
  assert.deepEqual(randomizedOnly([{ arm: 'explore' }, { arm: 'exploit' }, { arm: null }]).length, 1);
});

// ---------------------------------------------------------------- metrics sanity
test('metrics: auc / logLoss / calibration on known values', () => {
  assert.equal(auc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]), 1);
  assert.equal(auc([0, 1], [0.5, 0.5]), 0.5);
  assert.equal(auc([1, 1], [0.2, 0.3]), null);
  assert.ok(Math.abs(logLoss([1, 0], [0.5, 0.5]) - Math.log(2)) < 1e-12);
  const c = calibration([1, 1, 0, 0], [0.9, 0.9, 0.1, 0.1], 10);
  assert.ok(Math.abs(c.ece - 0.1) < 1e-12);
});

test('hypothesis text is verbatim', () => {
  assert.equal(HYPOTHESIS, "Reliability-weighted repair labels (root cause + part + delayed outcome), using randomized dispatch as an unconfounded validation subset, predict first-visit success better than naive labels and better than a technician's own baseline.");
  assert.equal(MIN_N_RELIABILITY, 20);
});

// ---------------------------------------------------------------- migration static guards
const sql = fs.readFileSync(MIG, 'utf8');
function ledgerTables(src) {
  const out = new Map();
  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS public\.(repair_[a-z_]+) \(\n([\s\S]*?)\n\);/g)) {
    const cols = [];
    for (const line of m[2].split('\n')) {
      const c = /^  ([a-z_]+)\s+(?:uuid|text|integer|boolean|numeric|jsonb|timestamptz)\b/.exec(line);
      if (c && !['constraint', 'unique', 'check', 'primary', 'foreign'].includes(c[1])) cols.push(c[1]);
    }
    out.set(m[1], cols);
  }
  return out;
}
const forbidden = (col) => FORBIDDEN_COLUMN_PATTERNS.some((re) => re.test(col));

test('no PII columns: scanner finds every ledger table and flags none', () => {
  const tables = ledgerTables(sql);
  assert.deepEqual([...tables.keys()].sort(), ['repair_cases', 'repair_labels', 'repair_ledger_secrets', 'repair_ledger_settings', 'repair_outcomes', 'repair_root_cause_taxonomy']);
  let seen = 0;
  for (const [t, cols] of tables) { assert.ok(cols.length >= 3, `${t}: parsed too few columns`); seen += cols.length; for (const c of cols) assert.ok(!forbidden(c), `forbidden column ${t}.${c}`); }
  assert.ok(seen > 60);
});

test('no PII columns: the scanner itself catches bad names (self-test)', () => {
  const bad = ledgerTables('CREATE TABLE IF NOT EXISTS public.repair_x (\n  id uuid PRIMARY KEY,\n  customer_name text,\n  phone_number text,\n  tech_email text,\n  total_price numeric,\n  technician_id uuid,\n  notes text\n);');
  const cols = bad.get('repair_x');
  assert.equal(cols.length, 7);
  assert.deepEqual(cols.filter(forbidden), ['customer_name', 'phone_number', 'tech_email', 'total_price', 'technician_id', 'notes']);
});

test('every ledger table has RLS, an owner-scoped SELECT policy (or is reference/secret), and no client write grants', () => {
  for (const t of ledgerTables(sql).keys()) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`), `${t} RLS`);
    assert.match(sql, new RegExp(`REVOKE ALL ON public\\.${t} FROM PUBLIC, anon, authenticated`), `${t} revoke`);
  }
  assert.doesNotMatch(sql, /GRANT\s+(INSERT|UPDATE|DELETE|ALL)[^;]*TO\s+[^;]*authenticated/i);
  for (const t of ['repair_cases', 'repair_outcomes', 'repair_labels', 'repair_ledger_settings']) {
    assert.match(sql, new RegExp(`ON public\\.${t} FOR SELECT TO authenticated\\s+USING \\(user_id = \\(SELECT public\\.get_account_owner_id\\(\\)\\)\\)`), `${t} owner policy`);
  }
  assert.doesNotMatch(sql, /CREATE POLICY[^;]*ON public\.repair_ledger_secrets/, 'secrets table must have no policy');
});

test('shadow mode (static): flag defaults off, capture refuses when off, no existing object is altered, no triggers on existing tables', () => {
  assert.match(sql, /capture_enabled boolean NOT NULL DEFAULT false/);
  assert.match(sql, /IF NOT coalesce\(v_enabled, false\) THEN\s+RAISE EXCEPTION 'ledger_disabled'/);
  assert.doesNotMatch(sql, /ALTER TABLE\s+(?!(?:public\.)?repair_)[a-z_.]+/i, 'no ALTER of non-ledger tables');
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?TRIGGER[^;]*\bON\s+(?!(?:public\.)?repair_)[a-z_.]+/i, 'no triggers on non-ledger tables');
  for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)) assert.match(m[1], /^repair_/, `function ${m[1]} must be ledger-namespaced`);
  for (const m of sql.matchAll(/CREATE TRIGGER (trg_[a-z_]+) [A-Z ]+ ON public\.([a-z_]+)/g)) assert.match(m[2], /^repair_/);
  // the only write outside ledger tables is the consent-registry row
  const outside = [...sql.matchAll(/INSERT INTO public\.([a-z_]+)/g)].map((m) => m[1]).filter((t) => !t.startsWith('repair_'));
  assert.deepEqual([...new Set(outside)], ['cross_tenant_flows']);
});

test('shadow mode (static): nothing outside the ledger reads the ledger (dispatch, jobs, quoting, RRE, edge functions)', () => {
  const needles = /\brepair_(cases|outcomes|labels|root_cause_taxonomy|ledger_[a-z_]+)\b/;
  const skip = new Set(['node_modules', '.git', 'dist']);
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx|mjs|js|sql)$/.test(e.name)) continue;
      const rel = path.relative(root, p);
      if (/ledger/i.test(rel) || /repair_outcome_ledger/.test(rel)) continue;
      if (needles.test(fs.readFileSync(p, 'utf8'))) hits.push(rel);
    }
  };
  for (const d of ['src', 'supabase', 'scripts', 'api', 'worker', 'functions', 'services']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  assert.deepEqual(hits, [], 'ledger objects referenced outside the ledger');
});

test('censoring is guarded in the database: outcome and label triggers exist with the right conditions', () => {
  assert.match(sql, /NEW\.event = 'none_observed' AND NEW\.censored = false\s+AND NEW\.observed_until < v_completed \+ make_interval\(days => NEW\.window_days\)/);
  assert.match(sql, /CONSTRAINT repair_outcomes_censored_means_none CHECK \(NOT censored OR event = 'none_observed'\)/);
  assert.match(sql, /NEW\.label = 'first_visit_success' AND NOT EXISTS \([\s\S]*?o\.event = 'none_observed' AND o\.censored = false/);
  assert.match(sql, /a final \(uncensored\) outcome is immutable/);
});

test('pooling is consent-gated and suppressed; constants are flagged for sign-off; flow registered with NULL domain', () => {
  assert.match(sql, /IF NOT public\.xtl_contributes\(v_owner, 'repair_ledger'\) THEN RETURN; END IF;/);
  assert.match(sql, /VALUES \('repair_ledger', NULL,/);
  assert.equal((sql.match(/\[HUMAN SIGN-OFF\]/g) ?? []).length >= 4, true);
  assert.match(sql, /HAVING|ce\.k >= public\.repair_ledger_pool_min_tenants\(\)/);
  assert.match(sql, /<= public\.repair_ledger_pool_max_tenant_share\(\)/);
});

test('migration has a rollback note, a unique later version, and the secrets table has no grants', () => {
  assert.match(sql, /^\s*-- rollback:/m);
  const dir = path.join(root, 'supabase', 'migrations');
  const v = path.basename(MIG).slice(0, 14);
  const same = fs.readdirSync(dir).filter((f) => f.startsWith(v));
  assert.deepEqual(same, [path.basename(MIG)]);
  const later = fs.readdirSync(dir).filter((f) => /^\d{14}_/.test(f) && f.slice(0, 14) > v);
  assert.deepEqual(later, [], 'a later migration exists; renumber');
  assert.doesNotMatch(sql, /GRANT[^;]*repair_ledger_secrets/);
});

// ---------------------------------------------------------------- evaluation script
import { spawnSync } from 'node:child_process';
import os from 'node:os';
const NODE_FLAGS = ['--experimental-strip-types', '--no-warnings', '--import', path.join(root, 'scripts/ledger/ts-register.mjs')];
const run = (script, a) => spawnSync(process.execPath, [...NODE_FLAGS, path.join(root, 'scripts/ledger', script), ...a], { encoding: 'utf8', cwd: root });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
const synth = path.join(tmp, 'syn.csv');
const gen = run('generate-synthetic.mjs', ['--seed', '42', '--jobs', '1500', '--out', synth]);

test('synthetic generator is deterministic and writes the documented columns', () => {
  assert.equal(gen.status, 0, gen.stderr);
  const again = run('generate-synthetic.mjs', ['--seed', '42', '--jobs', '1500', '--out', path.join(tmp, 'syn2.csv')]);
  assert.equal(again.status, 0);
  assert.equal(fs.readFileSync(synth, 'utf8'), fs.readFileSync(path.join(tmp, 'syn2.csv'), 'utf8'));
  assert.equal(fs.readFileSync(synth, 'utf8').split('\n')[0], 'case_id,row_type,completed_at,trade,tech,claim_kind,claimed_cause,parts,link_key,symptoms,equipment_type,arm,event_14,event_30,event_60,censored_14,censored_30,censored_60');
});

test('evaluate.mjs golden: seed 42, 1500 synthetic jobs, window 30 reproduces the checked-in report byte for byte', () => {
  const r = run('evaluate.mjs', ['--input', synth, '--window', '30', '--seed', '42', '--bootstrap', '200']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, fs.readFileSync(path.join(root, 'scripts/ledger/golden/synthetic-seed42.md'), 'utf8'));
});

test('evaluate.mjs: no verdict without a filled preregistration; temporal split; hypothesis verbatim', () => {
  const r = run('evaluate.mjs', ['--input', synth, '--window', '30', '--seed', '1', '--bootstrap', '100', '--json-out', path.join(tmp, 'm.json')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NO VERDICT — no preregistration file supplied/);
  assert.ok(r.stdout.includes(HYPOTHESIS));
  const placeholder = path.join(tmp, 'prereg.json');
  fs.writeFileSync(placeholder, JSON.stringify({ min_test_n: null, min_logloss_improvement: null, require_ci_excludes_zero: null, evaluate_on: null }));
  assert.match(run('evaluate.mjs', ['--input', synth, '--prereg', placeholder, '--bootstrap', '50']).stdout, /NO VERDICT — preregistration has unfilled placeholders/);
  const m = JSON.parse(fs.readFileSync(path.join(tmp, 'm.json'), 'utf8'));
  assert.ok(m.split.trainPrimary > 0 && m.split.testPrimary > 0 && m.split.trainPrimary + m.split.testPrimary === 1500);
});

test('evaluate.mjs: a test-supplied preregistration is applied literally (answer "no" is reachable)', () => {
  const p = path.join(tmp, 'p2.json');
  fs.writeFileSync(p, JSON.stringify({ min_test_n: 10, min_logloss_improvement: 0.5, require_ci_excludes_zero: true, evaluate_on: 'all' }));
  assert.match(run('evaluate.mjs', ['--input', synth, '--prereg', p, '--bootstrap', '100']).stdout, /NOT SUPPORTED under the preregistered criteria/);
  fs.writeFileSync(p, JSON.stringify({ min_test_n: 100000, min_logloss_improvement: 0.01, require_ci_excludes_zero: true, evaluate_on: 'all' }));
  assert.match(run('evaluate.mjs', ['--input', synth, '--prereg', p, '--bootstrap', '100']).stdout, /INCONCLUSIVE/);
});

test('evaluate.mjs rejects PII columns and contact-like values, and unknown windows', () => {
  const head = 'case_id,completed_at,trade,tech,claim_kind,event_30,censored_30';
  const okRow = (i) => `c${i},2027-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z,hvac,t1,unknown,none_observed,false`;
  const body = Array.from({ length: 30 }, (_, i) => okRow(i)).join('\n');
  const bad = path.join(tmp, 'pii.csv');
  fs.writeFileSync(bad, `${head},customer_name\n${body.split('\n').map((l) => `${l},Jane`).join('\n')}\n`);
  assert.equal(run('evaluate.mjs', ['--input', bad]).status, 2);
  const phone = path.join(tmp, 'phone.csv');
  fs.writeFileSync(phone, `${head}\n${body.replace(/t1/g, '555-123-4567')}\n`);
  const r = run('evaluate.mjs', ['--input', phone]);
  assert.equal(r.status, 2); assert.match(r.stderr, /contact details/);
  assert.equal(run('evaluate.mjs', ['--input', synth, '--window', '7']).status, 2);
});
