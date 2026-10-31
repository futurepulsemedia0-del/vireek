# BI Connectors

Dashboard: **/dashboard/bi-connectors** (owner, or team members with `can_export_data`). Builds on the [Data Platform](DATA_PLATFORM.md): same catalog, same privacy modes, same encryption key.

| Need | What to use |
| --- | --- |
| Power BI / Excel / Tableau, live | **Live access**: read-only OData feed with a scoped token |
| Metabase / Looker / Looker Studio | Data Platform **Warehouse** (BigQuery / Snowflake / Postgres) + read-only grants (Connection guides tab generates the SQL) |
| Google Sheets | Data Platform **Reverse ETL → Google Sheets** (Sheets cannot send auth headers, so tokens in URLs are deliberately unsupported) |
| BigQuery / Snowflake export | Data Platform **Warehouse** |
| Files in your bucket / SFTP, scheduled | **File exports** (S3, S3-compatible, SFTP) |
| Airbyte, dbt, scripts | REST JSON/CSV with a Bearer token |

## 1. One-time setup

```bash
supabase db push                      # applies 20280105000000_bi_connectors.sql (needs the Data Platform migration first)
supabase functions deploy bi-admin
supabase functions deploy bi-gateway     --no-verify-jwt
supabase functions deploy bi-export-run  --no-verify-jwt
supabase functions deploy bi-sftp-upload --no-verify-jwt
```

Secrets already used by the Data Platform are reused: `DATA_PLATFORM_ENCRYPTION_KEY` and `CRON_SECRET`.

Schedule (SQL editor; pg_cron + pg_net):

```sql
select cron.schedule('bi-export-tick', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/bi-export-run',
    headers := jsonb_build_object('Content-Type','application/json','X-Cron-Secret','<CRON_SECRET>'),
    body := jsonb_build_object('action','cron')
  ); $$);
```

Each tick runs due exports, prunes the request log (30 days) and export runs (90 days).

## 2. Live access (OData / REST)

Create a token in **Live access**: choose datasets, personal-data mode, expiry (default 180 days) and a per-minute limit. The token is shown once; only its SHA-256 is stored. Full personal data can only be granted by the account owner.

- OData feed: `https://<project-ref>.supabase.co/functions/v1/bi-gateway/odata/`. In Power BI / Excel / Tableau choose **Basic**, any user name, **password = token**.
- Supported: `$select`, `$filter` (date/timestamp columns, `eq ge gt le lt`, joined by `and`), `$orderby` (one non-personal column), `$top`, `$skip`, `$count`, server paging via `@odata.nextLink`. Everything else returns a clear 400.
- REST: `GET …/bi-gateway/v1/<dataset>?limit=&cursor=&updated_since=&format=json|csv` with `Authorization: Bearer vbi_…`; `GET …/v1/schema` returns the data dictionary.
- Always read-only (GET/HEAD). Unknown, expired, revoked tokens all return the same 401. Every request is logged (Recent requests table).

## 3. File exports

Credentials are encrypted (AES-256-GCM, bound to the target) and never shown again.

### S3 and S3-compatible
Needs only `s3:PutObject` on `arn:aws:s3:::<bucket>/<prefix>*`:

```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::my-bucket/vireek/*" }] }
```
R2 / B2 / MinIO / Wasabi: set the endpoint (public `https://` host) and region (`auto` for R2).

### SFTP
Detect and confirm the **host key fingerprint** (pinned; any other key is refused). Prefer a private key. Files are written to a `.part` name and renamed.

### Layout
```
<prefix>/<dataset>/dt=YYYY-MM-DD/run=<run>/part-00001.csv.gz
<prefix>/_manifests/<run>.json      files, row counts, sizes, SHA-256, columns, "complete"
<prefix>/_manifests/latest.json     status of the latest run (freshness heartbeat)
```
Modes: **incremental** (changed rows since the last export; resumable) or **snapshot** (every row each run; fails with a clear message if too large for the 110 s budget). Load files whose manifest says `"complete": true`; keep the newest `updated_at` per `id`.

## 4. Runbook

| Symptom | Check |
| --- | --- |
| 401 from BI tool | Token revoked/expired, or pasted with spaces. Use Basic with the token as **password**. |
| 429 | Per-token limit; raise it or refresh less often. |
| Target “Needs attention” | Open the card; run **Test**. S3 messages name the failing permission/region. |
| “host key changed” | Re-detect the key, confirm with your provider, save. |
| Nothing exports on schedule | Cron job exists, `CRON_SECRET` matches, `select * from cron.job_run_details order by start_time desc limit 5;` |
| SFTP “Could not connect” for every target | The Edge runtime may not support SSH for your plan/region: S3 and the BI gateway are unaffected. Smoke-test once after deploy. |

## 5. Tests
`supabase/functions/_shared/bi/bi.test.ts` (tokens, CSV/formula safety, OData parser, AWS SigV4 vectors, runner) and `src/pages/BiConnectorsPage.test.tsx`. Run `npm test`.
