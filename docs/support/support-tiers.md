# Support tiers (by plan)

> Internal template. **Not a public promise or contract.** Every value marked `TODO(owner)` must be supplied by the founder; wording shown to customers needs `TODO(counsel)` first.
> Naming: a *support tier* is what a **plan** includes. It is separate from T1/T2/T3 (internal roles, [tier-model.md](tier-model.md)) and S1–S4 (ticket severity, [severity-matrix.md](severity-matrix.md)).

## Tier table
Plan → tier mapping lives in `src/lib/supportTiers.ts` (`PLAN_SUPPORT_TIER`) and SQL `support_tier_for_plan()`. Unknown plans fall to `community`.

| Tier | Plans | Channels | Hours | First response | Resolution target |
|---|---|---|---|---|---|
| community | Trial | Help center / AI assistant `TODO(owner)` | `TODO(owner)` | `TODO(owner)` | `TODO(owner)` |
| standard | Starter | + email | `TODO(owner)` | `TODO(owner)` | `TODO(owner)` |
| priority | Professional | + priority queue | `TODO(owner)` | `TODO(owner)` | `TODO(owner)` |
| dedicated | Business | + Slack channel | `TODO(owner)` | `TODO(owner)` | `TODO(owner)` |
| enterprise | Enterprise | + account manager, per contract | per contract `TODO(counsel)` | per contract `TODO(counsel)` | per contract `TODO(counsel)` |

Channel names come from the plan feature lists in `src/lib/pricing.ts` (Community / Standard email / Priority / Dedicated Slack channel / Dedicated account manager). Everything else is unset. Current human-monitoring window for chat/email: `src/lib/supportHours.ts` [VERIFY it is still accurate].

## How targets are stored and used
- DB: `support_tier_targets` (one row per tier, minutes, **NULL = not tracked**). Staff-only; edit in Supabase Studio or SQL: `update support_tier_targets set first_response_minutes = <n>, resolution_minutes = <n> where tier = '<tier>';`
- View: `support_tier_overdue_tickets` (staff only) lists open tickets past their tier target. Resolution clock is skipped while `awaiting_customer`.
- Clock start is `support_conversations.created_at` (change to `internal_clock_started_at` if your DB has it).
- Not wired into the staff inbox UI yet; the existing priority/severity clocks are unchanged.
- Pricing page shows the tier **label only** (row "Support"). `SUPPORT_TARGETS_PUBLISHED` in `supportTiers.ts` must stay `false` until counsel clears public timing wording.

## Supply before use
1. Hours and channel list per tier. 2. Targets in minutes per tier (must be ≥ what you can staff). 3. Decide how tier targets relate to S1–S4 (e.g. stricter of the two). 4. Enterprise terms in the contract/DPA, `TODO(counsel)`. 5. Whether to publish any timing; if yes, update the claims register.
