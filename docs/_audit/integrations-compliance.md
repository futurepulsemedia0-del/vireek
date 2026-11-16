# Integrations compliance — audit report

Date: 2026-11-13 · Basis: uploaded `vireek-main__1_.zip` only (no node_modules, no network, no database, no git history, no live provider access).
**Nothing here was deployed, migrated or run against a real environment.**

## 1. Verified in code (several docs were stale)
- Already existed, unchanged: `provider-disconnect`, `_shared/price-book/disconnect.ts`, `jobber-webhook` (APP_DISCONNECT, HMAC, dedupe table), Price Book "Disconnect" button, Microsoft `canManage` check, `_shared/http/retry.ts` (backoff + full jitter + Retry-After + Jobber THROTTLED), Xero backoff (`retryDelayMs`, no jitter), QuickBooks `qboRequest` with sleep (jitter not verified), QuickBooks disconnect/revoke.
- **Real bugs found and fixed:**
  1. `_shared/price-book/jobber.ts` imported a non-existent path (`../_shared/auth/crmPermission.ts`, unused) → any function importing it fails to load in Deno.
  2. `_shared/dispatch/externalJobSync.ts` imported `servicetitanJobs.ts`; the file is `servicetitan-jobs.ts` → `vapi-webhook` could not load.
  3. `price-book-sync` Jobber branch dereferenced `refreshed.access_token` when `refreshed` was `null` (token still valid) → sync failed.
  4. `price-book-sync` with `{all_tenants:true}` had no authentication → now requires `CRON_SECRET` (fail-closed).
  5. `price-book-sync` wiped `last_synced_at` on error → "last successful sync" is now preserved.
  6. `externalJobSync` wrote refreshed Jobber tokens back to plaintext columns, leaving the vault copy stale (Jobber rotates refresh tokens → lockout risk) → now `saveSecrets`.
  7. `externalJobSync` had no idempotency: a webhook retry created duplicate external jobs → now claimed per `(job_id, provider)`.
  8. `IntegrationsPage` Disconnect for Google/HubSpot only flipped `status`; tokens stayed in `integrations.config`, no Google revoke → now `provider-disconnect`.
  9. `provider-disconnect` had no permission check (a technician could disconnect) → `can_manage_integrations`.
- `oauthState.ts`: signed, 10-min expiry, constant-time compare: MET. NOT single-use and bound to user id only (not tenant) → single-use added.
- 29 other unresolved relative imports remain in `supabase/functions` (agent-actions, fair-sale, safety, dispatch-optimizer, landscaping-cron, reputation, truth). Not integration code; probably files missing from this ZIP. **Not touched, not verified.**

## 2. Changed (see `integrations-safety.patch`, 51 files incl. tests/docs)
- Migrations: `20290304000000_integrations_permission_and_st_flag.sql` (can_manage_integrations, flag `servicetitan_app_key_onboarding` OFF, single-use OAuth nonces) and `20290304000100_integration_health_and_drift.sql` (drift reports, `get_integration_health()`). Rollback blocks inside each.
- Edge functions: `price-book-connect-servicetitan` (permission + flag + grandfathering), Jobber/HubSpot/Google start (permission), their callbacks (single-use state), `provider-disconnect` (permission + audit_log row), `price-book-sync`, new `integration-reconcile` (report-only drift).
- Shared: `auth/integrationAccess*`, `price-book/stOnboardingPolicy`, `oauthStateNonce*`, `price-book/drift`, `dispatch/jobSyncClaim`; retry/backoff wired into ServiceTitan, Housecall Pro, Jobber jobs and `externalJobSync`.
- UI: ServiceTitan "Certified connection coming soon" when flag OFF; last successful sync shown on error; Google/HubSpot disconnect via server.
- HubSpot **removed** from marketing (home, integrations page and marquee, FAQ, automation text, live-stream demo text, `integrations.ts` detail page, sitemap, evidence list); in-app card shown only for tenants who already have a connection (legacy, with honest text).
- Docs: `docs/integrations/servicetitan-application-pack.md` (draft, not submitted), `partner-status.md` correction.

## 3. Verification
| Check | Result |
|---|---|
| New/related unit tests run under Node with a small expect shim (38 tests: access, ST policy, OAuth state + nonce, claim/idempotency, drift, provider contracts incl. 429 and THROTTLED retry) | PASSED 38/38 — **this is not vitest** |
| `tsc --strict` on the pure new modules; TS syntax scan of all 33 edited TS/TSX files | PASSED (no syntax errors); full type-check with real deps NOT RUN |
| Patch applies cleanly to the pristine ZIP (`git apply --check`) | PASSED |
| `vitest run`, full `tsc -b`, `eslint` | **NOT RUN** (no node_modules/network) |
| pgTAP (`integrations_safety.test.sql`, 15 assertions) and both migrations | **NOT RUN** (no database) |
| Edge functions in Deno, UI in browser, any provider API | **NOT RUN / BLOCKED** |

## 4. NOT done / honest limits
- **Contract fixtures are SYNTHETIC**, not recorded from live APIs (`__fixtures__/README.md`). They pin our client's behaviour, not the provider's. No contract tests for Google (no sync client exists) or HubSpot (removed).
- Reconciliation covers ServiceTitan and Jobber price books only. Housecall Pro (no read endpoint in code), Xero, Google, QuickBooks (has its own `qbo_reconciliation` migration, not reviewed) are not covered by `integration-reconcile`.
- Dead-letter: `job_external_syncs.status='error'` rows are the dead-letter queue (counted by `get_integration_health()`); there is **no automatic retry job** and no UI list/retry button.
- `get_integration_health()` is created but **not yet rendered** in the UI (the Price Book page shows last success + error only). Drift is not shown in the UI yet.
- Xero retry has no jitter; I did not change it (existing tests may pin values).
- ServiceTitan connect still writes `st_client_secret`/`st_app_key` to plaintext columns; Jobber/HCP connect functions not audited for the same.
- No remote revocation for Jobber, ServiceTitan, Housecall Pro, HubSpot (no verified endpoint). UI tells the user to remove the app at the provider.
- Jobber `APP_DISCONNECT` topic name and payload shape are from existing code/comments: **verify in GraphiQL**. Jobber GraphQL version is still pinned in 3 places (2025-04-16 everywhere now, but duplicated).
- OAuth state binds user id, not account owner. "Bidirectional sync … automatic conflict resolution" (Salesforce/Zoho) in `AutomationEngines.tsx` is NOT verified. `docs/claims-register.json` has no entries (nothing to correct).
- Not production-ready: no executed integration, DB or end-to-end test exists.

## 5. Exact manual steps (in order)
1. Apply patch: `git apply -p1 integrations-safety.patch`. Review `git diff`.
2. `npm ci && npx tsc -b && npx vitest run && npm run lint` — fix anything real tooling reports (my shim is not vitest).
3. `supabase test db` against a **staging** DB, then apply both migrations to staging, then production.
4. Deploy: `price-book-connect-servicetitan`, `price-book-sync`, `provider-disconnect`, `jobber|hubspot|google-calendar-oauth-start`, `jobber|hubspot|google-calendar-oauth-callback`, `integration-reconcile` (new), and every function importing the fixed shared files (`vapi-webhook`, `jobber-oauth-callback`, `price-book-connect-housecallpro`).
5. Secrets: `CRON_SECRET` must be set. If anything already calls `price-book-sync` with `all_tenants:true`, add header `x-cron-secret`. Schedule `integration-reconcile` weekly (same header, body `{"all_tenants":true}`).
6. Decide in the staff flag console whether to enable `servicetitan_app_key_onboarding` for any tenant (default OFF).
7. Jobber Developer Center: register webhook URL for `jobber-webhook`, confirm APP_DISCONNECT in GraphiQL.

## 6. Needs human — vendor applications to submit
- **ServiceTitan**: App Marketplace application, dues, tenant fee/rev-share, sandbox, Data+API questionnaire (draft: `servicetitan-application-pack.md`).
- **Jobber**: Developer Center 2FA, pre-submission checklist, app review (watch the >5 paying accounts rule for Draft apps).
- **Intuit (QuickBooks)**: app assessment questionnaire, production keys, EULA/privacy/disconnect/launch URLs.
- **Housecall Pro**: contact partnerships for OAuth app/programme/sandbox.
- **Google**: Actions Center interest form, Business Profile API access, OAuth verification.
- **Microsoft**: Cloud Partner Program enrolment, publisher verification.
- **HubSpot**: only if you decide to build a real sync later (public app + Tech Partner agreement).
- **Cross-cutting**: named security owner, penetration test, SOC 2 / ISO decisions.
