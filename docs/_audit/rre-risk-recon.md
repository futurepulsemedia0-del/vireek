# RRE risk recon (Phase 0, read-only)

Source: the uploaded ZIP `vireek-main (8)`. Everything below was read from those files. Nothing was executed against a database.

## Where the probabilities come from (verified, not assumed)
- **Remote Resolution Engine score** (`supabase/functions/_shared/remote-resolution/score.ts`, `scoreCase`): `p = w*raw + (1-w)*prior`, with `w = 0.35 + 0.55*completeness`.
  - `raw` = share of the **LLM-proposed** hypotheses flagged `remote_fixable && !needs_parts` (the LLM supplies likelihoods and flags).
  - `prior` = `blendedPrior`: hand-set `DEFAULT_PRIORS` (comment in code: "conservative guesses, NOT industry statistics") shrunk toward the account's observed per-category rate (`rr_category_rates`, strength 10).
  - Penalties are hand-set constants (0.04 per conflict up to 0.12; x0.8 per failed step). **Nothing is fitted.** The score is not a calibrated probability.
- **Resolution Probability Engine** (`src/lib/resolutionProbability.ts`): smoothed history prior + bounded hand-set log-odds adjustments per dimension (weights, clamps, interaction -0.25). Also not fitted. `computeCalibration` only *reports* Brier/buckets; it never changes the model. This engine is dispatch-side and is not what gates remote attempts.
- **Decision** (`decide`): `troubleshoot` when `probability >= attempt_threshold` (account setting, default 55, 20..95). The safety screen (`screenSafety`, regex) runs earlier and returns dispatch with reason `safety`.

## Outcome data that exists
- `remote_resolution_cases`: `attempt_probability` (frozen at first entry to `troubleshooting`), `status` (`resolved_pending`, `resolved_remotely`, `dispatch_required`, `reopened`, `expired`, `withdrawn`), `resolved_at` (customer confirms fix), `verification_until`, `verified_at`, `reopened_at`, `dispatch_reason` (incl. `customer_not_fixed`).
- `jobs.is_rework` / `rework_of_job_id`: set by trigger `set_job_rework_flag` on INSERT when the same customer (id or phone) + same `service_type` has a job completed within 45 days (or in warranty).

## How a false resolution is detectable today
1. Customer or staff **reopens** (`rr_customer_reopen`, allowed up to 30 days after `verified_at`; staff any time) -> `status = reopened`, `reopened_at`.
2. A **later job** linked via `rework_of_job_id` to the remote-closed job.
3. `customer_not_fixed` is **not** a false resolution: it is a failed attempt caught before closing.

## Honest gaps
- The existing "success rate" (`rr_category_rates`, stats RPC) counts `resolved_remotely` (72 h after the fix by default) as success although reopening is allowed for 30 more days -> it **underestimates failures** (right-censoring) and feeds the prior.
- The rework trigger matches customer + service type, **not equipment**, and only if the earlier job has `completed_at`; whether `rr_close_job_remote` sets it depends on a trigger that must be checked in a real database (**unverified**).
- `rr_flush_case` (pending -> remotely) runs lazily when a case is touched, not on a schedule.
- No decision-time `attempt_threshold` was stored. The layer logs it from now on; older cases use the current setting (flagged as `assumed_current`).
- The score depends on LLM output, so a model or prompt change shifts the score distribution.
- Customers who call another company or say nothing are invisible.
