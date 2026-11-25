# Causal Dispatch Network — delivery report

Reference tree: uploaded zip (owner-declared source of truth). Date: 2026-11-24.

## What changed
New: `src/lib/causal/{normal,rng,estimators,shrinkage,evidence,analysis,ope,power,pooling,index}.ts`,
`src/lib/causal/causal.test.ts`, `scripts/causal/{simulate,study,run}.ts`, `scripts/causal/simulate.test.ts`,
`src/components/dispatch/CausalPowerPanel.tsx`, `supabase/migrations/20290312000000_causal_dispatch_network.sql`,
`supabase/tests/database/causal_dispatch_network.test.sql`, `docs/causal-dispatch-network.md`, `docs/_audit/*`.
Edited: `rulesAssign.ts` (B1 fix + `drawn_id`), `causalDispatchApi.ts` (adds `network`), `CausalDispatchCard.tsx`
(reportable-only cells, neutral copy, power panel), `claims.ts` (+1 `not_held` claim). Dispatch logic otherwise untouched.

## Commands (PASSED / FAILED / BLOCKED / NOT RUN)
| Command | Result | Evidence |
|---|---|---|
| Baseline `tsc` / `eslint` / `vitest` (project) BEFORE | **BLOCKED** | zip has no `node_modules`, network off |
| Same AFTER | **BLOCKED** | same; pre-existing failures therefore unknown |
| `tsc --strict --noUnusedLocals` on `src/lib/causal/*` (global tsc, alias-mapped) | **PASSED** | 0 errors in new files |
| Same on the new test files (local vitest type stub) | **PASSED** | 0 errors |
| `src/lib/causal/causal.test.ts` (24 tests) | **PASSED** — executed on `node:test` through a local vitest *shim*, not real vitest | 24/24 |
| `scripts/causal/simulate.test.ts` (7 tests, 200 seeds ×2 scenarios) | **PASSED** — same shim | 7/7, ≈12 s |
| `rulesAssign.exploration.test.ts` (+ flag-off identity test below) | **NOT RUN** | needs project deps (`vi.mock`) |
| TSX files (`CausalPowerPanel`, card) type-check | **NOT RUN** | no React types |
| `npm run lint:migrations` (`node scripts/lint-migrations.mjs`, also `--all-strict`) | **PASSED** | 0 errors, no finding for the new file |
| `node --test scripts/compliance/cross-tenant-consent.test.mjs` | **PASSED** | 19/19 (new migration does not touch the 20290305 file) |
| `npm run claims:check` | **PASSED** | 12 claims, 2234 files |
| New SQL migration and pgTAP test | **NOT RUN** | no PostgreSQL available. Reviewed by hand only. |
| Minimal repro of B1 (TS2448 + ReferenceError) | **PASSED as reproduction** | on a snippet, not on the project file |

## Simulation results (200 seeds, 8 technicians × 4 job types, q = 25%; computed by `scripts/causal/run.ts`)
| | n = 6000 jobs | n = 600 jobs |
|---|---|---|
| mean bias, AIPW / IPW (pp of FTF) | +0.02 / +0.08 | +0.01 / +0.24 |
| naive observational bias, senior technicians | **−2.34** | **−2.49** |
| RMSE naive / AIPW / IPW / shrunk | 6.3 / 5.9 / 14.4 / **3.1** | 12.7 / 19.4 / 46.4 / **7.9** |
| raw 95% CI coverage | 93.1% | 92.4% |
| shrunk 95% interval coverage | **85.4%** | 93.8% |
| reportable cells (share) / wrong-sign among them | 1.3% / **7.4%** | 0.05% / 0% |
(a) confounding is real and AIPW removes it: PASSED. (b) recovery: PASSED (|mean bias| < 0.25 pp; test threshold 0.5 pp). (c) raw coverage in band:
PASSED. (d) shrinkage helps: PASSED. **Findings, not hidden:** shrunk intervals undercover at moderate n (85%) even
after a ×1.25 inflation; at n = 6000 the unshrunk AIPW is *not* more accurate than the naive contrast overall (5.9 vs 6.3 pp
RMSE) — it removes the bias but is noisy; 7.4% of "reportable" cells had the wrong sign relative to truth (small
sample: 81 cells). Power formula vs simulation: predicted SE 5.98 pp vs empirical 5.54 pp (8% conservative, one scenario).
Intermediate bug found and fixed by measurement: estimating μ in shrinkage added +1.3 pp bias (now fixed at 0).

## Acceptance
- Simulation recovery tests: PASSED (shim). Flag-off identity test: **written, NOT RUN** (see below). Tenant isolation:
  pgTAP written, **NOT RUN**. No-regression: **cannot be shown** (baseline BLOCKED).

## Residual risks
1. B1 (`attemptOrder` TDZ) breaks all rules-enabled dispatch in this tree until the one-word rename is applied.
2. W1: post-randomization exclusions unanalyzed. 3. Shrunk intervals approximate; ×1.25 calibrated on synthetic data only.
4. Wrong-sign reportable cells (7.4% in simulation): treat all outputs as hypotheses to confirm, never as findings about a person.
5. SQL unexecuted. 6. Pooling thresholds and the `causal_cohorts` consent mapping need human/counsel sign-off.
7. Real-world validity (non-stationarity, interference between jobs, SUTVA) is untested.

## Claims you must NOT make publicly yet
- That randomized dispatch "proves", "validates" or "identifies" better/best technicians, or improves first-time fix.
- Any number from the simulation as a customer result; "statistically significant" for any real technician.
- That cross-tenant learning is live or consented (flag is unmapped). Registered as `product.causal_dispatch_validated` = not_held.

## Manual checklist
1. Apply B1 rename; run `npm run typecheck`, `npm run lint`, `npx vitest run src/lib/causal scripts/causal supabase/functions/_shared/dispatch`.
2. `supabase test db` (new pgTAP + `cross_tenant_consent`), and `npm run lint:migrations`.
3. Check the migration timestamp is unique on your branch. 4. Review thresholds in `power.ts` / `pooling.ts` with product + counsel.
5. Keep the feature flag off in production until a real tenant clears the power panel.
