# Outcome learning — end-to-end verification (VRN)

Scope: the chain *prediction + outcome → calibration bins → ECE breach → alert → automatic rollback*, plus *low-quality outcomes excluded* and *cohorts under 5 tenants suppressed*.
Inspected: `supabase/migrations/20270315000000_intelligence_evaluation_plane.sql`, `20290101000000_outcome_learning_foundation.sql` (dependency), `20290102000000_outcome_learning_advanced.sql`, `supabase/functions/{outcome-reconciler,learning-policy-monitor,remote-resolution}`, `_shared/outcomes/*`, `_shared/remote-resolution/*`.

## 1. How each link was checked

| Tag | Meaning |
|---|---|
| **EXECUTED** | Ran in this sandbox: `node --experimental-strip-types --test supabase/functions/_shared/outcomes/outcomeLearningChain.test.mjs` → **43 / 43 passed**. Pure TypeScript on seeded synthetic fixtures. |
| **STATIC** | A regex in the same test confirms the SQL / edge-function text says what the chain assumes. Proves wiring and constants, not behaviour. |
| **WRITTEN, NOT RUN** | `supabase/tests/outcome_learning_chain.sql` (17 checks). No Postgres here. Not executed, may contain mistakes. |
| **MISSING** | The link does not exist in the repository. |

Mutation check of the new test file (copies, not the repo): ECE threshold 0.15→0.5, removing `invoice_void` from the SQL exclusion list, tenant CHECK 5→2, rollback margin 0.1→0.9 each make at least one test fail. A first version missed the ECE mutation (the fixture also failed on skill); it was fixed with two ECE-only fixtures.

Not run anywhere: Deno edge functions, real Supabase, `vitest`, project `tsc`/lint (no `node_modules`, no network).

## 2. Links in the chain

| # | Link | Status | Evidence |
|---|---|---|---|
| L1 | A predictor records its prediction (`record_prediction`) | **MISSING** | The function exists (service role) but nothing calls it: no `.ts`/`.tsx` caller, only the migration and `supabase/tests/outcome_learning.sql`. `prediction_log` stays empty in production, so L3–L9 are dormant. |
| L2 | The real outcome resolves it (`resolve_prediction`) | **MISSING** (caller); leakage guard WRITTEN, NOT RUN | No caller. The rule "outcome at/before prediction is ignored" is in SQL and in the older `outcome_learning.sql` check. |
| L3 | Bins / ECE / Brier: TypeScript = SQL | **EXECUTED** (TS) + **STATIC** (SQL) | Bin expression identical; all 101 two-decimal probabilities land in the same bin as exact-decimal SQL. SQL view output: WRITTEN, NOT RUN (A.1). |
| L4 | ECE > 0.15 (or skill < 0) → `demote`, n < 50 → `insufficient_data` | **EXECUTED** (TS) + **STATIC** (SQL constants) | ECE-only and skill-only breaches tested separately. SQL behaviour: WRITTEN, NOT RUN (A.2–A.3). |
| L5 | Demotion → alert `predictor_demoted` (only on transition) | **STATIC**; WRITTEN, NOT RUN (A.4, A.7) | |
| L6 | Drift (recent vs prior 30–90 d) → alert `predictor_drift` | **EXECUTED** (TS drift) + **STATIC**; WRITTEN, NOT RUN (A.5) | |
| L7 | Demotion → weight 0 → decisions change | **MISSING** (consumer) | `get_predictor_weight` exists; nothing calls it. A demoted predictor still drives every decision. Weight write STATIC; read WRITTEN, NOT RUN (A.6). |
| L8 | A scheduler runs the monitor and reconciler | **MISSING** in repo | No `cron.schedule`, `config.toml`, workflow, `ops/` or docs entry for `learning-policy-monitor` or `outcome-reconciler`. May be configured outside the repo **[VERIFY]**. |
| L9 | Monitor calls `refresh_predictor_status` → `learning_change_post_stats` → `rollbackDecision` → `rollback_learning_change` | **STATIC** | Edge function not executed (Deno). |
| L10 | Rollback rule: degraded post-change outcomes → rollback; healthy → confirm; no evidence: relax rolls back, tighten confirms | **EXECUTED** | |
| L11 | **ECE breach → automatic rollback** | **MISSING (by design gap)** | Two independent loops. Calibration (L4–L7) demotes and alerts; rollback (L10) reacts only to the *action success rate*. `rollbackDecision` has no calibration input and the monitor's rollback step never reads `predictor_status` (asserted by a test). A badly miscalibrated predictor with unchanged success rate rolls nothing back. |
| L12 | Rollback restores `before_state`, raises `policy_rolled_back`, is idempotent, never touches a confirmed change | **STATIC**; WRITTEN, NOT RUN (B) | |
| L13 | Low-quality outcomes excluded (`excluded_from_learning`) | **EXECUTED** (8 bad fixtures excluded; clean success and no_effect kept) + **STATIC** | The exclusion list is parsed from the migration, so SQL/TS drift fails the test. `finalize_outcome_watch` itself: not run. |
| L14 | Every consumer honours the exclusion (stats, post-change stats, aggregates, dataset view) | **STATIC** | |
| L15 | Cohort < 5 tenants suppressed; dominance > 50 % and n < 30 suppressed; floors only raisable | **EXECUTED** (reference model) + **STATIC** (function + CHECK constraints); WRITTEN, NOT RUN (C) | A tenant whose rows are all low-quality, or that has not opted in, does not count towards the 5. |
| L16 | Alert reaches a human | **MISSING** | `outcome_alerts`, `learning_changes_v`, `predictor_status` are read by no UI and no notification code (`src/`, edge functions). Alerts are rows only. |

## 3. Related findings

- **Evaluation plane (`20270315000000`)** is a separate, read-only path: it derives its own prediction/outcome pairs from `ftf_predictions`, `quote_truth_analyses`, `job_assurance_snapshots` and computes ECE client-side against per-account thresholds (`ece_warn` 0.08 / `ece_fail` 0.15). It raises no alert and triggers no rollback; `eval_plane_decisions` `rollback` rows are manual records. Its leakage guard (prediction before outcome) is in SQL and not run here. The 0.15 threshold matches `refresh_predictor_status`, but the two systems never exchange data.
- **`remote-resolution`** is not connected to this chain: it does not call `record_prediction`, is not one of the three models in the evaluation plane, and calibrates only through `rr_category_rates` (resolved-remotely rate per category as a prior). Its probabilities are never measured for ECE.
- **Partial, late outcomes** (`paid_after_window`, `accepted_after_window`) are kept as `partial` and flagged, not excluded. Asserted as a documented design choice; confirm it is intended.
- **Migration versions:** `20270315000000` is shared by three files (`adaptive_diagnostic_network`, `intelligence_evaluation_plane`, `remote_resolution_engine`) and many other prefixes repeat. Supabase CLI migration history requires unique versions **[VERIFY]**; if migrations are applied only through the SQL editor this is harmless, but `supabase db push` would be affected. Not changed.
- **Dependency order:** `20290102000000` requires `20290101000000`; the SQL test must run after both.

## 4. What is needed to close the gaps (not done here)

1. L1/L2: have at least one real predictor call `record_prediction` / `resolve_prediction`.
2. L7: make decision code read `get_predictor_weight`.
3. L8: schedule `outcome-reconciler` and `learning-policy-monitor` and document it.
4. L11: decide whether a demotion/ECE alert should also roll back related policy changes; today it does not.
5. L16: surface `outcome_alerts` (UI or notification).
6. Run `supabase/tests/outcome_learning_chain.sql` on a scratch database and fix anything it finds.

## 5. Manual checklist

- [ ] `node --experimental-strip-types --no-warnings --test supabase/functions/_shared/outcomes/outcomeLearningChain.test.mjs` passes on your machine (expected 43/43).
- [ ] After both outcome-learning migrations on a scratch DB: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/outcome_learning_chain.sql` prints 17 `PASS` lines and ends in `ROLLBACK`.
- [ ] Confirm where (or whether) the two edge functions are scheduled.
