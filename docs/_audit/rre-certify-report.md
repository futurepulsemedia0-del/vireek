# RRE certify: verification report

Environment: no `node_modules`, no network, no Postgres. Node 22 only.

## Commands and results
| Check | Result | Evidence |
|---|---|---|
| `tsc` (typecheck) before / after | **NOT RUN** | dependencies not installed |
| `eslint` before / after | **NOT RUN** | same |
| `vitest` (real) | **NOT RUN** | same |
| rrCertify tests under a minimal local vitest-compatible shim (describe/it/expect subset, not shipped) | **PASSED 61/61** | includes hard-exclusion test with the real `screenSafety` (8 categories), 20,000-draw property test, censoring tests, flag-off identity |
| Existing `score.test.ts` | **NOT RUN** | needs real vitest |
| Simulation `scripts/rrCertify/simulate.ts`, 500 seeds | **12/13 checks PASSED, 1 FAILED** | `docs/_audit/rre-certify-simulation.json` |
| `lint:migrations` | **PASSED** (0 errors); my file checked with `--all-strict`: 0 findings | no git base, so default mode treats files as legacy |
| `claims:check` | **PASSED** (12 claims) | baseline was 11 |
| `lint:flags` | **FAILED, pre-existing** | `full_navigation` missing from registry (before my change too); `rre_certify` itself is clean |
| Migration SQL execution | **NOT RUN** | no Postgres. Apply to a branch DB first |
| Edge functions (Deno) | **NOT RUN** | not executed or type-checked |
| UI, i18n, route, nav | **NOT DONE** | see below |

## Simulation numbers (500 seeds each; alpha 5%, delta 10%; truth known)
| calibration n | certified | conditional-bound violations | CRC mean true per-attempt risk | CRC seeds above alpha | allowed share (certified) |
|---|---|---|---|---|---|
| 50 | 0% | 0% | 3.36% | 27% | n/a |
| 200 | 22.2% | 0.4% | 4.53% | 45.8% | 68.0% |
| 1000 | 98.2% | 0% | 4.84% | 46.4% | 75.0% |
| 5000 | 100% | 0% | 4.86% | 40.2% | 87.8% |
- Abstention at n=50: correct (0% certified). Conditional bound violations are far below the 10% allowed (conservative, as expected from Bonferroni + exact tests). CRC mean risk stays under alpha.
- **Drift: FAILED my pre-set criterion.** A x3 risk shift was detected within 100 allowed cases in only **63.8%** of seeds (87.8% within 200, 95.6% within 300; median 72 cases). The first version (single 100-window) scored 63.2%; I changed to multi-window and it barely moved. I did **not** relax the 90% criterion. No-shift false-alarm rate 2.6% over 300 sequential cases. On alarm the gate dispatched 478/478.

## Not done / unverified
1. **UI panel, i18n keys in all locales, route and nav registration**: not built. I did not inspect the locale namespaces and nav registry deeply enough to ship them safely, and I cannot run `lint:locale`/e2e here.
2. **Scheduled drift evaluation**: drift is evaluated when the owner calls `rr-certify` (status/report), not on a cron. Until a cron is added, "automatic revert on alarm" is **not** automatic.
3. Calibration is run by the owner (`recalibrate`), not scheduled.
4. Existing-file edits applied to the working tree only in `remote-resolution/index.ts`, `claims.ts`, `flags.registry.json` (diffs provided).
5. The extra `flag_evaluate` RPC per decision adds a small latency even when off.
6. Backfilled history uses the current `attempt_threshold` (`assumed_current`); the share is stored in each snapshot.

## Residual risks
Exchangeability is violated by construction (adaptive prior, LLM drift). Undetected failures. Rework trigger is not equipment-specific and its `completed_at` dependency is unverified. Pooled fallback does not bound a high-risk small segment. Sequential drift testing without alpha-spending.

## What you must NOT claim publicly
"Certified", "guaranteed", "statistically safe" remote resolution; any specific false-resolution percentage; that failures are fully measured. Claim `product.rre_certified_remote_resolution` is `not_held`.
