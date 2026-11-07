# Interoperability & Agent Ecosystem

Only behaviour that exists in the repository is described here.

## Agent Network (MCP + A2A) — `supabase/functions/mcp-server`
- Auth: bearer `vrk_agent_…` keys (hashed at rest, scoped, expiring, revocable). Reads are pinned to the key owner; writes go through `authorizeAgentAction` with human approval and a required `idempotency_key`.
- Gate v2 (`AGENT_NET_GATE_V2=1`): `agent_network_begin_v2` serialises each client with an advisory lock, charges one unit per JSON-RPC message in a batch (max 20), uses a 70 s burst window (60 units) and a 25 h daily window (stricter than v1), audits every denial in `agent_network_denials`, and throttles a key for 5 minutes after 25 scope/unknown-tool denials in 10 minutes (one `agent_network_alerts` row per hour).
- Browser safety: `AGENT_NET_ALLOWED_ORIGINS` (comma list). Requests without `Origin` are allowed (servers/CLIs); any other Origin must be listed, else 403. CORS never uses `*`.
- `MCP-Protocol-Version`: absent = accepted, unsupported value = 400.
- A2A: polling model (`message/send`, `tasks/get`, `tasks/cancel`). Streaming → `-32004`, push-notification methods → `-32003`.
- Not implemented on purpose: OAuth 2.1 / protected-resource metadata for MCP (keys remain the only auth mode).

## Partner self-test
```
export VIREEK_AGENT_KEY=vrk_agent_...
vireek conformance --url https://<project>.supabase.co/functions/v1/mcp-server [--json]
```
Read-only checks; exit code 1 on any failure.

## Outbound webhooks (durable)
Enable: `ALTER DATABASE postgres SET app.settings.webhook_outbox = 'on';` and schedule `webhook-outbox-worker` every minute (SQL in the function header). Rollback: `ALTER DATABASE postgres RESET app.settings.webhook_outbox;`.
- Queue `webhook_outbox`; at-least-once; stable `X-Vireek-Delivery-Id` (also kept on replay) — receivers must de-duplicate on it.
- Headers: `X-Vireek-Timestamp`, `X-Vireek-Signature-V1` = `v1=hex(HMAC_SHA256(secret, "<timestamp>.<body>"))` (comma-separated while a rotated secret is in its grace window), legacy `X-Vireek-Signature` (HMAC of body) unchanged. Reject deliveries older than 5 minutes.
- Retry: 2xx = delivered; 408/425/429/5xx/network = retry (backoff 30 s … 6 h with jitter, `Retry-After` honoured), up to 8 attempts; other 4xx/3xx = dead immediately. Dead rows are the DLQ: replay with `replay_webhook_delivery(id)`.
- Rotation: `rotate_webhook_secret(endpoint_id, grace_hours)`; old and new secret both sign during the grace window.
- Safety: https only, no credentials in URL, DNS answers must all be public, redirects never followed, 256 KB payload cap, credential-like keys dropped. Residual: DNS is resolved before the request, not pinned (Deno `fetch` cannot pin).
- Payload `version` is `EVENT_SCHEMA_VERSION` in `_shared/webhooks/outbound.ts`; add fields additively.
- 10+ dead letters raises a `dlq_growth` alert row; 20 dead in a row disables the endpoint.

## Connector health
`connector_sync_state` + `connector_record_result` / `connector_breaker_open` / `list_connector_health()`. QuickBooks reports every run and scheduled runs are skipped while its breaker is open (5 consecutive failures; 15 min doubling to 6 h; manual runs always allowed). Library: `_shared/connector-kernel/kernel.ts` (retry with Retry-After, single-flight tokens, breaker, checkpointed idempotent sync, conflict policy, reconcile, health). Migration path for other connectors: wrap their HTTP in `callWithRetry`, their token refresh in `TokenManager`, report through `connector_record_result`. QuickBooks already had its own lease lock, rotating-token handling, cursors and three-way merge, so it was not rewritten.

## Tenant data portability
`GET tenant-export` → tar of `manifest.json` + `<table>.ndjson` (customers, price_book_items, jobs, invoices, calls incl. transcripts, audit_log), checksums, `user_id` stripped, ≤100 000 rows per table (truncation flagged in the manifest). `POST tenant-import` (tar body) is a dry run unless `?commit=1`; refuses the whole bundle if any id belongs to another account; idempotent upsert by id; not one transaction. Competitor-format importers are not built.

## Public API
`api-v1` is read-only (GET). Source of truth `api-v1/contract.ts` → `public/openapi.json` (`npm run openapi:generate`, CI `openapi:check`). `api-v1/contract.test.ts` fails on a removed operation, parameter, response, schema property or error code unless the major `API_VERSION` is bumped (`BASELINE_UPDATE=1` to re-baseline deliberately). Version header `X-Vireek-Api-Version`; deprecations via `Deprecation`/`Sunset` headers from `API_DEPRECATIONS`.
