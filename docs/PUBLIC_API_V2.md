# Public API v2 (flag: `public_api_v2`, default OFF)

Per-account entitlement: a staff override ON for the tenant (flag is `enabled` with 0 % rollout).

## api-v1 additions
- **Per-key rate limit**: `api_keys.rate_limit_per_minute` (10–1200, NULL = platform default 120). Settable by staff / service_role only. Reflected in `X-RateLimit-Limit` and the 429 message.
- **Field allowlist**: list and get responses contain only the fields documented in the OpenAPI spec (never `select *`).
- **Filters** (flag only): exact-match on `status, sentiment, is_emergency, customer_id` (calls), `stage, customer_id, call_id` (leads), `job_status, invoice_status, customer_id, assigned_technician_id, lead_id` (jobs). Invalid values -> `400 invalid_filter`.
- **`fields=`** (flag only): comma-separated subset of documented fields (data minimisation). `id` and `created_at` are always returned.
- Test-mode keys ignore filters and `fields`. Without the flag they are ignored for live keys too.

## Webhook deliveries console
`/dashboard/webhook-deliveries` (owner only, flag only): delivery log, dead-letter queue, replay. Event bodies are never shown. Replays keep the original `delivery_id` and are written to the append-only `webhook_replay_audit` table.

## Connector SDK
`src/lib/connectors/sdk.ts` (manifest, registry, scope + field allowlist guards). Reference connector: `accounting-csv` (jobs -> CSV, formula-injection safe, exact cents, no contact PII).

## Operations
- Load/correctness test: `DATABASE_URL=… scripts/load/webhook-fanout.sh` (local DB only).
- Rollback notes are at the top of each migration.
- Retention of `webhook_replay_audit`: REQUIRES COUNSEL.
