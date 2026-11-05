# Causal Dispatch Loop

Dispatch scoring is observational: the best technicians get the hardest jobs, so their raw results cannot say who is
really better. This feature randomizes ONLY among technicians the rules already treat as interchangeable, logs the true
assignment probability, and later estimates causal technician × job-type effects from those draws.

Everything is **off by default, per account** (`dispatch_exploration_settings.enabled = false`).

## Moving parts

| Piece | File |
|---|---|
| Feasibility (read-only) | `supabase/migrations/20281102000000_dispatch_indifference_feasibility.sql` → `select public.dispatch_indifference_feasibility(3, 90, array['auto']);` |
| Schema + settings + append-only | `supabase/migrations/20281102000100_causal_dispatch_loop.sql` |
| Indifference set (pure) | `supabase/functions/_shared/dispatch/indifferenceSet.ts` |
| Seeded selector, exclusions, guardrail maths (pure) | `supabase/functions/_shared/dispatch/exploration.ts` |
| Settings / state / auto-disable (I/O, edge only) | `supabase/functions/_shared/dispatch/explorationPolicy.ts` |
| Outcome maturity for the guardrail | `supabase/functions/_shared/dispatch/outcomes.ts` |
| Integration (fallback-safe) | `supabase/functions/_shared/dispatch/rulesAssign.ts` |
| Estimator + provenance + suggestions (pure) | `src/lib/causalDispatch.ts` |
| Data access, settings, provenance store | `src/lib/causalDispatchApi.ts` |
| UI | `src/components/dispatch/CausalDispatchCard.tsx`, `CausalProvenanceBadge.tsx` |

## Deploy order

1. Apply both migrations (feasibility first, then `causal_dispatch_loop`). The second one also repairs the
   `dispatch_decisions` schema conflict: before it, the rules engine's audit inserts failed silently.
2. Deploy the edge function (`dispatch-auto-assign`). If it ships before the migration it still dispatches normally and
   falls back to logging without the new columns.
3. Ship the web app.
4. Turn the feature on per account (Dispatch board → "Learn who is really best") only after reading the feasibility number.

## How a decision is made

1. The rules engine ranks technicians exactly as before. The first eligible one is the deterministic pick.
2. Hard exclusions → deterministic pick, propensity 1: feature off, per-account kill switch, global kill switch
   (edge secret `DISPATCH_EXPLORATION_KILL_SWITCH=true`), automatic shut-off, emergency (service type / tags /
   `calls.is_emergency`), VIP customer, contracted SLA (`sla_response_hours`), First-Time-Fix Autopilot verdict
   `hold`/`review` on the top pick (or a failed verdict lookup), and anyone failing a `require` rule.
3. Indifference set = eligible technicians within `delta` score points of the top whose clean-completion rate (the FTF
   proxy available at the edge) is not more than `max_regret_pct` below the top's. Unknown history ⇒ not interchangeable.
   Technicians who already had `per_tech_weekly_cap` exploration picks this week sit out.
4. A seeded coin (hash of account + job + policy version) enrolls the job with probability `q = budget_pct`. Enrolled ⇒
   uniform pick inside the set. Each member's true probability is `q/k` (+ `1−q` for the top) and is logged.
5. The pick goes to `assign_technician_to_job()` first, so time-off, capacity and credential gates still apply. If a gate
   refuses it, the next deterministic candidate gets the job and the row is logged as `gate_fallback` (ignored by estimators).
6. Any error anywhere ⇒ the deterministic pick. Dispatch is never blocked.

Deliberate deviation from "propensity is 1.0 for every deterministic pick": a job that sat in a valid set but was not
enrolled still had probability `1−q+q/k` of the top pick, and the estimator needs that number. Picks where randomization
was impossible log exactly 1.

## Guardrails

* Budget: at most `budget_pct` of recent auto decisions may be randomized (also the enrollment probability).
* Per-technician weekly cap, per-job regret cap, kill switches (above).
* Auto-disable: on each batch, randomized vs not-enrolled jobs *inside valid sets* (a fair coin, so a causal comparison)
  are compared on 14-day first-time fix, mature jobs only. A drop ≥ tolerance **and** a one-sided 95% bound above 0
  switches the account off until an owner turns it on again. Detection latency is therefore ≥ 14 days.

## Estimation (no automatic changes)

`analyzeCausalDispatch()` uses only decisions whose probabilities are known (`explored`, `not_enrolled`), only mature
outcomes (`opsExperiments.observe`), only jobs still held by the drawn technician, and one decision per job.
Doubly-robust technician × job-type effects (FTF 14d, callback 14d / 30d, duration residual vs the conformal p50) get
empirical-Bayes shrinkage, 95% CIs and an A/B/C evidence grade. Each scoring factor is tagged
`validated_by_randomization`, `observational_only` or `contradicted` from the within-set slope of FTF on factor points.
Weight changes are suggestions only; an owner must open the suggestion, confirm, and the normal rule save runs.

## Known limits

* FTF proxy at the edge is the clean-completion rate (needs ≥ 5 completed jobs); the full autopilot model lives in the
  browser. Technicians with less history are never randomized into a set.
* Duration residual needs scored rows in `job_duration_predictions`; without them it is simply not reported.
* Reassigned jobs are excluded from estimation (their outcome belongs to another technician). If dispatchers override
  exploration picks often, estimates lose power and the card shows how many rows were skipped.
* Explore rows exist only for accounts that switch the feature on; expect the first usable estimates ~1–2 months later
  (callback windows must elapse).
