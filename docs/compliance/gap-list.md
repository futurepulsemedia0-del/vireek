# Gap list - EU / UK / CA / AU readiness

Basis: static read of the `vireek-main` snapshot (2026-11-01 archive). **Nothing was executed**: no tests, builds, SQL or deployed functions. The real repository may differ; re-verify each item against the current code before acting. Not legal advice.

## A. Engineering items

### P0 - fix before anything is promised to customers
| ID | Finding | Evidence | Fix direction |
| --- | --- | --- | --- |
| E1 | `data-retention-sweep` imports a React UI module (`@/components/trust-pack/SealedContent`) inside a Deno edge function; the `@/` alias does not exist there, so the function likely fails to load | `data-retention-sweep/index.ts` L20 | Delete the import |
| E2 | `eraseTrustPackData` is called but **never imported** in both `delete-account` and `data-retention-sweep` (defined in `_shared/trust/vault.ts`) -> ReferenceError at runtime | grep: no import in either file | Add the import |
| E3 | In the sweep, `eraseTrustPackData` runs for **every** deletion request type, including `customer_record` and `dataset`. A single-customer erasure would wipe the tenant's encryption keys and sealed data | sweep L134 runs before the `request_type` branches | Run it only inside the `full_account` branch |
| E4 | DSAR/sweep full-account erasure covers 15 tables (`OWNED_TABLES`). A rough regex scan finds ~1,200 tables with a `user_id` column, ~277 with an obvious cascade FK to auth/profiles. `delete-account` ends with `auth.admin.deleteUser` (cascade helps), but the **sweep/DSAR path never deletes the auth user**, so uncovered tables survive | `ownedTables.ts`, scan of 638 migrations (heuristic) | Generate the owned-table list from the schema (catalog query) + a CI test that every `user_id` table is either listed, cascades, or explicitly exempt |
| E5 | No provider-side erasure: Vapi/Twilio recordings and logs, ElevenLabs cloned voices, Resend logs. `delete-account` itself notes storage files are not removed | `delete-account/index.ts` NOTE | Per-provider erasure adapters with retry queue + proof record |
| E6 | Public sub-processor page omits 13 providers called from code (Twilio, Anthropic, Cohere, ElevenLabs, Lob, Xero, Meta, Slack, Klaviyo, Jobber, Yelp, Gusto, ServiceTitan) | `node scripts/compliance/gen-subprocessors-by-region.mjs --check` exit 1 | Classify core vs customer-optional; update list; follow DPA s.5 notice. Do not wire `--check` into CI until fixed |

### P1
| ID | Finding | Direction |
| --- | --- | --- |
| E7 | Recording consent is US area-code only, keyed to the caller number; no DE/EU/UK/CA/AU logic | Region/profile resolver by business location (voice doc s.1) |
| E8 | `data_regions` / `tenant_residency` CHECK allows only `us|eu|ca`; `eu`/`ca` unavailable and unenforced; UK/AU unrepresentable | Migration + enforcement probe (ADR phase 1) |
| E9 | Provider-hosted recordings (D1) not region-pinned; LLM chain US-only | ADR phase 2 |
| E10 | `/data-request`: only delete is automated; access and correct are queued manually; no portability/restriction/objection kinds; region list is `eu_uk | california | other` (no CA/AU) | Export job (reuse `export-run`), add kinds + regions, test end to end |
| E11 | No Impressum / Datenschutzerklaerung routes (`/privacy`, `/terms`, `/dpa`, `/gdpr-dpa`, `/cookies`, `/subprocessors` exist) | New pages + footer links for DE locale |
| E12 | Cookie consent engine exists with GPC/DNT; region-specific defaults (opt-in strictness) and GA consent-mode behaviour not verified | Audit + Playwright test per region |
| E13 | VAT/tax invoice fields (customer VAT ID, reverse charge, seller details) not audited; Regional Pack work exists (`regionalPacks/*`) | Audit packs vs invoice generator; extend, do not duplicate |
| E14 | Onboarding has no region/language selection tied to residency/consent profile | Extend onboarding; gate non-US regions on `enforced_at` |
| E15 | Sentry/GA/push providers: PII scrubbing and retention settings unverified | Vendor config review |

### Tests and proof (none written yet)
T1 EU-tagged tenant writes never leave allowed regions (router + DB trigger; needs a test double for the data plane). T2 DSAR e2e for access/delete/correct incl. legal-hold and provider erasure. T3 retention sweep unit tests with fake clock (policy delete vs anonymise, hold race). T4 schema coverage test (E4). T5 consent profile resolver per region. T6 Playwright + axe on consent banner and legal pages per locale. T7 subprocessor generator test (`--check` fixture).

## B. Legal-review items (counsel)
L1 Contracting entity, establishment, Art. 27 representative. L2 Final DPA + executed SCC annexes (Modules 2/3), UK Addendum, CA/AU riders. L3 DPF status of each US vendor; TIA sign-off. L4 Recording-consent law per country/state, esp. Germany (StGB s.201), works-council issues for technician data. L5 Lawful basis for recording/transcripts and analytics. L6 AI Act roles (provider/deployer), Art. 50(1)-(4) wording, Art. 5(1)(f) review of coaching features, 2 Dec 2026 marking duty. L7 Voice cloning: consent, biometric status, deepfake labelling. L8 Retention periods (tax/limitation). L9 Impressum (DDG s.5) and Datenschutzerklaerung content, ePrivacy cookie rules per country. L10 CASL / Spam Act / PECR messaging consent. L11 Quebec Law 25 PIA and breach duties. L12 VAT: OSS, reverse charge, invoice mandatory fields, e-invoicing mandates (DE).
