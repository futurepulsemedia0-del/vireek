# Consumer Agent surface (public, read-mostly)

Status: **built and unit-tested; not deployed or verified against a live database from this repo snapshot.**
See "What is verified" at the bottom before relying on any claim here.

A homeowner's AI agent can discover one Vireek customer business and send it a **pending** service request.
Separate from the owner-authenticated `mcp-server` (which stays unchanged and is the only door to customers, jobs, quotes, payments).

## Endpoints (API v1, `CONSUMER_API_VERSION = 1.0.0`)

Base: `https://<project>.supabase.co/functions/v1/consumer-agent`

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/health` | liveness, supported MCP versions |
| GET | `/v1/challenge` | proof-of-work challenge for unsigned agents |
| GET | `/v1/requests/{request_id}.{token}` | PII-free status of one request |
| GET | `/v1/b/{slug}/profile.json` | published facts (JSON) |
| GET | `/v1/b/{slug}/llms.txt` | same facts, llmstxt.org shape |
| GET | `/v1/b/{slug}/jsonld` | schema.org `HomeAndConstructionBusiness` |
| GET | `/v1/b/{slug}/agent-card.json` | A2A agent card for this business |
| POST | `/v1/b/{slug}/mcp` | MCP, Streamable HTTP, JSON responses |
| POST | `/v1/b/{slug}/a2a` | A2A JSON-RPC: `message/send`, `tasks/get` |

Vercel rewrites (after deploy): `/book/{slug}/llms.txt`, `/book/{slug}/agent-card.json`, `/book/{slug}/profile.json`.
A business that is off, kill-switched, or unknown returns the same `404 {"error":"not_found"}` (no enumeration).
Cached reads stay up to ~2 minutes after a kill switch; every write path checks the database live.

## Tools (public, minimal scope)

| Tool | Writes | Notes |
|---|---|---|
| `get_business_info` | no | only sections the owner published |
| `get_price_range` | no | only prices the owner marked public; estimates, never quotes |
| `check_availability` | no | verified windows from the same engine as the Google feed; no staff or customer data; expire ~120 s |
| `request_booking` | **pending request only** | needs `idempotency_key`, `homeowner_consent: true`, a time from `check_availability`; never confirms, never takes payment |

All schemas are closed (`additionalProperties: false`). Owner tools (`get_customer`, `create_quote`, `collect_payment`, ...) do not exist here.

## Abuse and privacy controls

* **Rate limits** (atomic in Postgres, `consumer_agent_hit`): unsigned reads 60/min/IP; unsigned writes 2/min and 4/h per IP, 5/day per IP per business, 12/h per business in total; registered agents 600 reads/min, 120 writes/h, 40/day per business; per-business daily cap set by the owner. Limit-store failure **fails closed**.
* **Bot challenge for unknown agents**: HMAC-signed, 5-minute, single-use SHA-256 proof-of-work (18 bits, 22 when behaviour looks unusual). This is **not a CAPTCHA** and does not prove a human; it prices bulk automation.
* **Request signing for registered agents**: Ed25519, Vireek-defined scheme (**not RFC 9421**). Headers `Vireek-Key-Id`, `Vireek-Timestamp` (unix s, ±300 s), `Vireek-Nonce` (single use), `Vireek-Signature` (base64url).
  Signed string: `vireek-sig-v1\n{METHOD}\n{path starting at /v1/...}\n{timestamp}\n{nonce}\n{sha256hex(body)}`.
  Register an agent (Vireek staff, service role): `insert into consumer_agent_registry (key_id, name, operator_url, public_key) values (...)` with the 32-byte raw public key, base64url (43 chars).
* **Idempotency**: unique per (business, principal, key); same key + same arguments returns the original request, changed arguments return `idempotency_conflict`.
* **PII minimisation**: name + one contact + postal code (+ optional street) + 500-char note. Hidden characters, markup and URLs are stripped; unverified contact data of declined/expired requests is erased after 30 days (`consumer_agent_purge`). IPs are stored only as a salted daily hash. Event logs hold no contact data.
* **Prompt-injection**: free text is data. It is sanitised, flagged (`injection_pattern`, `payment_language`, `had_url`, ...), shown to the owner as untrusted text, never echoed back to agents, and any flag permanently disables auto-accept for that request. No LLM reads it in this feature.
* **Anomaly detection**: per principal, from `consumer_agent_principal_stats` → allow / harder challenge / throttle / block (24 h block row in `consumer_agent_blocklist`).
* **Takedown**: owner kill switch (instant, also releases holds), global `CONSUMER_AGENT_DISABLED=true`, per-principal blocklist.

## Owner controls

`/dashboard/consumer-agent`: opt-in per section with an exact preview, per-price publish switches, hold vs pending mode, daily cap, response SLA (`sla_due_at`, states ok / due_soon / overdue), review queue (accept → real job through `create_public_booking_with_settings` tagged `booking_channel = 'ai_agent'`; decline with a fixed reason), auto-accept rules (registered agents only, listed services only, no flags, minimum lead time, area verified), activity counters, kill switch. A `notifications` row is created for each request so existing notification routing applies.

## Deploy

```
supabase db push                                   # 20280402000000_consumer_agent_surface.sql (needs 20271120000000 first)
supabase secrets set CONSUMER_AGENT_SECRET=$(openssl rand -hex 32) CONSUMER_AGENT_IP_SALT=$(openssl rand -hex 16)
supabase functions deploy consumer-agent --no-verify-jwt
```

Schedule `select consumer_agent_expire_stale(); select consumer_agent_purge();` (hourly / daily). **Not scheduled by this change.**

## Sandbox

Slug `vireek-sandbox`: fixture business, real protocol path, **never writes**. Include `accept` or `decline` in the `idempotency_key` to see those outcomes via `tasks/get` or `GET /v1/requests/...`. Sandbox postal codes: 60601, 60602, 60603.

Minimal agent flow: `tools/call check_availability` → `GET /v1/challenge` and solve (find `nonce` with `sha256("<token>:<nonce>")` having N leading zero bits) → `tools/call request_booking` with `arguments.challenge = {token, nonce}` → poll the returned `status_url`.

## Standards and honest labelling

* MCP: negotiates 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05; tools capability only; JSON responses (no SSE). A2A 0.3 JSON-RPC; no streaming, push or agent cancel.
* **No platform integration is claimed.** Being reachable through standard MCP/A2A/llms.txt/JSON-LD does not mean ChatGPT, Gemini, Claude or Google list or call this business. Google's agentic booking still requires Google partner approval (see `google-agentic-booking.md`). Google may ignore self-serving `aggregateRating` markup.

## What is verified

Unit-tested (59 tests, run with a local Vitest-compatible shim, not real Vitest): tool contract, scope escape, injection fixtures, proof-of-work, signing, idempotency, rate limits, anomaly, profile renderers, sandbox.
**Not executed anywhere yet:** the SQL migration, the edge function on Deno, `tsc`, ESLint, the design-system/locale lints, Playwright/axe, any live MCP/A2A client.
