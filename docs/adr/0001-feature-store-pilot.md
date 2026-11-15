# ADR 0001 — Feature store: audit result and pilot decision

- **Status:** Accepted (pilot only)
- **Scope:** the engines that turn equipment / job history into a score or probability
- **Evidence base:** the `vireek-main` snapshot available when this was written. Line numbers are from that snapshot and may have moved in the live repo **[VERIFY]**.

## 1. Question

The task rule: *if fewer than three engines compute overlapping features, record "do not build a feature store" and stop; otherwise pilot a point-in-time `ml_feature_snapshots` table for one engine.*

## 2. Audit

"Engine" here means a module that derives a prediction or score from entity features. Almost all are deterministic or statistical (Weibull hazard, weighted rules, empirical-Bayes), **not trained models**. There is no training pipeline today.

| Feature family | Engines that compute it independently |
|---|---|
| Equipment age / lifespan used (`install_date`, `expected_lifespan_years`) | PFN `_shared/predictive-failure/engine.ts`; `_shared/equipment-lifecycle/score.ts`; `src/lib/homeHealthScore.ts`; `src/lib/eventPredictionMeshApi.ts`; `src/lib/riskIntelligence(Api).ts`; `_shared/property-intelligence/scoring.ts` — **6** |
| Months since last service vs. interval | PFN; equipment-lifecycle; homeHealthScore; eventPredictionMeshApi — **4** |
| Repairs / callbacks in trailing windows | PFN; equipment-lifecycle; homeHealthScore; eventPredictionMeshApi; riskIntelligence; property-intelligence — **6** |
| Weather heat/cold pressure | PFN; Event Prediction Mesh — 2 |

Other scorers (`durationModel`, `fragilityScore`, `marginModel`, `selfEvolvingModel`) use different, mostly non-overlapping inputs.

**Result: ≥3 engines share features → the "do not build" branch does not apply.**

### Divergence already present (the actual cost of not sharing)
- Two exported functions named `monthsBetween` with different meaning: PFN returns fractional months (30.4375-day months); `equipment-lifecycle/score.ts` returns whole calendar months using local-time getters.
- Missing lifespan: PFN and the Mesh fall back to 15 years; `equipment-lifecycle` and `homeHealthScore` treat it as "no data". The same unit can therefore be "15-year-life" in one engine and "unknown" in another.
- Each engine re-implements age arithmetic (365.25-day years in five places).

## 2b. What was not found
No evidence that any engine's past inputs can be reproduced: `pfn_forecasts` keeps probabilities, factors and a summary `evidence` blob, but not the full input vector, and job/equipment rows are mutable. Calibration and back-tests therefore cannot be replayed point-in-time.

## 3. Decision

**Do not build a general feature store now.** There is no model-training pipeline, no online-serving latency problem and no second consumer asking for shared features at runtime.

**Do build a narrow pilot:** an append-only, tenant-scoped, point-in-time log of the exact feature vector each PFN forecast used — table `ml_feature_snapshots` (migration `20290305000000`), builder `supabase/functions/_shared/feature-snapshots/pfn.ts`, written best-effort from `supabase/functions/predictive-failure/index.ts`.

Why PFN: it is the only engine that already scores itself against real outcomes (`pfn_forecasts.outcome`, calibration bins), so reproducible inputs have an immediate use.

## 4. Consequences
- Forecasts become replayable (`predictUnit()` on a stored snapshot reproduces the stored forecast — tested) and back-test sets can be built without look-ahead (`ml_feature_snapshot_as_of()` returns only `as_of <= t`).
- Derived features are pinned to the engine by tests, so engine changes that would skew the log fail CI.
- Cost: one JSON row (≤ ~tens of KB) per *issued* forecast. Units skipped for lack of evidence, and forecasts that were unchanged, are not logged (documented selection effect).
- Snapshots contain equipment attributes and service history, no customer identity. **Retention period and lawful basis: [COUNSEL].** A service-role purge function exists; nothing schedules it.

## 5. Non-goals (pilot)
Other engines, a feature registry, online serving, backfill of historical forecasts, a UI, cross-tenant sharing. Do not extend the table to another engine until the exit criteria below are met.

## 6. Exit criteria (decide to extend, freeze or drop)
Review after **≥ 90 days of data or ≥ 1,000 snapshots, whichever is later**, **[VERIFY thresholds with the owner]**:
1. At least one real use: a back-test or calibration run built from snapshots.
2. Storage/latency impact measured and acceptable.
3. A second engine (candidate: equipment-lifecycle score) needs the same age/service features → promote a shared, tested feature module and log it through the same table.
If none holds, freeze writes and keep the table read-only.

## 7. Verification (sandbox, this change)
Vitest 20/20 new tests + 17/17 existing PFN tests; pgTAP 24/24 and migration applied twice on PostgreSQL 16 with Supabase-style role stubs. Not run: Deno edge function, real Supabase, `supabase test db`, project typecheck/lint.
