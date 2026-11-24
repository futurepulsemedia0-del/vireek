# Moat metrics

Status: v1, computed only from tables that already exist. **This document contains no figures**; every number comes from the live database through `staff_moat_metrics()`. Performance of the views is NOT MEASURED and the SQL was NOT RUN when this was written (no database was available); see the checklist in section 7.

Code: `supabase/migrations/20290311000000_moat_metrics.sql`. Test: `supabase/tests/database/moat_metrics.test.sql` (pgTAP). Related: `docs/analytics/north-star.md` (same read pattern), `docs/intelligence/vrn-verification.md` (status of the learning loop this document depends on).

## 1. What these are, and what they are not

Two families of **proxies**. A proxy is something countable that a moat would be expected to move; it is not proof of a moat.

- **Switching-cost proxies** count what a customer would have to rebuild or lose to leave: connected providers, data history held, automations switched on.
- **Data-network-effect proxies** place the accuracy of Vireek's predictions next to what each account contributes to the shared learning cohort, to see whether the two move together.

Not claimed: that any number here equals customer lock-in, that more data makes Vireek's predictions better, or that a competitor could not replicate any of it. Do not quote output externally as evidence of defensibility without review through `docs/claims-register.json`.

## 2. Eligibility and access

An **account** is a `profiles` row that is not platform staff (`is_staff`) and not a synthetic probe tenant (`is_synthetic_tenant`). Team members have no profile row, so they are never counted separately. The RPC defaults to accounts with `status = 'active'` (the column default); pass `p_active_only := false` to include the rest.

All views read across tenants, so every client privilege on them is revoked. The only read path is `staff_moat_metrics(p_min_n, p_active_only)`, a staff-only `SECURITY DEFINER` function that returns aggregates (no account ids, names or free text). A test asserts both the revoke and that no account id appears in the output.

## 3. Switching-cost proxies (per account)

| View | Column | Definition |
| --- | --- | --- |
| `moat_integrations_v` | `integrations_n` | Distinct connected providers. A provider is counted once even when it appears in two tables. Sources and "connected" state: `integrations.status = 'connected'` (type `webhook` excluded), `qbo_connections` (`connected`, counted as `quickbooks`), `acct_connections`, `payroll_connections`, `crm_connections` (`connected`), `listing_connections` (`active`). |
| `moat_history_v` | `first_record_at` | Earliest of `customers.created_at`, `jobs.created_at`, `calls.call_datetime`. |
| | `history_days` | Whole days from `first_record_at` to now, never negative. NULL when the account has no records (not 0). |
| | `customers_n`, `jobs_n`, `calls_n` | Row counts. |
| `moat_automations_v` | `installs_active_n` | `automation_installs` with `status = 'active'`. |
| | `workflows_live_n` | `compiled_workflows` with `status = 'live'`. |
| | `dispatch_rules_enabled_n` | `dispatch_rules` with `enabled`. |
| | `automations_n` | Plain sum of the three. No weights. |
| `moat_switching_cost_v` | all of the above plus `tenure_days` | One row per eligible account; missing counts are 0, missing history is NULL. |

The RPC reports, over eligible accounts: how many have at least one integration, at least one automation and any history; the 25th, 50th and 75th percentiles (continuous) and the maximum of each proxy; and the totals of the three automation components. There is no composite score. Any score would need weights, and no evidence here would justify choosing them.

### Caveats

1. **`integrations_n` is a lower bound.** Not yet counted: calendar sync, chat (Slack / Teams / WhatsApp), banking, telematics, property-management and other connectors that live in their own tables. Add a source by adding a `UNION ALL` branch, not by changing existing ones.
2. **Connected is not used.** A connection that is connected but never syncs (`last_synced_at` is old or null) still counts. Usage is a better lock-in signal than existence; not computed in v1.
3. **`history_days` is not tenure.** Imported or back-dated rows can make history older than the account (`data_import_jobs`, `customers.source = 'import'`). The RPC reports `data_quality.history_older_than_account_n` so the size of this effect is visible. Whether imports set `created_at` explicitly is **[VERIFY]**.
4. **Automation counts treat all items as equal.** One enabled dispatch rule (at most one per rule type) is not equivalent to one live workflow. Other configuration (`job_workflow_policies`, notification routing, templates) is deliberately excluded because it exists by default or is not an automation the customer built; whether defaults are seeded for `dispatch_rules` is **[VERIFY]**.
5. **Counts are not value.** An account with many integrations may use none of them.
6. **Cost of leaving is partly outside the database**: training, habit, contracts, phone-number porting. None of it is measured here.

## 4. Data-network-effect proxies

### 4.1 Prediction accuracy: `moat_prediction_accuracy_v`

One row per account, predictor and model version, with `n` resolved predictions.

| Column | Definition |
| --- | --- |
| `brier` | Mean of (predicted probability - outcome)^2, outcome 0 or 1. Lower is better. |
| `brier_skill` | 1 - `brier` / (base_rate x (1 - base_rate)), i.e. against always predicting the account's own base rate. Above 0 beats that baseline. NULL when the base rate is 0 or 1. |
| `ece` | Expected calibration error. Only available for `prediction_log` predictors. |

Sources:

1. `prediction_log`, through the existing `predictor_calibration_v` (reused, not re-implemented). Predictor key is `prediction_log:<predictor>`.
2. First-time-fix predictions (`ftf_predictions`) paired with the job's recorded outcome (`job_outcomes`). Predictor key `first_time_fix`. The pairing rule (outcome is first-visit fix with no callback, rework excluded, prediction no later than the outcome) mirrors `eval_plane_pairs('first_time_fix')` in `20270315000000_intelligence_evaluation_plane.sql`; that function is per-owner and cannot be used across accounts, so the rule is repeated in one place here and must be kept in sync.

Other prediction tables are left out on purpose. `pio_predictions` is rewritten in place on every rescan, so its stored probability is not the probability that was acted on and an accuracy score against it would be misleading.

### 4.2 Contribution: `moat_cohort_contribution_v`

| Column | Definition |
| --- | --- |
| `capture_enabled`, `share_cross_tenant` | From `outcome_learning_settings`; false when no row exists. |
| `benchmark_participating` | From `outcome_benchmark_settings`; true when no row exists (same default as `ob_is_participating()`). |
| `learnable_outcomes_n` | `agent_action_outcomes` with an attribution rule, not excluded from learning, outcome not `unknown`, no attribution conflict. |
| `contributed_outcomes_n` | `learnable_outcomes_n` when the account has both `capture_enabled` and `share_cross_tenant`, else 0. This is the filter `build_outcome_aggregates` applies per tenant. |

`contributed_outcomes_n` is **eligible** contribution. Published aggregates also require cohort floors (at least 5 tenants, minimum sample, no dominant tenant), and the rows actually used are stored under salted references that this view deliberately does not join back to accounts.

### 4.3 Joined: `moat_network_effect_v`, and what the RPC reports

Per predictor and model version, among accounts with at least `p_min_n` resolved predictions (default 30, the repository's existing minimum cell size) and a defined Brier skill: the number of accounts used and left out, resolved predictions used, contributing vs other accounts, the median Brier skill of each group, and the Pearson correlation between `contributed_outcomes_n` and `brier_skill`. It also returns `cohort_growth` (per computed day: number of published signals, min and max tenant count, total sample), taken from the anonymous `outcome_cross_tenant_aggregates` table.

### Caveats

1. **The loop is not closed, so no network effect should be expected yet.** As of the snapshot reviewed: nothing calls `record_prediction` or `resolve_prediction`, so `prediction_log` is empty in production; and nothing in `src/` or the edge functions reads `outcome_cross_tenant_aggregates`, so no prediction consumes the cohort's data (`docs/intelligence/vrn-verification.md` L1, L2, L7; the second finding is from a repository search by the author of this change). The first-time-fix source is the only one likely to hold data. **[VERIFY]** against the live codebase and database before drawing any conclusion. Until a predictor consumes cohort data, a flat or null correlation is the expected result, and a positive one would be a coincidence of account size.
2. **Association, never cause.** Accounts with more resolved outcomes contribute more and also have lower-variance scores; larger and more mature accounts differ in many other ways; opting in is self-selected. The correlation cannot show that contribution improves accuracy.
3. **A causal test needs an experiment.** The repository already has `outcome_experiments` and `assign_experiment_arm`. A valid design would randomise whether a predictor receives cohort priors and compare Brier skill between arms. Not built here.
4. **Small samples.** Accounts below `p_min_n` are counted but excluded from statistics. A correlation over a handful of accounts is noise; the RPC returns the accounts-used count next to every statistic and NULL where a statistic is undefined.
5. **Time is not covered.** Opt-in history is not stored, so contribution is a snapshot. Comparing accuracy over time against `cohort_growth` is possible outside the database but confounded by model changes.
6. **Brier skill is relative to each account's own base rate**, so accounts with different base rates are on a common scale but not a common difficulty.

## 5. Reading the output (RPC shape)

`staff_moat_metrics(p_min_n integer default 30, p_active_only boolean default true)` returns `jsonb`:

```
generated_at, definition_version (1), min_n, active_only
switching_cost   { accounts_n, with_integration_n, with_automation_n, with_history_n,
                   integrations_n{p25,p50,p75,max}, automations_n{...}, history_days{...}, components_total{...} }
network_effect   [ { predictor_key, model_version, accounts_total_n, accounts_below_min_n, accounts_used_n,
                     resolved_n_used, contributing_accounts_used_n, other_accounts_used_n,
                     brier_skill_median_contributing, brier_skill_median_other, corr_contribution_vs_brier_skill } ]
cohort_growth    [ { computed_on, signals_n, tenant_count_min, tenant_count_max, sample_n_total } ]   (up to 90 days)
data_quality     { prediction_log_rows, prediction_log_resolved_rows, accounts_with_resolved_predictions_n,
                   first_time_fix_pairs_n, accounts_opted_in_n, accounts_with_contribution_n,
                   published_aggregates_rows, history_older_than_account_n }
```

Read `data_quality` first. If `prediction_log_resolved_rows` is 0 and `first_time_fix_pairs_n` is small, the network-effect section is empty or meaningless, which is itself the finding.

## 6. Not built (and why)

- No admin card or TypeScript layer: not requested. When one is added it should follow `NorthStarTreeCard` (i18n, RTL, all states) and keep ratios and labels out of SQL.
- No composite "moat score": it would require invented weights.
- No usage-based lock-in signals (sync freshness, automation run counts): need decisions on what counts as active.
- No external benchmarks or competitor comparison: no verified source in the repository.

## 7. Verification status and checklist

| Check | Status |
| --- | --- |
| Table and column names used by the SQL read against the migrations in the snapshot | Done by inspection (static) |
| Migration executed on Postgres | **NOT RUN** (no database) |
| `moat_metrics.test.sql` (31 assertions) | **NOT RUN** |
| Query performance | **NOT MEASURED** |
| Snapshot is current | **[VERIFY]**: the uploaded ZIP is an older snapshot; re-check the table list in `20290311000000_moat_metrics.sql` against the live schema |

Manual checklist: apply the migration on a scratch database after all its dependencies; run `supabase test db` and expect 31 passes; call `select public.staff_moat_metrics();` as a staff user and read `data_quality` first; as a normal user confirm `forbidden`; on production-sized data time the call and apply the index note in the migration header if needed.
