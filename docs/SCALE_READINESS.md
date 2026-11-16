# Scale readiness (10x tenants)

## Verified in the repository snapshot (static, not load-tested)
- 112 `cron.schedule` entries exist; scheduled functions fan out per tenant inside one invocation.
- `node scripts/scale-limits-scan.mjs` found 23 fixed-cap reads in scheduled functions. Beyond the cap tenants are
  silently skipped. Examples: `voice-health-tick` (5000 phone_numbers), `escalation-tick` (100 active events),
  `capacity-guard-tick` (500 accounts), `lifecycle-touch-tick` (5000), `fraud-sweep` (up to 100000).
- `supabase/config.toml` has no pooler or `max_rows` setting; no pooling guidance was found in the docs.
- k6 assets exist in `load/k6` (api-v1, webhook soak); no results are recorded.

## Unverified (needs measurement on staging)
Connection pool size and mode, edge-function concurrency and timeout under fan-out, `calls` query cost at 10x
(index `idx_calls_user_datetime` exists), cron overlap when a run exceeds its interval.

## Required before 10x
1. Replace each fixed cap with keyset pagination or a queue (per-tenant jobs).
2. Add a run-lock so overlapping ticks do not double-process.
3. Use the transaction pooler for edge functions; document the setting.
4. Run `k6-load.yml` at 10x tenant counts and record results here.
5. Ratchet: CI runs `node scripts/scale-limits-scan.mjs --max=23`.
