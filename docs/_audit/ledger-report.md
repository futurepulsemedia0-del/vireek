# Repair Outcome Ledger — report (parts 1–3 of 5)

Every number below was printed by a command run in the authoring sandbox (Node v22, no network, no Postgres, no `node_modules`).

## Command results
| Check | Result | Evidence |
|---|---|---|
| `node --test scripts/ledger/ledger.test.mjs` (29 tests) | **PASSED** 29/29 | label rules, censoring property test (20,000 inputs), EM recovery (120 seeds), PII-column scan, shadow-mode static checks, evaluation golden test |
| EM recovery, 120 seeds, K=5, 12 technicians | **PASSED** | mean MAE 0.0445, p95 MAE 0.0638, mean Spearman 0.841, CI coverage 0.894 (nominal 0.95), monotone 120/120, converged 120/120, posterior-argmax accuracy 0.824 |
| EM vs first-annotator true-class accuracy (3 annotators) | **PASSED** | 0.823 vs 0.674 |
| strict `tsc` on `src/lib/ledger/*.ts` only (strict, noUncheckedIndexedAccess, noUnused*) | **PASSED** | 0 errors |
| repo `lint-migrations.mjs --all-strict` on the new migration alone | **PASSED** | 0 errors |
| `node scripts/check-claims.mjs` | **PASSED** | 13 claims, 2235 files scanned |
| SQL executed on Postgres | **NOT RUN** | no Postgres available; the migration is statically linted only |
| `supabase/tests/database/repair_outcome_ledger.test.sql` (pgTAP, 33 assertions) | **NOT RUN** | written, never executed — may contain mistakes |
| repo-wide `tsc` / `eslint` / `vitest` / `npm run i18n:keys` | **BLOCKED** | `package.json` in the supplied ZIP is invalid JSON (line 187, missing comma after `"cron:check"`), `npm ci` cannot start, and no network |
| Phase 4 UI, i18n keys, route/nav/permission gate | **NOT DONE** | see below |
| "flag off changes nothing" behavioural test | **PARTIAL** | static tests only (flag default false, refusal path, no altered/triggered existing objects, no reader outside the ledger); no database run |

Baseline: no pre-change test run was possible, so "pre-existing failures" are only what the ZIP itself reports in `pre-existing-syntax-errors.txt` (62 syntax errors, including `DashboardNav.tsx`).

## Synthetic experiment (machinery check, NOT evidence)
`generate-synthetic.mjs --seed 42 --jobs 1500` then `evaluate.mjs --window 30 --seed 42 --bootstrap 200` (golden: `scripts/ledger/golden/synthetic-seed42.md`). On the 3000-job run the reliability-weighted model did not beat either comparator: paired log-loss (b)−(a) = −0.0006 [−0.0017, 0.0006], (b)−(c) = −0.0002 [−0.0097, 0.0090]; AUCs were near 0.5. The generator was not tuned to make the hypothesis win. The point is that the pipeline can return "no".

## Acceptance
| Criterion | Status |
|---|---|
| Synthetic recovery tests pass | met (above) |
| Censoring never converted to success | met in TS (property test) and in SQL triggers (static test; trigger behaviour NOT executed) |
| No PII columns; scanner has a self-test | met |
| Shadow-mode identity test | partially met (static only) |
| Every number traces to a command | met for this report |
| Capture UX, admin page, i18n, route/nav | **unmet** |

## Residual risks
1. SQL and pgTAP never ran; syntax, RLS and trigger behaviour are unverified.
2. Observability watermark is account-level; customers who left may still look observable.
3. Informative items need second looks; real ledgers may have too few for any technician to reach the minimum n.
4. Reliability intervals under-cover (0.894 vs 0.95).
5. The ordinal confidence weights, minimum-n, validation thresholds and pooling constants are placeholders [HUMAN SIGN-OFF]; the starter taxonomy needs trade-expert review.
6. Employee-facing reliability measures raise labour-law and works-council questions (Vireek may serve EU customers); legal review is needed before any exposure beyond the owner.
7. The ZIP is internally inconsistent (invalid `package.json`, 62 syntax errors) and may differ from your live repo.

## Claims you must NOT make yet
"Verified repair outcomes"; "validated first-visit-fix prediction"; any technician reliability score as accurate or validated; that reliability-weighted labels beat naive labels or technician baselines; that the ledger improves dispatch, quoting or first-time-fix. Registered as `not_held` in `src/lib/trust/claims.ts`.

## Manual verification checklist
1. Fix `package.json` comma; run `npm ci`, `tsc`, `eslint`, `vitest`, `npm run lint:migrations`, `npm run i18n:keys`, `npm run claims:check`.
2. Apply the migration to a scratch Supabase branch; run `supabase test db`; fix any pgTAP failures.
3. As owner: enable the flag, complete a job, record a case; as another tenant confirm zero rows; confirm direct INSERT is denied.
4. Run `repair_ledger_refresh_outcomes` as service role; confirm young cases stay censored.
5. Fill `PREREGISTRATION.md` before real data; then run `evaluate.mjs`.
