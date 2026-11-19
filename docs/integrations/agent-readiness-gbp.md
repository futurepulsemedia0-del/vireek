# Agent Readiness — Google Business Profile read

Part of [agent-readiness.md](./agent-readiness.md).

Read-only (GET only). Fills the `gbp_categories_photos` check from the connected location: primary category, a second
category, description length and photo count; also reads the listing's own NAP, open status and
`metadata.hasVoiceOfMerchant` (false means the owner cannot manage the listing: unverified or suspended, Google does not say which).

- **Off by default.** Nothing calls Google unless `GBP_READ_ENABLED=true`. Set it only after Google has approved Business Profile API access for the Cloud project [VERIFY: access request and OAuth verification status].
- **Connection source.** It reads the `integrations` row (`integration_type='google_business_profile'`, `status='connected'`, `config.location_name = locations/<id>`, optional `config.account_name = accounts/<id>` for the photo count) and tokens from the credential vault (the same row `gbp-sync` uses). The row is created by the connect flow below.
- **Cache.** `agent_readiness_gbp_cache` holds derived facts only (no tokens, no raw payload). Fresh for 6 h (at most 2 Google calls per account per 6 h however many scans run); failures are remembered (5 min to 6 h by kind) so a revoked token or missing API access is not retried every scan; if a live read fails, facts from the last good read are used for up to 7 days and flagged `stale` (never for a deleted location). The row is dropped when the integration is disconnected (at the next scan) and with the account (`ON DELETE CASCADE`). Google's terms on caching Business Profile data [VERIFY] must be checked against these TTLs before enabling.
- **Never fails a scan.** Every failure (no access, revoked token, 404, 429, 5xx, timeout, bad payload) becomes a `not_measured` check with its own explanation.
- **Stored in a scan:** only a summary (`facts.gbp`: status, staleness, primary category, counts, open status, voice-of-merchant flag). No phone, address or website.
- **Not read:** attributes (separate API), hours/special-hours comparison against the profile, reviews.
- **Field names and endpoints** (Business Information API v1 `Location`, My Business v4 media list) follow Google's reference as understood at build time [VERIFY before release].

## Connect flow (owner/admin)
Card at the top of the Agent Readiness page (`GbpConnectCard`). `gbp-oauth-start` (JWT; account resolved server-side) returns Google's consent URL with an HMAC-signed, 10-minute `state` that carries the account id and a nonce; it uses its own secret so a state minted for another OAuth flow cannot be replayed. Google redirects to `gbp-oauth-callback` (public; the signed state is the identity), which: exchanges the code, rejects the grant when no refresh token came back or the `business.manage` scope was unticked, lists the readable accounts/locations (max 10 accounts, 50 locations, one page each), writes tokens to the vault, and only then saves the integration row through `gbp_connect_save`. If that save fails the vault entry is removed again. One location is selected automatically; with several, the card asks (`gbp_select_location` accepts only locations already stored as candidates). Reconnecting keeps the previous choice while that location is still readable. Tokens never reach the browser, the redirect URL, `integrations.config` or logs.

- Scope: `https://www.googleapis.com/auth/business.manage`, Google's only Business Profile scope (no read-only variant) [VERIFY]. It is a sensitive scope: Google OAuth app verification is needed before customers can connect [VERIFY].
- Google Cloud: add `<SUPABASE_URL>/functions/v1/gbp-oauth-callback` as an authorized redirect URI [VERIFY].
- Disconnect: use the existing integrations disconnect (`provider-disconnect`). The cache row is dropped at the next scan.
- Cannot work until the Business Profile APIs are enabled and approved for the Cloud project; every case surfaces as a plain message (`api_access`, `no_locations`, ...), never a failed scan.

Secrets: `GBP_READ_ENABLED`, `GOOGLE_BUSINESS_CLIENT_ID`, `GOOGLE_BUSINESS_CLIENT_SECRET` (shared with `gbp-sync`), `GOOGLE_BUSINESS_STATE_SECRET` (new, `openssl rand -hex 32`), `SITE_URL`.
Deploy: `supabase functions deploy gbp-oauth-start` and `supabase functions deploy gbp-oauth-callback --no-verify-jwt` (also listed in `supabase/config.toml`).

## Tests
`supabase/functions/_shared/agent-readiness/gbp.test.ts`, `gbpConnect.test.ts`, `src/lib/gbpConnectCore.test.ts`, `src/components/agentReadiness/GbpConnectCard.test.tsx` (fixtures only; Google is never called). Run: `npx vitest run supabase/functions/_shared/agent-readiness`.

## Release gate
Not releasable until: both migrations (`20290307000000`, `20290307010000`) have run on a real database, the connect flow and `GBP_READ_ENABLED` are exercised end to end against a real approved Business Profile project, Google OAuth verification is done, and every [VERIFY] above is resolved. `scripts/security/function-matrix.mjs --check` reports `webhook-no-replay` for both new functions: a heuristic false positive shared with the other OAuth functions (the shared state helper enforces a 10-minute TTL and a nonce).
