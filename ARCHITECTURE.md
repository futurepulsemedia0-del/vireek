# Vireek — Architecture

How the system is put together: frontend layers, the `lib/` pattern, the Supabase data model, the
edge-function map and realtime. Everything here was derived from the code in this repository; where
the code does not settle something it says **"verify"** instead of guessing.

> **Counts drift.** Numbers below (tables, functions, pages) are a snapshot. Regenerate the exact
> inventories from the current code with `npm run docs:inventory` →
> [`docs/generated/TABLES.md`](docs/generated/TABLES.md),
> [`docs/generated/EDGE_FUNCTIONS.md`](docs/generated/EDGE_FUNCTIONS.md),
> [`docs/generated/ENV_USAGE.md`](docs/generated/ENV_USAGE.md).

Related docs: [RUNBOOK.md](RUNBOOK.md) · [ENVIRONMENT.md](ENVIRONMENT.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [docs/LOCAL_SEED.md](docs/LOCAL_SEED.md)

---

## 1. System overview

```
 Browser (React SPA, PWA)  ──────────────►  Vercel (static hosting + SPA rewrite + security headers: vercel.json)
   │  supabase-js (anon key + user JWT)
   ▼
 Supabase project
   ├─ Auth (email/OAuth, MFA)                 ← profiles row created by DB trigger handle_new_user()
   ├─ Postgres + Row Level Security           ← tenant boundary = get_account_owner_id()
   ├─ Realtime (postgres_changes)             ← supabase_realtime publication
   ├─ Storage (private buckets)
   ├─ Edge Functions (Deno)                   ← supabase/functions/<name>/index.ts
   └─ pg_cron / pg_net                        ← scheduled SQL + DB → edge-function calls
 Third parties used by edge functions: Vapi (voice), Stripe, Twilio, Resend, Plaid, Google/HubSpot/Jobber/Meta
 (OAuth), AI providers (Gemini, Groq, Cerebras, Cloudflare Workers AI, OpenRouter, Anthropic, Cohere), ElevenLabs,
 Wisetack, property/weather/energy data APIs.
 Client-side third parties: Sentry, Google Analytics 4, Vapi web SDK, Plaid Link (see CSP in vercel.json).
```

- **Hosting:** Vercel; `vercel.json` rewrites everything to `/index.html`, proxies
  `/.well-known/agent-card.json` to the `mcp-server` A2A agent card, and sets HSTS / CSP / frame
  headers (the `/badge` route is embeddable: `frame-ancestors *`).
- **Mobile shell:** `capacitor.config.ts` (`appId: com.vireek.field`, `appName: Vireek Field`,
  `webDir: dist`) wraps the same build; native helpers live in `src/lib/native/`.
- **PWA / push:** `public/sw.js` handles Web Push events (registered in `src/main.tsx`).

---

## 2. Frontend

### 2.1 Boot sequence and provider stack (`src/main.tsx`)

`initSentry()` → import `@/i18n` → render:

```
StrictMode
 └ BrowserRouter  (+ ScrollToTop, AnalyticsListener)
   └ ThemeProvider
     └ AccessibilityProvider
       └ ExperimentProvider
         └ CurrencyProvider
           └ ToastProvider
             └ ConnectivityProvider
               └ AuthProvider
                 └ ErrorBoundary
                    ├ ConnectivityShell → <App/>        (routes)
                    ├ AccessibilityWidget
                    ├ SiteAssistant
                    └ LiveChatWidget
```

`NotificationsContext` (`src/contexts/`) also exists; it must wrap the dashboard exactly once because it
owns the single realtime subscription for notifications (see §5).

### 2.2 Layers (top → bottom, imports go downward only)

| Layer | Path | Responsibility |
|---|---|---|
| Entry | `index.html`, `src/main.tsx` | Providers, Sentry, i18n, service-worker registration |
| Routing | `src/App.tsx` | One `<Route>` per page, every page `lazy()`-loaded inside one `<Suspense>`; guard wrappers |
| Pages | `src/pages/` (~340 files; subfolders `admin/`, `onboarding/`) | One file per route: marketing/legal pages and authenticated dashboard pages |
| Components | `src/components/` (~230 files; `system/` = connectivity shell + banners) | Shared UI, layout (`Header`, `Footer`, `DashboardNav`), feature panels |
| Contexts / hooks | `src/contexts/` (8), `src/hooks/` (4) | Auth, theme, a11y, currency, experiments, toasts, connectivity, notifications; small hooks |
| Domain + data | `src/lib/` (~400 modules) | Types, pure logic, Supabase/edge I/O — see §2.4 |
| Static assets | `public/`, `src/locales/` | Icons, manifest, `robots.txt`, `sitemap.xml`, i18n JSON |

### 2.3 Route guards (`src/components/`)

| Guard | Used for | Rule |
|---|---|---|
| *(none)* | Marketing, legal, auth pages, `/portal/:token`, `/badge`, `/status` | Public |
| `ProtectedRoute` | `/dashboard/*` (used ~225×) | Requires session; also enforces the account's session policy (idle timeout / max session age) and, when enabled, the IP allow-list via the `check-ip-policy` function (`enterpriseSecurity` lib) |
| `StaffRoute` | `/staff/*` | `profiles.is_staff = true` |
| `TechnicianRoute` | technician/field pages | Team member with a technician record (`get_my_team_member_id` RPC) **or** profile role `owner`/`admin` |
| `PartnerRoute` | `/partner-portal/*` (except `/partner-portal/apply`) | Signed in with any `partners` row (pending, approved, rejected or suspended) |

Auth state (`src/contexts/AuthContext.tsx`): `session`, `user`, `profile`, `teamMember`.
The `profiles` row is created by a DB trigger after signup, so `fetchProfile` retries up to 4× (400 ms
back-off) and discards stale responses via a request-id ref. Non-owners load their `team_members`
row (by `member_email`) including `custom_role.permissions` (Enterprise RBAC overrides base
permissions).

**Account owner id.** Tenant data is keyed by the *owner's* id, not the logged-in user's. In the
frontend this is computed as `isOwner ? profile?.id : teamMember?.account_owner_id`
(e.g. `NotificationsContext.tsx`, `CalendarPage.tsx`, `NotificationsPage.tsx`). Always use this value
(never `user.id`) for realtime filters and `user_id` equality — using `user.id` silently breaks team members.

### 2.4 The `src/lib/` pattern

`lib/` is the domain layer. Conventions observed in the code:

1. **`<domain>.ts`** — types, constants and *pure* logic for one feature (scoring, formatting,
   state machines). No UI. Example: `adaptiveDiagnostic.ts`.
2. **`<domain>Api.ts`** — the I/O boundary for that domain (Supabase queries, RPC, edge-function
   calls). ~33 modules follow this split. Example: `adaptiveDiagnosticApi.ts`
   (imports the types from `adaptiveDiagnostic.ts`, uses `supabase` from `@/lib/supabase`).
3. **`<domain>.test.ts`** — colocated Vitest unit tests next to the pure module.
4. Many smaller domains keep types + Supabase calls in a single `<domain>.ts` (≈230 `lib` modules import
   the Supabase client). New code should prefer the `X.ts` / `XApi.ts` split so logic stays testable.

Shared infrastructure modules:

| Module | Role |
|---|---|
| `lib/supabase.ts` | The one `createClient()`; exports `supabase`, `isSupabaseConfigured`, and the `Profile` / `TeamMember` types. Falls back to a dummy URL and logs an error when the `VITE_*` vars are missing |
| `lib/realtime.ts` | `useRealtimeSubscription` + `RealtimeStatus` (§5) |
| `lib/aiStream.ts` | Client for SSE streams from edge functions (`{delta}` / `{done}` / `{error}` lines, as emitted by `demo-chat`) |
| `lib/sentry.ts`, `lib/analytics.ts` | Sentry init + `captureError`/`setSentryUser`; GA4 |
| `lib/push.ts`, `public/sw.js` | Web Push subscription + service worker |
| `lib/vapi.ts` | Vapi web SDK (demo assistant id overridable by env) |
| `lib/connectivity.ts` | Offline / maintenance / degraded detection (`ConnectivityShell`) |
| `lib/offline/`, `lib/native/` | Offline field capture/sync queue; Capacitor platform, NFC, scanner, tracking, vault |
| `lib/a11y/` | Announcer, focus trap |
| `lib/pricing.ts`, `industries.ts`, `glossary.ts`, `competitors.ts`, `brandFacts.ts`, `blog.ts`, `changelog.ts` | Static product/marketing data (also read by `scripts/ingest-brand-knowledge.mjs` and `scripts/generate-rss.mjs`) |

State management: there is no global store library (no Redux/React-Query in `package.json`). State is
React state + the contexts above + direct Supabase calls from pages/`lib`.

### 2.5 Cross-cutting frontend concerns

- **i18n:** `src/i18n/index.ts` (react-i18next) loads `src/locales/<lng>/common.json` for `en, es, zh, hi, fr, de, ar, fa, ja`.
  The language has a single source of truth — `AccessibilityContext` (localStorage key `vireek-a11y-lang`), which calls `i18n.changeLanguage`.
- **Design system:** Tailwind semantic tokens; `scripts/check-design-system.mjs` (`npm run lint:design`) scans the code for violations.
- **Connectivity / maintenance:** `ConnectivityShell` shows offline, degraded or maintenance screens from `navigator.onLine`,
  `VITE_MAINTENANCE_*` and an optional remote status JSON (`VITE_MAINTENANCE_STATUS_URL`); `/status`, `/privacy`, `/terms`, `/security` stay reachable during maintenance.
- **Errors/telemetry:** `ErrorBoundary`, Sentry (traces sampled 0.2 in production, cookies stripped), GA4 via `AnalyticsListener`.

---

## 3. Backend — Supabase

### 3.1 Tenancy and RLS model

- Every business-owned table has a `user_id uuid` that holds the **account owner's** profile id.
- Policies scope rows with `user_id = public.get_account_owner_id()`. The function (defined in
  `20260821101104_create_profiles_and_team_members.sql`) returns the caller's own profile id if they
  are an owner, otherwise `team_members.account_owner_id`.
- Sensitive writes do **not** go through table policies: they go through `SECURITY DEFINER` RPCs
  (e.g. `pio_register_device`, `pio_record_outcome`) or service-role edge functions. Example: Property
  Intelligence tables expose `SELECT` to the owner only and are written by `iot-ingest` /
  `property-intelligence-agent` / RPCs.
- `audit_log` is append-only for clients (no UPDATE/DELETE policy) and readable only by the actual owner.
- Anonymous/public flows (booking, customer portal, demo chat, site assistant) use token-gated edge
  functions plus rate-limit tables (`demo_chat_rate_limit`, `site_assistant_rate_limit`, …).
- The platform `profiles.role` is `owner | admin | member`; `profiles.is_staff` marks internal staff.

### 3.2 Tables by domain

~680 tables across ~326 migrations in the snapshot (full list: `docs/generated/TABLES.md`).
Representative tables per domain:

| Domain | Representative tables |
|---|---|
| Identity & tenancy | `profiles`, `team_members`, `custom_roles`, `trusted_devices`, `sso_domains`, `scim_tokens`, `ip_allow_rules`, `security_policies`, `audit_log` |
| Core operations | `calls`, `leads`, `jobs`, `customers`, `customer_memory`, `customer_sites*`, `business_profile`, `integrations`, `ai_insights`, `phone_numbers`, `call_tracking_numbers`, `saved_views` |
| Dispatch & field | `job_status_events`, `technician_*`, `territories`, `on_call_*`, `escalation_*`, `job_quality_*`, `job_evidence_*`, `field_form_templates` |
| Sales & billing | `quotes`, `quote_events`, `estimate_templates`, `invoices`, `payment_requests`, `stripe_connect_accounts`, `billing_events`, `price_book_items`, `membership_plans`, `memberships`, `financing_*`, `signature_*` |
| Accounting & payroll | `chart_of_accounts`, `journal_entries`, `journal_lines`, `ar_*`, `ap_*`, `vendor_bills`, `employees`, `timesheets`, `pay_runs`, `commission_records` |
| Inventory & procurement | `inventory_*`, `purchase_orders*`, `vendors`, `rfqs`, `goods_receipts*`, `replenishment_*`, `service_part_kits`, `parts_market_*` |
| Equipment & predictive | `equipment`, `equipment_passports*`, `pio_*` (devices, telemetry, predictions, missions), `telemetry_*`, `pfn_*`, `oem_*`, `failure_*` |
| Fleet & telematics | `vehicles`, `vehicle_*`, `telematics_*`, `fleet_*` |
| Marketing & growth | `marketing_*`, `lead_scores`, `referral_*`, `outbound_*`, `ad_*`, `demand_os_settings`, `call_sources`, `review_requests`, `newsletter_subscribers` |
| Communications | `sms_*`, `email_*`, `dm_*` (WhatsApp), `support_*`, `push_subscriptions`, `notifications` |
| AI platform | `ai_usage_logs`, `ai_budget_limits`, `ai_eval_*`, `ai_decision_*`, `ai_security_*`, `agent_*`, `marketplace_agent*`, `agent_network_*`, `ask_vireek_*`, `knowledge_*`, `kce_*` |
| Decision / "business brain" | `business_decisions`, `business_*` (twin, drift, immune, scientist, roadmap), `causal_*`, `decision_*`, `strategic_goals`, `commitments`, `negative_*` |
| Network & enterprise | `franchise_*`, `commercial_contracts`, `network_*`, `mutual_aid_*`, `labor_marketplace_*`, `partners*`, `evidence_*`, `sde_*`, `oin_*` |
| Compliance & DR | `data_retention_policies`, `deletion_requests`, `consent_records`, `pii_field_registry`, `platform_backup_runs`, `platform_restore_drills`, `dnc_suppressions` |
| Bank / finance data | `bank_*` |
| Public site | `sales_inquiries`, `demo_bookings`, `roadmap_items`, `roadmap_votes`, `community_*`, `academy_*`, `status_subscribers` |

### 3.3 Storage buckets referenced by the code

`quote-photos`, `estimate-photos`, `field-estimate-media`, `job-room-photos`, `job-evidence-photos`,
`job-evidence-chain`, `expert-assist-media`, `emergency-triage-media`, `diagnosis-copilot-photos`,
`voice-samples`, `property-vision`, `remote-resolution-media`, and `dr-backups` (must be created
manually, private — see `dr-backup-run`). Most are created by `INSERT INTO storage.buckets` in migrations; **verify**
the list against the current migrations/dashboard.

### 3.4 Shared edge-function code (`supabase/functions/_shared/`)

| Folder | Purpose |
|---|---|
| `ai-core/` | **AI router.** `registry.ts` maps task → ordered provider chain. Default chain: Gemini → Groq → Cerebras → Cloudflare Workers AI → OpenRouter; JSON-mode tasks skip Cloudflare. Adapters for Anthropic and Cohere (embeddings) are registered but not in the default chain. Also guardrails, cost tracking, eval harness, SSE helper and many domain "analysis" modules |
| `stripe/`, `billing/` | Stripe client; payment-suspension sweep |
| `messaging/`, `notify/` | `sendSms` / `sendCompliantSms` (A2P + DNC/STOP), email/SMS delivery |
| `governance/` | `authorizeAgentAction`, AI decision recorder (approval queue, spend limits) |
| `compliance/` | `ownedTables` registry (used by retention sweep and DR backup), DNC checks |
| `bank/`, `ads/`, `telematics/`, `price-book/`, `financing/` | Provider clients, OAuth state, token encryption (AES keys from secrets) |
| `knowledge/`, `property-intelligence/`, `dispatch/`, `automation/` | Domain helpers (RAG search, property data, technician assignment, automation gate) |

A stray top-level `functions/` folder mirrors `supabase/functions/agent-runtime` and `_shared/agent-marketplace`
(identical in the snapshot). Only `supabase/functions/` is deployable by the Supabase CLI.

### 3.5 Edge-function map

176 functions with an `index.ts` in the snapshot. Grouped by purpose (names are exact; open each file's
header comment for its contract; exact auth/secrets/tables per function are in `docs/generated/EDGE_FUNCTIONS.md`).

**How a function is invoked** (this decides how it must be deployed — see RUNBOOK §2):

| Trigger | Auth | Examples |
|---|---|---|
| App (user) | Supabase JWT in `Authorization` (platform JWT check on) | `ai-assistant-query`, `create-checkout-session`, `delete-account`, `generate-insights`, `sms-send`, `email-send` |
| Public webhook | `--no-verify-jwt` + provider signature/secret | `stripe-webhook`, `stripe-payment-webhook`, `vapi-webhook` (`x-vapi-secret`), `sms-webhook` (Twilio), `email-webhook`, `whatsapp-webhook`, `bank-webhook` (Plaid JWT), `financing-webhook` |
| Device / partner ingest | `--no-verify-jwt` + device key or token | `iot-ingest` (`X-Device-Key`), `telemetry-ingest`, `telematics-ingest`, `fleet-telemetry-ingest`, `rr-device-ingest`, `fabric-ingest`, `api-v1` (customer API key), `mcp-server` (agent key `vrk_agent_…`), `evidence-marketplace-api` |
| Scheduled | `X-Cron-Secret` header (or user JWT for "Run now") | see list below |
| DB-triggered | `pg_net` call from a trigger using `app.settings.*` | `send-push-notification` (from `notifications` inserts), `dispatch-webhook`, `event-bus-dispatch` |
| OAuth redirect | `--no-verify-jwt` callback | `google-calendar-oauth-callback`, `hubspot-oauth-callback`, `jobber-oauth-callback`, `ads-oauth-callback` |

**Scheduled / cron-secret functions** (secret env var in parentheses): `agent-runtime`, `commitment-monitor-tick`,
`detect-service-recovery-signals`, `emergency-network-orchestrator`, `escalation-tick`, `estimate-recovery-agent`,
`failure-genome-refresh`, `followup-agent-dispatcher`, `followup-agent-enroller`, `home-health-agent`, `kce-extract`,
`membership-lifecycle-agent`, `mine-organizational-memory`, `outbound-dialer`, `outbound-queue-builder`,
`predictive-failure`, `property-intelligence-agent`, `self-healing-orchestrator`, `service-guarantee-tick`,
`service-recovery-agent`, `switching-shield`, `workflow-engine-executor`, `workflow-graph-executor` (all `CRON_SECRET`);
`compute-benchmarks`, `compute-regional-demand` (`BENCHMARK_CRON_SECRET`); `compute-fleet-economics`
(`FLEET_ECONOMICS_CRON_SECRET`); `compute-fleet-intelligence` (`FLEET_INTELLIGENCE_CRON_SECRET`);
`compute-telematics-chain`, `telematics-sync` (`TELEMATICS_CRON_SECRET`); `telemetry-analyze` (`TELEMETRY_CRON_SECRET`);
`causal-outcome-tracker` (`CAUSAL_TRACKER_CRON_SECRET`); `automation-no-show-reschedule` (`NO_SHOW_CRON_SECRET`);
`automation-insurance-claim-status-update` (`INSURANCE_CLAIM_CRON_SECRET`); `automation-vip-customer-tag` (`VIP_TAG_CRON_SECRET`);
`send-payment-reminders` (`PAYMENT_REMINDER_CRON_SECRET`); `vertical-ai-pipeline` (`VERTICAL_AI_CRON_SECRET`);
`weather-surge-check` (`WEATHER_SURGE_CRON_SECRET`); ads functions (`ADS_CRON_SECRET`). Others with "scheduled"
semantics in their headers: `analyze-equipment-lifecycle` ("scheduled function"), `data-retention-sweep` (daily suggested),
`dr-backup-run` (daily suggested), `dr-restore-drill` (weekly suggested), `bank-sync` (`{ all: true }` nightly safety net).
The `check-*` functions (`check-usage-alert`, `check-warranty-alerts`, `check-warranty-claim-deadlines`,
`check-credential-expirations`, `check-contract-renewals`, `check-margin-guardrail`) carry no scheduling note in the
source — **verify** in your project how/when they are invoked.

**By domain** (all names exact):

| Domain | Functions |
|---|---|
| Voice & calls | `vapi-webhook`, `clone-voice`, `outbound-dialer`, `outbound-queue-builder`, `followup-agent-enroller`, `followup-agent-dispatcher`, `register-a2p-brand`, `escalate-emergency`, `escalation-tick`, `emergency-mode-activate`, `emergency-ops-broadcast`, `emergency-network-orchestrator`, `analyze-callback-root-cause` |
| Public AI chat | `demo-chat` (SSE streaming, rate-limited, unauthenticated), `site-assistant`, `onboarding-concierge`, `ask-vireek`, `ai-assistant-query` (RLS-scoped snapshot, no text-to-SQL; `RATE_LIMIT_MAX_PER_HOUR = 30` per user) |
| Messaging | `sms-send`, `sms-webhook`, `email-send`, `email-webhook`, `whatsapp-connect`, `whatsapp-webhook`, `send-team-invite`, `send-push-notification`, `notify-status-subscribers`, `unsubscribe-status-updates`, `mutual-aid-notify` |
| Billing & payments | `create-checkout-session` (plans `starter`/`professional`/`business`), `create-billing-portal-session`, `stripe-webhook`, `stripe-payment-webhook`, `stripe-connect-onboarding`, `create-payment-request`, `send-payment-reminders`, `enforce-payment-suspension`, `financing-create-offer`, `financing-webhook`, `franchise-royalty-issue`, `send-signature-request`, `sign-document-action` |
| Integrations & platform API | `google-calendar-oauth-start/-callback`, `hubspot-oauth-start/-callback`, `jobber-oauth-start/-callback`, `price-book-connect-servicetitan`, `price-book-connect-housecallpro`, `price-book-sync`, `data-import-run`, `fabric-ingest`, `api-v1`, `mcp-server` (MCP + A2A), `evidence-marketplace-api`, `event-bus-dispatch`, `dispatch-webhook`, `scim-v2`, `admin-sso`, `check-ip-policy`, `trusted-device`, `geocode-address`, `optimize-route` |
| Ads | `ads-oauth-start`, `ads-oauth-callback`, `ads-sync`, `ads-optimizer`, `ads-conversions` |
| Bank | `bank-connect`, `bank-intelligence`, `bank-sync`, `bank-insights`, `bank-webhook` (Plaid) |
| Dispatch & field | `dispatch-auto-assign`, `generate-mission-brief`, `job-context-engine`, `verify-job-evidence`, `field-estimate`, `visual-estimate`, `live-copilot`, `diagnosis-copilot`, `technician-simulator`, `remote-resolution`, `adaptive-diagnostic`, `adaptive-diagnostics` |
| IoT / telematics / predictive | `iot-ingest`, `telemetry-ingest`, `telemetry-analyze`, `rr-device-ingest`, `telematics-connect`, `telematics-ingest`, `telematics-sync`, `fleet-telemetry-ingest`, `compute-telematics-chain`, `compute-fleet-economics`, `compute-fleet-intelligence`, `property-intelligence`, `property-intelligence-agent`, `property-intelligence-enrich`, `property-vision-analyze`, `predictive-failure`, `home-health-agent`, `external-world-sync` |
| Business intelligence & "brain" | `generate-insights`, `business-decision-engine`, `business-drift-scan`, `business-immune-scan`, `business-scientist-cycle`, `causal-*` (3), `trust-bank-alerts`, `cash-flow-forecast`, `cash-flow-war-room`, `capacity-demand-insight`, `regional-demand-insight`, `compute-benchmarks`, `compute-regional-demand`, `outcome-benchmark-advisor`, `opportunity-cost-scan`, `next-best-actions`, `goal-decomposition-orchestrator`, `flywheel-engine`, `identity-signal-scan`, `mine-organizational-memory`, `workforce-equilibrium-engine`, `incentive-decision-engine`, `operational-truth`, `no-surprise-assess`, `quote-truth-engine`, `rebate-intelligence` |
| Knowledge / RAG | `knowledge-embed`, `knowledge-search`, `kce-extract`, `tribal-knowledge-manual-ingest`, `tribal-knowledge-voice-capture`, `contract-intelligence-extract`, `field-scientist-hypothesize` |
| Compliance, safety, DR | `delete-account`, `data-retention-sweep`, `dr-backup-run`, `dr-restore-drill`, `check-*` family (`check-contract-renewals`, `check-credential-expirations`, `check-ip-policy`, `check-margin-guardrail`, `check-usage-alert`, `check-warranty-alerts`, `check-warranty-claim-deadlines`), `analyze-job-compliance`, `permit-transaction-agent`, `verification-network` |
| Marketing | `marketing-engine-tick`, `marketing-campaign-dispatcher`, `marketing-track`, `ads-*` |
| Automations | `automation-no-show-reschedule`, `automation-vip-customer-tag`, `automation-insurance-claim-status-update`, `automation-seasonal-maintenance-reminder` (no `index.ts` in the snapshot — verify), `weather-surge-check`, `workflow-engine-executor`, `workflow-graph-executor`, `workflow-compiler`, `self-healing-orchestrator`, `service-guarantee-tick`, `service-recovery-agent`, `switching-shield`, `commitment-monitor-tick` |
| Agent platform | `agent-runtime` (sandbox broker: scope-minimised context → proposals → governance → approval/spend limits), `mcp-server` |
| AI ops | `ai-eval-run` (called nightly by `.github/workflows/ai-regression.yml`) |

### 3.6 AI Core request flow

`edge function` → `_shared/ai-core/index.ts` (`askVireekAi(task, …)`) → `router.ts` picks the chain from
`TASK_ROUTES[task]` → provider adapter (`providers/*.ts`, key from the secret named in
[ENVIRONMENT.md](ENVIRONMENT.md)) → on quota/error/outage falls through to the next provider →
cost logged (`costTracking.ts` → `ai_usage_logs`, limits in `ai_budget_limits`). Some functions call
Gemini directly (`GEMINI_API_KEY` / `GEMINI_MODEL` read in 16 places, mostly vision / multimodal).

### 3.7 Scheduling

Two mechanisms coexist:

1. **`pg_cron` inside Postgres**, created by migrations (≈25 jobs, e.g. `pio-agent-hourly`, `pio-prune-daily`,
   `service-twin-scan` every 5 min, `vireek-revenue-protection-scan` every 10 min, `verification-network-sweep`
   every 10 min, nightly refreshes: benchmarks, OEM reliability, failure atlas/genome, SDE/OIN, bank nightly sync).
   Jobs that call edge functions go through `pg_net` and need DB settings `app.settings.edge_function_base_url`
   and a secret (see ENVIRONMENT §4).
2. **External schedulers** (Supabase Dashboard Cron, GitHub Actions, any HTTP scheduler) calling a
   function with `X-Cron-Secret` — the function headers state the suggested cadence.

DB → function: a trigger on `notifications` INSERT calls `send-push-notification` via `pg_net`
(`dispatch_push_notification()`); it no-ops until the `app.settings.*` values are set.

---

## 4. Request paths worth knowing

- **Inbound call:** Vapi → `vapi-webhook` (assistant-request injects `caller_context`; tool calls
  `book_appointment`, `lookup_customer`, `check_weather`, `flag_emergency_call`, `request_human_transfer`,
  `lookup_price`, `search_knowledge`; lifecycle events upsert `calls`) → DB triggers create
  `notifications` (emergency, missed call, new lead) → push + bell.
- **Subscription change:** Stripe → `stripe-webhook` (verifies signature, logs to `billing_events` idempotently by event id,
  handles `invoice.payment_failed`, `invoice.payment_succeeded`, `checkout.session.completed`,
  `customer.subscription.updated|deleted`, updates `profiles`).
- **Checkout:** UI → `create-checkout-session` (validates the user JWT, price id from `STRIPE_PRICE_<PLAN>` secret).
- **Public API / agents:** `api-v1` (API key hashed with SHA-256, scopes `calls:read`, `leads:read`, `jobs:read`) and
  `mcp-server` (agent key, per-tool scopes, 60 calls/min + daily quota, writes require approval + idempotency key).
- **Sensor data:** device → `iot-ingest` (`X-Device-Key`, ≤500 readings / 256 KB) → `pio_telemetry` →
  `property-intelligence-agent` (hourly) → `pio_predictions` / `pio_missions`.

---

## 5. Realtime

- **Server side:** a table streams changes only if it is in the `supabase_realtime` publication. Migrations add
  (inside guarded `DO` blocks): `calls`, `jobs`, `expert_assist_messages`, `expert_assist_requests`, `pio_missions`,
  `vehicle_live_state`, `remote_resolution_cases`, `no_surprise_requests`, `revenue_protection_cases`,
  `emergency_incidents`, `inventory_stock_levels`, `network_*` (handoffs, matches, capacity listings),
  `parts_market_offers`, `supply_chain_*`, `sms_*`/`email_*`/`dm_*` conversations and messages, `support_*`.
  `notifications` has `REPLICA IDENTITY FULL` so UPDATE payloads carry the full row
  (**verify** its publication membership in the dashboard — the migrations here only set the replica identity).
- **Client hook:** `useRealtimeSubscription({ channelName, table, event, filter, onChange, enabled })`
  (`src/lib/realtime.ts`). It subscribes to `postgres_changes` on schema `public`, removes the channel on unmount,
  and returns `'connecting' | 'live' | 'reconnecting'` driven by the real `SUBSCRIBED` / `CHANNEL_ERROR` /
  `TIMED_OUT` / `CLOSED` states (used by the `LiveIndicator` UI). Used by ~19 files (Dashboard, Calls, Jobs,
  Calendar, Notifications, Command Center, Unified Inbox, Support Inbox, Revenue Protection, Property Intelligence,
  Network Handoffs, Capacity Exchange, …).
- **Direct channels** (not through the hook): `vehicle-live-state` (`lib/telematics.ts`), `supply-chain-outcomes`,
  `parts-market-live`, `expert-assist-<requestId>`.
- **Rules:**
  1. Filter by the **account owner id** (`user_id=eq.<ownerId>`), not `user.id`.
  2. Give each subscription a unique `channelName`; two components using the same name on one client collide
     (this once broke the dashboard — hence `NotificationsContext`, which subscribes once and shares state).
  3. Always clean up on unmount (the hook does).
  4. Add the table to the publication in a migration (guarded by `IF EXISTS (SELECT 1 FROM pg_publication …)`).

---

## 6. Quality gates (summary)

CI (`.github/workflows/ci.yml`): lint → typecheck → unit tests with coverage → build; then Playwright E2E.
Additional workflows: `security.yml` (npm audit, CodeQL, gitleaks), `quality-gates.yml` (migration lint,
bundle budget, Lighthouse), `edge-functions.yml` (Deno typecheck + gated deploy),
`vercel-preview-smoke.yml`, and `ai-regression.yml` (nightly eval-suite run). Details: [CONTRIBUTING.md](CONTRIBUTING.md), [RUNBOOK.md](RUNBOOK.md).
