// supabase/functions/_shared/outcomes/outcomeLearningChain.test.mjs
//
// Fixture-driven verification of the outcome-learning chain (docs/intelligence/vrn-verification.md):
//   synthetic predictions + outcomes -> calibration bins -> ECE breach -> demotion/alert
//   -> automatic rollback; low-quality outcomes excluded; cohorts under 5 tenants suppressed.
//
// What this file really executes: the pure TypeScript modules (calibration.ts, policyLearning.ts,
// attribution.ts) on seeded synthetic data. What it can only check STATICALLY: the SQL in the two
// migrations and the edge-function wiring (no Postgres / Deno here). The executed-SQL counterpart is
// supabase/tests/outcome_learning_chain.sql. Every static check is named "STATIC" so a pass is never
// mistaken for an executed one.
//
// Run:  node --experimental-strip-types --no-warnings --test supabase/functions/_shared/outcomes/outcomeLearningChain.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  assessPredictor, calibrationDrift, expectedCalibrationError, reliabilityBins,
} from "./calibration.ts";
import { rollbackDecision } from "./policyLearning.ts";
import { decideBooking, decideFinancing, decideInvoicePaid } from "./attribution.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), "utf8");
const ADV = read("../../../migrations/20290102000000_outcome_learning_advanced.sql");
const FND = read("../../../migrations/20290101000000_outcome_learning_foundation.sql");
const EVAL = read("../../../migrations/20270315000000_intelligence_evaluation_plane.sql");
const MONITOR = read("../../learning-policy-monitor/index.ts");
const RECONCILER = read("../../outcome-reconciler/index.ts");

// Seeded RNG (same LCG the repo's calibration tests use) so every run sees identical fixtures.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

/** n predictions whose true event rate is truth(p). */
function synth(n, seed, truth) {
  const r = rng(seed);
  return Array.from({ length: n }, () => { const p = r(); return { p, y: r() < truth(p) ? 1 : 0 }; });
}
const calibrated = (n, seed) => synth(n, seed, (p) => p);
// Over-confident model: says p, reality is pulled to 0.5 (the classic failure after a data shift).
const overconfident = (n, seed) => synth(n, seed, (p) => 0.5 + (p - 0.5) * 0.2);

// ---------------------------------------------------------------------------------------------
describe("1. predictions + outcomes -> calibration bins", () => {
  test("bins follow the SQL definition: 10 equal-width bins, p = 1 in the last", () => {
    const bins = reliabilityBins([{ p: 0, y: 0 }, { p: 0.0999, y: 0 }, { p: 0.5, y: 1 }, { p: 1, y: 1 }]);
    assert.equal(bins.length, 10);
    assert.equal(bins[0].n, 2);
    assert.equal(bins[5].n, 1);
    assert.equal(bins[9].n, 1);
  });

  test("TS bin index equals exact-decimal SQL floor(p*10) for every 2-decimal probability", () => {
    // SQL does floor(predicted_prob * 10) on numeric (exact). JS multiplies doubles: prove no off-by-one.
    const mismatches = [];
    for (let i = 0; i <= 100; i++) {
      const p = i / 100;
      const sqlBin = Math.min(9, Math.floor(i / 10));
      const tsBin = reliabilityBins([{ p, y: 1 }]).findIndex((b) => b.n === 1);
      if (sqlBin !== tsBin) mismatches.push({ p, sqlBin, tsBin });
    }
    assert.deepEqual(mismatches, []);
  });

  test("STATIC: SQL view uses the same bin expression as calibration.ts", () => {
    assert.match(ADV, /LEAST\(9, floor\(predicted_prob \* 10\)\)/);
  });

  test("a calibrated predictor yields low ECE and status ok", () => {
    const preds = calibrated(600, 11);
    const a = assessPredictor(preds);
    assert.equal(a.status, "ok");
    assert.ok(a.ece < 0.08, `ece ${a.ece}`);
    assert.equal(a.weight, 1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("2. ECE breach -> demotion (the 'alert' trigger)", () => {
  test("over-confident predictor breaches ECE 0.15 and is demoted to weight 0", () => {
    const a = assessPredictor(overconfident(400, 21));
    assert.ok(a.ece > 0.15, `ece ${a.ece}`);
    assert.equal(a.status, "demote");
    assert.equal(a.weight, 0);
  });

  test("ECE rule in isolation: systematic under-prediction (skill still > 0) breaches ECE and is demoted", () => {
    // truth = p + 0.2: the model still ranks well (positive skill) but is off by ~0.19 on average.
    const a = assessPredictor(synth(2000, 7, (p) => Math.min(1, p + 0.2)));
    assert.ok(a.skill > 0, `skill ${a.skill}`);
    assert.ok(a.ece > 0.15, `ece ${a.ece}`);
    assert.equal(a.status, "demote");
  });

  test("ECE rule in isolation: a small bias (ECE below 0.15, skill > 0) is NOT demoted", () => {
    const a = assessPredictor(synth(2000, 7, (p) => Math.min(1, p + 0.08)));
    assert.ok(a.skill > 0 && a.ece < 0.15, `skill ${a.skill} ece ${a.ece}`);
    assert.equal(a.status, "ok");
  });

  test("fewer than 50 outcomes never demotes (insufficient_data, weight 1)", () => {
    const a = assessPredictor(overconfident(49, 22));
    assert.equal(a.status, "insufficient_data");
    assert.equal(a.weight, 1);
  });

  test("drift: calibrated prior window vs. broken recent window is flagged", () => {
    const d = calibrationDrift(calibrated(300, 31), overconfident(300, 32));
    assert.equal(d.drifted, true);
    assert.ok(d.eceDelta > 0.10);
  });

  test("STATIC: SQL thresholds equal the TypeScript defaults (n>=50, ECE>0.15, drift>0.10)", () => {
    assert.match(ADV, /r\.n < 50 THEN 'insufficient_data'/);
    assert.match(ADV, /r\.ece > 0\.15 OR COALESCE\(r\.brier_skill, 0\) < 0 THEN 'demote'/);
    assert.match(ADV, /r1\.ece - r0\.ece > 0\.10/);
    assert.match(ADV, /r1\.n >= 50 AND r0\.n >= 50/);
  });

  test("STATIC: demotion raises a predictor_demoted alert only on the transition", () => {
    assert.match(ADV, /IF v_status = 'demote' AND v_prev IS DISTINCT FROM 'demote' THEN/);
    assert.match(ADV, /'demoted:' \|\| r\.predictor \|\| ':' \|\| r\.model_version, 'predictor_demoted'/);
  });

  test("STATIC: demotion zeroes the weight that decision code reads", () => {
    assert.match(ADV, /CASE WHEN v_status = 'demote' THEN 0 ELSE 1 END/);
    assert.match(ADV, /FUNCTION public\.get_predictor_weight/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("3. alert -> automatic rollback of a learning change", () => {
  const baseline = { baselineK: 90, baselineN: 100 }; // 90% success when the change was applied

  test("degraded outcomes after an applied change trigger rollback", () => {
    const d = rollbackDecision({ kind: "relax_approval", ...baseline, postK: 40, postN: 100, windowElapsed: false });
    assert.deepEqual(d, { action: "rollback", reason: "outcomes_degraded" });
  });

  test("healthy outcomes keep monitoring, then confirm when the window ends", () => {
    const mid = rollbackDecision({ kind: "relax_approval", ...baseline, postK: 88, postN: 100, windowElapsed: false });
    assert.equal(mid.action, "continue");
    const end = rollbackDecision({ kind: "relax_approval", ...baseline, postK: 88, postN: 100, windowElapsed: true });
    assert.equal(end.action, "confirm");
  });

  test("relax_approval fails safe when the window closes without enough evidence; tighten does not", () => {
    const relax = rollbackDecision({ kind: "relax_approval", ...baseline, postK: 3, postN: 4, windowElapsed: true });
    assert.equal(relax.action, "rollback");
    const tighten = rollbackDecision({ kind: "tighten_approval", ...baseline, postK: 3, postN: 4, windowElapsed: true });
    assert.equal(tighten.action, "confirm");
  });

  test("STATIC: the monitor feeds learning_change_post_stats into rollbackDecision and calls rollback_learning_change", () => {
    assert.match(MONITOR, /rpc\("learning_change_post_stats"/);
    assert.match(MONITOR, /rollbackDecision\(/);
    assert.match(MONITOR, /rpc\("rollback_learning_change"/);
    assert.match(MONITOR, /rpc\("refresh_predictor_status"/);
  });

  test("STATIC: rollback restores before_state, is idempotent and raises policy_rolled_back", () => {
    assert.match(ADV, /IF c\.status <> 'monitoring' THEN RETURN c; END IF; -- idempotent/);
    assert.match(ADV, /'rollback:' \|\| c\.id::text, 'policy_rolled_back'/);
  });

  test("GAP (documented, asserted): an ECE breach alone does NOT roll back a learning change", () => {
    // A predictor can be badly miscalibrated (demoted) while the action success rate is unchanged.
    // rollbackDecision has no calibration input, so nothing links the two. See vrn-verification.md, link L11.
    const broken = assessPredictor(overconfident(400, 41));
    assert.equal(broken.status, "demote");
    const d = rollbackDecision({ kind: "relax_approval", baselineK: 90, baselineN: 100, postK: 90, postN: 100, windowElapsed: false });
    assert.notEqual(d.action, "rollback");
    assert.equal(rollbackDecision.length, 1); // single options object; no second "calibration" argument
    // ...and the monitor's rollback step never reads calibration state.
    const start = MONITOR.indexOf('step("monitor_changes"');
    const end = MONITOR.indexOf('step("coverage_alerts"');
    assert.ok(start > 0 && end > start, "monitor_changes section not found");
    assert.doesNotMatch(MONITOR.slice(start, end), /predictor_status|calibration|\bece\b/i);
  });
});

// ---------------------------------------------------------------------------------------------
describe("4. low-quality outcomes are excluded from learning", () => {
  // The exclusion rule is applied in SQL (finalize_outcome_watch). Read the real list from the migration
  // so this test breaks if SQL and the TypeScript attribution rules drift apart.
  const m = FND.match(/v_excluded := p_outcome = 'unknown' OR COALESCE\(p_conflict, false\)\s+OR COALESCE\(p_flags, '\{\}'\) && ARRAY\[([^\]]+)\]/);
  const EXCLUDING = m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
  const excluded = (d) => d.outcome === "unknown" || d.conflict || d.flags.some((f) => EXCLUDING.includes(f));

  const now = new Date("2026-06-30T12:00:00Z");
  const exec = "2026-06-10T12:00:00Z";

  test("STATIC: the SQL exclusion list was parsed", () => {
    assert.ok(EXCLUDING.length >= 7, `parsed ${JSON.stringify(EXCLUDING)}`);
  });

  const bad = {
    "executed_at missing": decideBooking({ executedAt: null, now, jobCreatedAt: [], otherTouchAt: [] }),
    "executed_at in future": decideBooking({ executedAt: "2026-07-30T00:00:00Z", now, jobCreatedAt: [], otherTouchAt: [] }),
    "booking preceded action": decideBooking({ executedAt: exec, now, jobCreatedAt: ["2026-06-01T00:00:00Z"], otherTouchAt: [] }),
    "multi-touch conflict": decideBooking({ executedAt: exec, now, jobCreatedAt: ["2026-06-11T12:00:00Z"], otherTouchAt: ["2026-06-11T00:00:00Z"] }),
    "financing status timestamp invalid": decideFinancing({ executedAt: exec, now, status: "funded", statusUpdatedAt: null, approvedAmountCents: 1000 }),
    "invoice paid_at invalid": decideInvoicePaid({ executedAt: exec, now, status: "paid", paidAt: null }),
    "invoice paid before action": decideInvoicePaid({ executedAt: exec, now, status: "paid", paidAt: "2026-06-01T00:00:00Z" }),
    "invoice void": decideInvoicePaid({ executedAt: exec, now, status: "void", paidAt: null }),
  };
  for (const [name, d] of Object.entries(bad)) {
    test(`excluded: ${name}`, () => assert.equal(excluded(d), true, JSON.stringify(d)));
  }

  test("a clean, attributable success is learnable", () => {
    const d = decideBooking({ executedAt: exec, now, jobCreatedAt: ["2026-06-11T12:00:00Z"], otherTouchAt: [] });
    assert.equal(d.outcome, "success");
    assert.equal(excluded(d), false);
  });

  test("a clean no_effect (window closed, no booking) is learnable", () => {
    const d = decideBooking({ executedAt: "2026-06-01T00:00:00Z", now, jobCreatedAt: [], otherTouchAt: [] });
    assert.equal(d.outcome, "no_effect");
    assert.equal(excluded(d), false);
  });

  test("DESIGN NOTE (asserted): late events are kept as 'partial', flagged but not excluded", () => {
    const d = decideInvoicePaid({ executedAt: "2026-04-01T00:00:00Z", now, status: "paid", paidAt: "2026-06-20T00:00:00Z" });
    assert.equal(d.outcome, "partial");
    assert.ok(d.flags.includes("paid_after_window"));
    assert.equal(excluded(d), false);
  });

  test("STATIC: the reconciler's own 'unresolvable_target' flag is in the SQL exclusion list", () => {
    assert.match(RECONCILER, /flags: \["unresolvable_target"\]/);
    assert.ok(EXCLUDING.includes("unresolvable_target"));
  });

  test("STATIC: every consumer filters excluded rows (stats, post-change stats, aggregates)", () => {
    assert.match(FND, /NOT v_strict OR \(outcome <> 'unknown' AND NOT excluded_from_learning\)/);
    assert.match(ADV, /o\.outcome <> 'unknown' AND NOT o\.excluded_from_learning/); // learning_change_post_stats
    assert.match(ADV, /NOT o\.excluded_from_learning\s+AND o\.outcome <> 'unknown' AND NOT o\.attribution_conflict/); // aggregates
  });

  test("STATIC: quality filter and consent filter hold in the dataset view", () => {
    assert.match(ADV, /NOT o\.excluded_from_learning AS learnable/);
    assert.match(ADV, /s\.capture_enabled AND s\.share_cross_tenant/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("5. cohorts under 5 tenants are suppressed", () => {
  // Reference model of build_outcome_aggregates' publish rule, fed with fixtures, then compared to the SQL text.
  const FLOOR = { tenants: 5, maxShare: 0.5, minN: 30 };
  function publish(perTenantN, learnable = perTenantN.map(() => true), floors = {}) {
    const f = { tenants: Math.max(floors.tenants ?? 5, 5), maxShare: Math.min(floors.maxShare ?? 0.5, 0.5), minN: Math.max(floors.minN ?? 30, 30) };
    const rows = perTenantN.filter((_, i) => learnable[i]);
    const total = rows.reduce((a, b) => a + b, 0);
    if (rows.length < f.tenants || total < f.minN || Math.max(0, ...rows) / total > f.maxShare) return null;
    return { tenant_count: rows.length, sample_n: total };
  }

  test("4 tenants (even with plenty of data) -> suppressed", () => assert.equal(publish([40, 40, 40, 40]), null));
  test("5 tenants, balanced, n>=30 -> published", () => assert.deepEqual(publish([20, 20, 20, 20, 20]), { tenant_count: 5, sample_n: 100 }));
  test("5th tenant whose outcomes are all low-quality does not count -> suppressed", () =>
    assert.equal(publish([20, 20, 20, 20, 20], [true, true, true, true, false]), null));
  test("5 tenants but one dominates (>50%) -> suppressed", () => assert.equal(publish([100, 5, 5, 5, 5]), null));
  test("5 tenants but total n<30 -> suppressed", () => assert.equal(publish([5, 5, 5, 5, 5]), null));
  test("floors can only be raised by caller arguments", () => {
    assert.equal(publish([40, 40, 40, 40], undefined, { tenants: 1 }), null);
    assert.equal(publish([20, 20, 20, 20, 20], undefined, { tenants: 6 }), null);
  });

  test("STATIC: SQL enforces the same floors twice (function + CHECK constraints)", () => {
    assert.match(ADV, /v_t integer := GREATEST\(COALESCE\(p_min_tenants, 5\), 5\)/);
    assert.match(ADV, /v_s numeric := LEAST\(COALESCE\(p_max_share, 0\.5\), 0\.5\)/);
    assert.match(ADV, /v_n integer := GREATEST\(COALESCE\(p_min_n, 30\), 30\)/);
    assert.match(ADV, /HAVING count\(\*\) >= v_t AND sum\(n\) >= v_n AND max\(n\)::numeric \/ sum\(n\) <= v_s/);
    assert.match(ADV, /tenant_count integer NOT NULL CHECK \(tenant_count >= 5\)/);
    assert.match(ADV, /sample_n integer NOT NULL CHECK \(sample_n >= 30\)/);
    assert.match(ADV, /max_tenant_share numeric NOT NULL CHECK \(max_tenant_share > 0 AND max_tenant_share <= 0\.5\)/);
    assert.equal(FLOOR.tenants, 5);
  });

  test("STATIC: only opted-in tenants (capture_enabled AND share_cross_tenant) enter an aggregate", () => {
    const cnt = (ADV.match(/s\.capture_enabled AND s\.share_cross_tenant/g) ?? []).length;
    assert.ok(cnt >= 3, `found ${cnt} consent joins (per_tenant, contributions, dataset view)`);
  });

  test("STATIC: the monitor publishes aggregates by calling build_outcome_aggregates", () => {
    assert.match(MONITOR, /rpc\("build_outcome_aggregates"/);
  });

  test("STATIC (eval plane): per-tenant evaluation RPCs are manager-gated and scoped to the account owner", () => {
    assert.match(EVAL, /FUNCTION public\.eval_plane_bins[\s\S]*?NOT public\.ftf_is_manager\(\)/);
    assert.match(EVAL, /REVOKE ALL ON FUNCTION public\.eval_plane_pairs\(uuid, text, timestamptz, timestamptz\) FROM PUBLIC, anon, authenticated/);
  });
});
