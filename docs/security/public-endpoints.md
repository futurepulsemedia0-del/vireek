# Public and unsigned inbound endpoints — decisions

Scope: the 15 functions the security matrix flagged `no-auth` (the previous `function-matrix.md` listed 14; `dispatch-optimizer` was added afterwards) and the 6 unsigned inbound endpoints.
Regression guard: `scripts/security/public-endpoints.test.mjs` (`node --test scripts/security/public-endpoints.test.mjs`).
Rate limiting uses `edge_rate_limit_hit()` through `_shared/http/publicGuard.ts`. "Fail-open" = a limiter outage lets a cacheable read-only feed through; "fail-closed" = 503.

## A. The 15 `no-auth` functions

| Function | Decision | Credential / control now | Limits and validation |
|---|---|---|---|
| analyze-equipment-lifecycle | **Needs auth** (scheduler) | `x-cron-secret` via `requireCronAuth` (503 if `CRON_SECRET` unset) | n/a |
| business-immune-scan | **Needs auth** (scheduler; also sends SMS) | `x-cron-secret`; wildcard CORS removed | n/a |
| email-campaign-dispatcher | **Needs auth** (scheduler) | `x-cron-secret` **or** service-role Bearer, both constant-time (`secretEquals`); the plain `!==` compare is gone | n/a |
| dispatch-optimizer | **Needs auth** (user) | explicit `auth.getUser()` + existing `dispatch_optimizer_access` RPC gate as the caller | existing |
| fabric-ingest | **Authenticated** (matrix false negative: per-connection key `ingest_key_hash`) | ingest key + HMAC (section B) | IP 300/min (fail-closed), per connection 120/min (fail-closed), 1 MB body, 200 records |
| careers-sitemap | **Public** | none needed; reads OPEN postings through RLS with the anon key | 60/min/IP (fail-open); query string > 256 chars → 414 |
| status-feed | **Public** | `public_status_feed()` exposes no phones/tenants | 120/min/IP (fail-open); `format` must be `atom` or `json` |
| job-feeds | **Public** | board allow-list (`isFeedBoard`), 404 until staff enable it | 60/min/IP+board (fail-open) |
| google-booking-feed | **Public** (GET); preview POST needs the owner JWT | slug validated, 404 unless published | 120/min/IP+slug (fail-open) |
| event-register | **Public** | honeypot, validation, flood guard + capacity inside `register_for_public_event()` | DB-enforced (unchanged) |
| warranty-register | **Public** | honeypot, validation | `wr_rate_limit_hit` per IP, fail-closed (unchanged) |
| membership-join-checkout | **Public** | honeypot, strict validation; membership becomes active only via the signed Stripe webhook | per-plan and per-email hourly caps (unchanged) |
| exit-dataroom-public | **Public (capability token)** | 256-bit token (hash only), expiry/revocation/view cap in `exit_dataroom_open()` | DB-enforced rate limit and attempt log (unchanged) |
| punchout-return | **Public (capability token)** | one-time 256-bit BuyerCookie (hash only, single use, 4 h); stages a cart copy, never creates an order | 30/min/IP (fail-closed), answered with a redirect |
| video-ice | **Public (capability token)** | 64-hex guest session token validated by `get_video_session_public()` | 30/min/IP+token (fail-closed): TURN credentials cost money |

Accepted risk: the matrix still reports `service-role-unscoped` for the public functions above. They resolve their tenant from a slug/token, not from a caller identity, so there is no `user_id` to scope on. [VERIFY] each RPC they call is `SECURITY DEFINER` with its own input checks.

## B. The 6 unsigned inbound endpoints

| Function | Before | Now |
|---|---|---|
| acct-oauth-callback, crm-oauth-callback, google-calendar-oauth-callback, hubspot-oauth-callback | HMAC state (10 min TTL), replayable inside the TTL, still valid after sign-out | HMAC state **plus** server-issued record (`oauth_state_issued`): written by `*-oauth-start` with the caller's auth session id, atomically deleted on first redeem (`oauth_state_redeem`), expired or session-ended states rejected. Signed identity must equal the stored identity. google-calendar/hubspot also lacked the `saveSecrets` import, so every connect failed; fixed. |
| fabric-ingest | key only | + `X-Vireek-Timestamp` / `X-Vireek-Signature: sha256=HMAC(secret, "<ts>.<rawBody>")`, secret = HMAC(`FABRIC_SIGNING_KEY`, connection id), 300 s tolerance, one-time claim via `claim_webhook_event`; `FABRIC_SIG_MODE` shadow (default) / enforce |
| synthetic-webhook-sink | URL token only | + the same HMAC with `SYNTHETIC_SINK_SIGNING_SECRET`; `SYNTHETIC_SINK_SIG_MODE` shadow / enforce. `dispatch-webhook` signs when the integration config has `signing_secret` (≥ 32 chars); otherwise unchanged. JSON is parsed only after token + signature checks. |

Both HMAC endpoints are **kept** (used by the Data Fabric and by synthetic monitoring), not retired.

### Known limits
- "Bound to the user session" means the auth session that started the flow must still be alive at the callback. The callback runs on the functions domain, so it cannot prove it is the same *browser*. Full browser binding needs a ticket handed to the SPA and completed with the user's JWT. [VERIFY] product decision.
- fabric-ingest owners have no UI to read their connection secret yet. Keep `FABRIC_SIG_MODE` on shadow until they do.

### Rollout order
1. Migration `20290306000000_oauth_state_binding.sql`.
2. Deploy the four `*-oauth-start`, then the four `*-oauth-callback` (states in flight during the switch fail once).
3. Set `CRON_SECRET` and update the schedulers of `analyze-equipment-lifecycle` and `business-immune-scan` to send `x-cron-secret`.
4. Set `FABRIC_SIGNING_KEY`, `SYNTHETIC_SINK_SIGNING_SECRET`; watch logs for `signed_inbound_would_reject`; then switch to `enforce`.
