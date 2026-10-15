# Vireek — Environment & Secrets

Every configuration value the code reads, where it is read, and how to create it. Derived from a scan of
`src/`, `supabase/functions/`, `scripts/`, `e2e/`, the Vite/Playwright configs and `.github/workflows/`.

> **Regenerate the "where used" data** with `npm run docs:inventory` → [`docs/generated/ENV_USAGE.md`](docs/generated/ENV_USAGE.md).
> Run `npm run docs:inventory -- --check` to see whether it is stale. Names read dynamically (e.g. `STRIPE_PRICE_<PLAN>`) are listed here by hand.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) · [RUNBOOK.md](RUNBOOK.md) · [CONTRIBUTING.md](CONTRIBUTING.md)

## 0. Where configuration lives

| Layer | What goes there | How to set | Visible to |
|---|---|---|---|
| **A. Frontend build env** (`VITE_*`) | Public values compiled into the bundle | `.env` locally (git-ignored) · Vercel project → Environment Variables · GitHub Actions secrets for CI builds | **Everyone** (shipped in JS) — never put a secret here |
| **B. Edge Function secrets** | API keys, webhook secrets, encryption keys | `supabase secrets set NAME=value` or Dashboard → Edge Functions → Secrets | Edge functions only |
| **C. Platform-provided** | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Injected by Supabase into every function | Edge functions only |
| **D. Postgres settings** | `app.settings.*` used by `pg_net` triggers | `ALTER DATABASE postgres SET …` | DB only |
| **E. GitHub Actions** | CI secrets / variables | Repo → Settings → Secrets and variables | Workflows |

Rules (also enforced by `.github/copilot-instructions.md` §6 and gitleaks in CI):
never commit `.env`; never put a secret in a `VITE_*` var; never hard-code keys in source or migrations.

---

## A. Frontend (`VITE_*`, build-time)

Create `.env` from `.env.example`. After changing a value on Vercel you must **redeploy** (values are baked in at build).

| Variable | Required | Read in | Purpose / default | How to obtain |
|---|---|---|---|---|
| `VITE_SUPABASE_URL` | **Yes** | `src/lib/supabase.ts`, `aiStream.ts`, `agentNetwork.ts`, `fleetIntelligence.ts`, … (13 sites) | Supabase project URL. If missing the app logs an error and talks to `https://missing-env.invalid` | Supabase Dashboard → Project Settings → API → Project URL |
| `VITE_SUPABASE_ANON_KEY` | **Yes** | `lib/supabase.ts`, `aiStream.ts`, `accountData.ts` | Public anon key (RLS protects data) | Same page → `anon` `public` key |
| `VITE_VAPI_PUBLIC_KEY` | For web voice demo | `src/lib/vapi.ts` | Vapi public key for the in-browser "Talk to Sarah" call | Vapi Dashboard → API keys → **public** key |
| `VITE_VAPI_DEMO_ASSISTANT_ID` | No | `src/lib/vapi.ts` | Overrides the built-in demo assistant id (not in `.env.example`) | Vapi Dashboard → Assistants |
| `VITE_VAPID_PUBLIC_KEY` | For Web Push | `src/lib/push.ts` | Public VAPID key; **must pair with** the `VAPID_PRIVATE_KEY` secret | `npx web-push generate-vapid-keys` (public half) |
| `VITE_GA4_MEASUREMENT_ID` | No | `src/lib/analytics.ts` | GA4 id (`G-XXXXXXXXXX`); analytics off if unset | Google Analytics → Admin → Data streams |
| `VITE_SENTRY_DSN` | No | `src/lib/sentry.ts` | Sentry/GlitchTip DSN; Sentry is skipped silently if unset | Sentry/GlitchTip project → Client Keys |
| `VITE_STATUS_API_URL` | No | `src/hooks/useLiveStatus.ts` | Status provider `summary.json` (example in `.env.example` uses Instatus) | Status-page provider |
| `VITE_MAINTENANCE_MODE` | No (`false`) | `src/lib/connectivity.ts` | `true` → full-app maintenance screen (only `/status`, `/privacy`, `/terms`, `/security` stay reachable) | Set to `true` on Vercel + redeploy |
| `VITE_MAINTENANCE_TITLE` | No | `connectivity.ts` | Maintenance screen title | free text |
| `VITE_MAINTENANCE_MESSAGE` | No | `connectivity.ts` | Maintenance screen body | free text |
| `VITE_MAINTENANCE_ETA` | No | `connectivity.ts` | ISO timestamp shown as ETA | e.g. `2026-09-16T18:30:00Z` |
| `VITE_MAINTENANCE_STATUS_URL` | No | `connectivity.ts` | Remote JSON that can flip maintenance/degraded **without a redeploy** | Host a small JSON file on a CDN |
| `VITE_SITE_URL` | No (`https://vireek.com`) | `src/pages/ForgotPasswordPage.tsx` | Base URL for password-reset redirects; set on staging/preview so links point back to that host | Your deployment URL |

Built-ins used: `import.meta.env.MODE` (Sentry environment, traces sampled 0.2 only in `production`) and `DEV`.

---

## B. Edge Function secrets (`supabase secrets set …`)

Set with: `supabase secrets set NAME=value --project-ref <ref>` (or the dashboard). `openssl rand -hex 32` generates a
suitable random secret; `openssl rand -base64 32` generates a 32-byte AES key (the source comments use exactly these).
"Used by" lists the main readers; `_shared/…` means shared code used by several functions.

### B1. Site / URLs

| Secret | Used by | Notes |
|---|---|---|
| `SITE_URL` | 28 functions (checkout, billing portal, OAuth callbacks, emails, orchestrators …) | Public site base URL for redirects/links. Falls back to `https://vireek.com` in most functions (`emergency-network-orchestrator` falls back to `https://app.vireek.com`) — set it explicitly for every environment |
| `DEFAULT_TIMEZONE` | `emergency-network-orchestrator` | Fallback IANA timezone when the schedule has none |

### B2. AI providers (`_shared/ai-core/providers/*`)

Chain order and task routing: `_shared/ai-core/registry.ts`. A provider without a key is not usable (adapter throws `NOT_CONFIGURED`).

| Secret(s) | Provider | Used by | Obtain |
|---|---|---|---|
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Google Gemini (first in chain; default model `gemini-2.5-flash`) | `_shared/ai-core` + 15 functions that call Gemini directly (vision/multimodal: `visual-estimate`, `field-estimate`, `live-copilot`, `property-vision-analyze`, `diagnosis-copilot`, `remote-resolution`, …) | Google AI Studio → API key |
| `GROQ_API_KEY`, `GROQ_MODEL` | Groq (2nd) | `providers/groq.ts` | console.groq.com |
| `CEREBRAS_API_KEY`, `CEREBRAS_MODEL` | Cerebras (3rd) | `providers/cerebras.ts` | cloud.cerebras.ai |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_MODEL` | Cloudflare Workers AI (4th; skipped for JSON-mode tasks) | `providers/cloudflare.ts` | Cloudflare dashboard → Workers AI |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | OpenRouter (5th) | `providers/openrouter.ts` | openrouter.ai |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Anthropic adapter (registered, not in the default chain) | `providers/anthropic.ts` | console.anthropic.com |
| `COHERE_API_KEY`, `COHERE_MODEL`, `COHERE_EMBED_MODEL` | Cohere (embeddings / RAG; also read by `scripts/ingest-brand-knowledge.mjs`, default embed model `embed-english-v3.0`) | `providers/cohere.ts`, `_shared/knowledge/search.ts` | dashboard.cohere.com |
| `PROPERTY_VISION_MODEL` | Model override for `property-vision-analyze` (falls back to `GEMINI_MODEL`, then `gemini-2.5-flash`) | — | model id |
| `AI_PRICE_OVERRIDES_JSON` | JSON merged over the built-in price table in `_shared/ai-core/costTracking.ts` (cost accounting without a redeploy) | — | JSON shaped like `PRICE_TABLE` |

### B3. Stripe

| Secret | Used by | Obtain |
|---|---|---|
| `STRIPE_SECRET_KEY` | `create-checkout-session`, `create-billing-portal-session`, `create-payment-request`, `stripe-connect-onboarding`, `stripe-webhook`, `membership-lifecycle-agent`, `mcp-server` | Stripe → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook` (signature check) | Stripe → Developers → Webhooks → endpoint `…/functions/v1/stripe-webhook` → signing secret |
| `STRIPE_PAYMENT_WEBHOOK_SECRET` | `stripe-payment-webhook` | Same, for the `…/stripe-payment-webhook` endpoint |
| `STRIPE_PUBLISHABLE_KEY` | `public-payment` | Stripe → Developers → API keys → **Publishable key** (`pk_…`). Public by design; must be the same mode (test/live) as `STRIPE_SECRET_KEY` |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PROFESSIONAL`, `STRIPE_PRICE_BUSINESS` | `create-checkout-session` (read dynamically via `PRICE_ENV_BY_PLAN`). Missing → HTTP 500 "Billing is not configured yet" | Stripe → Products → price id (`price_…`) |

### B4. Messaging

| Secret | Used by | Notes / obtain |
|---|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | `_shared/messaging/sendSms.ts`, `_shared/notify/deliver.ts`, `register-a2p-brand` | Twilio Console |
| `TWILIO_MESSAGING_SERVICE_SID` | `sendSms.ts` (compliant SMS path) | Twilio → Messaging → Services |
| `TWILIO_FROM_NUMBER` | `notify/deliver.ts` (plain SMS path) | A Twilio number in E.164 |
| `RESEND_API_KEY` | `notify/deliver.ts`, `email-send`, `send-team-invite`, `notify-status-subscribers`, `stripe-webhook` | resend.com → API keys |
| `RESEND_FROM_EMAIL` | same | e.g. `"Vireek <noreply@yourdomain.com>"` (verified domain) |
| `INBOUND_EMAIL_DOMAIN` | `email-send`, `email-webhook` | Domain whose inbound mail is routed to `email-webhook`; tenants get `<profiles.inbound_email_token>@<domain>` |
| `STATUS_NOTIFY_WEBHOOK_SECRET` | `notify-status-subscribers` | Optional but recommended: callers must send `X-Webhook-Secret`. `openssl rand -hex 32` |
| `ESCALATION_WEBHOOK_SECRET` | `escalate-emergency` | Optional: if set, callers must send `X-Webhook-Secret` |
| `WHATSAPP_VERIFY_TOKEN` | `whatsapp-webhook` | Any string; enter the same value as "Verify Token" in the Meta webhook setup |
| `DNC_SCRUB_API_URL`, `DNC_SCRUB_API_KEY` | `_shared/compliance/dncCheck.ts` | Optional second layer: external National DNC registry scrub |

### B5. Voice

| Secret | Used by | Notes |
|---|---|---|
| `VAPI_SERVER_SECRET` | `vapi-webhook` | Verified against header `x-vapi-secret`; set the same value as the assistant's "Server URL Secret" in Vapi (the function header asks you to **re-verify the header name against current Vapi docs**) |
| `VAPI_PRIVATE_KEY` | `outbound-dialer`, `followup-agent-dispatcher`, `workflow-engine-executor` | Vapi **private** key (server-side calls). Missing → `"VAPI_PRIVATE_KEY is not configured."` |
| `ELEVENLABS_API_KEY` | `clone-voice` | ElevenLabs profile → API keys |

### B6. Web Push

| Secret | Used by | Notes |
|---|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `send-push-notification` | `npx web-push generate-vapid-keys`; the public key must also be `VITE_VAPID_PUBLIC_KEY` |
| `VAPID_SUBJECT` | same | `mailto:you@yourdomain.com` |
| `PUSH_DISPATCH_SECRET` | `send-push-notification`, `dispatch-webhook`, `event-bus-dispatch` | **Must equal** the Postgres setting `app.settings.push_dispatch_secret` (§D). `openssl rand -hex 32` |

### B7. Scheduler secrets (sent as `X-Cron-Secret`)

Generate each with `openssl rand -hex 32`. The scheduler (Dashboard Cron / GitHub Action / any HTTP caller) must send the
matching value. Functions also accept a user JWT for "Run now" from the dashboard (those that say so in their header).

| Secret | Functions |
|---|---|
| `CRON_SECRET` | `agent-runtime`, `commitment-monitor-tick`, `detect-service-recovery-signals`, `emergency-network-orchestrator`, `escalation-tick`, `estimate-recovery-agent`, `failure-genome-refresh`, `followup-agent-dispatcher`, `followup-agent-enroller`, `home-health-agent`, `kce-extract`, `membership-lifecycle-agent`, `mine-organizational-memory`, `outbound-dialer`, `outbound-queue-builder`, `predictive-failure`, `property-intelligence-agent`, `self-healing-orchestrator`, `service-guarantee-tick`, `service-recovery-agent`, `switching-shield`, `workflow-engine-executor`, `workflow-graph-executor` |
| `ADS_CRON_SECRET` | ads functions (`_shared/ads/common.ts`) |
| `BENCHMARK_CRON_SECRET` | `compute-benchmarks`, `compute-regional-demand` |
| `CAUSAL_TRACKER_CRON_SECRET` | `causal-outcome-tracker` |
| `FLEET_ECONOMICS_CRON_SECRET` | `compute-fleet-economics` |
| `FLEET_INTELLIGENCE_CRON_SECRET` | `compute-fleet-intelligence` |
| `INSURANCE_CLAIM_CRON_SECRET` | `automation-insurance-claim-status-update` |
| `NO_SHOW_CRON_SECRET` | `automation-no-show-reschedule` |
| `PAYMENT_REMINDER_CRON_SECRET` | `send-payment-reminders` |
| `TELEMATICS_CRON_SECRET` | `compute-telematics-chain`, `telematics-sync` |
| `TELEMETRY_CRON_SECRET` | `telemetry-analyze` |
| `VERTICAL_AI_CRON_SECRET` | `vertical-ai-pipeline` |
| `VIP_TAG_CRON_SECRET` | `automation-vip-customer-tag` |
| `WEATHER_SURGE_CRON_SECRET` | `weather-surge-check` |

### B8. OAuth integrations

Each OAuth start/callback pair signs a `state` value with a `*_STATE_SECRET` (`openssl rand -hex 32`).
Callback functions are deployed with `--no-verify-jwt`. Redirect URI = the callback function URL.

| Secrets | Functions | Obtain |
|---|---|---|
| `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_STATE_SECRET` | `google-calendar-oauth-start/-callback` | Google Cloud Console → OAuth client |
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_STATE_SECRET` | `hubspot-oauth-start/-callback` | HubSpot developer app |
| `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`, `JOBBER_STATE_SECRET` | `jobber-oauth-start/-callback`, `_shared/price-book/jobber.ts` | Jobber developer app |
| `ADS_STATE_SECRET`, `ADS_TOKEN_ENCRYPTION_KEY` (32-byte base64), `ADS_CRON_SECRET` | `ads-oauth-start/-callback`, `_shared/ads/common.ts` | generate locally |
| `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_API_VERSION` (default `v24`) | `_shared/ads/google.ts` | Google Ads API access |
| `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION` (default `v23.0`) | `_shared/ads/meta.ts` | Meta for Developers |
| `GOOGLE_MAPS_API_KEY` | `optimize-route` | Google Cloud → Maps |
| `VIREK_MANAGEMENT_TOKEN`, `VIREK_PROJECT_REF` | `admin-sso` | Supabase **Management API** personal access token (`supabase.com/dashboard/account/tokens`) and the project ref |

### B9. Banking, financing, telematics, encryption keys

| Secret | Used by | Notes |
|---|---|---|
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (`sandbox` \| `production`) | `_shared/bank/plaid.ts` (via `bank-*`) | Plaid dashboard |
| `PLAID_WEBHOOK_URL` | `bank-intelligence` | `https://<project-ref>.supabase.co/functions/v1/bank-webhook` |
| `BANK_TOKEN_KEY` | `_shared/bank/crypto.ts` | **32 bytes, base64**: `openssl rand -base64 32`. Encrypts stored Plaid tokens — losing/rotating it makes stored connections undecryptable |
| `TELEMATICS_ENCRYPTION_KEY` | `_shared/telematics/security.ts` | Same format (`openssl rand -base64 32`) |
| `WISETACK_API_KEY`, `WISETACK_WEBHOOK_SECRET` | `_shared/financing/providers/wisetack.ts` | Wisetack merchant portal |

### B10. Property / external data

| Secret | Used by | Notes |
|---|---|---|
| `ATTOM_API_KEY`, `RENTCAST_API_KEY` | `_shared/property-intelligence/service.ts` | Property data providers |
| `CENSUS_API_KEY` | `property-intelligence-enrich` | api.census.gov |
| `EIA_API_KEY` | `external-world-sync`, property intelligence | Enables the electricity-price signal; skipped when absent |
| `NRI_COUNTIES_URL` | `external-world-sync` | Overrides the FEMA NRI county FeatureServer query URL |
| `SOCRATA_APP_TOKEN` | `verification-network` | Socrata open-data app token |

### B11. Platform-provided (do not set)

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase (README lists the service-role key
among secrets; on the hosted platform the `SUPABASE_*` names are reserved — **verify** with your CLI version).
`SUPABASE_DB_URL` is read only by `dr-restore-drill` to enable its optional *live restore* check. Its header says to point it at a
role limited to a dedicated schema; since the name is platform-reserved, **verify** whether you can override it before relying on that.

---

## D. Postgres settings (`app.settings.*`)

Used by `pg_net` triggers/jobs to call edge functions; set once per project (SQL editor). Never commit real values.

```sql
ALTER DATABASE postgres SET app.settings.edge_function_base_url = 'https://<project-ref>.supabase.co/functions/v1';
ALTER DATABASE postgres SET app.settings.push_dispatch_secret   = '<same value as the PUSH_DISPATCH_SECRET secret>';
```

Some migrations also read `app.settings.functions_url` and `app.settings.service_role_key` (see the comment block near the
end of the migration that references them: `grep -rn "app.settings.service_role_key" supabase/migrations`). Until the settings
exist, `dispatch_push_notification()` simply no-ops.

---

## E. GitHub Actions

| Name | Kind | Used by | Purpose |
|---|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | secret | `ci.yml`, `quality-gates.yml` | Build/E2E |
| `SUPABASE_URL`, `AI_REGRESSION_TEST_USER_JWT`, `AI_REGRESSION_DEFAULT_SUITE_ID` | secret | `ai-regression.yml` | Nightly `ai-eval-run` call (the suite id can also be passed on manual dispatch). The JWT is a real user's access token — it expires, so refresh it |
| `E2E_TEST_EMAIL`, `E2E_TEST_PASSWORD` | secret | `e2e/auth-and-dispatch.spec.ts`, `quote-to-invoice.spec.ts` | Staging test account. **`ci.yml` does not pass these today**, so authenticated E2E specs are skipped in CI — add them to the E2E job's `env` to enable them |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | secret | `vercel-preview-smoke.yml` | Lets the smoke test pass Vercel Deployment Protection |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` | secret | `edge-functions.yml` (deploy job) | Supabase CLI auth for function deploys |
| `EDGE_DEPLOY_ENABLED`, `EDGE_TYPECHECK_STRICT` | variable | `edge-functions.yml` | Turn on automatic deploy / make the full Deno typecheck blocking |
| `BUDGET_INITIAL_JS_KB`, `BUDGET_CHUNK_JS_KB`, `BUDGET_TOTAL_JS_KB`, `BUDGET_TOTAL_CSS_KB` | variable | `scripts/check-bundle-size.mjs` | Bundle budgets (gzip KB) |
| `COV_STATEMENTS`, `COV_BRANCHES`, `COV_FUNCTIONS`, `COV_LINES` | env (optional) | `vite.config.ts` | Coverage thresholds (default 10) |
| `BASE_SHA`, `GITHUB_STEP_SUMMARY`, `CI` | set by workflows/Actions | `scripts/lint-migrations.mjs`, `check-bundle-size.mjs`, Playwright config | — |
| `E2E_BASE_URL` | optional env | `playwright.config.ts` | Point Playwright at an existing deployment (default `http://localhost:4173`) |

---

## F. Local scripts

| Script | Env it reads |
|---|---|
| `scripts/ingest-brand-knowledge.mjs` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `COHERE_API_KEY`, optional `COHERE_EMBED_MODEL`; `--dry-run` needs no keys. Also needs `esbuild` installed (not in `package.json` devDependencies) and writes to table `brand_knowledge` |
| `scripts/telemetry-simulate.mjs` | `INGEST_URL`, `TOKEN`, optional `EQUIPMENT_ID`, `FAULT` (default `1`; `0` = healthy only) |
| `scripts/generate-rss.mjs` | none (needs `esbuild`) |
| `scripts/lint-migrations.mjs`, `check-bundle-size.mjs`, `gen-docs-inventory.mjs` | see §E / none |

> The service-role key bypasses RLS. Use it only in your own terminal or a secret store, never in `VITE_*`, a commit, or a chat.

---

## Quick checklists

**Minimum to run the dashboard locally:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (+ a Supabase project with migrations applied).

**Minimum for a production launch of the core product:** Vercel `VITE_*` (A) · `SITE_URL` · Stripe (B3) · Resend + Twilio (B4) ·
Vapi (B5, `VAPI_SERVER_SECRET` + the web public key) · at least one AI provider key (B2) · VAPID pair + `PUSH_DISPATCH_SECRET` +
DB settings (B6, D) · scheduler secrets for each cron-style function you actually schedule (B7).
