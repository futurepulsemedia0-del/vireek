# Scheduled edge jobs, heartbeats and the dead-man switch

Migration: `supabase/migrations/20290306000000_scheduled_edge_jobs_and_heartbeats.sql`.
Checks: `npm run cron:check` (CI), `supabase/tests/database/job_heartbeats.test.sql` (pgTAP).

## Jobs
| pg_cron job | Edge function | Schedule (UTC) | Auth header <- secret name |
|---|---|---|---|
| `vireek-c2c-sweep` | `c2c-sweep` | every 5 min | `X-Cron-Secret` <- `cron_secret` (>= 16 chars) |
| `vireek-webhook-outbox-worker` | `webhook-outbox-worker` | every minute | `x-push-dispatch-secret` <- `push_dispatch_secret` |
| `vireek-learning-policy-monitor` | `learning-policy-monitor` | daily 02:35 | `Authorization: Bearer` <- `service_role_key` |
| `vireek-agent-readiness-cron` | `agent-readiness-cron` | daily 05:10 | `X-Cron-Secret` <- `agent_readiness_cron_secret` |
| `vireek-growth-weekly-digest` | `growth-weekly-digest` | Mondays 07:00 | `x-growth-cron-secret` <- `growth_cron_secret` (>= 16 chars) |
| `vireek-automation-vip-customer-tag` | `automation-vip-customer-tag` | daily 03:50 | `X-Cron-Secret` <- `vip_tag_cron_secret` (>= 16 chars) |
| `vireek-job-heartbeat-evaluate` | SQL `job_heartbeat_evaluate()` | every 5 min | none |

Deliberately not scheduled (`docs/governance/cron-exemptions.json`): `failure-genome-refresh` (SQL job already does the work),
`provider-credentials-backfill` (one-off, see its runbook), `google-redirect-feed` (needs an external SFTP uploader).
`compliance-evaluate` is a signed-in-user API, not a job; nothing in `src/` calls it (wire it up or delete it: owner decision).

## Before applying the migration: provision the secrets
Each name is read at run time from Supabase Vault (`vault.decrypted_secrets.name`) first, then from `app.settings.<name>`.
Values must equal the matching edge-function secrets. Applying the migration first makes the jobs fail loudly
(`last_error = secret_not_configured:<name>`) and alert after 3 failures (frequent jobs) or 1 (daily/weekly).
```sql
-- Option A: Vault
select vault.create_secret('<value>', 'cron_secret');
-- Option B: database setting (existing project pattern)
alter database postgres set app.settings.cron_secret = '<value>';
```
Also required: `edge_function_base_url` (`https://<ref>.supabase.co/functions/v1`; the older `functions_url` is accepted as fallback),
and `supabase secrets set VIP_TAG_CRON_SECRET=... GROWTH_CRON_SECRET=... AGENT_READINESS_CRON_SECRET=... CRON_SECRET=...` for the functions.

## Alerts and the dead-man switch
- Alert opens when `now() > last_success_at + interval + grace` (`missed_window`) or on repeated failures
  (3 for jobs under 1 h, 1 otherwise). One open alert per job; it resolves itself on recovery.
- Destinations (all optional, same secret mechanism): `job_alert_slack_webhook_url`, `job_alert_pagerduty_routing_key` (SEV1/SEV2 only).
  Delivery is fire-and-forget through pg_net; the alert row stays in `job_heartbeat_alerts` either way.
- **Dead-man**: set `job_deadman_ping_url` to an external check URL that alerts when pings stop (every 5 min).
  Without it, an outage of the database or pg_cron raises no alert at all. [VERIFY the provider you choose]
- Staff view: `select * from public.job_heartbeats_overview();` (no UI yet).
- Pause a job on purpose: `update public.job_heartbeats set enabled = false where job_name = '...';`

## Verify after deploy
```sql
select jobname, schedule from cron.job where jobname like 'vireek-%' order by 1;
select job_name, status, last_status_code, last_error from public.job_heartbeats_overview();  -- as staff
```
