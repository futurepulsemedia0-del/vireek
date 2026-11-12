# Usage & limit alerts

Single owner-facing alerter for included-minute usage and plan limits. Replaces the old `check-usage-alert`
(unpaginated, in-app only, broken dedupe) and the owner-alert block that lived in `check-cost-guardrails`
(that function still produces staff cost flags; it no longer writes owner alerts).

## Behaviour
| Kind | Trigger | Channels |
|---|---|---|
| `minutes_80` | used*100 >= included*80 | in-app (`ai_insights`) + email to owner |
| `minutes_100` | used >= included | in-app + email + push (a `notifications` row, which fires the existing push and notification-router triggers) + SMS |
| `seat_limit` / `location_limit` / `number_limit` | `notifyLimitReached...()` helper | in-app + email |

- **Period key:** UTC calendar month `YYYY-MM`. The repo has no `usage_periods` table, so this is the fallback. Each
  `(owner, period_key, kind)` is stored once in `usage_alert_events` (UNIQUE), so every alert is sent at most once per period.
- **Same-run jump:** an account that is already past 100% the first time it is seen gets the 100% alert only; 80% is recorded as `skipped:superseded`.
- **Effective limit:** `minutes_included` (+ `bonus_minutes` if that column ever exists; it does not today).
- **Retries:** a claim takes a 5-minute lease; channels that ended `failed:*` are retried on later runs (max 5 attempts); `sent`, `deferred` and `skipped:*` are final.
- **SMS:** only through `sendCompliantSms` (A2P approval, STOP/DNC, quiet hours; held messages are queued by the existing dispatcher). Skipped when the owner has active `notification_routing_rules` (their own channel preferences) or no `profiles.phone`.
- **Not implemented on purpose:** `overage_started` (no overage-policy flag in the repo), top-up price copy (no top-up product), "service paused / emergencies still forwarded" copy (no usage-based pause exists; the Free "hard cutoff" is described only in the UI banner and not enforced in any edge function I could find).
- Copy comes from `src/lib/pricing.ts` (`PRICING_PLANS`, `parseOverageRate`); change prices there and the emails follow.

## Rollout
1. Apply `20290303000000_usage_alert_events.sql` and `20290303000100_usage_period_rollover.sql`.
2. Deploy `check-usage-alert` (and `check-cost-guardrails`). Secrets: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SITE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`. Push needs `app.settings.edge_function_base_url` and `app.settings.push_dispatch_secret` (already used by the notifications triggers).
3. Schedule it (SQL editor, once). Replace `<project-ref>` and `<service-role-key>`:
```sql
select cron.schedule('usage-alert-sweep', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/check-usage-alert',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <service-role-key>'),
    body := '{}'::jsonb);
$$);
```
4. The function starts in **shadow mode** (default): it reports `would_send` counts in its JSON response and the `usage_alert_sweep` log line and sends nothing. Review the counts, then `supabase secrets set USAGE_ALERT_MODE=live`.
5. Monthly counter reset (required, otherwise counters only grow):
```sql
select cron.schedule('usage-period-rollover', '5 0 1 * *', $$ select public.rollover_usage_period(); $$);
```
   `rollover_usage_period()` recomputes each owner's counter from `calls` for the new UTC month, once per month; it is safe next to any reset job you already run.
6. If an older schedule for `check-usage-alert` or a cron calling it without the service-role Bearer exists, unschedule it (`select cron.unschedule('<name>')`); the function now answers 401 without the key.

## Using the limit helper
```ts
import { notifyLimitReachedForOwner } from "../_shared/usage-alerts/ports.ts";
await notifyLimitReachedForOwner(admin, ownerId, "seat_limit", currentSeats, seatLimit); // never throws
```
Not wired anywhere yet: `requireEntitlement` only raises `module_not_entitled`; no seat/location/number limit check exists to hook.

## Rollback
Unschedule the cron jobs, redeploy the previous function version, drop the objects listed at the top of each migration.
