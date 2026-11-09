# Smart dispatch optimizer (suggestions only)

Default **OFF**. Visible only when BOTH are true: feature flag `dispatch_optimizer` is on for the tenant AND `dispatch_optimizer_settings.entitled = true` (staff-granted via `staff_set_dispatch_optimizer_entitlement`). With either off, the Dispatch Board renders and behaves exactly as before.

## Code map
- Engine (pure, deterministic, no I/O; also runs in Deno): `src/lib/dispatchOptimizer/` — `model.ts` (constraints + cost), `solver.ts` (constructive insertion + seeded local search), `evaluate.ts` (replay of an existing schedule), `suggestions.ts`, `explain.ts`, `whatif.ts`, `emergency.ts`, `travel.ts` (adapter), `inputBuilder.ts`.
- Server: `supabase/functions/dispatch-optimizer` (gate via `dispatch_optimizer_access()` as the caller; ids verified per account; settings read from DB; append-only audit).
- Client: `src/lib/dispatchOptimizerApi.ts`, `src/components/dispatch/OptimizerPanel.tsx`, mounted in `DispatchBoardPage`.
- DB: `supabase/migrations/20290301000000_dispatch_optimizer.sql` (rollback notes in the header).
- It extends, not replaces, `dispatchIntelligence.ts` (reuses its geometry and travel model) and applies moves through `evaluateMove` + `useJobMoves.commit` (conflict check + Undo).

## Model
Hard: skills, certifications (blocking credentials), shifts (time off removed), customer arrival windows, per-shift capacity, overtime cap, fixed/locked jobs, optional hard parts (`partsPolicy=hard`) and hard SLA (`slaHard`). Soft (cost): driving time, SLA lateness/risk, overtime, workload fairness, missing parts, revenue of unscheduled jobs, churn (`stabilityPenalty`, used by emergency re-plans). Weights per account: revenue, travel, slaRisk, overtimeFairness (0–10). Cost scale is documented in `COST` (`model.ts`).
Simplifications: no return-to-base leg; one start point per technician; a technician with no listed skills is treated as a generalist; times use the browser's local zone.

## Determinism and speed
Same input + seed ⇒ same output. The edge function adds a 1.5 s wall-clock valve; if it fires the response says `truncatedByTime` (result then not bit-reproducible). 200 jobs × 50 technicians: see benchmark.

## Routing adapter
Engine uses a synchronous `TravelFn`. `buildTravelFn(points, provider)` awaits a `TravelProvider` first and falls back to the offline straight-line estimate on any failure. No provider that needs credentials is bundled; the edge function currently uses the offline estimate and says so. To add one: implement `TravelProvider`, keep API keys in edge-function secrets (never in code), then pass it to `buildTravelFn` in the edge function. Not scraped, no data leaves the account except the coordinates sent to the provider you choose (**REQUIRES COUNSEL** for privacy/regulatory review of that provider).

## Tests and benchmark
`npx vitest run src/lib/dispatchOptimizer` · `node --experimental-strip-types scripts/dispatch-optimizer-benchmark.ts [--jobs 200 --techs 50 --seeds 10 | --input history.json]`.
Property tests use the repo's own seeded generator (fast-check is not a dependency); an independent verifier re-checks every hard constraint.
The default benchmark baseline is a synthetic "manual dispatcher" stand-in — it proves the engine beats a naive plan, not that it saves a given customer money.

## Not covered / follow-ups
Road-time provider; bulk "apply plan" (suggestions are applied one at a time on purpose); multi-day re-arrangement beyond the 2-day horizon; staff UI to toggle the entitlement (use the RPC); i18n of panel strings; Playwright E2E.
