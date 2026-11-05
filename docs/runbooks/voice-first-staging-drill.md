# First staging drill: voice ladder

**Status: NOT RUN.** No staging project, Twilio/Vapi staging credentials or network path to them existed when this was written. Nothing below is a result; fill the "Results" table only from a real run.

## Preconditions (all must be true)
- [ ] Staging Supabase project, separate from production; migration `20281101000000_voice_resilience.sql` applied; functions deployed (`voice-front-door`, `voice-health-tick`, `voice-reconcile`, `voice-resilience-admin`, `vapi-webhook` with the edits).
- [ ] Function env on staging: `VOICE_CHAOS_ENABLED=true`, Twilio + Vapi staging keys, `VOICE_PROBE_FROM`. **Never set `VOICE_CHAOS_ENABLED` in production.**
- [ ] `voice_cron_tick` scheduled (1/min) on staging; `voice-health-tick` seen producing rows.
- [ ] A staff JWT; a staging owner account with 1 Vireek test number, a saved business number you can answer, and ≥1 forward number you control.
- [ ] Nobody on staging is a real customer; status-page/SMS alert targets are test recipients.

## Run
```
STAGING_FUNCTIONS_URL=https://<staging-ref>.supabase.co/functions/v1 \
STAGING_STAFF_JWT=<jwt> \
node scripts/gameday/voice-gameday.mjs --i-am-on-staging
```
Single drill: add `--drill engine_down`. The script writes its report to `docs/runbooks/gameday-results/`; commit it.

## Manual checks during the drill (the script cannot see these)
1. Place a real call to the test number at L0, L1, L2, L3, L4 (use the org pin on the Backup handling tab). Confirm what the caller hears and that the end state matches `status.levels.*`.
2. Press `1` / say "gas leak" at each level: call must reach a forward target (L3) or the 911 message (L4).
3. Carrier wizard: run "Test forwarding is on" and "off" against the staging business line; confirm both pass/fail correctly, including answering the call once (`answered_by_human`).
4. Confirm owner SMS + in-app notice on level change, and the status-page entry.
5. Stop the staging webhook for 10 minutes, then run `voice-reconcile`: missing calls recovered or flagged.

## Results (empty until a real run)
| Drill | Expected level | Observed | Time to react | Time to recover | Pass? | Notes |
|---|---|---|---|---|---|---|
| engine_down | 2 | | | | | |
| engine_slow | 1 | | | | | |
| tools_down | 1 | | | | | |
| carrier_down | 0 | | | | | |

Abort: `set_chaos` clear (script does this on exit/Ctrl+C) or unset `VOICE_CHAOS_ENABLED`.
