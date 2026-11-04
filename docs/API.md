# Vireek API, MCP server, agent runtime, CLI and extension reference

Machine-readable spec: `public/openapi.json` (regenerate with `npm run openapi:generate`, verify with `npm run openapi:check`). Public page: https://vireek.com/developers/api-reference.

## 1. REST API v1 (`supabase/functions/api-v1`)
- Base URL: `https://<project-ref>.supabase.co/functions/v1/api-v1`
- Auth: `Authorization: Bearer vrk_live_…` (create under Dashboard → API Keys). Scopes `calls:read`, `leads:read`, `jobs:read`, enforced per endpoint (`x-required-scope` in the spec). Keys are SHA-256 hashed at rest and every request is logged per key.
- Methods: **GET only**; other methods return `405`.
- Endpoints: `/calls`, `/calls/{id}`, `/leads`, `/leads/{id}`, `/jobs`, `/jobs/{id}`.
- Pagination: newest first, `{ data, has_more, next_before }`; pass `next_before` as `before`; `limit` 1–100 (default 25).
- Rate limit: 120 requests/minute/key; exceeding returns `429` with `Retry-After: 60`.
- Versioning: response header `X-Vireek-Api-Version`; deprecation signalled with `Deprecation`/`Sunset` headers (exposed via CORS). Current version `1.0.0`.
- Tracing: `X-Request-Id` on responses.
- Error codes: standard HTTP status codes (`401/403` auth or scope, `404`, `405`, `429`). A full machine-readable error-code catalogue is not defined in the repo — **open item**: add it to `public/openapi.json`.
- Load tests: `load/k6/api-v1.load.js`.

## 2. MCP server and A2A (`supabase/functions/mcp-server`)
- `POST /mcp-server` — Model Context Protocol over Streamable HTTP (JSON responses).
- `POST /mcp-server/a2a` — Agent2Agent JSON-RPC: `message/send`, `tasks/get`, `tasks/cancel`.
- `GET /mcp-server/a2a/agent-card` — public agent card (also `/.well-known/agent-card.json` via `vercel.json`).
- Auth: `Authorization: Bearer vrk_agent_…` (Dashboard → Agent Network). Per-tool scopes, expiry, **60 calls/min** and a daily quota (`agent_network_begin()`).
- Safety: queries pinned to the key owner's `user_id`; reads are narrow (exact id/phone/email, never list-all); every write goes through `authorizeAgentAction()` and defaults to human approval; writes require an `idempotency_key`; every call recorded in `agent_network_calls`.
- Deploy: `supabase functions deploy mcp-server --no-verify-jwt` (auth is enforced in code).

## 3. Agent runtime (`supabase/functions/agent-runtime`, mirrored at `functions/agent-runtime`)
Broker for marketplace agents; agents never receive DB access or credentials.
- Actions: `run_now` (user JWT, owner/security permission), `tick` and `event` (header `X-Cron-Secret`; `CRON_SECRET` must be set or they are refused).
- Pipeline: check install/budget → minimised context → proposals from the agent brain (Vireek AI or signed publisher webhook with timeout/size/SSRF guards) → validate against granted scopes → `evaluate_agent_action()` (approval queue, spend limits, audit) → execute → meter usage in the append-only billing ledger.
- Only `supabase/functions/` deploys; the top-level `functions/` copy is not deployed (RUNBOOK §8).

## 4. CLI (`packages/cli`, `@vireek/cli`)
See `packages/cli/README.md`. Build: `npm run cli:build`; typecheck: `npm run cli:typecheck`. Env: `VIREEK_API_URL`, `VIREEK_API_KEY` (flags → env → saved profile). Node ≥ 20.3, zero runtime dependencies.

## 5. Chrome extension
See `chrome-extension/README.md` and `docs/browser-extension.md`.
