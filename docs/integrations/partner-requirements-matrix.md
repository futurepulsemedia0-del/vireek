# Partner certification — requirements matrix & gap report

Audit date: 2026-11-03 · Code basis: `vireek-main__5_.zip` (no `.github/`, no `node_modules`, no live DB). Sources are official platform pages unless marked **(secondary)**; every requirement must be re-checked on the official page before you submit — programs change. Status: **MET** / **PARTIAL** / **MISSING** / **UNVERIFIED** (could not be verified from code or public docs).

## 0. Honest summary (read first)

| # | Finding | Severity |
|---|---|---|
| 1 | **ServiceTitan "tunneling" risk.** `price-book-connect-servicetitan` asks each customer for their own Client ID, Client Secret, **App Key** and Tenant ID. ServiceTitan's help center says a third party asking a customer to create an app and share its App Key is *tunneling* and is **prohibited**; customers may be told to disconnect. Certified Apps connect "without requiring you to share App Keys". The only compliant paths are (a) ServiceTitan Certified App (Partner Program application, fees, certification) or (b) the customer builds/hosts their own app. Source: help.servicetitan.com/commercial/docs/understand-approved-integration-paths-in-servicetitan (updated 2026-10-16). | **Critical / business** |
| 2 | **Plaintext credentials at rest.** Jobber access+refresh tokens, ServiceTitan `client_secret`/`app_key`, Housecall Pro API key are plaintext columns in `price_book_connections` (RLS on, zero policies → service-role only: not browser-readable, but not encrypted). **HubSpot and Google Calendar tokens are stored in `integrations.config`, a table with a per-user SELECT policy → readable by the browser/any XSS.** QuickBooks and CRM (Salesforce/Pipedrive/Zoho) are done right (AES-256 in service-role-only `*_connection_secrets`). | **Critical** |
| 3 | HubSpot is a stub: OAuth only, scopes `crm.objects.contacts.read/write`, tokens stored but **no function consumes them** (only the 2 OAuth functions reference HubSpot). No refresh, no sync, no uninstall endpoint, no webhooks. Not listable as-is. | High |
| 4 | Jobber/HubSpot/Google-Calendar OAuth bind the connection to `auth.uid()` rather than the account owner and **skip the `can_manage_*` permission check** that QuickBooks/CRM use (`qbo-oauth-start`, `crm-oauth-start`). Inconsistent for multi-user accounts. | High |
| 5 | No inbound webhook receivers for ServiceTitan, Jobber, Housecall Pro, HubSpot (only QuickBooks `qbo-webhook`). Jobber needs one (APP_DISCONNECT/uninstall handling; HMAC verify now provided — see §6). | High |
| 6 | **No FSM availability is read** from ServiceTitan/Jobber/Housecall Pro. `google-booking-feed` uses Vireek's own technician capacity. Write-back exists but maps one default job type + business unit per tenant (ServiceTitan) and a minimal client+job (Jobber). | High (capacity-aware booking) |
| 7 | No disconnect/offboarding function found for ServiceTitan, Jobber, Housecall Pro, HubSpot, Google Calendar. QuickBooks disconnect revokes the grant at Intuit (`qbo-sync-run` ~L1564–1574 — verified). `delete-account` does not reference any connection table (may rely on FK cascade — **UNVERIFIED**). | High |
| 8 | Jobber GraphQL version is pinned inconsistently: `2025-04-16` (`_shared/price-book/jobber.ts`) vs `2023-11-15` with a `TODO` (`_shared/price-book/jobber-jobs.ts`, and a third copy of the Jobber GraphQL call in `_shared/dispatch/externalJobSync.ts`). No handling of Jobber `THROTTLED` / 429. | Medium |
| 9 | No contract tests for ServiceTitan/Jobber/Housecall Pro/HubSpot/Google. Tests exist for QuickBooks (`src/lib/quickbooks*.test.ts`) and CRM (`src/lib/crmSync.test.ts`). | Medium |
| 10 | Security programme: **no SOC 2 report, no ISO 27001, pen-test status not evidenced in repo**, accountable security owner "TBD", MFA not enforced, no on-call roster (`docs/compliance/SOC2_READINESS.md`, snapshot 2026-10-28). Several partners ask for these. | Medium (varies by partner) |

## 1. Requirements matrix

### 1.1 ServiceTitan — App Marketplace Program & Certification
Sources: servicetitan.com/legal/app-marketplace-program-guide (last revised Nov 2025, fetched 2026-11-03); help.servicetitan.com … understand-approved-integration-paths (updated 2026-10-16); servicetitan.com/blog/app-marketplace-relaunch (2025-09-08); servicetitan.com/legal/api-terms.

| Requirement (official) | Status | Evidence / gap |
|---|---|---|
| Competitive application; tiers Silver/Gold/Titanium; **upfront annual dues**; per-tenant fee **or** revenue share (ST decides) | MISSING | Business action: apply. **Needs you: application, fees, order form.** |
| Certification steps: Integration Evaluation Call → Workflow Recommendation → **Data + API Workflow Questionnaire** → Integration Environment (sandbox) → Final Review | MISSING | Data-flow map in `docs/security/partner-security-questionnaire.md` §3 is a starting point for the questionnaire. |
| **No tunneling**; certified apps must not need customers' App Keys | **MISSING (violated by current design)** | `price-book-connect-servicetitan/index.ts` collects `app_key`/`client_secret`. Must be replaced after certification by ServiceTitan's own app credentials/auth model for certified apps (confirm exact model with your Technology Partner Manager — not publicly documented in what I could fetch). |
| Re-certification at least once per year; patches/updates may require re-certification | MISSING | Calendar item. |
| Least-privilege / stay within "Certified Scope" (API scopes, endpoints, fields) (API Terms §2.3–2.4) | PARTIAL | Current code calls Pricebook, CRM customers/locations, JPM jobs. Document the exact endpoint list (see §3). |
| UI integrated into ServiceTitan where possible | MISSING | Not built. |
| Support SLA obligations, Code of Conduct, branding rules | UNVERIFIED | Need partner agreement. |
| Sandbox testing with test tenant | MISSING | `servicetitan-jobs.ts` header says "VERIFY before production… against a live sandbox tenant". Not done. |

### 1.2 Housecall Pro
Official help (help.housecallpro.com/en/articles/8505035-api-overview, fetched 2026-11-03): API key generated by an Admin in the App Store; API available **only on MAX plan**; HCP "cannot build or maintain custom integrations created via API keys". A public partner/marketplace certification programme: **UNVERIFIED — I found no official public page** (only third-party sources, not relied on). **Needs you: ask HCP partnerships for the partner programme, OAuth app credentials and listing requirements.**

| Requirement | Status | Evidence / gap |
|---|---|---|
| Per-company API key (MAX plan only) | PARTIAL | `price-book-connect-housecallpro` verifies key via `verifyHousecallProKey`; key plaintext in `hcp_api_key`. Customers on non-MAX plans cannot connect — must be stated in UI/listing. |
| OAuth for public apps | UNVERIFIED | Secondary sources mention OAuth; not confirmed from official docs. |
| Webhooks (signed) | UNVERIFIED / MISSING | No receiver in code. |
| Rate-limit compliance | UNVERIFIED | HCP limits not found in official docs; implement generic 429 + `Retry-After` backoff. |

### 1.3 Jobber — Developer Center / App Marketplace
Sources: developer.getjobber.com/docs/publishing_your_app/app_review_process; …/building_your_app/testing_your_app; …/using_jobbers_api/api_rate_limits; …/using_jobbers_api/setting_up_webhooks; help.getjobber.com … Developer Center (all fetched/searched 2026-11-03).

| Requirement | Status | Evidence / gap |
|---|---|---|
| Developer Center account with **2FA** (needed to submit for review) | UNVERIFIED | Owner action. |
| App Pre-Submission Checklist; Jobber testing + app review; ~2-week beta after approval | MISSING | Owner action. |
| Draft apps: API access **blocked if >5 paying Jobber accounts** connect while in Draft; no mass distribution of connect URLs | **UNVERIFIED — risk** | Verify how many live customers use `JOBBER_CLIENT_ID` today. |
| Test with Jobber developer test account (90-day) | MISSING | No tests/sandbox suite. |
| Marketplace listing fields: name, developer, description, Manage App URL, features, gallery, logo | MISSING | Drafted in `listing-kit.md`. |
| Connect/Disconnect workflows work from the marketplace | PARTIAL | Connect: `jobber-oauth-start/callback`. **Disconnect: missing** (no function, no APP_DISCONNECT handling). |
| OAuth code flow + refresh-token flow | PARTIAL | `jobber.ts` refreshes (5-min skew, stores new refresh token). Verify `refreshJobberTokenIfNeeded` result is persisted by every caller (`price-book-sync`, `externalJobSync`) — **not verified**. |
| API versioning via `X-JOBBER-GRAPHQL-VERSION` | PARTIAL | Two different versions in code (finding 8). |
| Rate limits: leaky-bucket query cost (10,000 pts, 500/s refill — **(secondary)**), 2,500 req/5 min DDoS guard (secondary), `THROTTLED` error code (official page) | MISSING | No backoff. |
| Cursor pagination | MET | `fetchJobberProducts` uses `pageInfo`/`endCursor`, page size 100. |
| Webhooks: HMAC-SHA256 base64 of raw body with client secret in `X-Jobber-Hmac-SHA256`; at-least-once; Jobber may disable slow/failing endpoints | MISSING → primitive added | `_shared/price-book/jobberWebhookSignature.ts` (new, tested). Receiver function not written: topic names / payload shape / account-id field must be confirmed in Jobber's GraphiQL schema first (I did not invent them). |
| Scopes minimal | UNVERIFIED | Scopes are configured in Developer Center, not in code. |

### 1.4 QuickBooks Online (Intuit)
Sources: developer.intuit.com/app/developer/qbo/docs/go-live/publish-app/technical-requirements (search snippet 2026-11-03; page is JS-rendered, full text not retrievable); Intuit app-assessment details via **secondary** mirrors (docs.apideck.com … app_compliance; docs.unified.to quickbooks-oauth-app).

| Requirement | Status | Evidence |
|---|---|---|
| **App assessment & compliance questionnaire** required for *any* app touching production QBO companies (listed or not); gates production keys | MISSING | **Needs you** (Intuit developer account). Answers prepared in security pack §2. |
| App Store listing = technical + security + legal + marketing review, repeated annually; apps >500 connections reviewed annually even if unlisted (secondary) | MISSING | **Needs you.** Fix critical/high/medium findings before publish; compliance issues within 2 weeks (secondary). |
| Use discovery-document endpoints | PARTIAL | URLs hard-coded in `_shared/quickbooks/engine.ts` L765–767 (match Intuit's published values per a 2026-09-20 secondary check). Acceptable; add a contract test. |
| OAuth `state`/CSRF handled | MET | `signOAuthState`/`verifyOAuthState` (10-min, signed). |
| Handle `invalid_grant` / expired or revoked refresh token | MET | `qbo-sync-run` classifies `token_revoked`; refresh token expiry stored. |
| Store rotated refresh token + realmId | MET | encrypted in `qbo_connection_secrets`; realm validated, unique live realm index. |
| Capture `intuit_tid` | MET | `qbo-sync-run` L217. |
| Disconnect inside app calls revoke endpoint | MET | `qbo-sync-run` L1564–1574 (best effort). |
| Throttle handling (429 / error 6570) | PARTIAL | `classifyResponse` handles 429; 6570 (usage limit) not seen — **UNVERIFIED**. |
| Webhook signature (`intuit-signature` HMAC) | MET | `verifyWebhookSignature`, constant-time. Intuit's newer CloudEvents webhook format: **UNVERIFIED** — check Intuit changelog. |
| EULA + Privacy URLs, host domain, launch URL, disconnect URL, redirect URIs per environment | MISSING (portal) | **Needs you.** Privacy/Terms pages exist in the web app (not verified at the URL level). |
| Idempotent writes (`requestid`) | MET | `buildWriteRequest`. |
| Minor version pinned | MET | 75. |
| Fees: partnership fee above 500,000 CorePlus calls/month (secondary) | UNVERIFIED | Verify in Intuit App Partner Program terms. |

### 1.5 Google
Sources: developers.google.com/actions-center/verticals/{reservations/e2e,local-services/e2e}/integration-steps/overview (fetched 2026-11-03); Business Profile prerequisites per **secondary** guides (docs.unified.to, slashpost.ai, singhamandeep.com, Aug–Sep 2026) citing developers.google.com/my-business/content/prereqs.

| Requirement | Status | Evidence / gap |
|---|---|---|
| **Actions Center partner** (interest form → partner portal); integration typically **12–16 weeks**; Sandbox review then Production review; launch only after both; ongoing health-check thresholds or take-down | MISSING | **Needs you: interest form + Google approval.** Confirm with Google which vertical applies to home-services appointments (Local Services vs Reservations) — the pages I found describe both; I could not confirm which fits. |
| Daily Merchant / Services / Availability feeds via SFTP (Reservations E2E) | PARTIAL | `google-booking-feed` is HTTP, **Vireek-canonical field names, not Google's spec** (`docs/integrations/google-agentic-booking.md`). |
| **Booking Server** (HealthCheck, BatchAvailabilityLookup, CreateBooking, UpdateBooking; HTTPS Basic auth) | MISSING | Explicitly not built. `create_public_booking_with_settings` is the intended core. |
| Real-time updates (optional) | MISSING | — |
| Business Profile APIs: **access request approved per Cloud project** (quota 0 QPM until approved); owner/manager of a verified profile active ≥60 days with website (secondary); `business.manage` is a **sensitive scope → OAuth verification** | MISSING | **Needs you.** `gbp-sync` is off by default (`GBP_APPLY_ENABLED`). |
| OAuth tokens protected | **MISSING** | Google Calendar tokens plaintext in `integrations.config` (browser-readable). GBP tokens planned in the same table — **do not connect GBP before moving to an encrypted secrets table.** |
| "AI Mode agentic booking" | UNVERIFIED | No self-serve programme found; partner-only. |

### 1.6 HubSpot
Sources: developers.hubspot.com/app-partners/set-up; …/docs/apps/developer-platform/list-apps/listing-your-app/app-marketplace-listing-requirements; …/apply-for-certification/certification-requirements (certification page last modified 2026-02-23; set-up page 2026-06-03; fetched/searched 2026-11-03).

| Requirement | Status | Evidence / gap |
|---|---|---|
| Single public app ID; **OAuth as sole auth** | PARTIAL | OAuth used; project uses its own `HUBSPOT_CLIENT_ID` (needs to be the public app listing's ID). |
| **≥3 active unique installs** to list | MISSING | Needs real customers using it. |
| Request only scopes you use; remove unused | PARTIAL | Contacts read/write requested but **nothing uses them**. |
| Shared-data table accurate; read+write ⇒ advertise bi-directional | MISSING | Draft in `listing-kit.md`. |
| Setup docs URL, install URL, support URL, ToS & Privacy URLs live; HubSpot Crawler allow-listed; pricing matches website; ≥1 support method | MISSING | Owner action. |
| Initial review ≤10 business days; whole process ≤60 days after feedback | — | Timing info. |
| Certification: listed ≥6 months, **≥60 active installs**, demo video (incl. user disconnecting), use **Uninstall App API**, webhook endpoint must survive 150 req/s, no classic CRM cards | MISSING | Far off. |
| Token refresh, webhooks signature (v3), uninstall handling | MISSING | — |

### 1.7 Microsoft
Sources: learn.microsoft.com/entra/identity-platform/publisher-verification-overview; …/mark-app-as-publisher-verified; learn.microsoft.com/microsoft-365-app-certification/docs/{userguide,attestation,certification} (searched 2026-11-03).

| Requirement | Status | Evidence / gap |
|---|---|---|
| Publisher verification: verified Cloud Partner Program (Partner One) account linked to the Entra app registration; initiator needs Entra MFA and CPP Admin/Accounts Admin/Global Admin | MISSING | **Needs you (Partner Center enrolment).** |
| Publisher Attestation (self-assessment in Partner Center, renewed every year); first step towards Microsoft 365 Certification | MISSING | Docs state SaaS-app attestation is gated/pre-approved by the M365 App Compliance team — **confirm eligibility**. |
| Microsoft 365 Certification (independent security review, substantial effort) | MISSING | Not realistic before SOC 2 / pen-test evidence exists. |
| Existing code | **UNVERIFIED** | `microsoft-calendar-oauth-*`, `microsoft-calendar-sync`, `microsoft-calendar-disconnect` exist and `docs/MICROSOFT_CALENDAR_SETUP.md`; I did **not** inspect them or their token storage. |

## 2. Technical hardening — status & backlog

| Area | State | Action (priority) |
|---|---|---|
| Token encryption | QBO/CRM ✔; **Jobber/ST/HCP/HubSpot/Google Calendar: implemented in this change (vault + backfill + dual-read) — pending your deploy, backfill and plaintext scrub per `docs/runbooks/provider-credentials-migration.md`**; GBP ✘ (no flow yet) | ~~P0: create~~ (done in code) — original design: create `fsm_connection_secrets` (service-role only, AES-GCM like `encryptSecret` in `_shared/crm/engine.ts`), move all tokens, null the old columns, stop writing `integrations.config` tokens. Needs a data-migration plan — not done here (see §6). |
| OAuth state | **Fixed in this change (applied by you per instructions)** (nonce + constant-time + future-skew) | Apply edit in §6.2. Add PKCE where provider supports it (Salesforce already). |
| Permissions on connect | Jobber/HubSpot/Google ✘ | **P1:** mirror `qbo-oauth-start` (`get_account_owner_id`, `can_manage_*`). |
| Scopes | HubSpot unused; Jobber/Google unknown | **P1:** document exact scopes per provider in listing kit. |
| Refresh rotation/revocation | QBO/CRM ✔; Jobber partial; HubSpot/Google ✘ | **P1:** shared `getValidToken()` with row-lock to avoid concurrent refresh races. |
| Webhooks | QBO ✔; others ✘ | **P1:** Jobber receiver (after schema check), ST/HCP/HubSpot per partner docs. Always raw-body verify, constant-time, dedupe by event id, return 2xx fast, process async. |
| Idempotency | QBO ✔ (`requestid`) | **P1:** FSM job push: unique key on `job_external_syncs(job_id, provider)` and provider-side lookup before create. **Not verified** whether the existing upsert key is unique — check `job_external_syncs` migration. Jobber `clientCreate` runs on every booking → duplicate clients; add find-by-phone/email first. |
| Rate limits / retries | QBO ✔; CRM ✔ (429); **Jobber product import now uses `graphqlWithRetry` (THROTTLED/429/5xx)**; Jobber job push, ST, HCP ✘ | **P1:** shared fetch wrapper: honour `Retry-After`, Jobber `THROTTLED`, exponential backoff with jitter, circuit-break per connection. |
| Pagination | Jobber ✔, QBO ✔; ST unverified | check `servicetitan.ts`. |
| Error mapping | QBO ✔ (`classifyResponse`) | **P2:** one `ProviderError` taxonomy (auth/throttle/validation/transient) for all FSMs. |
| Offboarding / deletion | QBO revoke ✔; **others: `provider-disconnect` added (Google revoke ✔; other providers' remote revoke ✘ unverified)**; delete-account covered by FK cascade on `provider_credentials` | original: `*-disconnect` functions: revoke at provider where an endpoint exists, delete secrets + record links, stop sync, audit-log entry; wire into `delete-account`. |
| Contract tests / sandbox suites | QBO/CRM unit only | **P2:** record/replay fixtures per provider; sandbox suites need partner sandbox accounts (**needs you**). |
| Data-mapping docs | none | §3 below is the first draft. |

## 3. Data-mapping & endpoint inventory (as implemented today)

| Provider | Direction | Objects / endpoints in code | Mapping |
|---|---|---|---|
| ServiceTitan | pull | Pricebook (`servicetitan.ts`) | → `price_book_items` (`external_id`, price cents) |
| ServiceTitan | push | CRM v2 customers (search by phone) + locations, JPM v2 jobs (`servicetitan-jobs.ts`) | one `st_business_unit_id` + `st_job_type_id` per tenant; no skills/tags/campaign |
| Jobber | pull | GraphQL `products` (id, name, category, defaultUnitCost) | → `price_book_items` |
| Jobber | push | `clientCreate`, job creation (`jobber-jobs.ts`, `externalJobSync.ts`) | minimal; no property/request/quote |
| Housecall Pro | push | job write-back (`externalJobSync.ts`); key verify | not inspected in detail |
| QuickBooks | both | account, customer, item, invoice, payment (`QBO_ENTITIES`) with per-entity direction + conflict rules | `VIREEK_FIELDS`, `canonToQbo` / `qboToCanon` |
| Salesforce/Pipedrive/Zoho | both | via `crm-sync-run` | `defaultSettings(provider)` |
| HubSpot | none | tokens stored only | — |
| Google | feed out | `google-booking-feed` (bundle/availability/services) | Vireek-canonical |
| Google Calendar / Microsoft Calendar | calendar | OAuth + sync | — |

## 4. Capacity-aware booking — gap analysis

| Capability | ServiceTitan | Jobber | Housecall Pro |
|---|---|---|---|
| Read real availability before offering a slot | **Not implemented.** ST exposes dispatch/capacity APIs (not verified here — confirm in developer.servicetitan.io Dispatch/Capacity section in your sandbox) | **Not implemented**; verify whether the schema exposes schedulable availability (GraphiQL) | **Not implemented**; verify in docs.housecallpro.com |
| Write confirmed job back | ✔ customer+location+job | ✔ minimal | ✔ (not inspected) |
| Job type mapping per service | ✘ single tenant default | n/a | ✘ |
| Business unit per service area / trade | ✘ single default | n/a | n/a |
| Skills / required technician tags | ✘ | ✘ | ✘ |
| Tags / lead source / campaign | ✘ | ✘ | ✘ |
| Arrival window | ✘ (only `scheduledDatetime`) | start/end | — |
| Conflict policy when FSM and Vireek disagree | ✘ — Vireek's `jobs_no_double_booking` protects only Vireek's own table | ✘ | ✘ |

Design recommendation: add an `availability_provider` interface (`getBusyWindows(range)`) per FSM; `google-booking-feed` and `/book/:slug` subtract FSM busy windows only (can remove slots, never add — same invariant as `availability.test.ts`); cache ≤60 s; **fail closed** (publish nothing) if the FSM read fails or is stale. Mapping table `fsm_service_mappings(service_id, provider, job_type_id, business_unit_id, skill_ids[], tag_ids[])`. Requires sandbox access for each FSM — **blocked on partner access**.

## 5. What requires you (applications, fees, approvals)

1. ServiceTitan: Marketplace Program application; annual dues; per-tenant fee or revenue share; certification calls; sandbox. 
2. Intuit: app assessment questionnaire; production keys; EULA/privacy/disconnect/launch URLs; optional App Store listing.
3. Jobber: Developer Center 2FA; pre-submission checklist; app review; beta; confirm current number of connected paying accounts vs the 5-account Draft limit.
4. Housecall Pro: contact partnerships for programme/OAuth.
5. Google: Actions Center interest form; Business Profile API access request (+ OAuth verification for `business.manage`); decide vertical.
6. HubSpot: public app + listing; ≥3 installs; Tech Partner Program agreement.
7. Microsoft: Cloud Partner Program enrolment → publisher verification → Publisher Attestation eligibility check.
8. Security: name a security owner; pen-test (commission one); decide SOC 2 timeline.

## 6. Code delivered / required edits (this change)

See the chat message for step-by-step Persian instructions. New files: `supabase/functions/_shared/price-book/jobberWebhookSignature.ts` (+ test), `…/oauthState.test.ts`. Edit: `…/oauthState.ts` (replace `signState`/`verifyState`).

**Verification:** the 10 unit tests (`jobberWebhookSignature.test.ts`, `oauthState.test.ts`) were run with vitest 2.1.9 on Node 22 in an isolated scratch folder → **PASSED (10/10)**. They were **NOT run inside your repository** (no `node_modules`, no Deno here), and no type-check, lint, `check-design-system.mjs`, Playwright or axe run was possible → **NOT RUN**. Nothing was deployed or executed against Supabase/any partner API.
