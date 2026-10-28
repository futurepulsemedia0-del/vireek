# BI export

Two ways to get Vireek data into BI tools. Both are read-only, tenant-scoped and free of personal columns unless explicitly permitted.

1. **Scheduled signed files** to your own Amazon S3 or Google Cloud Storage bucket.
2. **Read-only Postgres views** (`bi_*`) for Power BI, Tableau, Looker and SQL clients.

Where: **Dashboard > BI Export** (needs the "export data" permission; personal data additionally needs `can_export_pii`, always granted to owners).

## Setup (once per project)

```bash
supabase db push                                   # applies 20280120000000_bi_export.sql
supabase functions deploy bi-export-run --no-verify-jwt
# secrets already used by the Data Platform: DATA_PLATFORM_ENCRYPTION_KEY, CRON_SECRET
```

Schedule the runner (SQL editor, pg_cron + pg_net):

```sql
select cron.schedule('bi-export-tick', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/bi-export-run',
    headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
    body := jsonb_build_object('action','cron')
  ); $$);
```

## 1. Files in your bucket

**Amazon S3** policy for the key (replace bucket and prefix):

```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::my-bucket/vireek/*" }] }
```
`s3:DeleteObject` is only used to clean up the connection-test file.

**Google Cloud Storage**: create an HMAC key for a service account with *Storage Object Creator* (plus *Storage Object Admin* on the prefix if you want the test file cleaned up) and enter its access id and secret.

### Layout

```
<prefix>/<table>/<mode>/dt=YYYY-MM-DD/run=<id>/part-0001.csv   (max 50,000 rows / 24 MB each)
<prefix>/<table>/<mode>/dt=YYYY-MM-DD/run=<id>/manifest.json   (written LAST)
<prefix>/<table>/<mode>/_latest.json                           (copy of the newest manifest)
```
A run folder without `manifest.json` is incomplete: ignore it. CSV is UTF-8, no BOM, CRLF, ISO-8601 UTC timestamps, `true`/`false`, JSON columns as JSON text. Text cells starting with `= + - @` are prefixed with `'` (spreadsheet-formula hardening).

### Modes

| Mode | Delivers | Use |
|---|---|---|
| Incremental | rows changed since the last run (5 min overlap) | upsert by `id`, keep the newest `updated_at` |
| Snapshot | every current row, consistent, up to 500,000 per table | replace your copy |

Incremental cannot signal hard deletes or soft-deleted customers/leads; run a weekly snapshot to reconcile.

### Signed manifest

`manifest.json` lists every part with its SHA-256 and carries an HMAC-SHA256 `signature` over the canonical JSON of everything else. The signing secret is shown once when you add your first bucket (rotate it on the BI Export page). Verification code is on the page and in `src/lib/biExport.ts` (`VERIFY_SNIPPET`).

### Personal data

| Mode | File content |
|---|---|
| No personal data (default) | personal columns are not selected from the database and not written |
| Pseudonymised | phones/emails as keyed hashes (`email_hash`, `phone_hash`; same hash as the warehouse sync, so they join); names and addresses not written |
| Full | names, phones, emails, addresses |

Pseudonymised and full need `can_export_pii`. It is re-checked on every scheduled run for the person who authorised the schedule; if they lose it the run fails instead of exporting.

## 2. Power BI and SQL

### Option A: dedicated login (recommended for Power BI Service / gateways)

BI Export > Power BI & SQL > **Create login**. You get host, user and a password (shown once). In Power BI Desktop: *Get data > PostgreSQL database*, server `db.<ref>.supabase.co`, database `postgres`, then pick the `bi_*` views (or paste the query shown on the page). Behind the Supabase pooler use the `user.<project-ref>` name the page shows. Use *Import* mode and schedule refresh in the Power BI Service.

The login can only `SELECT` from the views, has a 60 s statement timeout, belongs to exactly one account and stops working the moment you revoke it. At most 5 active logins per account.

### Option B: your own Supabase login (JWT)

Signed-in members with the export permission can query the same views through the Supabase API; rows are scoped to their account.

### View contract v1

Names and columns are stable; new columns are only ever appended in later versions.

| View | Source | Personal companion (join on `id`) |
|---|---|---|
| `bi_customers` | customers (not deleted) | `bi_pii_customers` |
| `bi_leads` | leads (not deleted) | `bi_pii_leads` |
| `bi_calls` | calls (no transcript, no recording) | `bi_pii_calls` |
| `bi_jobs` | jobs | `bi_pii_jobs` |
| `bi_quotes` | quotes | `bi_pii_quotes` |
| `bi_job_costs` | job cost entries (cents) | none |
| `bi_revenue_recovery` | revenue recovery events (cents) | `bi_pii_revenue_recovery` |
| `bi_metrics_daily` | daily semantic metrics | none |

Column lists are the Data Platform catalog (`supabase/functions/_shared/data-platform/catalog.ts`); a unit test fails if the SQL and the catalog drift. `bi_pii_*` views return zero rows unless personal data is permitted for that login or user.

## Security notes

- Bucket secrets and signing secrets are AES-256-GCM encrypted, bound to their row, never returned to the browser.
- Storage hosts are fixed (`amazonaws.com`, `storage.googleapis.com`): no user-supplied URLs.
- Tenant resolution uses `session_user`, which a database client cannot change.
- Use PostgreSQL 15+ (Supabase default) so the public schema does not grant CREATE to everyone; views are `security_barrier` either way.
- Add a network allow-list for the database if your BI gateway has fixed IPs.

## Tests

```bash
npx vitest run supabase/functions/_shared/exports/bi.test.ts   # 30 tests: PII, CSV, signatures, SigV4 vector, storage, run, SQL/catalog drift
supabase test db                                              # bi_export.test.sql: isolation and PII gating
```
