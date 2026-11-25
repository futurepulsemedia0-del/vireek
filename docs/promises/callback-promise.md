# Callback promise

Product rule: **every missed or unresolved call gets a callback within X.** X is the owner's decision.

| Item | Value |
| --- | --- |
| X (callback window) | `TODO(owner)` - per account, 5 min to 7 days, no default. Rule is off until set. |
| Human escalation delay | `TODO(owner)` - optional. Empty = overdue alert only. |
| Does a no-answer attempt count as "made"? | `TODO(owner)` - implemented as **yes** (attempt, not reached). Change in `callback_promise_sweep()` Phase 2 if not. |
| Minimum sample before any public number | `TODO(owner)` - per account, no default. Empty = never published. |
| Public wording / where it is shown | `TODO(owner)` - nothing is published or wired to a page yet. |

## What it reuses (nothing duplicated)
- **Which calls**: the Missed-Revenue Recovery Ledger (missed, voicemail, not booked) - same definition as Rescue Loop.
- **Was the callback made**: `rescue_loop_events_for()` - callback step, follow-up call, or a team call logged in the Priority Call Queue. Texts do not count (that is Rescue Loop's first-response SLA).
- **The promise**: a row in `promises` (category `callback`, `origin = 'callback_policy'`), shown in Promise Tracker.
- **Alerts**: rows in `notifications` (existing push + routing). `high` when overdue, `critical` when escalated.

## Timers
1. Clock starts at the call time (not-booked: when the call ended). Only calls after the rule was turned on are tracked.
2. `due_at = clock start + X`. X is stored on each promise, so changing X never rewrites history.
3. Sweep (every minute): create promises, close the ones with a recorded callback attempt, alert once per stage.
4. Past `due_at`: `overdue` alert. After `due_at + escalation delay` (if set): `escalated` alert (critical).
5. Nothing becomes "broken" by itself. A person marks it broken or cancelled. Turning the rule off cancels the pending ones.
6. A burst for one account becomes one notification per stage.

## Numbers
Judged by due time, last 30 days, cancelled excluded, pending counted only once past due.
- **Made in time (recorded)** = callback attempt recorded by the system at or before the deadline / decided cases.
- Confirmed-by-hand outcomes are shown separately and never raise a published rate. A hand resolution cannot be back-dated.
- Public stat (`callback_promise_public_stat(slug)`, service role only): needs Trust Badge on + owner opt-in + window + minimum sample, one window across the period. Otherwise `NULL` or `publishable: false` with no counts.

## Deploy
1. Apply `supabase/migrations/20290312000000_callback_promise.sql` (rename the timestamp if it does not sort after your newest migration).
2. `supabase functions deploy callback-promise-sweep --no-verify-jwt` and set `CRON_SECRET`.
3. Call it every minute with `X-Cron-Secret`, same cron that calls `rescue-sla-monitor`. It refuses to run without `CRON_SECRET`.
4. Owner opens Promise Tracker, sets X, turns the rule on.

## Not done
- The public stat is not rendered on the Trust Badge page or the marketing site (needs your wording decision first).
- No per-team-member assignment: escalation goes to the account owner.
- Business hours are not modelled; X runs on the wall clock.
