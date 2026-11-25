# Verified Resolution Network (VRN)

> Status: DRAFT. Items marked `TODO(owner)` / `TODO(counsel)` must be filled by a human. Nothing here is a published claim until those are closed.

## 1. What is "verified"
A job counts as a **verified resolution** only if ALL hold (same definition as `compute_outcome_metrics()` in `20270301000000_outcome_benchmark_network.sql`):
- `jobs.job_status = 'completed'` and `is_rework = false`
- 14-day maturity has passed (completion date <= window end - 14 days)
- No rework job (`rework_of_job_id = job.id`) was created within 14 days of completion

The network publishes three business-level outcome metrics only: first-time-fix rate, reservice rate, median response minutes (job created -> `first_response_at`).

Not verified / never published: customer satisfaction, revenue, prices, anything self-reported outside the job record.

## 2. Evidence standard
| Rule | Value |
|---|---|
| Source | Existing job records only (no manual entry, no import-only edits) |
| Per-business minimum | >= 5 samples per metric, else the business contributes nothing (never a 0) |
| Public minimum cohort (k) | 10 businesses (DB constant in `vrn_public_summary()`; internal benchmark stays at 5) |
| Freshness | Cohorts older than 72 h are shown as "stale" |
| Noise | Cohort percentiles carry small jitter (see benchmark migration). It is NOT a formal differential-privacy guarantee and must not be described as one |
| Insufficient data | Shown explicitly; no estimate, no interpolation, no placeholder number |

## 3. Participant rules
- Participation = `outcome_benchmark_settings.participating` (default true in code today). `TODO(owner)`: decide whether public-network contribution should become explicit opt-in before launch; if yes, add a separate flag (do not reuse the private-benchmark flag).
- Opted-out accounts contribute nothing from the next nightly refresh.
- Participation must not be sold or implied as a ranking, certification or endorsement of a business.
- No business names, ids, regions below US-state level, or per-business values are ever returned by the public RPC.

## 4. Privacy
- Public RPC reads only `outcome_benchmark_cohorts` (already aggregated, k-gated, jittered). No tenant table is readable by `anon`.
- Industry is free text from `business_profile.primary_industry`; only rows with >= k contributors are exposed. `TODO(owner)`: review the industry label list for identifying strings before launch.
- Region is not exposed publicly.
- `TODO(counsel)`: privacy-policy wording for public aggregate use of customer-business job data; DPA/terms basis; any state-law review.

## 5. Metrics (public methodology)
| Metric | Direction | Published as |
|---|---|---|
| first_time_fix_rate | higher is better | median + interquartile range across businesses |
| reservice_rate | lower is better | same |
| median_response_minutes | lower is better | same |
Windows: 30 and 90 days.

## 6. Operating metrics for the network itself
- Contributing businesses per metric (k-gated)
- Share of metric/window cells that clear k (coverage)
- Cohort freshness (max age of `computed_at`)
- Opt-out rate `TODO(owner)`: define target

## 7. Public copy
`TODO(owner)`: final headline, claims and any partner logos. The page currently states only methodology and live aggregates.
`TODO(counsel)`: disclaimer text if benchmarks are used in marketing.
