# Antitrust information-exchange review (competitively sensitive data shared across tenants)

> **Status: DRAFT for counsel and product review. Not legal advice.** Built from a static read of the `vireek-main` snapshot.
> Every tier assignment and every numeric threshold below is an **engineering proposal marked [COUNSEL]**. Facts that depend on
> the live project are marked **[VERIFY]**. The SQL in the companion migration was executed only against a local PostgreSQL 16
> with stub tables (see section 9); it has **not** been run against the real schema or a Vireek database.
> Companion files: `supabase/migrations/20290306000000_antitrust_info_exchange_guardrails.sql`,
> `supabase/functions/_shared/infoExchangeGuard.ts`, `supabase/tests/database/antitrust_info_exchange_guardrails.test.sql`,
> `scripts/compliance/antitrust-info-exchange.test.mjs`. Builds on `docs/compliance/cross-tenant-data-flows.md` (consent register); it does not repeat it.

## 1. Why this exists

Tenants on Vireek are frequently direct competitors (same trade, same metro). Pooling their numbers, even as aggregates, can
be a channel for exchanging competitively sensitive information, with price-related data the most sensitive. k-anonymity and
consent (already in place) address privacy; they do not decide **which metrics may be shared at all, how current they may
be, or at what geography**. This review inventories each shared metric, proposes a price-sensitivity tier, and drives
config-driven, fail-closed guardrails from that tier.

Whether any particular exchange is lawful depends on facts and jurisdiction. **[COUNSEL]** Nothing here is a legal conclusion.

## 2. Tiers (proposal, [COUNSEL])

| Tier | Meaning | Examples | Default posture |
|---|---|---|---|
| 0 | Operational quality; no pricing or volume signal | call score, first-time fix, response time | Publish at k >= 5 |
| 1 | Commercially sensitive, not price (volumes, demand, conversion, labor time) | regional call volume, lead conversion | k >= 5, single-tenant share <= 50 %, no postal-level geography |
| 2 | Price-adjacent (derived from realized prices or ticket size) | average paid ticket | **Blocked until counsel approves the metric**; then k >= 8, share <= 40 %, state level or coarser |
| 3 | Direct price, rate, cost, discount or pooled spend | median paid ticket, pooled procurement spend | **Blocked until counsel approves**; then k >= 10, share <= 25 %, region level or coarser |

Thresholds live in `ixg_guardrail_config` (editable without a deploy). The numbers are placeholders **[COUNSEL]**.

## 3. What was inspected and what was found

| Item | Finding |
|---|---|
| `20260923000000_cross_tenant_benchmarking.sql` | Six per-tenant metrics, then cohort percentiles by industry. k = 5 hard-coded, **no geography, no dominance cap, no data lag, no price tiering**; one metric (`avg_ticket_cents`) is a realized-price level. Has a known `GET DIAGNOSTICS` bug fixed by the later migration. |
| `20261205000000_deep_privacy_preserving_benchmarking.sql` | Adds size-tier cohorts, jitter (DP-*inspired*, not formal DP) and a nightly cron. Still k = 5 hard-coded and window ends **today** (no lag). The latest deployed definition of `refresh_benchmark_cohorts` is in `20290305000000_cross_tenant_consent_enforcement.sql` (adds the consent gate). |
| `capacity-demand-insight` | **Not a cross-tenant exchange.** Runs `run_capacity_demand_control` as the caller, scoped by `get_account_owner_id()`; the AI narrative receives only that account's status. No guardrail needed; a static test keeps it that way. |
| `supplier-price-feed` | **Not a cross-tenant exchange today.** A supplier key (hashed) writes catalog prices into exactly one tenant (`p_owner: key.user_id`); supplier tables have owner-only RLS and are read by no consent-gated builder (static test). **[COUNSEL]** Residual hub-and-spoke risk is commercial, not technical: a supplier relaying one customer's terms to another. The Procurement Network (`pn_*`) is the place where supplier prices and pooled volumes reach several tenants. |
| Readers of the cohort data | `quote-truth-engine` (reads `avg_ticket_cents`, `quote_acceptance_rate` to inform a quote) and `compute_market_intelligence` (SECURITY DEFINER, bypasses RLS). **[COUNSEL]** Feeding a cohort price level into a pricing recommendation is an algorithmic-pricing question, not only a disclosure one. |

## 4. Inventory of shared metrics

Columns: **Tier** (proposal [COUNSEL]); **Geo** = finest geography published; **Today** = controls before this change;
**Enforced by** = how the new guardrails reach it. "Doc only" means the metric is classified and registered, but its own
builder is **not** changed here (see section 6).

### 4.1 `benchmark_cohorts` -> `benchmark_cohort_stats` (industry x size tier; consent gate `outcomes`)

| Metric | Tier | Geo | Today | Enforced by |
|---|---|---|---|---|
| `lead_conversion_rate` | 1 | national | k = 5, jitter, no min/max | Write trigger + RLS read gate |
| `quote_acceptance_rate` | 1 | national | same | same. **[COUNSEL]** raise to tier 2 if acceptance is judged price-revealing |
| `missed_call_rate` | 0 | national | same | same |
| `avg_call_score` | 0 | national | same | same |
| `avg_lead_response_hours` | 0 | national | same | same |
| `avg_ticket_cents` | **2** | national | same | same; **hidden until counsel approves** |

### 4.2 `regional_demand` -> `regional_demand_snapshots` (industry x free-text `service_area`; consent gate `outcomes`)

Raw sums, no noise. All tier 1. Geo is whatever tenants type, classified by `ixg_geo_level()` (unknown or empty = finest).

| Metric | Tier | Additive | Today | Enforced by |
|---|---|---|---|---|
| `current_week_calls` | 1 | yes | k = 5, **no dominance cap** | Edge guard (`compute-regional-demand`), RLS, hourly purge |
| `prior_week_calls` | 1 | yes | same | same |
| `current_week_leads` | 1 | yes | same | same |
| `call_volume_change_pct` | 1 | no | same | same |
| `emergency_rate_pct` | 1 | no | same | same |

### 4.3 `platform_benchmarks` (legacy) -> `benchmark_snapshots` (written by `compute-benchmarks`)

| Metric | Tier | Today | Enforced by |
|---|---|---|---|
| `avg_invoice_amount` | **2** | k = 5, no noise | Edge guard; **blocked until counsel approves** |
| `lead_conversion_rate` | 1 | same | Edge guard |
| `emergency_call_rate` | 1 | same | Edge guard |
| `avg_payment_collection_hours` | 1 | same | Edge guard |
| `avg_call_duration_seconds` | 0 | same | Edge guard |
| `job_completion_rate` | 0 | same | Edge guard |

### 4.4 `outcome_benchmarks` (trade x US state; consent gate `outcomes` + legacy opt-out flag)

| Metric | Tier | Geo | Enforced by |
|---|---|---|---|
| `first_time_fix_rate` | 0 | state | Doc only |
| `reservice_rate` | 0 | state | Doc only |
| `median_response_minutes` | 0 | state | Doc only |

### 4.5 `service_data_exchange` (SDE; own builder with k = 5, pricing k = 8, 25-event cap, 40 % dominance, noise)

| Metric | Tier | Note | Enforced by |
|---|---|---|---|
| `median_paid_ticket_cents` | **3** | Median paid price per trade x service: the most price-revealing metric in the product. SDE already uses k = 8 and noise; **[COUNSEL]** whether it should be shared at all, at what lag, and at what geography | Doc only |
| `median_job_minutes` | 1 | Labor time, not rate | Doc only |
| `first_time_fix_rate_pct` | 0 | | Doc only |
| `attach_rate_pct` | 1 | Part attach rate per service type | Doc only |
| `demand_momentum_index` | 1 | Recent vs trailing volume | Doc only |
| `age_at_failure_years`, `service_calls_per_unit`, `rework_rate_pct` | 0 | Reliability | Doc only |

SDE `benchmark_intelligence` reuses the six metrics of 4.1 (same tiers apply).

### 4.6 `procurement_network` (`pn_*`; consent `share_volume_consent`)

| Metric | Tier | Today | Enforced by |
|---|---|---|---|
| `pooled_cents` | **3** | Pooled qualifying spend per supplier program; k = `pn_min_cohort()` = **3** | k only: `pn_min_cohort()` now reads config (flow override seeded at 3 to preserve behaviour) |
| `item_volumes` | **3** | Ordered/committed quantities per item | same |

**[COUNSEL]** Joint purchasing has its own analysis (purchase share, whether pooled purchase prices spill into downstream pricing).

### 4.7 Shared flows not in the registry (outside the price/volume question)

Failure Atlas, OEM reliability, failure genome, FIE, service-loop priors, voice priors, evidence marketplace, State-of-Calls report and
the directory-style networks are reliability, diagnostic or identity-bearing flows, covered in `cross-tenant-data-flows.md`. They carry no
price metric as far as the static read shows **[VERIFY]**. The directory networks (capacity exchange, labor sharing, contractor hub) are
identity-bearing listings and deserve their own counsel review **[COUNSEL]**.

## 5. Guardrails (config-driven, fail closed)

| Guardrail | Config column | Where evaluated | Fails closed when |
|---|---|---|---|
| Minimum cohort size | `min_cohort_size` (>= 3) | `ixg_evaluate` | cohort size missing or below minimum |
| Maximum single-tenant share | `max_single_share_pct` | additive metrics | share unknown or above cap |
| Data lag | `data_lag_days` | `period_end` vs today | lag > 0 and data date missing or too recent |
| Narrow-geography suppression | `min_geo_level` (finest allowed) | row geography and metric granularity | geography unknown, empty or finer than allowed |
| Counsel approval | `require_counsel_approval` + registry `counsel_status` | registry | tier 2/3 metric not `approved`; any `rejected` |
| Registration | `ixg_metric_registry` | always | metric not registered, disabled, or tier config row missing |

Precedence: `flow:<key>` config row overrides the metric's `tier:<n>` row. Approving a metric requires a reviewer name and date (CHECK).

## 6. Enforcement map and honest gaps

| Flow | Write side | Read side | Dominance | Lag | Geography |
|---|---|---|---|---|---|
| `benchmark_cohorts` | trigger (covers SECURITY DEFINER readers) | RLS | n/a: one value per tenant, ranked statistics | gate on `period_end` | n/a (national) |
| `regional_demand` | edge guard | RLS (k, geography) + purge | edge guard + purge (`ixg_regional_segment_shares`, call-volume weight) | not applicable to the current builder | edge guard + RLS |
| `platform_benchmarks` | edge guard | none (service-role table) | n/a | none | n/a |
| `procurement_network` | k via `pn_min_cohort()` | n/a | **not enforced** | **not enforced** | **not enforced** |
| `outcome_benchmarks`, SDE | **not wired** | **not wired** | SDE has its own 40 % cap | **not enforced** | **not enforced** |

Known limits:
1. **Lag is a gate, not a window shift.** Builders still compute windows that end today. A metric whose tier has `data_lag_days > 0` stays hidden until its builder uses `ixg_window_end(flow, metric)`. Defaults keep lag at 0 so published metrics are not silently lost; setting a lag is a counsel decision plus a builder change.
2. **Dominance is only computed for regional demand**, using call volume as the weight; lead sums are not weighed separately **[VERIFY]**.
3. **SDE, outcome benchmarks and procurement are classified, not gated** (own builders; re-creating them would risk diverging from the deployed definitions, which this snapshot may not match).
4. Jitter is not differential privacy and is not claimed to be.
5. The metric registry is a manual inventory. The static test catches drift against the known metric lists, not against future builders; add a registry row whenever a flow gains a metric.

## 7. Behaviour changes to expect

1. `avg_ticket_cents` and `avg_invoice_amount` stop being published until counsel approves them. `quote-truth-engine` already degrades when cohort context is empty. **[VERIFY]** BenchmarksPage empty state for that card.
2. Regional demand segments keyed by postal code, or by any unrecognized or empty area, are no longer visible or published; segments where one tenant holds more than 50 % of call volume are dropped.
3. If a config row is deleted, the affected metrics disappear rather than fall back to a default.
4. `compute-benchmarks` and `compute-regional-demand` return 503 and purge their published rows if the guard cannot answer.

## 8. Operating the guardrails

```sql
-- Approve a metric after counsel sign-off (reviewer and date are mandatory)
UPDATE ixg_metric_registry
   SET counsel_status = 'approved', counsel_reviewed_by = 'Name, firm', counsel_reviewed_at = now()
 WHERE flow_key = 'benchmark_cohorts' AND metric_key = 'avg_ticket_cents';
-- Tighten or loosen a tier
UPDATE ixg_guardrail_config SET min_cohort_size = 10 WHERE scope = 'tier:2';
-- Per-flow override
INSERT INTO ixg_guardrail_config (scope, min_cohort_size, max_single_share_pct, data_lag_days, min_geo_level)
VALUES ('flow:regional_demand', 8, 40, 0, 'metro') ON CONFLICT (scope) DO UPDATE SET min_cohort_size = EXCLUDED.min_cohort_size;
-- Apply immediately instead of waiting for the hourly purge
SELECT public.ixg_purge_published();
```
Staff can read config, registry and the last 50 suppression decisions through `ixg_admin_overview()`. The suppression audit stores flow, metric, cohort size and reasons only, no tenant identifiers.

## 9. Verification status

| Check | Result |
|---|---|
| Migration applied twice on local PostgreSQL 16 with stub tables | PASSED (idempotent) |
| pgTAP `antitrust_info_exchange_guardrails.test.sql` on the same stubs | PASSED, 75 of 75 |
| Dominance function with seeded data (75 % tenant dropped, 50 % kept, missing cap drops all) | PASSED (manual, local only) |
| Vitest `infoExchangeGuard.test.ts` | PASSED, 10 of 10 (run in an isolated project, not via the repo's `npm test`) |
| `node --test scripts/compliance/antitrust-info-exchange.test.mjs` | see final report |
| `supabase test db` against the real schema | **NOT RUN** (needs the real schema and the repo's baseline replay) |
| Edge functions on Deno / deployed | **NOT RUN** |

## 10. Counsel and product checklist

- [COUNSEL] Confirm or change every tier in section 4, especially `quote_acceptance_rate`, `median_paid_ticket_cents` and procurement volumes.
- [COUNSEL] Decide thresholds in section 2, a lag per tier, and whether tier 3 metrics are shared at all.
- [COUNSEL] Review consent wording for the `pricing` and `outcomes` SDE domains against this inventory.
- [COUNSEL] Algorithmic-pricing review of any feature that turns a cohort price level into a recommendation.
- [VERIFY] Live cron schedules, the deployed definition of `refresh_benchmark_cohorts`, and whether any tenant has granted `pricing` consent.
- Product: decide whether to build lagged windows (builder change) for any tier 2/3 metric counsel wants to keep.
