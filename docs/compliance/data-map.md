# Data map (EU / UK / CA / AU readiness)

> **Status: DRAFT for counsel review. Not legal advice.** Prepared from a static read of the `vireek-main` snapshot. Nothing here was executed against a live environment. "Evidence" says which file supports each row; anything marked **TO CONFIRM** must be checked in the live project / vendor dashboards before it is published or promised to a customer.

## 1. Data classes

| # | Data class | Examples | Where stored (control plane = primary Supabase project, US) | Who else touches it | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| D1 | Call audio (recordings) | `calls.recording_url` | URL stored in control plane; audio file hosted by the voice provider. Optional encrypted archive in regional bucket `recordings-<region>` (Trust Pack) | Vapi (US), Twilio (telephony, TO CONFIRM) | `vapi-webhook/index.ts` (~L2157-2310), `_shared/trust/vault.ts`, `regions.ts` | Provider-side copy is **not** region-pinned. TO CONFIRM where Vapi stores audio and whether custom storage is available |
| D2 | Conversation Intelligence audio | `conversation_recordings`, bucket `conversation-recordings` | Supabase Storage (control plane) | Gemini (analysis) | `conversation-intel-purge/index.ts` | Purge worker exists; account-deletion hook **TO CONFIRM** |
| D3 | Call transcripts + summaries | `calls.transcript`, `ai_insights` | Control plane; optionally sealed (ciphertext in regional data plane) | Gemini, Groq, Cerebras, Cloudflare Workers AI, OpenRouter, Anthropic, Cohere (routing chain) | `vapi-webhook`, `_shared/ai-core/providers/*` | Plain text in US unless tenant enabled sealing |
| D4 | Caller identity | phone number, name, address given on call | Control plane (`calls`, `leads`, `customers`) | Vapi, Twilio | `ownedTables.ts` | Personal data of third parties (callers) |
| D5 | Customer / job / quote data | `customers`, `jobs`, `quotes`, photos, notes | Control plane | Per integrations (QuickBooks, Xero, Jobber, ServiceTitan ...) | migrations | Not region-pinned |
| D6 | Payment data | Stripe customer/payment refs, `payment_requests`; pay-by-phone card capture | Stripe (US). Raw card data must never touch Vireek storage | Stripe, Twilio (pay-by-phone) | `docs/pci-pay-by-phone.md` | Retention duty (tax) conflicts with erasure - see retention schedule |
| D7 | Bank data | Plaid-linked accounts, `bank_transactions` | Control plane + Plaid | Plaid | `bank-*` functions | Customer-optional; own DPIA trigger |
| D8 | SMS / email content | `sms-send`, `email-webhook`, Resend | Control plane | Twilio, Resend | `_shared/messaging/sendSms.ts`, `_shared/notify/deliver.ts` | CASL / PECR / Spam Act consent rules apply |
| D9 | Voice-clone samples | `clone-voice` -> ElevenLabs | Provider-hosted voice model | ElevenLabs | `clone-voice/index.ts` | **Biometric-adjacent. Needs explicit consent + DPIA item + subprocessor listing.** ElevenLabs is not on the public list |
| D10 | Technician precise location | trip sharing, photo stamping | Control plane | Mapping / push providers (TO CONFIRM) | `docs/store/privacy-data-map.md` | Employee data - works-council issue in DE (counsel) |
| D11 | Consent + AI-disclosure proof | `consent_records`, `call_ai_disclosures`, `ai_disclosure_versions` | Control plane | - | `_shared/ai-disclosure/ledger.ts` | Evidence records; retention must outlive the calls they prove |
| D12 | Telemetry | Sentry errors (PII stripped client-side), GA (consent-gated) | Sentry, Google | Sentry, Google | `src/lib/consent/engine.ts`, `PrivacyPanel` | GA only after consent. Verify GA loader respects consent mode and IP handling |
| D13 | Audit / security logs | `audit_log`, `api_request_logs` | Control plane | - | migrations | Needs a defined retention period |
| D14 | Push tokens, device IDs | `device_push_tokens` | Control plane | Push providers (TO CONFIRM) | `PrivacyInfo.xcprivacy` | - |

## 2. What is region-pinned today (honest statement)

* The code has a fail-closed router for **recordings and sealed fields** (`REGION_CODES = us | eu | ca`).
* `data_regions` seeds `eu` and `ca` as `is_available = false`, and `enforced_at` is NULL for every region in the migrations read. So **no non-US region is offered or enforced from this snapshot**. TO CONFIRM against the live database.
* UK and AU are **not representable**: `data_regions.code` and `tenant_residency.region` have `CHECK (... IN ('us','eu','ca'))`.
* Everything else (accounts, customers, jobs, billing, transcripts unless sealed) lives in the US control plane, and all live voice/LLM processing happens at US providers.
* Therefore: **do not advertise data residency.** What may truthfully be said today is "hosted in the United States; transfers from EU/UK covered by [mechanism - counsel to confirm]".

## 3. Sub-processors by region

Source of truth: `src/lib/subprocessors.ts` + `src/lib/trustPack/subprocessorResidency.ts`. Regenerate with `node scripts/compliance/gen-subprocessors-by-region.mjs`; CI gate: `--check`.

<!-- BEGIN GENERATED:subprocessors -->
_Generated by scripts/compliance/gen-subprocessors-by-region.mjs — do not edit by hand._

| Processor | Purpose | Listed location | Residency class | EU / UK / CA / AU tenant impact |
| --- | --- | --- | --- | --- |
| Supabase, Inc. | Database, authentication, and backend (edge function) hosting | United States | Regional data plane (recordings + sealed fields only, once a region is verified) | In-region only for data written to the regional plane; control plane stays US |
| Vercel Inc. | Frontend website and dashboard hosting | United States | No customer content by design | None expected (verify) |
| Vapi Inc. | Voice AI and telephony infrastructure for answering and routing calls | United States | US processing in transit — outside the region for non-US tenants | Transfer outside region (needs mechanism + TIA) |
| Google LLC (Gemini API) | AI language model used for call understanding and summarization | United States | US processing in transit — outside the region for non-US tenants | Transfer outside region (needs mechanism + TIA) |
| Groq, Inc. | AI inference (fallback provider in the model routing chain) | United States | US processing in transit — outside the region for non-US tenants | Transfer outside region (needs mechanism + TIA) |
| Cerebras Systems Inc. | AI inference (fallback provider in the model routing chain) | United States | US processing in transit — outside the region for non-US tenants | Transfer outside region (needs mechanism + TIA) |
| Cloudflare, Inc. (Workers AI) | AI inference (fallback provider in the model routing chain) | United States | US processing in transit — outside the region for non-US tenants | Transfer outside region (needs mechanism + TIA) |
| OpenRouter, Inc. | AI inference routing (fallback provider in the model routing chain) | United States | US processing in transit — outside the region for non-US tenants | Transfer outside region (needs mechanism + TIA) |
| Stripe, Inc. | Payment processing and subscription billing | United States | US processing in transit — outside the region for non-US tenants | Transfer outside region (needs mechanism + TIA) |
| Resend | Transactional email delivery (e.g. team invites) | United States | US processing in transit — outside the region for non-US tenants | Transfer outside region (needs mechanism + TIA) |
| Sentry (Functional Software, Inc.) | Application error monitoring | United States | No customer content by design | None expected (verify) |
| Google LLC (Google Analytics) | Website analytics | United States | No customer content by design | None expected (verify) |
| Google LLC (Google Calendar) | Appointment scheduling sync | United States | Only if the customer connects it | Customer-controlled; customer is responsible for their own transfer basis |
| Intuit Inc. (QuickBooks) | Accounting sync | United States | Only if the customer connects it | Customer-controlled; customer is responsible for their own transfer basis |
| Zapier, Inc. | Workflow automation | United States | Only if the customer connects it | Customer-controlled; customer is responsible for their own transfer basis |

### Providers called from code but NOT in the published list
- **Xero** (`api.xero.com`) — 4 file(s), e.g. `supabase/functions/_shared/accounting/xero.ts`
- **Meta Platforms** (`graph.facebook.com`) — 6 file(s), e.g. `supabase/functions/_shared/ads/meta.ts`
- **Anthropic** (`api.anthropic.com`) — 1 file(s), e.g. `supabase/functions/_shared/ai-core/providers/anthropic.ts`
- **Cohere** (`api.cohere.com`) — 2 file(s), e.g. `supabase/functions/_shared/ai-core/providers/cohere.ts`
- **Slack** (`slack.com/api`) — 3 file(s), e.g. `supabase/functions/_shared/chat/providers.ts`
- **Klaviyo** (`a.klaviyo.com`) — 2 file(s), e.g. `supabase/functions/_shared/data-platform/runner.ts`
- **Lob** (`api.lob.com`) — 3 file(s), e.g. `supabase/functions/_shared/direct-mail/verify.ts`
- **Jobber** (`api.getjobber.com`) — 4 file(s), e.g. `supabase/functions/_shared/dispatch/externalJobSync.ts`
- **Yelp** (`api.yelp.com`) — 2 file(s), e.g. `supabase/functions/_shared/listings/providers.ts`
- **Twilio** (`api.twilio.com`) — 4 file(s), e.g. `supabase/functions/_shared/messaging/sendSms.ts`
- **Gusto** (`api.gusto.com`) — 2 file(s), e.g. `supabase/functions/_shared/payroll/gusto.ts`
- **ServiceTitan** (`api.servicetitan.io`) — 2 file(s), e.g. `supabase/functions/_shared/price-book/servicetitan-jobs.ts`
- **ElevenLabs** (`api.elevenlabs.io`) — 1 file(s), e.g. `supabase/functions/clone-voice/index.ts`
<!-- END GENERATED:subprocessors -->

**Reading the gap list above:** providers listed there are called from code but absent from the public page (`/subprocessors`). Some are customer-optional integrations (Xero, Jobber, ServiceTitan, Gusto, Slack, Klaviyo, Yelp, Meta), but **Twilio, Anthropic, Cohere, ElevenLabs and Lob are Vireek-side processors** and must be classified. Adding them triggers the customer-notice process in `DpaContent.tsx` section 5 - a legal/contract step, not just a code edit.

## 4. Open questions that change this map
1. Which legal entity contracts with customers, and where is it established? (Determines GDPR Art. 3, Art. 27 representative, and whether EU customers' data "leaves" at all when the entity itself is in Germany.)
2. Does Vapi offer EU storage / custom bucket / zero-retention for recordings and transcripts? Which Twilio region handles voice media?
3. Which LLM providers can be pinned to an EU/UK region with zero-retention terms?
4. Is the sealed-fields feature on by default for non-US tenants?
