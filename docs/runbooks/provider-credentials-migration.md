# Runbook — move third-party credentials into the encrypted vault

Applies to: Jobber, ServiceTitan, Housecall Pro (`price_book_connections`), HubSpot, Google Calendar (`integrations.config`).
Not covered: Google Business Profile (no OAuth flow exists in the repo; the `gbp-sync` reader still reads `integrations.config` — build the GBP connect flow vault-first, see `docs/integrations/partner-requirements-matrix.md`).

## Order (do not reorder)
1. **Secret:** `supabase secrets set PROVIDER_CREDENTIALS_KEY="$(openssl rand -base64 32)"` — back this key up in your password manager. Losing it = every stored connection must be reconnected.
2. **Migration:** `supabase db push` (creates `provider_credentials`, service-role only).
3. **Deploy** the new functions: `provider-credentials-backfill` (`--no-verify-jwt`), `provider-disconnect`; **redeploy** every function whose code changed: `jobber-oauth-callback`, `hubspot-oauth-callback`, `google-calendar-oauth-callback`, `price-book-connect-servicetitan`, `price-book-connect-housecallpro`, `price-book-sync`, and every function that imports `_shared/dispatch/externalJobSync.ts` or `_shared/price-book/jobber.ts`.
   Reader code is dual-mode: vault first, legacy plaintext as fallback, so steps 3–5 are safe while old rows still exist.
4. **Backfill (idempotent, copy-only):**
   `curl -X POST "$SUPABASE_URL/functions/v1/provider-credentials-backfill" -H "X-Cron-Secret: $CRON_SECRET"`
   Expect `{"ok":true,"stats":{"failed":0,...}}`. Re-run until `failed` is 0.
5. **Verify before scrubbing** (SQL editor, service role):
   ```sql
   -- every connection that still has plaintext must have a vault row
   SELECT pbc.provider, count(*) AS missing_in_vault
   FROM price_book_connections pbc
   WHERE (pbc.jobber_access_token IS NOT NULL OR pbc.jobber_refresh_token IS NOT NULL OR pbc.st_client_secret IS NOT NULL
          OR pbc.st_app_key IS NOT NULL OR pbc.hcp_api_key IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM provider_credentials pc WHERE pc.user_id = pbc.user_id AND pc.provider = pbc.provider)
   GROUP BY 1;                                  -- must return 0 rows
   SELECT i.integration_type, count(*) AS missing_in_vault
   FROM integrations i
   WHERE i.integration_type IN ('hubspot','google_calendar')
     AND (i.config ? 'access_token' OR i.config ? 'refresh_token')
     AND NOT EXISTS (SELECT 1 FROM provider_credentials pc WHERE pc.user_id = i.user_id AND pc.provider = i.integration_type)
   GROUP BY 1;                                  -- must return 0 rows
   ```
   Then trigger one Price Book sync and one booking → FSM push from the UI and confirm success.
6. **Scrub plaintext** (guarded: only rows that already have a vault copy are touched):
   ```sql
   UPDATE price_book_connections pbc
   SET jobber_access_token = NULL, jobber_refresh_token = NULL, st_client_secret = NULL, st_app_key = NULL, hcp_api_key = NULL
   WHERE EXISTS (SELECT 1 FROM provider_credentials pc WHERE pc.user_id = pbc.user_id AND pc.provider = pbc.provider);

   UPDATE integrations i
   SET config = i.config - 'access_token' - 'refresh_token'
   WHERE i.integration_type IN ('hubspot','google_calendar')
     AND EXISTS (SELECT 1 FROM provider_credentials pc WHERE pc.user_id = i.user_id AND pc.provider = i.integration_type);
   ```
7. **Rotate the exposed secrets.** Plaintext credentials sat in the database (and, for HubSpot/Google, were browser-readable) and in any backups. Treat them as exposed: rotate your own OAuth **client secrets** (Jobber, HubSpot, Google) and ask customers on ServiceTitan/Housecall Pro to regenerate their credentials/API keys when practical. Reconnecting also issues fresh tokens.

## Key rotation
`supabase secrets set PROVIDER_CREDENTIALS_KEY_PREV=<old> PROVIDER_CREDENTIALS_KEY=<new>` → redeploy → each credential re-seals with the new key the next time it is saved (tokens refresh regularly). Remove `_PREV` only after no row is sealed with the old key (a decrypt failure logs `credential_hydrate_failed`).

## Rollback
Code: redeploy previous function versions (they read plaintext columns; rows scrubbed in step 6 would then require reconnect). Data: step 6 is the only irreversible step — do not run it until step 5 returns 0 rows and a live test passed.

## Monitoring
Search function logs for `credential_hydrate_failed`, `credential_backfill_failed`, `provider_disconnected`.

## Known limits (honest)
- `hydrateRow` costs one vault read per connection per sync; fine at current scale, batch it if you pass a few thousand connections per cron run.
- Jobber/ServiceTitan/Housecall Pro/HubSpot token **revocation at the provider** is not implemented in `provider-disconnect` (no verified endpoint in this repo); only Google revocation is. Tell users to also remove the app in the provider.
- Concurrent refresh of a rotating Jobber refresh token by two parallel requests is not locked.
