# ServiceTitan App Marketplace — application pack (DRAFT, NOT SUBMITTED)

Status: **draft prepared from code in this repository. Nothing has been submitted, and no ServiceTitan approval, tier, sandbox or fee exists.**
Every statement is tagged **[code]** (verified in the file cited), **[owner]** (a business fact only the owner can supply) or **[unverified]**.
Re-check requirements on ServiceTitan's official pages before submitting; programmes change (see `partner-requirements-matrix.md` §1.1).

## 1. Current integration, as implemented

| Item | Fact | Source |
|---|---|---|
| Auth to ServiceTitan | OAuth2 `client_credentials` grant against `https://auth.servicetitan.io/connect/token`, using the **customer's own** Client ID + Client Secret + App Key + Tenant ID | [code] `_shared/price-book/servicetitan.ts` |
| Policy status | This is the "App Key tunneling" pattern ServiceTitan prohibits. **New tenants are now blocked by default** (flag `servicetitan_app_key_onboarding`, default OFF). Existing live connections are grandfathered. | [code] `price-book-connect-servicetitan/index.ts`, `_shared/price-book/stOnboardingPolicy.ts`, migration `20290304000000` |
| Certified auth model | Unknown: ServiceTitan's own credentials model for certified apps is not documented publicly in what was reviewed. Ask the Technology Partner Manager. | [unverified] |

## 2. Data flows (verified endpoints only)

| # | Direction | Method + path | Purpose | Source |
|---|---|---|---|---|
| 1 | Vireek → ST | `POST https://auth.servicetitan.io/connect/token` | obtain access token | [code] servicetitan.ts |
| 2 | ST → Vireek | `GET /pricebook/v2/{tenant}/services?page&pageSize=200&active=true` (max 50 pages) | import service prices (id, name, price, active, category.name) into `price_book_items` | [code] servicetitan.ts |
| 3 | Vireek → ST | `GET /crm/v2/tenant/{tenant}/customers?phone=…&pageSize=1` | find an existing customer by phone | [code] servicetitan-jobs.ts |
| 4 | Vireek → ST | `POST /crm/v2/tenant/{tenant}/customers` (name, type "Residential", phone, street) | create customer when not found | [code] servicetitan-jobs.ts |
| 5 | Vireek → ST | `POST /jpm/v2/tenant/{tenant}/jobs` (customerId, locationId, businessUnitId, jobTypeId, priority "Normal", summary, one appointment) | book a job taken by the AI receptionist | [code] servicetitan-jobs.ts |

Not implemented (do not claim): reading ST technician availability/capacity, webhooks, UI embedded in ServiceTitan, two-way job status sync. [code] no such calls exist.
Field names and paths carry a "VERIFY against a live sandbox" note in the source; **never exercised against a ServiceTitan sandbox.** [code]

## 3. Scopes / least privilege
- The code touches three API areas: Pricebook (read), CRM customers (read, create), JPM jobs (create). [code]
- The API scopes actually granted live in the customer's ServiceTitan app today, not in Vireek code. For certification, request only the three areas above. [owner/unverified]

## 4. Data handling and security answers (from code)
- **Credential storage.** A sealed credentials vault exists (`_shared/secrets/providerCredentials.ts`, keys `st_client_secret`, `st_app_key`) with deletion on disconnect. [code] **Gap:** `price-book-connect-servicetitan` still upserts `st_client_secret`/`st_app_key` into plaintext columns of `price_book_connections`; the table is service-role only (RLS enabled, no policies, so not browser-readable) but not encrypted for this path. [code] Fix before certification.
- **Tenant isolation.** `price_book_connections` RLS on, zero policies; status exposed through SECURITY DEFINER `get_price_book_connections()` which returns no secrets. [code] migration `20260913010100`.
- **Authorization to connect.** `can_manage_integrations()` (business-profile edit + billing view), enforced server-side with 401/403. [code] migration `20290304000000`, `_shared/auth/integrationAccess.ts`.
- **Disconnect / offboarding.** `provider-disconnect` deletes sealed credentials and nulls plaintext columns, marks the connection `disconnected`, optionally deletes imported price-book rows. **No ServiceTitan-side revocation call exists** (none verified). [code]
- **Resilience.** Outbound calls use `fetchWithRetry` (exponential backoff + full jitter, `Retry-After`, 429/503 always retried, 5xx/network only for reads; writes are never replayed after a 5xx). Job push is idempotent per `(job_id, provider)`. [code] `_shared/http/retry.ts`, `_shared/dispatch/jobSyncClaim.ts`
- **Audit logging.** Disconnect and connect events are logged to function logs only (`provider_disconnected`). **No dedicated audit-table row is written.** [code]
- **Certifications.** No SOC 2, no ISO 27001, no evidenced penetration test in the repo. Do not claim any. [code] `docs/compliance/SOC2_READINESS.md` per matrix

## 5. Questions only the owner can answer ("Needs human")
Company legal entity and signatory · tier (Silver/Gold/Titanium) and annual dues · tenant fee vs revenue share · support SLA and contacts · target customer count · pricing · Technology Partner Manager contact · data-retention periods · sub-processors list (see `docs/security/partner-security-questionnaire.md`).

## 6. Before submitting
1. Move ST secrets to the vault on connect (remove plaintext write). 2. Obtain sandbox, run the flows in §2, correct field names. 3. Replace the App-Key connect path with ServiceTitan's certified auth model. 4. Fill ServiceTitan's Data + API Workflow Questionnaire from §2–§4.
