# 06 — Entity / brand / domain dependency audit (holdco restructure readiness)

> **Status: DRAFT, read-only static audit.** Not legal or tax advice. Items marked **requires counsel** need qualified legal/tax review.
> **Evidence basis:** static read of the uploaded `vireek-main.zip` snapshot (may be older than the working tree). Nothing was executed against a live environment; no secret values were read or printed. The code **cannot** show who owns each provider account, which contracts exist, or what DNS/dashboards contain. Those facts are marked **UNVERIFIED** and must be filled from dashboards and contracts (start with `docs/integrations/providers/OWNER_REGISTER.md`, currently an empty table).
> **Companion:** [RESTRUCTURE_RUNBOOK.md](RESTRUCTURE_RUNBOOK.md).

## 0. Key findings (read this first)

1. **No legal entity name is stored anywhere in the repo.** `src/lib/legalEntity.ts` (`LEGAL_ENTITY`) is empty except `email`; Terms/MSA/DPA/Privacy print only "Vireek". Governing law in `TermsContent.tsx` and `MsaContent.tsx` is the placeholder `[State]`. Consequence: the contracting party is defined by the *signed order forms and Stripe/provider account records*, not by code. **UNVERIFIED which entity is the contracting party today.**
2. **The brand/domain is the real coupling, not the entity.** `vireek.com` appears ~900 times; `app.vireek.com`, `in.vireek.com` (inbound email), `command.vireek.ai`, `vireek.ai` (Instagram handle, report ids), `vireek.co` also appear. Bundle IDs `com.vireek.field` / `com.vireek.home` are permanent once published. **Rule: a holdco restructure should keep brand, domains, bundle IDs, RP ID, and API key prefixes unchanged.** Only the legal party behind them moves.
3. **Passkey RP ID = `vireek.com`** (`docs/AUTH_PASSKEYS_SOCIAL_LOGIN_ALERTS.md`): changing it invalidates every enrolled passkey. Domain change is a separate, much riskier project than a holdco insertion.
4. **Provider accounts are the migration critical path.** Stripe (incl. Connect), Twilio (A2P 10DLC brand/campaign registered with `legal_business_name` + `ein`), Vapi, Apple Developer / Google Play, Supabase, Vercel/Cloudflare, Resend, Lob, Firebase/APNs, Google/Microsoft/Meta/Intuit OAuth apps. Several of these **cannot be transferred, only re-created** (see matrix).
5. **Hosting ambiguity:** both `vercel.json` (Vercel, SPA rewrite) and `wrangler.jsonc` + `worker/` (Cloudflare Workers) exist, and `cf-build.sh` is present. **UNVERIFIED which serves production.** Resolve before planning DNS cutover.
6. **Supabase project reference is hard-coded** (not env-driven) in `vercel.json` (agent-card, job feeds, careers sitemap, `/badge-api` rewrites), `api/win-card.ts`, `public/openapi.json`, `public/embed/analytics.html`, `scripts/openapi.mjs`. It also appears in customer-facing URLs (webhook endpoints customers configure, Stripe/Twilio/Vapi/Meta callbacks). A Supabase org transfer keeps the ref; creating a new project changes it everywhere.
7. **Secret hygiene finding:** the uploaded zip contains a populated `.env` (keys present: Supabase URL/anon key, Vapi public key, VAPID public key, GA4, Sentry DSN, status URL). Values were not read. These are mostly public-by-design client keys, but `.env` should not be in an archive that is shared; confirm `.gitignore` is honoured in the real repo and rotate if the zip circulated.
8. Typo-like env names `VIREK_MANAGEMENT_TOKEN` / `VIREK_PROJECT_REF` (admin SSO, 13 refs) are inconsistent with `VIREEK`; leave as-is during restructure (renaming = outage risk) but document.

## 1. Dependency matrix

Legend: **Bound to** E = legal entity, B = brand, D = domain. **Risk** L/M/H = downtime or customer impact. **Counsel** Y/N.
"Account owner" is **UNVERIFIED** for every row unless stated; the code cannot show it.

### 1.1 Payments and billing

| Item (evidence) | Bound to | What changes at holdco migration | Migration method | Risk | Counsel |
|---|---|---|---|---|---|
| Stripe platform account: subscriptions, prices `STRIPE_PRICE_STARTER/PROFESSIONAL/BUSINESS`, webhooks `stripe-webhook`, `stripe-payment-webhook` (`ENVIRONMENT.md` B3) | E (account legal entity, bank, tax id), B (statement descriptor) | If the operating company stays the Stripe account holder: nothing technical. If the contracting/billing party moves: Stripe cannot reassign customers/subscriptions to a different account | Preferred: **keep the account with the operating company**. Otherwise Stripe-supported account details update (legal-entity change via Stripe support) after counsel confirms; avoid new account (would require re-collecting every card) | **H** if new account; L if details updated | **Y** (contracting party, invoices, tax) |
| Stripe Connect (`stripe-connect-onboarding`, `stripe_connect_accounts`) | E (platform), customers' own connected accounts | Connected accounts are tied to the platform account; moving platform = re-onboarding every contractor | Do not move platform account unless unavoidable; if so, plan Stripe-assisted migration | **H** | **Y** |
| Stripe publishable key `STRIPE_PUBLISHABLE_KEY`, signing secrets | E (via account) | Rotate only if account changes | Secret rotation + webhook endpoint re-registration | M | N |
| Invoices/receipts issued by Vireek to customers, tax, sales-tax registrations, TaxJar | E | Seller name/address/tax id on future invoices; historical invoices stay with old entity | Counsel/tax decide timing and invoice-series cut | M | **Y** (tax) |
| Plaid (`PLAID_CLIENT_ID/SECRET`), Wisetack (`WISETACK_*`), Pay-by-bank/financing flows | E (merchant/app registration) | Merchant of record and partner agreements may need novation/re-registration | Provider-led account update | M–H | **Y** |
| Customer-facing "Pay" pages and payment-method update links (`UpdatePaymentMethodPage`) | D, B | None if domain unchanged | — | L | N |

### 1.2 Telephony, voice, messaging

| Item | Bound to | What changes | Method | Risk | Counsel |
|---|---|---|---|---|---|
| Twilio account (`TWILIO_*`), phone numbers, Messaging Service | E (account holder), numbers are customer-facing identity | Numbers cannot be re-created without breaking customers' forwarding/published numbers | Keep Twilio account with current holder, or Twilio-supported account-to-account number transfer (**UNVERIFIED** procedure) | **H** | **Y** if ownership of numbers/contract changes |
| **A2P 10DLC brand + campaign** (`register-a2p-brand`: `legal_business_name`, `ein`, `business_registration_type`; columns `a2p_brand_status`) | **E** (EIN/legal name are the registration) | A new EIN/entity means a **new brand registration and campaign vetting** (days to weeks); old registration is not transferable | Pre-register new brand in parallel; keep old live until approved; switch Messaging Service sender pool | **H** (SMS blocked/filtered during gap) | **Y** |
| Vapi (`VAPI_SERVER_SECRET`, `VAPI_PRIVATE_KEY`, `VITE_VAPID`/`VITE_VAPI_PUBLIC_KEY`, assistants, webhook `vapi-webhook`) | E (account), D (webhook URL = Supabase function URL) | Org/billing owner transfer; assistants and numbers live in the account | Vapi support org transfer; keep webhook URL and server secret unchanged | M–H | Y (DPA/contract) |
| Telnyx, Deepgram, ElevenLabs (`ELEVENLABS_API_KEY`, `SARAH_VOICE_ID`, `clone-voice`) | E (account); voice clone consent is tied to a person/entity | Voice-clone license/consent records may name the contracting party | Account ownership transfer; **confirm voice-rights paperwork** | M | **Y** (voice rights) |
| Call-recording consent notice (`_shared/compliance/recordingConsent.ts`: "this call may be recorded…") and AI disclosure | B (says "Vireek"), E (who is recording) | Wording does not print entity name; business-customer notice may need to identify the recording party | Keep brand wording; counsel review whether recording party identity changes | L | **Y** |
| SMS terms (`SmsTermsPage`), opt-in language stored with A2P campaign | E, B | Sender identification text in campaign description and opt-in records | Update campaign registration text in sync with new brand registration | M | **Y** |
| Meta WhatsApp/Messenger (`META_APP_ID/SECRET`, verify tokens), Sinch (RCS/Apple Messages) | E (Business Manager verification), B | Meta Business verification is tied to the legal entity; re-verification possible | Meta Business Manager ownership transfer or re-verify; keep app ID | M–H | Y |

### 1.3 Email

| Item | Bound to | What changes | Method | Risk | Counsel |
|---|---|---|---|---|---|
| Resend account, verified sending domain, `RESEND_FROM_EMAIL` (`"Vireek <noreply@…>"`) | E (account), **D** (SPF/DKIM/DMARC records) | None if domain and From unchanged. Account holder change = Resend account/billing transfer | Keep domain and DKIM selectors; transfer account ownership or re-add domain as second sender first | L–M | N |
| DNS email authentication (SPF/DKIM/DMARC per `docs/EMAIL_DELIVERABILITY.md`; **records are not in the repo, UNVERIFIED**) | D | DNS registrar/zone ownership may move to holdco | Change registrar account/ownership **without altering records**; never publish two SPF records | **H** if records dropped | N |
| Inbound email (`INBOUND_EMAIL_DOMAIN` = `in.vireek.com`; tenant addresses `<inbound_email_token>@in.vireek.com`; `email-webhook`) | **D**, customers' forwarding rules | Changing the domain breaks every tenant's alias | Do not change; if ever required, run dual-domain acceptance | **H** | N |
| Contact addresses `ali@vireek.com` (88 refs incl. `LEGAL_ENTITY.email`, security.txt), `support@vireek.com`, `staff@`, `jobs@`, `demo@` | D | Mailboxes must continue to exist; legal notices must reach the right entity | Keep mailboxes; update notice addresses only with counsel | L | **Y** (legal notice address) |

### 1.4 Print/postcard, ads, data providers

| Item | Bound to | What changes | Method | Risk | Counsel |
|---|---|---|---|---|---|
| Lob (`direct-mail-send`, `verify.ts`; return address/sender identity on postcards) | E (account, return address, compliance "identify your business + mailing address") | Sender legal name/address on printed mail; billing | Update sender profile; send test proofs (feature is **not live-verified** per `docs/DIRECT_MAIL.md`) | L | Y (sender ID rules) |
| QR codes on already-printed mailers (`{SITE_URL}/m/{CODE}`) | **D** | Printed mailers keep working only while the domain and `/m/` route work | Keep domain; never remove `/m/*` | **H** if domain lost | N |
| Google Ads / Meta Ads OAuth (`GOOGLE_ADS_*`, `META_APP_*`, `ads-oauth-*`), Google Business Profile, Maps/Places keys | E (Google Cloud project, developer token, billing account), B | Developer token and API access are granted per applicant entity; billing account may move | Google Cloud project org move (project ID kept) ; developer token re-application is **not instant** | M–H | Y |
| ATTOM, RentCast, Census, EIA, Socrata keys | E (contract holder) | Licence assignment | Vendor assignment/novation | L–M | **Y** (licences) |
| AI providers (Gemini, Groq, Cerebras, Cloudflare AI, OpenRouter, Anthropic, Cohere) | E (billing/DPA) | Account owner and DPA counterparty | Billing/owner transfer; keys unchanged | L | Y (DPAs) |

### 1.5 Auth, OAuth, mobile

| Item | Bound to | What changes | Method | Risk | Counsel |
|---|---|---|---|---|---|
| Supabase Auth: Site URL, redirect allow-list, passkey **RP ID `vireek.com`**, RP name "Vireek", Google/Apple sign-in providers | **D**, B | None if domain fixed | **Do not change RP ID**; re-verify redirects after any host change | **H** if RP ID changes (all passkeys lost) | N |
| Google OAuth consent screen / app verification (Calendar `GOOGLE_CALENDAR_*`, Ads, Business Profile), Microsoft Entra app + publisher domain (`docs/MICROSOFT_CALENDAR_SETUP.md`), HubSpot, Jobber, Intuit/QuickBooks, Xero, Meta | E (publisher/legal name, privacy/terms URLs), D (authorised domains) | Developer/publisher entity names and support contacts; verification may need redo if app ownership moves | Transfer project ownership (keep client IDs, redirect URIs); update consent branding; check each provider's re-verification rule | M–H (users forced to re-consent if client ID changes) | Y (publisher legal name) |
| Apple Developer Program (bundle `com.vireek.field`, `com.vireek.home`, AASA `REPLACE_WITH_TEAMID…` is a placeholder), Google Play (package `com.vireek.field`) | **E** (developer account = legal entity; seller name shown in stores) | Apps can be **transferred** between accounts (Apple App Transfer / Play transfer) but Team ID changes → universal links, push keys, Sign in with Apple identifiers, associated domains must be redone | App Transfer per store rules; update `apple-app-site-association` and `assetlinks.json`; re-issue APNs key and Firebase config; ship app update | **H** (push + universal links break until redone) | **Y** (D-U-N-S, seller name, agreements) |
| Firebase/FCM + APNs `.p8` (`docs/SETUP_MOBILE_SURFACES.md`), `google-services.json` (not in repo) | E (Google account), Team ID | New Team ID needs new APNs key; Firebase project can stay | Re-upload new `.p8`; keep Firebase project | M | N |
| Web Push VAPID pair (`VAPID_*`, `VAPID_SUBJECT` = `mailto:`) | D (origin), contact | Subject contact only; **keep keypair** (changing invalidates subscriptions) | None / update subject | L | N |
| `security.txt`, `/vulnerability-disclosure` | D, E | Contact address/policy owner | Update text | L | N |

### 1.6 Hosting, database, storage, observability

| Item | Bound to | What changes | Method | Risk | Counsel |
|---|---|---|---|---|---|
| Supabase org/project (DB, Auth, Storage buckets incl. `conversation-recordings`, `emergency-triage-media`, regional `recordings-<region>`, edge functions); project ref hard-coded in 5 files | E (org/billing), D (`*.supabase.co` in customer-configured webhooks) | Org billing owner; **project ref must not change** | Supabase org ownership/billing transfer (no data move). Avoid dump/restore into new project | L if transfer; **H** if new project | Y (DPA/contract) |
| Vercel and/or Cloudflare (`vercel.json`, `wrangler.jsonc`, `cf-build.sh`) | E (team/account), **D** (DNS, custom domains) | Team/account ownership; DNS zone and certificates | Transfer project/team; keep domain bindings; lower TTLs before change | M | N |
| Domain registrations (`vireek.com`, `.co`, `.ai`; registrant UNVERIFIED) | **E** (registrant), D | Registrant change; WHOIS; renewals | Registrar-supported registrant change with lock/transfer rules respected | M (accidental expiry/lock) | **Y** (IP ownership of domains/marks) |
| Customer custom domains (`verify-custom-domain`, `landing-domain-verify`, `VITE_APP_HOSTS`, `VITE_LANDING_CNAME_TARGET`) | D (CNAME target) | None if CNAME target unchanged; target change breaks every customer landing page | Keep CNAME target | **H** if changed | N |
| Sentry/GlitchTip DSN (`VITE_SENTRY_DSN`), GA4 (`VITE_GA4_MEASUREMENT_ID`), status page (`VITE_STATUS_API_URL`, `status.vireek.com`) | E (account), B | Account owner/DPAs; GA property ownership | Add holdco users as owners; no ID change | L | Y (DPA) |
| SIEM streaming (`siem-stream`, Splunk/Datadog, `User-Agent: Vireek-SIEM/1.0`, `SIEM_ENCRYPTION_KEY`) | B (UA string), customer destinations | Customers' allow-lists may key on UA | Keep UA string | L | N |
| GitHub org/repo, Actions secrets (`SUPABASE_ACCESS_TOKEN`, `VERCEL_AUTOMATION_BYPASS_SECRET`, test JWT `AI_REGRESSION_TEST_USER_JWT`), CODEOWNERS | E | Repo ownership; secrets keep working if org transfer | GitHub org transfer; verify Actions secrets; rotate real-user JWT | M | N |
| Encryption keys `BANK_TOKEN_KEY`, `TELEMATICS_ENCRYPTION_KEY`, `ADS_TOKEN_ENCRYPTION_KEY`, `SIEM_ENCRYPTION_KEY` | — (not entity-bound) | **Must not change**; rotating makes stored tokens undecryptable | Freeze keys during migration | **H** if touched | N |

### 1.7 Legal documents and where the entity is printed or stored

| Item (evidence) | Bound to | What changes | Method | Risk | Counsel |
|---|---|---|---|---|---|
| Terms of Service (`TermsContent.tsx`; governing law `[State]` placeholder), Master Services Agreement (`MsaContent.tsx`), SMS terms, Cookie policy (`CookiePolicyContent.tsx`), DMCA (`DmcaContent.tsx`), Trademark policy | E, B | Defined party "Vireek" must be tied to the correct legal entity; assignment/affiliate language; effective-date/version bump | Counsel drafts; publish versioned update; keep old versions archived | M | **Y** |
| DPA (`DpaContent.tsx`) and GDPR DPA (`GdprDpaContent.tsx`): "Vireek is the data processor"; SCCs "incorporated by reference, annexes on request" (`docs/compliance/transfers-and-contracts.md`: no executed annexes, **which Vireek entity signs is an open question**) | **E** | Processor identity, sub-processor flow-down, SCC party, EU representative | Counsel: novation/assignment or new DPA with affiliate; notify customers per DPA notice clause | **H** (compliance) | **Y** |
| Privacy policy (`PrivacyPage`), Location privacy, Subprocessors list (`src/lib/subprocessors.ts`: Supabase, Vercel, Vapi, Google, Groq, Cerebras, Cloudflare, OpenRouter, Stripe, Resend, Sentry, GA, Google Calendar, Intuit, Zapier) | E (controller identity), B | Controller name/address; subprocessor additions (holdco as intra-group processor?) | Counsel; DPA requires advance notice of subprocessor change | M | **Y** |
| Impressum data (`src/lib/legalEntity.ts` `LEGAL_ENTITY`: empty) | **E** | Must be filled with the registered entity (DE/AT/CH rules) | Counsel-supplied values; the code path already shows an "incomplete" state | L | **Y** |
| Governing-law and venue placeholders `[State]` in Terms §13 / MSA §14 | E | Must be completed regardless of restructure | Counsel | L | **Y** |
| Consent and AI-disclosure records (`docs/compliance/voice-consent-and-ai-disclosure.md`, `recordingConsent.ts`, `aiDisclosureLedger.ts` report id `vireek.ai_disclosure_audit`) | B, E | Historical records keep original entity; report id string is an identifier (do not rename) | Retain; document the cut-over date | L | Y |
| Acceptance records (tables with `terms_accepted` / version columns, e.g. warranty, payment plans, talent network) | E (counterparty at acceptance time) | Past acceptances bind the old entity; new terms need re-acceptance or assignment notice | Counsel decides assignment vs re-accept; add version + entity snapshot going forward | M | **Y** |
| Customer data fields `legal_business_name`, `ein`, `company_name`, `business_name` (tenant data, not Vireek's) | tenant | None | — | — | N |
| Public claims register (`docs/claims-register.json`, `/trust`, SOC2 readiness) | E (certified entity), B | Certifications/audits belong to the audited entity; claims like "SOC 2" must stay true after restructure | Trust owner + auditor review | M | **Y** |
| Contracts not in repo: customer order forms/MSAs, vendor MSAs, insurance, office lease, employment/contractor agreements, IP assignments, voice-talent rights | E | Assignment/novation, consent clauses, change-of-control | **Out of code scope; UNVERIFIED** | M–H | **Y** |

### 1.8 Data-processing roles (as implied by the code and docs)

| Data | Role today | Evidence | Restructure effect | Counsel |
|---|---|---|---|---|
| Callers'/customers' data held for a home-service business | Customer = controller, Vireek = **processor** | `DpaContent`, `GdprDpaContent`, `transfers-and-contracts.md` §1 | The processor entity (or an intra-group processor) must be identified; sub-processor chain gains the holdco if it touches data | **Y** |
| Vireek's own account, billing, marketing, analytics data | Vireek = **controller** | same | Controller identity in Privacy Policy and cookie notice | **Y** |
| Call audio/transcripts at sub-processors (Vapi, Gemini, Groq, Cerebras, Cloudflare AI, OpenRouter) | Sub-processors of Vireek | `data-map.md` D1–D4, `subprocessors.ts` | Vendor DPAs must name the correct contracting entity | **Y** |
| Employees/technicians data, EU/UK/CA/AU flows | Mixed | `transfers-and-contracts.md` | TIAs and SCC party identity | **Y** |

### 1.9 Webhooks, API keys, customer-side integrations that embed the brand or domain

| Item (evidence) | Bound to | Impact if brand/domain/entity moves | Method | Risk | Counsel |
|---|---|---|---|---|---|
| API key prefixes `vrk_live_`, `vrk_test_`, `vrk_agent_`, `vrk_tg_`, `sk_vireek…` (BI export, MCP, conversations/messages APIs) | B | Customers' stored keys and scanners key on the prefix | **Never rename prefixes** | **H** if renamed | N |
| Outbound headers/identifiers: `X-Vireek-Mode`, `User-Agent` strings (`Vireek-SIEM/1.0`, `Vireek-Agent-Runtime/1.0`, `Vireek-DataPlatform/1.0`, Emergency Network UA incl. `support@vireek.com`) | B, D | Customer firewalls/allow-lists/log rules | Keep as-is | L–M | N |
| Webhook endpoints customers/partners configured: `https://<project-ref>.supabase.co/functions/v1/…` (Stripe, Twilio, Vapi, Meta, Sinch, Plaid, Wisetack, Zapier, job feeds) and `https://vireek.com/badge-api`, `/feeds/*.xml`, `/.well-known/agent-card.json` | D, Supabase ref | Any host change breaks inbound callbacks and published feeds (Indeed/ZipRecruiter/LinkedIn feed URLs) | Keep hosts; if unavoidable, dual-serve with redirects/proxy first | **H** | N |
| Partner/marketplace listings and approvals (`docs/partner-status.md`, `partner-requirements-matrix.md`: Google Actions Center, Business Profile access, directory listings) | E, B, D | Approvals were granted to a named applicant | Applicant-of-record change with each partner; expect delays | M–H | Y |
| Embedded customer assets: "Powered by Vireek" trust badge/widgets (`trustBadge/core.ts`, `/badge-api`), `public/embed/analytics.html`, QR codes, `/lp/*` landing pages, embedded booking links, Chrome extension (`chrome-extension/`) | B, D | Third-party sites hard-code the host | Keep host | **H** if changed | N |
| Public OpenAPI (`public/openapi.json`) server URL, MCP server/A2A card | D, Supabase ref | Integrators pin URLs | Keep; version any change | M | N |
| Email links `SITE_URL` fallback `https://vireek.com` (28 functions), password-reset (`VITE_SITE_URL`) | D | Old emails in inboxes still link to the domain | Keep domain | M | N |

## 2. Prioritized risk list

| # | Risk | Why | Mitigation (see runbook phase) |
|---|---|---|---|
| 1 | **Contracting party / DPA party unclear** (no entity in code; SCC annexes not executed; governing law `[State]`) | Cannot plan novation without knowing today's signatory | Phase 0 fact-finding; counsel |
| 2 | **Stripe account/Connect move** | Moving platform account forces re-collection of cards and re-onboarding of connected accounts | Keep Stripe at operating company unless counsel/tax require otherwise |
| 3 | **A2P 10DLC brand tied to legal name + EIN** | New entity = new registration; SMS filtering during gap | Pre-register early; parallel run |
| 4 | **Apple/Google developer account transfer** (Team ID, APNs, universal links) | Push and deep links break; store seller name changes | Start transfer lead time first; update AASA/assetlinks; ship update |
| 5 | **Domain/RP ID/inbound email/custom-domain CNAME** | Passkeys, tenant aliases, landing pages, printed QR codes depend on them | Freeze all domain-level identifiers |
| 6 | **Supabase project ref hard-coded + customer webhooks** | New project changes every callback URL | Transfer org, never recreate project |
| 7 | **Encryption keys / secrets rotation during migration** | Rotating `BANK_TOKEN_KEY` etc. makes stored tokens unreadable | Change freeze on keys |
| 8 | **Provider ownership unknown** (`OWNER_REGISTER.md` empty) | Single-person (`ali@vireek.com`) dependency in many places; lost access = outage | Fill register; add second owner everywhere before restructure |
| 9 | **DNS email auth records live outside repo** | Mail goes to spam if SPF/DKIM/DMARC dropped in zone move | Export zone before any change |
| 10 | **Public claims/certifications tied to audited entity** | Misstated trust claims | Trust owner + auditor |
| 11 | **Hosting target ambiguity (Vercel vs Cloudflare)** | Wrong cutover plan | Confirm in Phase 0 |
| 12 | **`.env` inside the shared zip** | Secret handling | Confirm real repo ignores it; rotate if shared |

## 3. Gaps this audit could not close (all UNVERIFIED)

- Account owners, plan tiers, contract status, DPAs for every provider (`OWNER_REGISTER.md` is blank).
- DNS zone contents, registrar, who holds domains, certificate setup.
- Which hosting target is production; Apple Team ID and Play signing state (`REPLACE_WITH_TEAMID` placeholders in `public/.well-known`).
- Whether Twilio numbers and A2P brand are under the operating company's EIN.
- Customer-signed contracts and their assignment clauses.
- Live database content (e.g. any stored legal-entity snapshots per customer agreement). Only migrations/code were inspected.
- Anything changed in your newer local working tree.

## 4. Method and limits

Static grep/read of: `ENVIRONMENT.md`, `.env.example` (names only), `vercel.json`, `wrangler.jsonc`, `capacitor.config.ts`, `public/.well-known/*`, `src/lib/legalEntity.ts`, `src/lib/subprocessors.ts`, `src/components/sections/{Terms,Msa,Dpa,GdprDpa}Content.tsx`, `supabase/functions` (A2P, Stripe Connect, direct mail, SIEM, recording consent), `docs/compliance/*`, `docs/integrations/*`, `docs/AUTH_PASSKEYS_SOCIAL_LOGIN_ALERTS.md`, `docs/EMAIL_DELIVERABILITY.md`. No source code was changed. No commands were run against live systems. Not exhaustive for all 462 edge functions: re-run the greps in the runbook's Phase 0 against the current tree.
