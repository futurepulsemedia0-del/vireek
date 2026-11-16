# Cross-tenant data flows (register)

> **Status: DRAFT for counsel and product review. Not legal advice.** Built from a static read of the `vireek-main` snapshot
> (migrations, edge functions, `src/`). **No SQL was executed against a database for this register**; anything that depends on
> deployed state is marked **[VERIFY]**, anything that needs a legal decision is marked **[COUNSEL]**.
> Companion files: `supabase/migrations/20290305000000_cross_tenant_consent_enforcement.sql`,
> `docs/compliance/cross-tenant-terms-draft.md`, `supabase/tests/database/cross_tenant_consent.test.sql`,
> `scripts/compliance/cross-tenant-consent.test.mjs`.

## 1. Scope and method

A **cross-tenant flow** is any path where data produced by tenant A changes what tenant B (or an external party) sees or what an AI
prompt for tenant B contains. Method: grep of all 780 migration files for aggregation / cohort / pooled / network markers and
permissive `USING (true)` policies; full read of every function that scans more than one tenant; grep of `supabase/functions` and `src`
for callers and consumers. "Tenant" = account owner (`get_account_owner_id()`).

**Not in scope:** staff/operator access to tenant data (tenant success tooling, staff explorer, impersonation) — covered by
`docs/security/` and `docs/compliance/policies/access-control.md`; sub-processor transfers — covered by `data-map.md`.

## 2. Consent model that already existed (reused, not duplicated)

`20270215000000_service_data_exchange.sql` (SDE) provides: `sde_consents` (per account × domain: `failure | equipment | pricing | labor | parts | outcomes`),
append-only `sde_consent_events`, owner-only `sde_set_consent()`, a contribution ledger, and give-to-get reads. Its own builder
(`sde_refresh_exchange`) joins consent live and rebuilds every cohort from scratch. UI: `src/pages/ServiceDataExchangePage.tsx`.
**Gap found:** the older pipelines were never wired to it (the SDE header says so itself), and four of them default to opt-out.

## 3. Register

Legend — **Before / After**: consent state of the *contribution* side. k = minimum distinct contributing tenants.
Flow keys in backticks are the keys in `cross_tenant_flows` (the registry used by the gate).

### 3a. Flows brought under the central gate by this change

| Flow key | Source tables | Transform / output | k and disclosure control | Purpose | Before | After |
|---|---|---|---|---|---|---|
| `benchmark_cohorts` | `leads, quotes, calls, jobs, business_profile` | One number per tenant per metric, then mean/stddev/p10–p90 per industry × size tier → `benchmark_cohort_stats`; also fires `benchmark.gap_detected` events to the tenant | k = 5; jitter ∝ stddev/√n (DP-*inspired*, not formal DP); no min/max; **no dominance cap** | In-product "how do I compare" (`BenchmarksPage`); consumed by `quote-truth-engine` and `market_intelligence_mesh` | **None** (every owner) | SDE `outcomes` |
| `regional_demand` | `calls, leads, business_profile` | **Raw sums** per industry × normalized `service_area` → `regional_demand_snapshots` | k = 5; **no noise, no dominance cap** [VERIFY: one large tenant can dominate a 5-tenant segment] | Demand trend (`regional-demand-insight`, `staffing-forecast`) | **None** | SDE `outcomes` |
| `platform_benchmarks` (legacy) | `leads, jobs, calls, payment_requests` | Per-tenant metric → median/p25/p75/avg → `benchmark_snapshots` | k = 5 (per-tenant minimum 3–5 records); no noise | Legacy `src/lib/benchmarks.ts`; duplicates `benchmark_cohorts` | **None** | SDE `outcomes` (partial wording fit) |
| `outcome_benchmarks` | `jobs` outcomes via `compute_outcome_metrics` | p10–p90 per trade × US state → `outcome_benchmark_cohorts` | k = 5; one shared jitter per row | Outcome benchmark page; its cohort data is sent to an LLM (`outcome-benchmark-advisor`) | **Opt-out** (`participating DEFAULT true`) | Legacy flag **and** SDE `outcomes` (also on the read side) |
| `failure_genome` | `failure_genomes, equipment_failure_events` | Failure-pattern rates by model × age × climate → `failure_patterns` | k = 5, ≥ 20 units, dominance ≤ 60 % | Emerging-failure detection; **also an aggregate feed to approved OEM / distributor / insurer partners (`failure_genome_partners`)** [COUNSEL] | **Opt-out** (`failure_genome_contribute DEFAULT true`) | Legacy flag **and** SDE `failure` |
| `fie_patterns` | `fie_actions, fie_observations` | Success rate per make/model × diagnosis/part → `fie_global_patterns` | **k = 3 accounts and 5 observations** (weaker than the platform's 5) [COUNSEL] | Field Intelligence page | **Opt-out** (`contribute_to_network DEFAULT true`) | Legacy flag **and** SDE `failure` |
| `service_loop_priors` | `job_outcomes` | Cause shares / fix rates per playbook × job type → `service_loop_global_priors` | k = 5, ≥ 20 weighted cases | `sil_get_priors`, called by `diagnosis-copilot` [VERIFY: how priors enter the LLM prompt] | **Opt-out** (`share_global DEFAULT true`) | Legacy flag **and** SDE `failure` |
| `vertical_intelligence` | `calls` (AI-extracted objections, intents, upsells) | Counts/rates per industry × **free-text phrase** (≤ 200 chars) → `vertical_intelligence_signals` | k = 5 tenants per phrase. **Free-text keys can still be identifying** [VERIFY] | "Vertical AI" signals page | **None** | **Unmapped → closed** (see §5) |
| `causal_cohorts` | `causal_outcome_tracking, causal_scenarios` | p25/p50/p75 of measured revenue impact per decision category | k = 5, no dominance cap | Fed to the `causal-world-simulator` LLM | **None** | **Unmapped → closed** |
| `rebate_realization` | `rebate_applications` | Decided / approved counts per program | **≥ 5 decisions from ≥ 3 accounts** | `rebate-intelligence` realization rate | **None** | **Unmapped → closed** |

Derived consumers with no direct cross-tenant read (they inherit the gate): `market_intelligence_mesh` (reads `benchmark_cohort_stats`
and `regional_demand_snapshots` plus the tenant's own data), `quote-truth-engine`, `staffing-forecast`, `uncertaintyMap`.

### 3b. Flows verified as already opt-in (not changed)

| Flow | Consent object (default) | k / controls | Revocation behaviour | Notes |
|---|---|---|---|---|
| Service Data Exchange (`sde_*`) | `sde_consents` (none) | k ≥ 5 (pricing 8), cap 25 events/account, dominance 40 %, noise, counts rounded to 5 | Full rebuild nightly | Reference implementation |
| Failure Atlas | `failure_atlas_consent` / `failure_atlas_participation` (`false`) | k ≥ 5 businesses, ≥ 20 units, dominance 40 %, bucketing | Rebuilt from scratch | **Two generations** (`20270215…` and `20270301…`) define the same objects; replay order is **[VERIFY]** (same function name, different parameter names) |
| OEM model reliability | reuses `failure_atlas_consent` | k ≥ 5, 20 units, dominance caps | Rebuilt | Hard-fails if Atlas consent table is missing |
| Evidence Marketplace | `evidence_sharing_consent` (`false`, versioned, append-only log) | k ≥ 5 and ≥ 30 obs, dominance 40 %, immutable content-hashed releases, give-to-get | Future releases only; **released aggregates cannot be disaggregated** [COUNSEL] | External partners receive releases |
| Outcome learning aggregates | `outcome_learning_settings.share_cross_tenant` (`false`) | k ≥ 5, dominance ≤ 50 %, n ≥ 30; salted tenant ref in audit | Future builds; earlier aggregate rows persist | |
| Voice pooled priors | `voice_autopilot_settings.pooled_priors_opt_in` (`false`) | k ≥ 10 accounts, own account excluded | **Fixed by this change** (contributor's *current* opt-in now required) | Previously only the caller's flag was checked |
| State of Home Service Calls report | `report_contribution_settings` + `report_consent_events` (none) | k ≥ 10 orgs, ≥ 100 events, dominance, complementary suppression, census-region geography | Excluded from future builds; **published editions are frozen** [COUNSEL] | Public output; legal + fact-check gate |
| Directory-style networks (capacity exchange, labor sharing, mutual aid, contractor hub, skill liquidity) | `business_profile.network_enabled` (`false`) | Not statistical: identity-bearing listings visible to other opted-in tenants | Leaving the network removes listings from future queries | Different purpose from learning; terms should say so [COUNSEL] |
| Physical economy network | `pen_nodes.consent_version` (explicit) | Directory | — | |
| Procurement network | `share_volume_consent` (`false`) | **k = 3** (`pn_min_cohort()`) [COUNSEL] | Opt-out stops pooling | |

### 3c. Reviewed and judged not to be tenant-to-tenant learning

`continual_identity_learner` (`USING (true)` only on a static catalog), outcome clearinghouse (per-record public tokens, opt-in per record),
pricing learning flywheel (own-account only), community forum (user-authored posts visible to all authenticated users by design — **[COUNSEL]** for
content moderation and personal-data in posts), reference catalogs (OEM, trade packs, refrigerant GWP, …).
Read by header/grep only, not line-by-line: `franchise_*`, `capacity_demand_control`, `customer_lifecycle_touches` [VERIFY].

## 4. Enforcement design

* **Single registry** `cross_tenant_flows (flow_key → sde_domain, wording_fit)`; no client access.
* **Fail-closed gate** `xtl_contributors(flow)` / `xtl_contributes(user, flow)`: true only for `sde_consents.status = 'granted'` on the mapped domain.
  Missing row, revoked, unknown flow, unmapped flow and NULL user all return false. Not executable by `anon`/`authenticated` (it would reveal another tenant's consent).
* **Evaluated on every build** (a live join, never a cached flag), so revocation takes effect on the next build of each flow.
* **Legacy opt-out flags stay** as an extra off-switch (a tenant must pass both).
* **Stale rows are removed**: `refresh_benchmark_cohorts` now deletes every row not rewritten in the run (the old 14-day history could have kept a revoked tenant's data for two weeks);
  `compute-regional-demand` and `compute-benchmarks` edge functions now delete rows not rewritten in the run (previously a segment that dropped below k was never removed).

## 5. What changes for customers (read before deploying)

1. **Cohorts shrink to consenting tenants.** Until ≥ 5 tenants grant the mapped domain, k-anonymity suppresses output: benchmarks, regional demand and failure patterns can appear empty. Expected.
2. **Three flows are closed** (`vertical_intelligence`, `causal_cohorts`, `rebate_realization`): no existing consent wording covers them. To open one after product and counsel approve wording **and re-consent**:
   `UPDATE cross_tenant_flows SET sde_domain = '<domain>' WHERE flow_key = '<key>';` **[COUNSEL]**
3. The SDE UI text for `outcomes` and `failure` should enumerate the metrics now covered (see `wording_fit = partial`). The consent terms version (`sde_terms_version()`) is **not** bumped by this change; bump it only with counsel-approved wording.

## 6. Revocation semantics (what is and is not guaranteed)

| Aspect | Behaviour |
|---|---|
| New cohorts | Revoked tenant excluded from the next build of every gated flow (live join) |
| Already-published aggregates | Replaced at the next build; up to one build interval (nightly for most flows) **[VERIFY schedules in the live project]** |
| Published *external* artifacts (Evidence releases, State-of-Calls editions) | Cannot be recomputed without the tenant; wording must say so **[COUNSEL]** |
| Raw per-tenant data | Never persisted by the gated builders (temp tables / per-run aggregates) except `voice_prior_contributions` (successes/trials per experiment, `user_id`-keyed) |
| Audit | SDE writes `sde_consent_events` (append-only). Legacy flags (`failure_genome_contribute` etc.) keep **no** history |
| Account erasure | `sde_consents` cascades from `profiles`; derived aggregates cannot be disaggregated |

## 7. Deploy and verification checklist

1. Apply `20290305000000_cross_tenant_consent_enforcement.sql` on staging; run `supabase test db` (the repo's `migrations.yml` db-reset job is **non-blocking and currently fails to replay the baseline**, so run the test file by hand if CI cannot).
2. After deploy, run each builder once (so stale cohorts are replaced immediately): `select public.refresh_benchmark_cohorts(); select public.refresh_outcome_benchmarks(); select public.refresh_service_loop_global_priors(); select public.fie_refresh_global_patterns(); select public.refresh_failure_patterns();` and invoke the `compute-benchmarks` and `compute-regional-demand` edge functions.
3. Confirm with two staging tenants: grant → appears; revoke → absent after the next run.
4. `node --test scripts/compliance/cross-tenant-consent.test.mjs` (static, no DB).

## 7b. Open items

* **[COUNSEL]** Terms wording: `docs/compliance/cross-tenant-terms-draft.md`. Lawful basis, controller/processor role for derived aggregates, and whether aggregates of ≥ k tenants are "personal data" or "customer data" under the DPA.
* **[COUNSEL]** k = 3 (procurement, FIE, rebate) vs 5 elsewhere; whether to raise.
* **[VERIFY]** Regional demand raw sums without dominance cap; free-text keys in `vertical_intelligence_signals`.
* **[VERIFY]** Failure Atlas migration replay order; live cron schedules; whether any tenant already has explicit SDE consent.
* Not implemented here: UI changes (the SDE page exists; its copy is hard-coded English and not i18n-keyed — pre-existing), a "per-flow" consent granularity, and a consent-version check at read time.
