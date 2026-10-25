# Data Platform

Dashboard: **/dashboard/data-platform** (owner, or team members with `can_export_data`; the Metrics tab needs `can_view_billing`).

| Piece | What it does |
| --- | --- |
| Metrics layer | 13 official metrics defined once in `supabase/functions/_shared/data-platform/metrics.ts` and reused by the dashboard tab, warehouse `metrics_daily`, Sheets exports, embeds and the finance copilot (Ask Vireek). |
| Warehouse sync | Incremental, idempotent loads of 8 tables into BigQuery, Snowflake or a Postgres replica. |
| Reverse ETL | Google Sheets, Mailchimp, Klaviyo. Marketing audiences only include customers with `marketing_opt_in` and an email. |
| Embeds | Signed, read-only analytics for partners (iframe or JSON API). |
| Schema | Live data dictionary (Schema tab → Download .md). |

## 1. One-time setup

```bash
# 1. Secrets (CRON_SECRET may already exist in your project: reuse it)
supabase secrets set DATA_PLATFORM_ENCRYPTION_KEY="$(openssl rand -base64 32)"
supabase secrets set CRON_SECRET="$(openssl rand -hex 32)"   # skip if already set

# 2. Database
supabase db push        # applies 20271102000000_data_platform.sql

# 3. Functions
supabase functions deploy metrics-query
supabase functions deploy data-platform-admin
supabase functions deploy data-platform-run --no-verify-jwt
supabase functions deploy analytics-embed    --no-verify-jwt
```

`DATA_PLATFORM_ENCRYPTION_KEY` encrypts every stored credential (AES-256-GCM, bound to its row) and keys the PII pseudonymiser.
**Back it up.** If it is lost, destinations must be re-entered; if it is changed, stored secrets stop decrypting and PII hashes change.

### Schedule (Supabase SQL editor; needs pg_cron + pg_net)

```sql
select cron.schedule('data-platform-tick', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/data-platform-run',
    headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
    body := jsonb_build_object('action','cron')
  ); $$);
```

Each tick runs destinations that are due (15 min / hourly / 6 h / daily per destination), refreshes metric history and applies housekeeping.

## 2. Credentials per destination

All credentials are entered in the dashboard, validated server-side, stored encrypted and never shown again. Leave a credential empty when editing to keep the saved one.

### BigQuery
1. Google Cloud → IAM → Service Accounts → create `vireek-sync`.
2. Grant **BigQuery Data Editor** and **BigQuery Job User** on the project.
3. Keys → Add key → JSON. Paste the whole file.
4. Fields: project id, dataset (default `vireek`, created if missing), location (`US`, `EU`, …).

### Snowflake
1. Account identifier: `myorg-myaccount` (not the full URL).
2. Create a user, role and warehouse that can `CREATE SCHEMA`/`CREATE TABLE` in the target database (or pre-create the schema and grant `USAGE`, `CREATE TABLE`).
3. Authentication, either:
   - **Programmatic access token** for that user, or
   - **Key pair**: generate an unencrypted PKCS#8 key (`openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out key.p8`), assign the public key with `ALTER USER … SET RSA_PUBLIC_KEY='…'`, paste `key.p8`.
4. If your account uses a network policy, allow Supabase edge egress.

### Postgres replica
- Public hostname reachable from the internet (RDS, Cloud SQL, Neon, Supabase, self-hosted). Private/internal addresses are rejected.
- A user that can create a schema, or a pre-created schema it owns. TLS is required (`verify-full` also checks the certificate).
- Allow-list Supabase edge egress if your firewall needs it.

### Google Sheets
1. Create a service account, enable the **Google Sheets API**, download its JSON key.
2. Share the target sheet with the key's `client_email` as **Editor**.
3. Paste the sheet URL (or id) and a tab name. The tab is created if missing; its contents are replaced each run. Values are written as plain text (no formulas can be injected).

### Mailchimp
API key (`…-us21`) plus audience id. Contacts are added with a tag; existing unsubscribed contacts are never resubscribed.

### Klaviyo
Private API key (`pk_…`) with `profiles:write` and `lists:write`, plus the list id.

## 3. How sync works

- Cursor on `(updated_at, id)` with a 5-minute overlap; rows are upserted by `id`, so retries and overlaps are safe.
- A weekly **full refresh** re-reads everything and marks rows missing from Vireek with `_vireek_deleted = true` (query `WHERE NOT _vireek_deleted`).
- Every table also has `account_id` and `_vireek_synced_at`.
- Failures are classified (retryable / auth / config); retryable ones back off, auth/config ones flag the destination “Needs attention” with a readable message.
- Personal data: **Pseudonymised** (stable keyed hash of email/phone; names and addresses empty), **Full**, or **None**.

Tables: `customers`, `leads`, `calls`, `jobs`, `quotes`, `job_costs`, `revenue_recovery`, `metrics_daily`. Column-level documentation: Schema tab.

## 4. Metrics

`revenue`, `collected_revenue`, `collection_rate`, `jobs_completed`, `avg_ticket`, `gross_profit`, `gross_margin`, `quotes_sent`, `close_rate`, `response_time`, `missed_calls`, `recovery_rate`, `recovered_revenue`.
Ratios carry numerator/denominator; “no data” is `null`, never 0. Definitions are versioned; the Metrics tab shows each rule.
Change a definition **only** in `metrics.ts` (bump `version`); `metrics.test.ts` locks parity with the executive report.

## 5. Embeds

1. Dashboard → Data Platform → Embeds → **Create an embed**; copy the signing secret (shown once).
2. On **your server**, mint a token per viewer (snippets are shown in the dashboard). Payload: `eid`, `iat`, `exp` (max 24 h), optional `sub` and `filters`.
3. Put the URL in an iframe: `https://<your-app>/embed/analytics.html#token=<token>` (optional `&currency=EUR`).
4. JSON API: `POST https://<project-ref>.supabase.co/functions/v1/analytics-embed` with `Authorization: Bearer <token>` and body `{ "action":"data", "from":"…", "to":"…", "metrics":["revenue"], "compare":true }`; `GET …?action=meta` for the embed definition.

Security: tokens are HMAC-SHA256 signed, expire, can be narrowed per viewer, and can never exceed the embed's metrics, range, breakdowns or locked filters. All failures return the same generic 401. Revoking an embed kills every token; rotating the secret invalidates old tokens. Each embed has its own requests-per-minute limit.

## 6. Runbook

| Symptom | Check |
| --- | --- |
| “server is missing its encryption key” | `supabase secrets set DATA_PLATFORM_ENCRYPTION_KEY=…` and redeploy. |
| Destination “Needs attention” | Open the card: the message names the failing check. Run **Test**. Fix credentials/permissions, then **Sync now**. |
| Nothing runs on schedule | Confirm the cron job exists and `CRON_SECRET` matches; `select * from cron.job_run_details order by start_time desc limit 5;` |
| Rows missing in warehouse | Run **Full refresh**. |
| Embed shows “invalid or has expired” | Token expired, wrong secret, or embed revoked/rotated. |
| Reset one table | Drop it in the warehouse, then **Full refresh**. |

## 7. Tests

`supabase/functions/_shared/data-platform/*.test.ts` (metrics, catalog, warehouse SQL, secrets, JWTs, embeds, reverse ETL). Run `npm test`.
The IO adapters (BigQuery/Snowflake/Postgres/Sheets/Mailchimp/Klaviyo) need a one-time smoke test with real credentials: connect, **Test**, **Sync now**.
