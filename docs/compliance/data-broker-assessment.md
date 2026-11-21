# Data-broker assessment: external data sources and non-customer data subjects

> **Status: DRAFT for counsel and product review. Not legal advice.** Built from a static read of the repository. **No SQL was
> executed against a database and no provider terms were fetched** (no network access when this was written). Anything that
> depends on deployed state or on a provider's current terms is marked **[VERIFY]**; anything that needs a legal decision is marked
> **[COUNSEL]**. Nothing here states that Vireek is, or is not, a "data broker" under any statute: that conclusion belongs to counsel.
>
> Companion files: `supabase/migrations/20290306000000_data_sources_registry.sql`,
> `supabase/functions/dsar-non-customer/index.ts`, `supabase/functions/_shared/compliance/nonCustomerDsar.ts`,
> `scripts/compliance/check-data-sources.mjs`, `supabase/tests/database/data_sources_registry.test.sql`.
> Related: `docs/compliance/cross-tenant-data-flows.md`, `docs/compliance/data-map.md`, `docs/compliance/dpia-voice-ai.md`.

## 1. Scope and method

Two functions were inspected line by line: `property-intelligence-enrich` and `identity-signal-scan` (plus the `ai-core` provider chain
that `identity-signal-scan` calls through `narrateIdentityDrift`). Method: read each function; extract every literal external host;
follow the AI route in `ai-core/registry.ts`; read the migrations that create the tables written. The host list is re-checked by
`node scripts/compliance/check-data-sources.mjs`, which fails when a host called by these two functions is missing from the registry.
That check sees literal URLs only; a host assembled at runtime would not be seen.

Out of scope here (see the register in `cross-tenant-data-flows.md` and `data-map.md`): voice/telephony vendors, payment and
accounting connectors, and every other edge function. They need the same registry rows before the registry can be called complete **[VERIFY]**.

## 2. What the code does

### 2.1 `property-intelligence-enrich`

Runs as the signed-in caller (anon key plus the caller's JWT, never the service role). For one `customer_sites` row it:

1. builds a query from the site's street address, city, state and postal code and sends it to Nominatim (only when coordinates are missing or the address changed);
2. sends the resulting **latitude/longitude** to the Census geocoder (tract), Open-Meteo (climate), FEMA NFHL (US flood zone) and USGS ComCat (seismic count);
3. sends tract codes (state/county/tract, no address) to the Census ACS API for area-level economics.

Results are stored on `property_profiles` (coordinates, normalized address, tract id) and `property_intel_layers` (climate, hazards,
economic) with provenance (`source`, `confidence`, `as_of`). The code comment on the economic layer states it is area level and
never about the occupants; this assessment confirms the ACS request contains no person-level field.

**No data is bought or licensed about individuals.** Every provider is a public or open service queried with an address or a coordinate
that a Vireek tenant already holds. The personal-data exposure is the other direction: **the address and coordinates of a tenant's
end customers (people who are not Vireek customers) are sent to third parties.**

### 2.2 `identity-signal-scan`

Reads the signed-in account owner's own decisions (`business_decisions`, `causal_outcome_tracking`, `regret_console_decisions`,
`business_decision_settings`), turns them into numeric signals with a fixed category map (no AI in the numbers), and writes
`identity_observations` / `identity_drift_alerts`. The only outbound call is `narrateIdentityDrift` -> `askVireekAi` with the task
`continual_identity_learner`. That task uses the JSON chain: Gemini, Groq, Cerebras, OpenRouter (Cloudflare is excluded from the JSON
chain in `registry.ts`). The prompt carries the dimension name, two averages, sample counts and up to three example notes such as
"Approved a pricing decision (80% confidence)". If every provider fails a deterministic fallback text is used.

**No third-party personal data is acquired or sent.** The subject is the account owner and the content is their own aggregated decision
metadata. It is in the registry because it is an outbound AI flow and AI providers' training/retention terms must be known **[VERIFY]**.
Route overrides (`applyRouteOverrides` in `economics/routeOverrides.ts`) could change the chain at runtime **[VERIFY]**.

## 3. Registry (summary of `data_sources`)

The authoritative rows are in the table; this is a human-readable copy. Every `license_status` starts as `verify` and can only be
set to `verified` with a named reviewer and review date (database CHECK).

| Key | Provider / host | Receives from Vireek | Data subjects | Terms concern | Retention in Vireek |
|---|---|---|---|---|---|
| `osm-nominatim` | Nominatim `nominatim.openstreetmap.org` | **Full street address** | Tenants' end customers | **[VERIFY]** public-instance usage policy (identifying UA, rate limits, bulk-use limits); ODbL attribution/share-alike on results | Life of the site (cascade); no sweep located |
| `us-census-geocoder` | `geocoding.geo.census.gov` | Lat/lon | Same | **[VERIFY]** US-government service terms | Tract id, life of the site |
| `us-census-acs` | `api.census.gov` | Tract codes only | none | **[VERIFY]** attribution / non-endorsement notice | Economic layer, life of the site |
| `open-meteo-archive` | `archive-api.open-meteo.com` | Lat/lon | Same | **[VERIFY] the free API is described as non-commercial; Vireek is commercial.** Confirm plan or self-host | Climate layer, life of the site |
| `fema-nfhl` | `hazards.fema.gov` | Lat/lon | Same | **[VERIFY]** terms / disclaimer | Hazards layer, life of the site |
| `usgs-comcat` | `earthquake.usgs.gov` | Lat/lon | Same | **[VERIFY]** terms / credit line | Hazards layer, life of the site |
| `ai-gemini`, `ai-groq`, `ai-cerebras`, `ai-openrouter` | respective APIs | Aggregated owner-decision metadata | Account owners | **[VERIFY]** training use, retention, DPA; OpenRouter routes to a varying upstream | Only generated text is stored |

## 4. The data-broker question

**Facts from code.** (a) No personal data about people with whom Vireek has no relationship is purchased, scraped or enriched from
people-search sources. (b) Vireek does hold records about such people (tenants' customers, leads, callers) as a processor. (c) Provider
responses stored by the enrich function are place data, not person data, but the stored coordinates and normalized address identify a
dwelling. (d) Cross-tenant sharing exists (Service Data Exchange, benchmarks, demand exchange); `cross-tenant-data-flows.md` classifies
those flows, and `src/lib/homeDemandExchangeApi.ts` reads `property_profiles`, so it must be reviewed before any conclusion **[VERIFY]**.

**Not decided here.** State data-broker laws are commonly framed around a business that knowingly collects **and sells** personal
information of consumers it has no direct relationship with **[VERIFY the definitions of every state in which Vireek has users]**.
Whether tenant-to-tenant data products, lead marketplace features or any monetised enrichment fall inside such a definition, and whether
registration or deletion-platform obligations apply, is **[COUNSEL]**. Facts counsel will need: what is sold or licensed to whom,
whether any non-customer personal information is in it, and whether it is de-identified.

## 5. Non-customer data subjects: how requests are handled

Identity is verified by `dsar-request` (one-time code). What happens next, by request kind, for a requester who is **not** an account owner:

| Request | Immediately on verification (`dsar-request`) | Staff action (`dsar-non-customer`, `action: process`) | Closes when |
|---|---|---|---|
| Delete / opt out | Email key added to `data_subject_suppressions` | Clears Vireek-derived property data (coordinates, normalized address, tract, provider layers) for the subject's sites; suppresses those addresses; opens a **controller referral** per tenant holding matching `customers` / `leads` rows | No matches, or every referral resolved by the tenant (`dsar_referral_resolve`) |
| Access | none | Referrals only. **Nothing is disclosed automatically**; staff answer the requester | Every referral resolved and staff reply sent |
| Correct | none | Referrals only (tenant owns the record) | Every referral resolved |

Rules built in:

- `property-intelligence-enrich` calls `property_site_suppressed()` before any outbound request and **fails closed**: an opted-out subject's
  address is never sent to Nominatim or any other provider again, and a failure of the check blocks enrichment.
- Vireek never deletes tenant-controlled records on its own. The tenant decides **[COUNSEL: confirm controller/processor roles and that the DPA says so]**.
- Deadlines: the existing promise is 30 days from verification (`DSAR_RESPONSE_DAYS`). Tenants receive that deadline minus 10 days, never less than 3 days from now
  (`CONTROLLER_RESPONSE_BUFFER_DAYS`, `CONTROLLER_MIN_RESPONSE_DAYS`). These are operational choices, not legal advice **[COUNSEL]**.
- Suppression lookups are counts/booleans; discovery returns row counts only, never content.
- Manual (`status = 'manual'`) property layers are tenant-entered and are left for the tenant to decide.

## 6. Open items (nothing below is done by the code in this change)

| # | Item | Why it matters | Owner |
|---|---|---|---|
| 1 | Confirm Open-Meteo commercial terms or switch/self-host | Free tier is described as non-commercial **[VERIFY]** | Product + counsel |
| 2 | Confirm Nominatim policy fit or move to a licensed/self-hosted geocoder | Production traffic on a public instance **[VERIFY]**; sends full addresses | Engineering |
| 3 | Add a retention rule for `property_profiles` / `property_intel_layers` | No scheduled sweep found (grep of `data-retention-sweep`, `delete-account`, `ownedTables.ts`) **[VERIFY]** | Engineering |
| 4 | UI: tenant page to view and resolve referrals; staff queue for non-customer DSARs | Today referrals are visible through the API/RLS only and staff use the function directly | Product |
| 5 | Apply the suppression list to other flows (lead intake, call handling, marketing sends, lead marketplace) | Only property enrichment checks it today; DNC/preference checks are separate | Engineering |
| 6 | Email suppression keys are **unsalted** SHA-256 | Low-entropy inputs are guessable; the table is service-role only (RLS, no policy). Consider an HMAC with a server secret | Security |
| 7 | Address keys are ASCII-only | Non-Latin addresses cannot be keyed and are not suppressed by address (the email key still applies) | Engineering |
| 8 | AI providers: confirm no-training/retention settings on every key | Registry rows `ai-*` | Security + counsel |
| 9 | Review `homeDemandExchangeApi` and other consumers of `property_profiles` | Section 4(d) | Engineering + counsel |
| 10 | Extend the registry to every other outbound integration | Section 1 | Engineering |
| 11 | Reviewer sign-off in `data_sources` (`license_status`, `reviewed_by`, `last_reviewed_at`) | Rows stay `verify` until a person has read the terms | Compliance |

## 7. How to verify

```bash
node scripts/compliance/check-data-sources.mjs                    # host drift check (exit 1 on drift)
node --test scripts/compliance/check-data-sources.test.mjs        # its tests
npx vitest run supabase/functions/_shared/compliance/nonCustomerDsar.test.ts
supabase test db                                                  # includes data_sources_registry.test.sql
```

Review cadence: re-run the host check in CI on every change to the two functions or to `ai-core/registry.ts`; re-review each row's terms at least yearly **[COUNSEL to set]**.
