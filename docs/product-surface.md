# Product surface (pilot freeze)

> **Generated file — do not edit by hand.** Regenerate with `npm run docs:surface`; CI runs `npm run docs:surface:check`.
> Source of truth for tiers: [`src/lib/productSurface.manifest.json`](../src/lib/productSurface.manifest.json).

## How to read this

Every column is derived from **source text only**. Nothing here was executed: no test run, no database, no network.

- **Backend** — `.from()` tables, `.rpc()` functions and edge functions (`fn:`) referenced by the page and its local imports (2 levels). `real` = every name resolves to a `CREATE TABLE/VIEW/FUNCTION` in `supabase/migrations` or a folder in `supabase/functions`; `partial` = some do not; `dangling` = none do; `none` = the page references no backend at all. Resolution against *migration files* does not prove the object exists in a live database.
- **Tests** — existence of test files, not their result. `page` = a test imports this page; `mods a/b` = `a` of the `b` backend-bearing modules the page depends on are imported by a test; `db a/b` = feature-specific tables/RPCs (generic ones like `profiles`, `team_members`, `get_account_owner_id` are ignored) mentioned in pgTAP files under `supabase/tests/database`; `fn a/b` = edge functions with a test file in their folder; `e2e n` = Playwright specs that navigate to the route.
- **Tier** — **Core**: part of the pilot product (jobs, scheduling/dispatch, customers, calls, quotes, invoices/payments, QuickBooks, warranty, plus the account/auth shell they need). **Secondary**: routed and shipped, not part of the pilot promise; routes keep working. **Unverified**: abstract/experimental surface; hidden (nav and route) for tenants without the `experimental_surface` flag. **Secondary** pages are additionally left out of the *nav* for tenants without `full_navigation` (see Gating).

## Summary

Page modules under `src/pages` (excluding tests): **635** · routed: **599** · in dashboard nav: **363** · page test files: **46** · e2e specs: **5**

| Tier | Pages | Routed | In nav | Backend real | Page test exists |
|---|---:|---:|---:|---:|---:|
| Core | 88 | 73 | 39 | 70 | 10 |
| Secondary | 495 | 474 | 273 | 482 | 38 |
| Unverified | 52 | 52 | 51 | 50 | 0 |

Backend universe found in the repo: 1457 tables/views, 2997 SQL functions, 345 edge-function folders.

## Gating

Two flags on the existing `feature_flags` mechanism (both seeded OFF = "overrides only"; see `supabase/migrations/20271231130000_product_surface_freeze_flag.sql`):

| Flag | Controls | New tenant | Existing tenants |
|---|---|---|---|
| `full_navigation` | Secondary pages **listed in the dashboard nav** (their routes always work) | OFF → Core nav only | grandfathered ON by the migration |
| `experimental_surface` | Unverified pages: **nav entry and route** (direct URL redirects to `/dashboard` with a toast; waits for the flag lookup, fails closed after 4 s) | OFF | grandfathered ON by the migration |

- A new tenant's nav therefore lists **39** entries (Core) out of **386** nav entries in `DashboardNav` (per-permission filtering still applies on top).
- Enable for one tenant: `/staff/feature-flags` → pick the flag → add an “on” override for that tenant (or “off” to freeze an existing tenant).
- Tenants with `experimental_surface` on see unverified nav entries with a **Beta** badge.
- Not separately filtered: `CommandPalette`, keyboard shortcuts and `MobileBottomNav` use static link lists; the generator verifies none of them link to an unverified route (see Review flags), and any link that did would still hit the route guard.
- **Server-side:** the edge functions behind unverified pages call `userHasFlag()` (`supabase/functions/_shared/surfaceGate.ts` → `user_flag_is_on`, service-role only, fail closed) and answer `403 feature_not_enabled` for tenants without `experimental_surface`. `--check` fails if a function behind an unverified page lacks the gate.
- Other than that gate, RLS / edge-function authorization is unchanged and the data behind the pages is untouched. This is a feature freeze, **not** a new authorization model. No code, data or migration is deleted.

### Unverified routes (52 prefixes)

| Route prefix | Why unverified |
|---|---|
| `/dashboard/causal-simulator` | Causal World Simulator — what-if simulation of the business; no page/module/pgTAP/function test evidence |
| `/dashboard/causal-shock-simulator` | Causal Shock Simulator — scenario simulation; no page/module/pgTAP/function test evidence |
| `/dashboard/causal-chains` | Causal Disruption Chains — abstract causal model; no page/module/pgTAP/function test evidence |
| `/dashboard/causal-roi` | Causal ROI Attribution — modelled attribution; no page/module/pgTAP/function test evidence |
| `/dashboard/revenue-causality` | Revenue Causality Graph — abstract graph; no page/module/pgTAP/function test evidence |
| `/dashboard/reality-engine` | Counterfactual Reality Engine — counterfactual simulation; no page/module/pgTAP/function test evidence |
| `/dashboard/counterfactuals` | Counterfactual Library — counterfactual store; no page/module/pgTAP/function test evidence |
| `/dashboard/business-scientist` | Business Scientist — autonomous hypothesis engine; no page/module/pgTAP/function test evidence |
| `/dashboard/entropy` | Operational Entropy — no backend reference at all in page or imports; no page/module/pgTAP/function test evidence |
| `/dashboard/outcome-clearinghouse` | Outcome Clearinghouse — no backend reference at all in page or imports; no page/module/pgTAP/function test evidence |
| `/dashboard/identity-learner` | Continual Identity Learner — abstract learner; no page/module/pgTAP/function test evidence |
| `/dashboard/identity` | Business Identity — abstract learner; no page/module/pgTAP/function test evidence |
| `/dashboard/identity-graph` | Universal Identity — abstract graph; no page/module/pgTAP/function test evidence |
| `/dashboard/technician-identity` | Technician Identity Graph — abstract graph; no page/module/pgTAP/function test evidence |
| `/dashboard/decision-engine` | Decision Engine — abstract decision scoring; no page/module/pgTAP/function test evidence |
| `/dashboard/decision-debt` | Decision Debt — abstract metric; no page/module/pgTAP/function test evidence |
| `/dashboard/opportunity-cost` | Opportunity Cost Ledger — modelled ledger; no page/module/pgTAP/function test evidence |
| `/dashboard/digital-twin` | Business Digital Twin — abstract twin; no page/module/pgTAP/function test evidence |
| `/dashboard/immune-system` | Business Immune System — abstract monitor; no page/module/pgTAP/function test evidence |
| `/dashboard/flywheel` | Compounding Flywheel — abstract metric; no page/module/pgTAP/function test evidence |
| `/dashboard/pricing-flywheel` | Pricing Flywheel — abstract metric; no page/module/pgTAP/function test evidence |
| `/dashboard/operating-model` | Self-Evolving Operating Model — abstract model; no page/module/pgTAP/function test evidence |
| `/dashboard/constitution` | Business Constitution — abstract rules store; no page/module/pgTAP/function test evidence |
| `/dashboard/contradictions` | Business Contradictions — abstract detector; no page/module/pgTAP/function test evidence |
| `/dashboard/commitments` | Commitment Graph — abstract graph; no page/module/pgTAP/function test evidence |
| `/dashboard/business-drift` | Business Drift Detector — abstract detector; no page/module/pgTAP/function test evidence |
| `/dashboard/roadmap` | Evolution Roadmap — generated roadmap; no page/module/pgTAP/function test evidence |
| `/dashboard/market-intelligence` | Market Intelligence — abstract aggregation; no page/module/pgTAP/function test evidence |
| `/dashboard/reflexes` | Company Reflexes — autonomous reflex rules; no page/module/pgTAP/function test evidence |
| `/dashboard/self-healing` | Self-Healing — autonomous remediation; no page/module/pgTAP/function test evidence |
| `/dashboard/operations-loop` | Operations Loop — abstract loop; no page/module/pgTAP/function test evidence |
| `/dashboard/service-intelligence-loop` | Service Intelligence Loop — abstract loop; no page/module/pgTAP/function test evidence |
| `/dashboard/service-graph` | Service Graph — abstract graph; no page/module/pgTAP/function test evidence |
| `/dashboard/physical-economy-network` | Physical Economy Network — abstract network; no page/module/pgTAP/function test evidence |
| `/dashboard/regulation-graph` | Temporal Regulation Graph — abstract graph; no page/module/pgTAP/function test evidence |
| `/dashboard/workforce-equilibrium` | Workforce Equilibrium — abstract model; no page/module/pgTAP/function test evidence |
| `/dashboard/seasonal-stabilizer` | Seasonal Revenue Stabilizer — abstract model; no page/module/pgTAP/function test evidence |
| `/dashboard/economic-autopilot` | Economic Autopilot — autonomous financial actions; no page/module/pgTAP/function test evidence |
| `/dashboard/ltv-autopilot` | LTV Autopilot — autonomous marketing actions; no page/module/pgTAP/function test evidence |
| `/dashboard/execution-reliability` | Execution Reliability — abstract metric; no page/module/pgTAP/function test evidence |
| `/dashboard/autonomy-budget` | Autonomy Budget — agent autonomy accounting; no page/module/pgTAP/function test evidence |
| `/dashboard/autonomy-readiness` | Autonomy Readiness — agent autonomy scoring; no page/module/pgTAP/function test evidence |
| `/dashboard/agent-company` | Multi-Agent Company — agent simulation; no page/module/pgTAP/function test evidence |
| `/dashboard/agent-network` | Agent Network — agent network; no page/module/pgTAP/function test evidence |
| `/dashboard/switching-shield` | Switching Shield — abstract retention model; no page/module/pgTAP/function test evidence |
| `/dashboard/cash-flow-war-room` | Cash Flow War Room — modelled scenarios; no page/module/pgTAP/function test evidence |
| `/dashboard/demand-os` | Demand OS — abstract demand model; no page/module/pgTAP/function test evidence |
| `/dashboard/adoption` | Adoption OS — abstract adoption model; no page/module/pgTAP/function test evidence |
| `/dashboard/outcome-benchmarks` | Outcome Benchmark Network — cross-tenant benchmark network; no page/module/pgTAP/function test evidence |
| `/dashboard/data-exchange` | Service Data Exchange — cross-tenant data exchange; no page/module/pgTAP/function test evidence |
| `/dashboard/field-intelligence` | Field Intelligence — abstract aggregation; no page/module/pgTAP/function test evidence |
| `/dashboard/oem-graph` | OEM Intelligence Graph — abstract graph; no page/module/pgTAP/function test evidence |

## Route integrity findings (read from `src/App.tsx` / `DashboardNav.tsx`)

- Nav entries whose `href` matches **no** `<Route>` (clicking lands on the 404 route): `/dashboard/site-sketches` (Site Sketches, Primary, tier Secondary); `/dashboard/equipment` (Equipment Intelligence, Primary, tier Secondary); `/dashboard/speed-to-lead` (Speed to Lead, Primary, tier Secondary); `/dashboard/field-evidence` (Field Evidence, Primary, tier Secondary); `/dashboard/account` (My Account, Account, tier Secondary); `/dashboard/pay-by-bank` (Pay by Bank, Account, tier Secondary); `/dashboard/phone-payments` (Phone Payments, Account, tier Secondary). These were **not** changed by the freeze — if the routes were lost from a damaged snapshot, restore them; if intentional, remove the nav entries.
- Route paths declared more than once (first match wins): `/review/:token`, `/track/:token`, `/customers`, `/dashboard/service-recovery`, `/dashboard/adaptive-diagnostics`, `/dashboard/bank-intelligence`, `/dashboard/tax`, `/dashboard/insights`, `/dashboard/workflows`, `/dashboard/benchmarks`, `/dashboard/inventory`.
- Page modules whose file name starts lower-case (likely corrupted names): `src/pages/hangelogPage.tsx`.

## Review flags

- **warn** — Core page BillingInvoicesPage has backend=none — confirm it is data-backed
- **warn** — Core page BillingPlansPage has backend=none — confirm it is data-backed
- **warn** — Core page HelpPage has backend=none — confirm it is data-backed
- **warn** — Core page PaymentResultPage has backend=none — confirm it is data-backed
- **warn** — Core page SlackTeamsSettingsPage has backend=none — confirm it is data-backed
- **warn** — Core page UpdatePaymentMethodPage has backend=none — confirm it is data-backed

## Core pages (88)

| Page | Route(s) | Nav | Backend | Tests |
|---|---|:-:|---|---|
| `AccountPage` | — |  | real: profiles, auth.updateUser | page N · mods 0/1 · db 0/0 · fn 0/0 · e2e 0 |
| `ApiKeysPage` | `/dashboard/settings/api-keys` |  | real: api_keys | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ApiUsagePage` | `/dashboard/settings/api-usage` | Y | real: api_keys, api_usage_alert_events, api_usage_alert_rules, get_api_usage_summary(), get_api_usage_timeseries() +2 | page N · mods 0/2 · db 0/6 · fn 0/1 · e2e 0 |
| `AssistantPersonaPage` | `/dashboard/settings/assistant` |  | real: business_profile | page N · mods 0/1 · db 1/1 · fn 0/0 · e2e 0 |
| `AuditLogPage` | `/dashboard/settings/audit-log` |  | real: audit_log | page N · mods 1/1 · db 0/1 · fn 0/0 · e2e 0 |
| `BillingInvoicesPage` | `/dashboard/billing/invoices` | Y | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `BillingPage` | `/dashboard/billing` | Y | real: ai_insights, jobs | page N · mods 0/1 · db 1/2 · fn 0/0 · e2e 1 |
| `BillingPlansPage` | `/dashboard/billing/plans` | Y | none | page Y · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `BookingSettingsPage` | `/dashboard/booking-settings` | Y | real: business_profile, jobs, get_booking_public_settings(), get_booking_busy_window(), create_public_booking_with_settings() +7 | page N · mods 0/3 · db 2/11 · fn 0/1 · e2e 0 |
| `BrandingSettingsPage` | `/dashboard/settings/branding` | Y | real: brand_settings, audit_log, get_portal_branding(), fn:verify-custom-domain | page Y · mods 1/1 · db 0/3 · fn 0/1 · e2e 0 |
| `BusinessProfilePage` | `/dashboard/business-profile` | Y | real: business_profile, profiles, call_sources, auto_reply_settings, auto_reply_log +5 | page N · mods 1/8 · db 1/7 · fn 0/2 · e2e 0 |
| `CalendarPage` | `/dashboard/calendar` | Y | real: jobs, team_members, assign_technician_to_job() | page N · mods 0/1 · db 1/2 · fn 0/0 · e2e 0 |
| `CallDetailPage` | `/dashboard/calls/:id` |  | real: calls, leads, jobs, call_dispositions, tasks +5 | page Y · mods 1/3 · db 5/9 · fn 0/0 · e2e 0 |
| `CallFlowsPage` | `/dashboard/calls/flows`<br>`/dashboard/calls/flows/:id` | Y | real: call_routing_configs, business_profile, team_members, call_flows, call_flow_settings | page Y · mods 2/2 · db 1/4 · fn 0/0 · e2e 0 |
| `CallRoutingPage` | `/dashboard/call-routing` | Y | real: call_routing_configs, business_profile, team_members | page N · mods 1/1 · db 1/2 · fn 0/0 · e2e 0 |
| `CallsPage` | `/dashboard/calls` | Y | real: calls, leads, jobs, team_members, customer_memory +3 | page N · mods 1/5 · db 3/7 · fn 0/0 · e2e 0 |
| `CancelSubscriptionPage` | `/dashboard/billing/cancel` |  | real: calls, jobs | page Y · mods 1/1 · db 2/2 · fn 0/0 · e2e 0 |
| `ChatWidgetSettingsPage` | `/dashboard/settings/chat-widget` | Y | real: chat_widget_settings, team_members, chat_widget_messages, rotate_chat_widget_key() | page N · mods 0/1 · db 0/3 · fn 0/0 · e2e 0 |
| `CustomerDetailPage` | `/dashboard/customers/:id` |  | real: customers, equipment, jobs, calls, job_equipment +57 | page N · mods 4/13 · db 12/59 · fn 0/2 · e2e 0 |
| `CustomerSitesPage` | `/dashboard/customers/:id/sites` |  | real: customers, equipment, jobs, customer_sites, customer_site_buildings +3 | page N · mods 0/1 · db 3/8 · fn 0/0 · e2e 0 |
| `CustomersPage` | `/customers`<br>`/dashboard/customers` | Y | real: customers, team_members, custom_field_definitions, saved_views, soft_delete_records() +9 | page N · mods 3/6 · db 1/13 · fn 0/0 · e2e 1 |
| `DashboardPage` | `/dashboard` | Y | real: calls, jobs, leads, ai_insights, business_profile +19 | page N · mods 3/8 · db 7/22 · fn 0/1 · e2e 1 |
| `DataGovernancePage` | `/dashboard/settings/data-governance` |  | real: data_retention_policies, deletion_requests, consent_records, pii_field_registry, platform_backup_runs +3 | page N · mods 0/1 · db 0/7 · fn 0/0 · e2e 0 |
| `DispatchBoardPage` | `/dashboard/dispatch` | Y | real: jobs, team_members, business_profile, technician_time_off, company_blackout_dates +94 | page N · mods 6/16 · db 16/91 · fn 0/6 · e2e 1 |
| `DispatchRulesPage` | `/dashboard/assignment-rules` | Y | real: jobs, dispatch_rules, dispatch_technician_preferences, customers, dispatch_decisions | page N · mods 0/3 · db 2/5 · fn 0/0 · e2e 0 |
| `EmailSettingsPage` | `/dashboard/settings/email` | Y | real: fn:email-settings | page N · mods 1/1 · db 0/0 · fn 0/1 · e2e 0 |
| `EnterpriseSecurityPage` | `/dashboard/settings/enterprise-security` |  | real: custom_roles, team_members, ip_allow_rules, security_policies, sso_domains +6 | page N · mods 0/2 · db 0/6 · fn 0/2 · e2e 0 |
| `ForgotPasswordPage` | `/forgot-password` |  | real: auth.resetPasswordForEmail | page N · mods 0/1 · db 0/0 · fn 0/0 · e2e 0 |
| `GettingStartedPage` | `/dashboard/getting-started` | Y | real: business_profile, phone_numbers, team_members, integrations, getting_started_progress | page N · mods 0/1 · db 1/4 · fn 0/0 · e2e 0 |
| `HelpPage` | `/dashboard/help` | Y | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `ImportsPage` | `/dashboard/imports` | Y | real: data_import_jobs, data_import_row_errors, fn:data-import-run, auth.getSession | page N · mods 0/1 · db 0/2 · fn 0/1 · e2e 0 |
| `IntegrationsPage` | `/dashboard/integrations` | Y | real: integrations, microsoft_calendar_connections, chat_connections, chat_routes, chat_deliveries | page N · mods 1/3 · db 0/5 · fn 0/0 · e2e 1 |
| `InvoiceDetailPage` | `/dashboard/invoicing/:id` |  | real: invoices, invoice_payments, invoice_refunds, invoice_reminders, profiles +31 | page N · mods 6/6 · db 2/32 · fn 0/2 · e2e 0 |
| `InvoicesPage` | `/dashboard/invoicing` | Y | real: invoices, team_members, saved_views, tax_rates, tax_settings +23 | page N · mods 4/6 · db 1/26 · fn 0/0 · e2e 1 |
| `JobDetailPage` | `/dashboard/jobs/:id` |  | real: invoices, jobs, job_quality_checklist_templates, job_checklist_completions, job_quality_requirements +84 | page N · mods 7/17 · db 15/84 · fn 0/3 · e2e 0 |
| `JobRoomPage` | `/service/:token` |  | real: newsletter_subscribers, jobs, no_surprise_requests, customers, get_job_tracking() +10 | page N · mods 2/5 · db 2/14 · fn 0/1 · e2e 0 |
| `JobsPage` | `/dashboard/jobs` | Y | real: jobs, team_members, price_book_items, review_requests, leads +199 | page N · mods 15/35 · db 23/190 · fn 0/11 · e2e 1 |
| `LeadDetailPage` | `/dashboard/leads/:id` |  | real: leads, calls, customers, quotes, business_activity_events +2 | page Y · mods 2/2 · db 3/7 · fn 0/0 · e2e 0 |
| `LeadsPage` | `/dashboard/leads` | Y | real: jobs, team_members, price_book_items, business_profile, review_requests +146 | page N · mods 9/27 · db 6/137 · fn 0/11 · e2e 0 |
| `LocationsSettingsPage` | `/dashboard/settings/locations` | Y | real: business_locations, business_brands, team_members, location_members, location_preferences +3 | page N · mods 0/1 · db 0/7 · fn 0/0 · e2e 0 |
| `LoginPage` | `/login` |  | real: list_own_sessions(), revoke_own_session(), fn:trusted-device, auth.signInWithPassword, auth.signOut +6 | page N · mods 1/4 · db 0/2 · fn 0/1 · e2e 1 |
| `MfaChallengePage` | `/mfa` |  | real: fn:mfa-recovery, auth.getSession, auth.mfa, auth.refreshSession, auth.signOut | page Y · mods 1/1 · db 0/0 · fn 0/1 · e2e 0 |
| `OAuthAppsPage` | `/dashboard/settings/oauth-apps` |  | real: oauth_apps, oauth_grants, api_keys | page N · mods 1/2 · db 0/3 · fn 0/0 · e2e 0 |
| `OnboardingConciergePage` | `/onboarding/concierge` |  | real: business_profile, profiles | page N · mods 0/1 · db 1/1 · fn 0/0 · e2e 0 |
| `OnboardingPage` | `/onboarding/classic` |  | real: business_profile, profiles | page N · mods 0/1 · db 1/1 · fn 0/0 · e2e 0 |
| `PaymentPricingSettingsPage` | `/dashboard/payment-pricing` | Y | real: payment_pricing_settings, record_discounted_manual_payment(), get_job_pricing_ledger(), get_job_payment_summary(), record_manual_payment() +4 | page N · mods 1/2 · db 0/8 · fn 0/1 · e2e 0 |
| `PaymentResultPage` | `/pay-result` |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `PaymentsPage` | `/dashboard/payments` | Y | real: jobs, payment_requests, stripe_connect_accounts, set_tipping_enabled(), fn:stripe-connect-onboarding +1 | page N · mods 1/2 · db 2/4 · fn 0/2 · e2e 0 |
| `PhoneNumbersPage` | `/dashboard/phone-numbers` | Y | real: phone_numbers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `PropertyDigitalTwinPage` | `/dashboard/customers/:customerId/sites/:siteId/twin` |  | real: agent_action_catalog, agent_permissions, agent_spending_limits, agent_action_log, equipment +12 | page N · mods 1/5 · db 2/17 · fn 0/0 · e2e 0 |
| `PropertyIntelligencePage` | `/dashboard/customers/:customerId/sites/:siteId/intelligence`<br>`/dashboard/property-intelligence` | Y | real: equipment, jobs, job_equipment, equipment_maintenance_alerts, pio_missions +13 | page N · mods 2/2 · db 2/15 · fn 0/3 · e2e 0 |
| `PublicPaymentPage` | `/pay/:token` |  | real: fn:public-payment | page N · mods 1/1 · db 0/0 · fn 0/1 · e2e 0 |
| `QuickBooksSyncPage` | — |  | real: qbo_connections, qbo_sync_runs, qbo_sync_log, qbo_record_links | page N · mods 1/1 · db 2/4 · fn 0/0 · e2e 0 |
| `QuoteAcceptPage` | `/quote/:token` |  | real: newsletter_subscribers, estimate_templates, quote_events, quote_videos, quote_video_settings +18 | page Y · mods 3/6 · db 0/20 · fn 0/3 · e2e 0 |
| `QuoteDetailPage` | `/dashboard/quotes/:id` |  | real: quote_videos, quote_video_settings, quote_ar_models, quote_ar_previews, site_sketches +27 | page Y · mods 1/6 · db 1/29 · fn 0/3 · e2e 0 |
| `QuotesPage` | `/dashboard/quotes` | Y | real: leads, business_profile, quotes, price_book_items, estimate_templates +30 | page N · mods 4/13 · db 4/29 · fn 0/4 · e2e 1 |
| `RegionalPacksSettingsPage` | `/dashboard/settings/regional-packs` | Y | real: regional_pack_enablements, tax_registrations, regional_custom_closures, customers, consent_records +3 | page N · mods 0/1 · db 1/8 · fn 0/0 · e2e 0 |
| `ResetPasswordPage` | `/reset-password` |  | real: auth.verifyOtp, auth.onAuthStateChange, auth.updateUser, auth.signOut | page N · mods 0/1 · db 0/0 · fn 0/0 · e2e 0 |
| `RichMessagingSettingsPage` | `/dashboard/settings/rich-messaging` |  | real: rich_messaging_accounts, request_rich_messaging_access() | page N · mods 1/1 · db 0/2 · fn 0/0 · e2e 0 |
| `SecuritySettingsPage` | `/dashboard/settings/security` |  | real: audit_log, profiles, list_own_sessions(), revoke_own_session(), fn:trusted-device +8 | page N · mods 2/7 · db 0/3 · fn 0/3 · e2e 0 |
| `SessionsPage` | `/dashboard/settings/sessions` |  | real: login_events, profiles, custom_roles, team_members, ip_allow_rules +14 | page N · mods 0/5 · db 0/11 · fn 0/2 · e2e 0 |
| `SettingsPage` | `/dashboard/settings` | Y | real: profiles, push_subscriptions, team_members, device_push_tokens, daily_briefings +4 | page N · mods 1/5 · db 0/6 · fn 0/1 · e2e 0 |
| `SignupPage` | `/signup` |  | real: attribute_partner_referral(), fn:trusted-device, auth.signUp, auth.verifyOtp, auth.resend +2 | page N · mods 0/2 · db 0/1 · fn 0/1 · e2e 0 |
| `SlackTeamsSettingsPage` | `/dashboard/settings/slack-teams` | Y | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `SmsCompliancePage` | `/dashboard/settings/sms-compliance` |  | real: profiles, dnc_suppressions, consent_records, fn:register-a2p-brand | page N · mods 1/1 · db 0/2 · fn 0/1 · e2e 0 |
| `TeamPage` | `/dashboard/team` | Y | real: team_members, fn:send-team-invite | page N · mods 0/1 · db 0/0 · fn 0/1 · e2e 0 |
| `TechnicianDetailPage` | `/dashboard/team/:id` |  | real: team_members, technician_scorecards, technician_credentials, jobs, review_requests +10 | page N · mods 1/4 · db 2/14 · fn 0/0 · e2e 0 |
| `TechnicianSchedulePage` | `/tech/schedule` | Y | real: get_technician_today_jobs(), get_my_crew_jobs(), get_job_brief(), advance_job_status(), set_job_safety_flag() +2 | page Y · mods 1/2 · db 0/7 · fn 0/0 · e2e 0 |
| `TechnicianTodayPage` | `/tech/today` | Y | real: job_messages, get_technician_today_jobs(), get_my_crew_jobs(), get_job_brief(), advance_job_status() +4 | page N · mods 1/2 · db 0/9 · fn 0/0 · e2e 0 |
| `UpdatePaymentMethodPage` | `/dashboard/billing/update-payment` |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `VerifyEmailPage` | — |  | real: fn:trusted-device, auth.getSession | page N · mods 0/1 · db 0/0 · fn 0/1 · e2e 0 |
| `VoicemailsPage` | `/dashboard/voicemails` | Y | real: calls | page N · mods 0/1 · db 1/1 · fn 0/0 · e2e 0 |
| `WarrantyClaimRecoveryPage` | `/dashboard/warranty-claims` | Y | real: warranty_claims, warranty_eligible_jobs, signature_requests, signature_events, get_signature_request_for_signer() +2 | page N · mods 0/2 · db 0/5 · fn 0/2 · e2e 1 |
| `WarrantyRegisterPage` | `/warranty/register` |  | real: newsletter_subscribers, equipment_passport_links, verify_equipment_passport(), get_equipment_passport(), list_equipment_passports() +6 | page N · mods 2/3 · db 0/10 · fn 0/1 · e2e 0 |
| `WebsiteWidgetsPage` | `/dashboard/settings/website-widgets` | Y | real: price_book_items, website_widgets, website_widget_daily_stats, business_profile, reviews +2 | page N · mods 0/2 · db 2/7 · fn 0/0 · e2e 0 |
| `onboarding/OnboardingWizard` | `/onboarding` |  | real: business_profile, profiles, phone_numbers, knowledge_articles, knowledge_article_versions +9 | page N · mods 0/3 · db 1/9 · fn 0/4 · e2e 0 |
| `onboarding/StepShell` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `onboarding/Stepper` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `onboarding/steps/BusinessInfoStep` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `onboarding/steps/CalendarStep` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `onboarding/steps/ConfirmStep` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `onboarding/steps/HoursStep` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `onboarding/steps/KnowledgeStep` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `onboarding/steps/LaunchStep` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `onboarding/steps/OperationsStep` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `onboarding/steps/PhoneStep` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `onboarding/steps/SarahStep` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `onboarding/steps/TestCallStep` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |

## Unverified pages (52)

| Page | Route(s) | Nav | Backend | Tests |
|---|---|:-:|---|---|
| `AdoptionOSPage` | `/dashboard/adoption` | Y | real: adoption_interventions, get_adoption_signals() | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `AgentCompanyPage` | `/dashboard/agent-company` | Y | real: agent_action_catalog, agent_permissions, agent_spending_limits, agent_action_log, agent_tasks +7 | page N · mods 0/2 · db 0/12 · fn 0/0 · e2e 0 |
| `AgentNetworkPage` | `/dashboard/agent-network` | Y | real: create_agent_network_client(), revoke_agent_network_client(), list_agent_network_clients(), list_agent_network_calls(), fn:mcp-server | page N · mods 0/1 · db 0/4 · fn 0/1 · e2e 0 |
| `AutonomyBudgetPage` | `/dashboard/autonomy-budget` | Y | real: agent_action_catalog, agent_permissions, agent_spending_limits, agent_action_log, agent_autonomy_budgets +8 | page N · mods 0/2 · db 0/13 · fn 0/0 · e2e 0 |
| `AutonomyReadinessPage` | `/dashboard/autonomy-readiness` | Y | real: agent_autonomy_score_snapshots, get_agent_autonomy_readiness(), capture_my_agent_autonomy_snapshot() | page N · mods 0/1 · db 0/3 · fn 0/0 · e2e 0 |
| `BusinessConstitutionPage` | `/dashboard/constitution` | Y | real: agent_action_catalog, constitution_articles, constitution_violations, get_agent_authority_matrix(), create_constitution_article() +2 | page N · mods 0/1 · db 0/7 · fn 0/0 · e2e 0 |
| `BusinessContradictionsPage` | `/dashboard/contradictions` | Y | real: business_contradictions, run_contradiction_detection() | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `BusinessDecisionEnginePage` | `/dashboard/decision-engine` | Y | real: business_decisions, business_decision_settings, fn:business-decision-engine, auth.getSession | page N · mods 0/1 · db 0/2 · fn 0/1 · e2e 0 |
| `BusinessDigitalTwinPage` | `/dashboard/digital-twin` | Y | real: business_twin_scenarios, business_twin_runs, business_twin_learned_adjustments | page N · mods 0/1 · db 0/3 · fn 0/0 · e2e 0 |
| `BusinessDriftPage` | `/dashboard/business-drift` | Y | real: business_drift_snapshots, fn:business-drift-scan, auth.getSession | page N · mods 0/1 · db 0/1 · fn 0/1 · e2e 0 |
| `BusinessEvolutionRoadmapPage` | `/dashboard/roadmap` | Y | real: business_roadmap_goals, business_roadmap_milestones, set_active_roadmap_goal(), update_roadmap_milestone_status(), get_roadmap_dimension_scores() | page N · mods 0/1 · db 0/5 · fn 0/0 · e2e 0 |
| `BusinessIdentityPage` | `/dashboard/identity` | Y | real: identity_decision_events, business_identity_snapshots, business_identity_drift_events, get_business_identity_profile(), acknowledge_identity_drift() +2 | page N · mods 0/1 · db 0/7 · fn 0/0 · e2e 0 |
| `BusinessImmuneSystemPage` | `/dashboard/immune-system` | Y | real: business_immune_signals, workflow_definitions, business_immune_settings, business_immune_actions | page N · mods 0/1 · db 0/4 · fn 0/0 · e2e 0 |
| `BusinessScientistPage` | `/dashboard/business-scientist` | Y | real: business_scientist_studies, business_scientist_settings, fn:business-scientist-cycle | page N · mods 0/1 · db 0/2 · fn 0/1 · e2e 0 |
| `CashFlowWarRoomPage` | `/dashboard/cash-flow-war-room` | Y | real: cash_flow_war_room_plans, cash_flow_war_room_action_log, fn:cash-flow-war-room, auth.getSession | page N · mods 0/1 · db 0/2 · fn 0/1 · e2e 0 |
| `CausalChainsPage` | `/dashboard/causal-chains` | Y | real: causal_chain_analyses, compute_causal_disruption_chains() | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `CausalRoiAttributionPage` | `/dashboard/causal-roi` | Y | real: causal_roi_attributions, find_unanalyzed_ai_action_events(), compute_causal_roi_attribution(), get_causal_roi_summary(), get_causal_roi_by_action_type() | page N · mods 0/1 · db 0/5 · fn 0/0 · e2e 0 |
| `CausalShockSimulatorPage` | `/dashboard/causal-shock-simulator` | Y | real: causal_shock_simulations, fn:causal-shock-simulator, auth.getSession | page N · mods 0/1 · db 0/1 · fn 0/1 · e2e 0 |
| `CausalWorldSimulatorPage` | `/dashboard/causal-simulator` | Y | real: causal_scenarios, causal_simulations, causal_outcome_tracking, fn:causal-world-simulator, auth.getSession | page N · mods 0/1 · db 0/3 · fn 0/1 · e2e 0 |
| `CommitmentGraphPage` | `/dashboard/commitments` | Y | real: commitments, resolve_commitment(), create_manual_commitment(), get_commitment_trust_scores() | page N · mods 0/1 · db 0/4 · fn 0/0 · e2e 0 |
| `CompanyReflexesPage` | `/dashboard/reflexes` | Y | real: company_reflexes, reflex_steps, reflex_executions, reflex_action_queue, create_reflex() +4 | page N · mods 0/1 · db 0/9 · fn 0/0 · e2e 0 |
| `CompoundingFlywheelPage` | `/dashboard/flywheel` | Y | real: flywheel_snapshots, flywheel_promotions, fn:flywheel-engine | page N · mods 0/1 · db 0/2 · fn 0/1 · e2e 0 |
| `CounterfactualLibraryPage` | `/dashboard/counterfactuals` | Y | real: business_counterfactuals, job_technician_assignments, job_schedule_changes, quotes, generate_technician_dispatch_counterfactual() +2 | page N · mods 0/1 · db 0/7 · fn 0/0 · e2e 0 |
| `CounterfactualRealityEnginePage` | `/dashboard/reality-engine` | Y | real: business_reality_decisions, compute_counterfactual_reality_path() | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `DecisionDebtPage` | `/dashboard/decision-debt` | Y | real: decision_debt_items | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `DemandOsPage` | `/dashboard/demand-os` | Y | real: demand_os_settings, ad_conversion_events, ad_accounts, get_account_owner_id(), demand_os_my_economics() +2 | page N · mods 0/1 · db 0/6 · fn 0/0 · e2e 0 |
| `EconomicAutopilotPage` | `/dashboard/economic-autopilot` | Y | real: economic_snapshots, economic_actions, log_economic_signal(), run_economic_autopilot(), decide_economic_action() +1 | page N · mods 0/1 · db 0/6 · fn 0/0 · e2e 0 |
| `ExecutionReliabilityPage` | `/dashboard/execution-reliability` | Y | real: execution_reliability_events, get_execution_reliability_summary() | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `FieldIntelligencePage` | `/dashboard/field-intelligence` | Y | real: fie_learning_runs, fie_observations, fie_diagnosis_outcomes_v, fie_part_outcomes_v, fie_technician_outcomes_v +6 | page N · mods 0/1 · db 0/11 · fn 0/0 · e2e 0 |
| `IdentityLearnerPage` | `/dashboard/identity-learner` | Y | real: identity_drift_alerts, fn:identity-signal-scan, auth.getSession | page N · mods 0/1 · db 0/1 · fn 0/1 · e2e 0 |
| `LtvAutopilotPage` | `/dashboard/ltv-autopilot` | Y | real: customer_ltv_profiles, automation_installs, recompute_customer_ltv_profiles() | page N · mods 0/1 · db 0/3 · fn 0/0 · e2e 0 |
| `MarketIntelligencePage` | `/dashboard/market-intelligence` | Y | real: market_intelligence_signals, acknowledge_market_signal(), dismiss_market_signal(), promote_signal_to_decision() | page N · mods 0/1 · db 0/4 · fn 0/0 · e2e 0 |
| `OemGraphPage` | `/dashboard/oem-graph` | Y | real: oem_graph_stats, get_oem_graph_fleet(), get_oem_graph_for_equipment() | page N · mods 0/1 · db 0/3 · fn 0/0 · e2e 0 |
| `OperationalEntropyPage` | `/dashboard/entropy` | Y | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `OperationsLoopPage` | `/dashboard/operations-loop` | Y | real: sync_ops_loop_events(), get_ops_loop_snapshot() | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `OpportunityCostLedgerPage` | `/dashboard/opportunity-cost` | Y | real: opportunity_cost_entries, opportunity_cost_summary, fn:opportunity-cost-scan, auth.getSession | page N · mods 0/1 · db 0/2 · fn 0/1 · e2e 0 |
| `OutcomeBenchmarkNetworkPage` | `/dashboard/outcome-benchmarks` | Y | real: outcome_benchmark_settings, get_outcome_benchmark(), get_outcome_drivers(), set_outcome_benchmark_participation(), fn:outcome-benchmark-advisor | page N · mods 0/1 · db 0/4 · fn 0/1 · e2e 0 |
| `OutcomeClearinghousePage` | `/dashboard/outcome-clearinghouse/:recordId?` |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `PhysicalEconomyNetworkPage` | `/dashboard/physical-economy-network` | Y | real: pen_trades, pen_identifiers, pen_ledger_entries, pen_events, pen_offers | page N · mods 0/1 · db 0/5 · fn 0/0 · e2e 0 |
| `PricingFlywheelPage` | `/dashboard/pricing-flywheel` | Y | real: pricing_flywheel_facts, price_book_items, pricing_adjustments, pricing_flywheel_settings, get_pricing_adjustment_results() +3 | page N · mods 0/1 · db 0/8 · fn 0/0 · e2e 0 |
| `RevenueCausalityGraphPage` | `/dashboard/revenue-causality` | Y | real: revenue_causality_snapshots, compute_revenue_causality_graph() | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `SeasonalRevenueStabilizerPage` | `/dashboard/seasonal-stabilizer` | Y | real: seasonal_stabilizer_actions, seasonal_stabilizer_runs, seasonal_deferral_offers, business_twin_scenarios, business_twin_runs +11 | page N · mods 0/2 · db 0/16 · fn 0/0 · e2e 0 |
| `SelfEvolvingModelPage` | `/dashboard/operating-model` | Y | real: operating_policies, evolution_cycles, evolution_proposals, seed_default_operating_policies(), log_operating_observation() +2 | page N · mods 0/1 · db 0/7 · fn 0/0 · e2e 0 |
| `SelfHealingPage` | `/dashboard/self-healing` | Y | real: self_healing_incidents, self_healing_actions | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `ServiceDataExchangePage` | `/dashboard/data-exchange` | Y | real: sde_consent_events, sde_get_overview(), sde_set_consent(), sde_get_intelligence() | page N · mods 0/1 · db 0/4 · fn 0/0 · e2e 0 |
| `ServiceGraphPage` | `/dashboard/service-graph` | Y | real: service_graph_stats(), service_graph_insights(), service_graph_search(), service_graph_neighborhood(), record_service_graph_failure() +1 | page N · mods 0/1 · db 0/6 · fn 0/0 · e2e 0 |
| `ServiceIntelligenceLoopPage` | `/dashboard/service-intelligence-loop` | Y | real: job_outcomes, service_loop_settings, sil_loop_metrics(), sil_get_priors(), sil_verify_my_due_outcomes() | page N · mods 0/1 · db 0/5 · fn 0/0 · e2e 0 |
| `SwitchingShieldPage` | `/dashboard/switching-shield` | Y | real: switching_shield_cases, switching_shield_actions, switching_shield_settings, fn:switching-shield | page N · mods 0/1 · db 0/3 · fn 0/1 · e2e 0 |
| `TechnicianIdentityGraphPage` | `/dashboard/technician-identity` | Y | real: technician_passport_shares, technician_insurance_policies, get_technician_trust_passport(), get_technician_identity_passport(), issue_technician_passport_share() +2 | page N · mods 0/2 · db 0/7 · fn 0/0 · e2e 0 |
| `TemporalRegulationPage` | `/dashboard/regulation-graph` | Y | real: regulation_jurisdictions, regulation_nodes, regulation_versions, regulation_edges, regulation_resolve() +10 | page N · mods 0/1 · db 0/15 · fn 0/0 · e2e 0 |
| `UniversalIdentityPage` | `/dashboard/identity-graph` | Y | real: identity_relationship_types | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `WorkforceEquilibriumPage` | `/dashboard/workforce-equilibrium` | Y | real: workforce_equilibrium_runs, workforce_equilibrium_action_log, fn:workforce-equilibrium-engine, auth.getSession | page N · mods 0/1 · db 0/2 · fn 0/1 · e2e 0 |

## Secondary pages (495)

| Page | Route(s) | Nav | Backend | Tests |
|---|---|:-:|---|---|
| `AIReceptionistVsHumanPage` | `/ai-receptionist-vs-human-receptionist` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `AboutPage` | `/about` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `AcademyCertificatePage` | `/academy/certificate` |  | real: profiles, academy_progress | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `AcademyPage` | `/academy` |  | real: academy_progress, newsletter_subscribers, award_academy_badge_if_complete() | page N · mods 0/2 · db 0/3 · fn 0/0 · e2e 0 |
| `AcceptableUsePage` | `/acceptable-use-policy` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `AccessibilityConformancePage` | `/accessibility/conformance` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `AccessibilityPage` | `/accessibility` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `AccessibilityStatementPage` | `/accessibility-statement` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 1 |
| `AccountingPage` | `/dashboard/accounting` | Y | real: customers, vendors, chart_of_accounts, journal_entries, ar_invoices +11 | page N · mods 0/2 · db 3/16 · fn 0/0 · e2e 0 |
| `AckEscalationPage` | `/ack/:token` |  | real: acknowledge_escalation() | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `AcquisitionDetailPage` | `/dashboard/acquisitions/:id` |  | real: acquisitions, acquisition_workstreams, acquisition_source_controls, acquisition_data_checks, acquisition_synergies +17 | page N · mods 1/2 · db 0/19 · fn 0/1 · e2e 0 |
| `AcquisitionsPage` | `/dashboard/acquisitions` | Y | real: acquisitions, acquisition_workstreams, acquisition_source_controls, acquisition_data_checks, acquisition_synergies +13 | page Y · mods 1/1 · db 0/17 · fn 0/0 · e2e 0 |
| `ActivityLedgerPage` | `/dashboard/activity-ledger` | Y | real: business_activity_events, get_aggregate_history(), append_activity_event() | page N · mods 1/1 · db 0/3 · fn 0/0 · e2e 0 |
| `AdaptiveDiagnosticsPage` | `/dashboard/adaptive-diagnostics` | Y | real: jobs, equipment, adn_symptoms, adn_causes, adn_sessions +14 | page N · mods 0/3 · db 2/17 · fn 0/2 · e2e 0 |
| `AdvancedRoutingPage` | `/dashboard/routing` | Y | real: jobs, team_members, territories, assign_technician_to_job(), find_nearest_technicians() +2 | page N · mods 0/2 · db 1/4 · fn 0/2 · e2e 0 |
| `AffiliatePage` | `/affiliate` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `AgentMarketplacePage` | `/dashboard/agent-marketplace` | Y | real: agent_action_catalog, agent_permissions, agent_spending_limits, agent_action_log, marketplace_scopes +13 | page N · mods 1/2 · db 0/17 · fn 0/1 · e2e 0 |
| `AiDisclosureLedgerPage` | `/dashboard/ai-disclosure-ledger` | Y | real: call_ai_disclosures, ai_disclosure_versions, ai_disclosure_drift_checks, business_profile, ai_disclosure_summary() +1 | page Y · mods 0/1 · db 1/5 · fn 0/1 · e2e 0 |
| `AiDisclosurePage` | `/ai-disclosure` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `AiQualityCenterPage` | `/dashboard/ai-quality` | Y | real: ai_quality_findings, ai_quality_fixes, ai_quality_rules, get_ai_quality_feed(), get_ai_quality_overview() +5 | page N · mods 0/1 · db 0/9 · fn 0/1 · e2e 0 |
| `AiReliabilityPage` | `/dashboard/ai-reliability` | Y | real: ai_decision_records, ai_decision_events, ai_governance_suggestions, get_ai_reliability_metrics(), get_ai_governance_settings() +6 | page N · mods 1/1 · db 0/11 · fn 0/0 · e2e 0 |
| `AiSecurityCenterPage` | `/dashboard/security-center` | Y | real: ai_security_settings, ai_agent_sandbox_policies, ai_security_events, api_keys, security_policies +7 | page N · mods 1/1 · db 0/12 · fn 0/0 · e2e 0 |
| `AiTransparencyPage` | `/dashboard/ai-transparency` | Y | real: get_ai_transparency_registry(), set_ai_transparency_feature(), set_ai_transparency_legal_review(), my_ai_transparency_feature_state(), export_ai_transparency_registry() +1 | page N · mods 0/1 · db 0/6 · fn 0/0 · e2e 0 |
| `AlternativePage` | `/alternatives/:competitor` |  | real: newsletter_subscribers | page Y · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `AmbassadorPage` | `/ambassador` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `AnalyticsPage` | `/dashboard/analytics` | Y | real: calls, jobs, leads, team_members, equipment +8 | page N · mods 1/7 · db 6/12 · fn 0/0 · e2e 0 |
| `ApiReferencePage` | `/developers/api-reference` |  | real: newsletter_subscribers, api_keys, api_request_logs, fn:api-v1 | page N · mods 3/5 · db 0/3 · fn 0/1 · e2e 0 |
| `AskVireekPage` | `/dashboard/ask-vireek` | Y | real: ask_vireek_conversations, ask_vireek_messages, fn:ask-vireek, auth.getSession | page N · mods 0/1 · db 0/2 · fn 0/1 · e2e 0 |
| `AudiencesPage` | `/dashboard/audiences` | Y | real: marketing_segments, leads, customers, lead_scores | page N · mods 1/2 · db 2/4 · fn 0/0 · e2e 0 |
| `AutomationMarketplacePage` | `/dashboard/automation-marketplace` | Y | real: automation_installs | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `BadgePage` | `/badge` |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `BankIntelligencePage` | `/dashboard/bank-intelligence` | Y | real: bank_connections, bank_accounts, bank_transactions, bank_apply_reconciliation(), bank_ignore_transaction() +2 | page N · mods 0/2 · db 0/5 · fn 0/1 · e2e 0 |
| `BenchmarksPage` | `/dashboard/benchmarks` | Y | real: get_benchmark_comparison() | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `BetaProgramPage` | `/beta` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `BlocklistPage` | `/dashboard/blocklist` | Y | real: call_block_rules, call_block_overrides, call_blocklist, dnc_suppressions, call_block_events +2 | page N · mods 1/1 · db 1/7 · fn 0/0 · e2e 0 |
| `BlogPage` | `/blog` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `BlogPostPage` | `/blog/:slug` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `BookingPage` | `/book/:slug` |  | real: newsletter_subscribers, arrival_window_notifications, business_profile, service_areas, gbp_sync_proposals +24 | page N · mods 1/7 · db 5/26 · fn 0/3 · e2e 0 |
| `BottleneckMarketMakerPage` | `/dashboard/bottleneck-market` | Y | real: team_members, jobs, leads, capacity_waitlist_entries, customers +12 | page N · mods 0/3 · db 5/13 · fn 0/2 · e2e 0 |
| `BrandGuidelinesPage` | `/brand` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `BreakCompliancePage` | `/dashboard/break-compliance` | Y | real: time_shifts, break_violation_reviews, break_compliance_options(), my_break_rules(), save_break_compliance_settings() +2 | page N · mods 0/1 · db 0/7 · fn 0/0 · e2e 0 |
| `BudgetsPage` | `/dashboard/budgets` | Y | real: chart_of_accounts, journal_entries, ar_invoices, ap_bills, ensure_default_chart_of_accounts() +15 | page N · mods 1/2 · db 2/20 · fn 0/0 · e2e 0 |
| `BuildingTelemetryPage` | `/dashboard/building-telemetry` | Y | real: telemetry_gateways, telemetry_points, equipment_failure_predictions, customers, jobs +7 | page N · mods 0/2 · db 4/10 · fn 0/2 · e2e 0 |
| `BusinessForecastPage` | `/dashboard/business-forecast` | Y | real: jobs, payment_requests, memberships, quotes, team_members +3 | page N · mods 0/1 · db 2/7 · fn 0/0 · e2e 0 |
| `BusinessRealityPage` | `/dashboard/reality` | Y | real: jobs, price_book_items, job_evidence_checks, payment_requests, quotes +1 | page N · mods 1/1 · db 2/6 · fn 0/0 · e2e 0 |
| `BusinessWorldModelPage` | `/dashboard/world-model` | Y | real: customers, jobs, equipment, job_equipment, calls +7 | page N · mods 1/3 · db 4/10 · fn 0/1 · e2e 0 |
| `CalculatorPage` | `/calculator` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `CalendarFeedsPage` | `/dashboard/calendar-feeds` | Y | real: calendar_feed_overview(), calendar_feed_ensure(), calendar_feed_regenerate(), calendar_feed_update(), fn:calendar-feed | page N · mods 1/2 · db 4/4 · fn 0/1 · e2e 0 |
| `CallMaskingPage` | `/dashboard/call-masking` | Y | real: proxy_numbers, proxy_number_stats, proxy_sessions, proxy_call_events, team_members +6 | page Y · mods 0/1 · db 0/9 · fn 0/1 · e2e 0 |
| `CallQueuePage` | `/dashboard/call-queue` | Y | real: revenue_recovery_events, quotes, invoices, memberships, call_feedback +12 | page N · mods 1/3 · db 2/13 · fn 0/2 · e2e 0 |
| `CallScriptsPage` | `/dashboard/call-scripts` | Y | real: call_scripts, call_script_versions, call_script_assignments, calls, fn:call-script-simulate +1 | page N · mods 0/1 · db 1/4 · fn 0/1 · e2e 0 |
| `CallbackRootCausePage` | `/dashboard/callback-root-cause` | Y | real: jobs, team_members, callback_root_cause_analyses, callback_prevention_workflows | page N · mods 0/1 · db 1/3 · fn 0/0 · e2e 0 |
| `CampaignDetailPage` | `/dashboard/campaigns/:id` |  | real: marketing_campaigns, marketing_campaign_steps, marketing_campaign_enrollments, marketing_campaign_sends, customers +2 | page N · mods 0/1 · db 3/7 · fn 0/0 · e2e 0 |
| `CanvassingPage` | `/dashboard/marketing/canvassing` | Y | real: canvass_territories, canvass_doors, canvass_visits, canvass_reps(), canvass_territory_save() +6 | page Y · mods 0/1 · db 0/11 · fn 0/0 · e2e 0 |
| `CapacityDemandPage` | `/dashboard/capacity-demand` | Y | real: capacity_waitlist_entries, get_or_create_capacity_policy(), update_capacity_demand_policy(), get_capacity_status(), run_capacity_demand_control() +4 | page N · mods 0/1 · db 0/7 · fn 0/1 · e2e 0 |
| `CapacityExchangePage` | `/dashboard/network/capacity-exchange` | Y | real: network_handoffs, network_handoff_contacts, jobs, network_handoff_matches, network_handoff_ratings +3 | page N · mods 1/2 · db 1/8 · fn 0/0 · e2e 0 |
| `CareerPostingPage` | `/careers/:slug` |  | real: newsletter_subscribers, job_postings, job_posting_stats, job_applications, submit_job_application() | page N · mods 0/2 · db 0/5 · fn 0/0 · e2e 0 |
| `CareersPage` | `/careers` |  | real: newsletter_subscribers, job_postings, job_posting_stats, job_applications, submit_job_application() | page N · mods 0/2 · db 0/5 · fn 0/0 · e2e 0 |
| `CaseStudiesPage` | `/case-studies` |  | real: newsletter_subscribers, signature_requests, signature_events, get_signature_request_for_signer(), fn:send-signature-request +1 | page N · mods 0/2 · db 0/4 · fn 0/2 · e2e 0 |
| `CashFlowForecastPage` | `/dashboard/cash-flow` | Y | real: cash_flow_snapshots, cash_flow_fixed_expenses, cash_flow_settings, fn:cash-flow-forecast, auth.getSession | page N · mods 0/1 · db 0/3 · fn 0/1 · e2e 0 |
| `CcpaPage` | `/ccpa` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ChangeOrdersPage` | `/dashboard/change-orders`<br>`/dashboard/change-orders/:changeOrderId` | Y | real: change_orders, change_order_events, jobs, install_projects, invoices +5 | page Y · mods 1/2 · db 2/10 · fn 0/0 · e2e 0 |
| `ChangelogPage` | `/changelog` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ChartOfAccountsPage` | `/dashboard/chart-of-accounts` | Y | real: chart_of_accounts, journal_entries, ar_invoices, ap_bills, accounting_audit_events +20 | page N · mods 1/2 · db 2/25 · fn 0/0 · e2e 0 |
| `ClickToCashAttributionPage` | `/dashboard/click-to-cash` | Y | real: jobs, leads, calls, job_profitability, job_cost_entries +3 | page N · mods 0/3 · db 3/8 · fn 0/0 · e2e 0 |
| `CloseoutBoardPage` | `/dashboard/closeout` | Y | real: closeout_steps, closeout_cases, closeout_programs, closeout_settings, closeout_evidence +6 | page N · mods 1/1 · db 5/10 · fn 0/0 · e2e 0 |
| `CoachingReportsPage` | `/dashboard/coaching-reports` | Y | real: calls, coaching_reports | page N · mods 0/2 · db 1/2 · fn 0/0 · e2e 0 |
| `CollectionsPage` | `/dashboard/collections` | Y | real: collection_actions, run_collections_cycle(), get_collections_overview(), get_collection_cases(), get_collection_actions() +10 | page N · mods 1/1 · db 0/15 · fn 0/0 · e2e 0 |
| `CommandCenterPage` | `/dashboard/command-center` | Y | real: calls, jobs, team_members | page N · mods 0/1 · db 2/2 · fn 0/0 · e2e 0 |
| `CommercialContractsPage` | `/dashboard/contracts` | Y | real: commercial_contracts, customers, contract_sla_breaches, signature_requests, signature_events +3 | page N · mods 0/2 · db 1/6 · fn 0/2 · e2e 0 |
| `CommissionsPage` | `/dashboard/commissions` | Y | real: commission_plans, commission_plan_tiers, commission_records, commission_job_overrides, jobs +21 | page N · mods 0/2 · db 2/26 · fn 0/0 · e2e 0 |
| `CommunityForumPage` | `/dashboard/community` | Y | real: community_categories, community_threads, community_replies, community_votes, create_community_reply() +5 | page N · mods 0/1 · db 0/9 · fn 0/0 · e2e 0 |
| `CommunityPage` | `/community` |  | real: newsletter_subscribers | page N · mods 0/2 · db 0/1 · fn 0/0 · e2e 0 |
| `CommunityThreadPage` | `/dashboard/community/:threadId` |  | real: community_categories, community_threads, community_replies, community_votes, create_community_reply() +5 | page N · mods 0/1 · db 0/9 · fn 0/0 · e2e 0 |
| `ComparePage` | `/compare` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `CompetitorPage` | `/compare/:slug` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ComplianceCenterPage` | `/dashboard/compliance` | Y | real: team_members, technician_credentials, compliance_requirements, equipment, refrigerant_log +1 | page N · mods 1/3 · db 1/5 · fn 0/0 · e2e 0 |
| `ComplianceRulesPage` | `/dashboard/compliance-rules` | Y | real: compliance_profiles, compliance_evaluations, compliance_staff_role() | page Y · mods 1/1 · db 0/3 · fn 0/0 · e2e 0 |
| `ComplianceStatusPage` | `/trust/compliance` |  | real: newsletter_subscribers | page Y · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ContactPage` | `/contact` |  | real: newsletter_subscribers, demo_bookings, get_booked_demo_slot_starts() | page N · mods 0/2 · db 0/3 · fn 0/0 · e2e 0 |
| `ContactSalesPage` | `/contact-sales` |  | real: newsletter_subscribers, demo_bookings, get_booked_demo_slot_starts(), fn:contact-sales | page N · mods 0/3 · db 0/3 · fn 0/1 · e2e 0 |
| `ContentCalendarPage` | `/dashboard/marketing/calendar` | Y | real: email_campaigns | page Y · mods 1/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ContextEnginePage` | `/dashboard/context-engine` | Y | real: jobs, job_context_snapshots, property_context_profiles, fn:job-context-engine | page N · mods 0/2 · db 1/3 · fn 0/1 · e2e 0 |
| `ContinuousImprovementPage` | `/dashboard/continuous-improvement` | Y | real: jobs, team_members, job_parts_readiness, job_mission_briefs, job_outcomes +12 | page N · mods 2/2 · db 1/15 · fn 0/0 · e2e 0 |
| `ContractIntelligencePage` | `/dashboard/contract-intelligence` | Y | real: commercial_contracts, contract_intelligence_profiles, customers, jobs, job_equipment +3 | page N · mods 0/2 · db 2/7 · fn 0/1 · e2e 0 |
| `ConversationIntelligencePage` | `/dashboard/conversations` | Y | real: conversation_intel_settings, conversation_recordings, conversation_insights, conversation_coaching_notes, jobs +8 | page N · mods 0/1 · db 1/10 · fn 0/2 · e2e 0 |
| `CookiePolicyPage` | `/cookies` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `CrmSyncPage` | `/dashboard/crm-sync` | Y | real: crm_connections, crm_sync_runs, crm_sync_log, crm_record_links, crm_deals | page N · mods 0/1 · db 0/5 · fn 0/0 · e2e 0 |
| `CsrDeskPage` | `/dashboard/csr-desk` | Y | real: calls, team_members, csr_call_actions, jobs, quotes +2 | page N · mods 0/1 · db 2/5 · fn 0/1 · e2e 0 |
| `CulturePage` | `/culture` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `CustomFieldsPage` | `/dashboard/custom-fields` | Y | real: custom_field_definitions, delete_custom_field() | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `CustomerIntelligencePage` | `/dashboard/customer-intelligence` | Y | real: customers, jobs | page N · mods 0/1 · db 2/2 · fn 0/0 · e2e 0 |
| `CustomerPortalHistoryPage` | `/portal/:token/history` |  | real: newsletter_subscribers, customers, get_customer_portal_history(), get_portal_language(), get_invoice_language() +1 | page Y · mods 2/3 · db 1/6 · fn 0/0 · e2e 0 |
| `CustomerPortalInventoryPage` | `/portal/:token/inventory` |  | real: newsletter_subscribers, get_portal_home_inventory(), get_customer_portal_history(), fn:portal-home-inventory | page Y · mods 2/3 · db 1/3 · fn 0/1 · e2e 0 |
| `CustomerPortalPage` | `/portal/:token` |  | real: newsletter_subscribers, job_summaries, job_summary_settings, job_photos, loyalty_settings +29 | page N · mods 1/6 · db 1/30 · fn 0/4 · e2e 0 |
| `CustomerRoiPage` | `/roi` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `CustomerStatementsPage` | `/dashboard/statements` | Y | real: statement_schedules, statement_sends, customers, list_statement_accounts(), get_customer_statement() +5 | page Y · mods 1/1 · db 1/9 · fn 0/1 · e2e 0 |
| `CustomerStoriesPage` | — |  | real: newsletter_subscribers | page Y · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `CustomerTrustBankPage` | `/dashboard/trust-bank` | Y | real: customers, customer_trust_events, log_customer_trust_event(), fn:trust-bank-alerts | page N · mods 0/1 · db 1/3 · fn 0/1 · e2e 0 |
| `CustomerTrustLayerPage` | `/dashboard/trust-layer` | Y | real: job_trust_scores, job_trust_events, refresh_job_trust_score(), record_job_trust_event(), get_public_job_trust() +2 | page N · mods 1/1 · db 0/7 · fn 0/0 · e2e 0 |
| `DashboardSnapshotsPage` | `/dashboard/snapshots` | Y | real: dashboard_snapshots, dashboard_snapshot_views, create_dashboard_snapshot(), revoke_dashboard_snapshot(), get_dashboard_snapshot() +1 | page N · mods 0/1 · db 0/6 · fn 0/0 · e2e 0 |
| `DataFabricPage` | `/dashboard/data-fabric` | Y | real: fabric_connections, fabric_records, fabric_overview(), fabric_create_connection(), fabric_update_connection() +4 | page N · mods 1/1 · db 0/8 · fn 0/1 · e2e 0 |
| `DataPlatformPage` | `/dashboard/data-platform` | Y | real: dp_destinations, dp_runs, dp_sync_state, dp_embeds | page N · mods 0/1 · db 0/4 · fn 0/0 · e2e 0 |
| `DataQualityCenterPage` | `/dashboard/data-quality` | Y | real: customers, jobs, leads, equipment, job_equipment +8 | page N · mods 1/2 · db 5/13 · fn 0/0 · e2e 0 |
| `DataRequestPage` | `/data-request` |  | real: newsletter_subscribers, fn:dsar-request | page N · mods 1/2 · db 0/1 · fn 0/1 · e2e 0 |
| `DecisionLedgerPage` | `/dashboard/decision-ledger` | Y | real: team_members, decision_ledger_entries, decision_debt_items, approve_decision_ledger_entry(), reject_decision_ledger_entry() +2 | page N · mods 0/3 · db 0/6 · fn 0/0 · e2e 0 |
| `DemoPage` | `/demo` |  | real: newsletter_subscribers, demo_bookings, get_booked_demo_slot_starts() | page N · mods 0/2 · db 0/3 · fn 0/0 · e2e 0 |
| `DeveloperChangelogPage` | `/developers/changelog` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `DeveloperDocsPage` | `/docs` |  | real: newsletter_subscribers, fn:api-v1 | page N · mods 0/2 · db 0/1 · fn 0/1 · e2e 0 |
| `DiagnosePage` | `/diagnose/:token` |  | real: newsletter_subscribers, diag_sessions, diag_hypotheses, diag_questions, diag_confirm_outcome() +2 | page N · mods 0/2 · db 0/6 · fn 0/1 · e2e 0 |
| `DiagnosisCopilotPage` | `/dashboard/diagnosis-copilot` | Y | real: jobs, equipment, diagnosis_sessions, fn:diagnosis-copilot | page N · mods 0/2 · db 2/3 · fn 0/1 · e2e 0 |
| `DirectMailPage` | `/dashboard/direct-mail` | Y | real: direct_mail_campaigns, direct_mail_pieces, landing_pages, customers, direct_mail_settings_get() +11 | page Y · mods 1/2 · db 12/13 · fn 0/3 · e2e 0 |
| `DisputesPage` | `/dashboard/disputes` | Y | real: payment_requests, stripe_connect_accounts, stripe_disputes, stripe_dispute_evidence_files, stripe_dispute_events +8 | page N · mods 1/2 · db 1/10 · fn 0/3 · e2e 0 |
| `DmcaPage` | `/dmca` |  | real: newsletter_subscribers, submit_dmca_notice() | page Y · mods 1/2 · db 0/2 · fn 0/0 · e2e 0 |
| `DocumentsPage` | `/dashboard/documents` | Y | real: customers, documents, document_versions, check_my_document_expiries(), set_document_homeowner_visible() | page N · mods 0/3 · db 2/5 · fn 0/0 · e2e 0 |
| `DpaPage` | `/dpa` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `DuplicatesPage` | `/dashboard/duplicates` | Y | real: find_duplicate_pairs(), duplicate_counts(), duplicate_related_counts(), merge_records(), unmerge_records() +8 | page Y · mods 2/2 · db 3/13 · fn 0/0 · e2e 0 |
| `DurationIntelligencePage` | `/dashboard/duration-intelligence` | Y | real: job_duration_settings, job_equipment, jobs, job_outcomes, team_members +6 | page N · mods 0/1 · db 1/10 · fn 0/0 · e2e 0 |
| `EmailCampaignsPage` | `/dashboard/email-campaigns` | Y | real: email_campaigns, email_templates, marketing_segments, email_suppressions, email_campaign_links +1 | page Y · mods 2/2 · db 0/5 · fn 0/1 · e2e 0 |
| `EmailUnsubscribePage` | `/email/unsubscribe/:token` |  | real: newsletter_subscribers, fn:email-unsubscribe | page N · mods 0/2 · db 0/1 · fn 0/1 · e2e 0 |
| `EmergencyNetworkPage` | `/dashboard/emergency-network` | Y | real: emergency_incidents, emergency_incident_events, get_emergency_network_settings(), set_emergency_network_settings(), approve_emergency_network_handoff() +3 | page N · mods 1/1 · db 1/7 · fn 0/1 · e2e 0 |
| `EmergencyOperationsPage` | `/dashboard/emergency-ops` | Y | real: business_profile, emergency_triage_queue, emergency_broadcasts, fn:emergency-mode-activate, fn:emergency-ops-broadcast | page N · mods 0/1 · db 1/3 · fn 0/2 · e2e 0 |
| `EmergencyTriagePage` | `/emergency/:token` |  | real: newsletter_subscribers, customers, submit_emergency_triage(), get_portal_language(), get_invoice_language() +1 | page N · mods 1/3 · db 1/6 · fn 0/0 · e2e 0 |
| `EnergyIntelligencePage` | `/dashboard/energy-intelligence` | Y | real: customers, equipment, incentive_programs, rebate_applications, energy_usage_periods +3 | page N · mods 1/2 · db 2/6 · fn 0/2 · e2e 0 |
| `EnterprisePage` | `/enterprise` |  | real: newsletter_subscribers, demo_bookings, get_booked_demo_slot_starts() | page N · mods 0/2 · db 0/3 · fn 0/0 · e2e 0 |
| `EquipmentLifecyclePage` | `/dashboard/equipment-health` | Y | real: equipment_maintenance_alerts, customers, equipment_passport_links, verify_equipment_passport(), get_equipment_passport() +6 | page N · mods 1/2 · db 1/11 · fn 0/0 · e2e 0 |
| `EquipmentPassportDetailPage` | `/dashboard/equipment-passports/:code` |  | real: customers, equipment, equipment_passport_links, technician_passport_shares, technician_insurance_policies +12 | page N · mods 1/3 · db 2/17 · fn 0/0 · e2e 0 |
| `EquipmentPassportsPage` | `/dashboard/equipment-passports` | Y | real: equipment_passport_links, technician_passport_shares, technician_insurance_policies, saved_views, verify_equipment_passport() +12 | page N · mods 2/3 · db 0/17 · fn 0/0 · e2e 0 |
| `EvaluationPlanePage` | `/dashboard/evaluation-plane` | Y | real: eval_plane_policies, eval_plane_decisions, eval_plane_bins(), eval_plane_ai_ops(), save_eval_plane_policy() +1 | page N · mods 1/1 · db 0/6 · fn 0/0 · e2e 0 |
| `EventBusPage` | `/dashboard/event-bus` | Y | real: webhook_endpoints, webhook_logs, send_test_webhook_event() | page N · mods 0/1 · db 0/3 · fn 0/0 · e2e 0 |
| `EventPredictionMeshPage` | `/dashboard/event-prediction-mesh` | Y | real: weather_surge_events, business_profile, equipment, job_outcomes, jobs +12 | page N · mods 0/1 · db 7/15 · fn 0/0 · e2e 0 |
| `EventsPage` | `/events` |  | real: newsletter_subscribers, list_public_events(), fn:event-register | page Y · mods 1/2 · db 0/2 · fn 0/1 · e2e 0 |
| `EvidenceChainPage` | `/dashboard/evidence-chain` | Y | real: jobs, job_evidence_chain_entries, job_evidence_chain_requirements, job_equipment, equipment_passport_links +4 | page N · mods 2/3 · db 1/8 · fn 0/0 · e2e 0 |
| `EvidenceMarketplacePage` | `/dashboard/evidence-marketplace` | Y | real: evidence_sharing_consent, evidence_products, evidence_patterns, evidence_releases, evidence_partners +9 | page N · mods 1/1 · db 0/14 · fn 0/0 · e2e 0 |
| `ExecutiveReportsPage` | `/dashboard/reports/executive` | Y | real: executive_report_settings, executive_reports, fn:executive-report-run, auth.getSession | page Y · mods 1/1 · db 0/2 · fn 0/1 · e2e 0 |
| `ExitDataRoomPublicPage` | `/data-room` |  | real: exit_readiness_settings, exit_addbacks, exit_snapshots, exit_action_states, exit_dataroom_links +14 | page N · mods 0/2 · db 4/18 · fn 0/1 · e2e 0 |
| `ExitReadinessPage` | `/dashboard/exit-readiness` | Y | real: exit_readiness_settings, exit_addbacks, exit_snapshots, exit_action_states, exit_dataroom_links +14 | page N · mods 0/2 · db 4/18 · fn 0/1 · e2e 0 |
| `ExpensesPage` | `/dashboard/expenses` | Y | real: expense_categories, expenses, jobs, fn:expense-receipt-ocr | page N · mods 1/1 · db 1/3 · fn 0/1 · e2e 0 |
| `ExpertAssistInboxPage` | `/dashboard/expert-assist` | Y | real: expert_assist_requests, expert_assist_messages, create_expert_assist_request(), claim_expert_assist_request(), resolve_expert_assist_request() +7 | page N · mods 0/2 · db 0/12 · fn 0/0 · e2e 0 |
| `ExpertAssistThreadPage` | `/dashboard/expert-assist/:requestId` |  | real: expert_assist_requests, expert_assist_messages, get_my_team_member_id(), create_expert_assist_request(), claim_expert_assist_request() +8 | page N · mods 0/3 · db 0/13 · fn 0/0 · e2e 0 |
| `ExportsPage` | `/dashboard/exports` | Y | real: export_jobs, fn:export-run | page N · mods 0/1 · db 0/1 · fn 0/1 · e2e 0 |
| `FAQPage` | `/faq` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `FailureAtlasPage` | `/dashboard/failure-atlas` | Y | real: failure_atlas_stats, failure_atlas_consent, job_outcomes, team_members, get_failure_atlas_index() +3 | page N · mods 1/1 · db 0/7 · fn 0/0 · e2e 0 |
| `FailureGenomePage` | `/dashboard/failure-genome` | Y | real: equipment, failure_genomes, equipment_failure_events, business_profile, diagnosis_sessions +1 | page N · mods 1/1 · db 2/6 · fn 0/0 · e2e 0 |
| `FeatureMatrixPage` | `/compare/matrix` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `FeaturesPage` | `/features` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `FeedbackAnalyticsPage` | `/dashboard/feedback-analytics` | Y | real: jobs, get_feedback_records() | page N · mods 0/1 · db 1/2 · fn 0/0 · e2e 0 |
| `FeedbackPage` | `/dashboard/feedback` | Y | partial: roadmap_items, roadmap_votes ⚠ unresolved: request_marketplace_integration() | page Y · mods 1/1 · db 0/3 · fn 0/0 · e2e 0 |
| `FieldEvidencePage` | — |  | real: jobs, job_evidence_checks, fn:verify-job-evidence | page N · mods 0/2 · db 1/2 · fn 0/1 · e2e 0 |
| `FieldMessagesPage` | `/dashboard/field-messages` | Y | real: job_messages, get_account_owner_id(), get_job_thread_summaries(), mark_job_thread_read(), auth.getUser | page N · mods 2/2 · db 0/3 · fn 0/0 · e2e 0 |
| `FieldScientistPage` | `/dashboard/field-scientist` | Y | real: jobs, job_equipment, team_members, field_hypothesis_events, field_hypotheses +2 | page N · mods 1/1 · db 1/5 · fn 0/1 · e2e 0 |
| `FinancingCenterPage` | `/dashboard/financing` | Y | real: financing_connections, financing_offers, jobs, quotes, financing_offer_events +10 | page N · mods 4/4 · db 2/12 · fn 0/3 · e2e 0 |
| `FinancingOfferPage` | `/financing/:token` |  | real: newsletter_subscribers, financing_connections, financing_offers, get_public_financing_offer(), fn:financing-create-offer | page N · mods 1/2 · db 0/4 · fn 0/1 · e2e 0 |
| `FindingsPackagePublicPage` | `/findings/:token` |  | real: newsletter_subscribers, estimate_templates, quote_events, findings_packages, findings_package_items +17 | page N · mods 2/6 · db 1/21 · fn 0/1 · e2e 0 |
| `FindingsPackagesPage` | `/dashboard/findings`<br>`/dashboard/findings/:id` | Y | real: findings_packages, findings_package_items, jobs, job_photos, expert_assist_requests +13 | page N · mods 1/4 · db 1/17 · fn 0/1 · e2e 0 |
| `FirstTimeFixAutopilotPage` | `/dashboard/first-time-fix` | Y | real: jobs, team_members, review_requests, diagnosis_sessions, job_equipment +23 | page N · mods 1/2 · db 9/27 · fn 0/0 · e2e 0 |
| `FixedAssetsPage` | `/dashboard/fixed-assets`<br>`/accounting/fixed-assets` | Y | real: chart_of_accounts, journal_entries, ar_invoices, ap_bills, accounting_audit_events +32 | page Y · mods 2/3 · db 2/37 · fn 0/0 · e2e 0 |
| `FleetDvirPage` | `/dashboard/fleet-dvir` | Y | real: team_members, dvir_checklist_items, vehicles, vehicle_faults, vehicle_inspections +5 | page N · mods 1/2 · db 0/8 · fn 0/0 · e2e 0 |
| `FleetEconomicsPage` | `/dashboard/fleet-economics` | Y | real: vehicles, vehicle_job_profitability, vehicle_expenses, fn:compute-fleet-economics | page N · mods 0/1 · db 0/3 · fn 0/1 · e2e 0 |
| `FleetIntelligencePage` | `/dashboard/fleet-intelligence` | Y | real: vehicles, fleet_intelligence_profiles, fleet_trip_intelligence, vehicle_safety_events, vehicle_diagnostics +5 | page N · mods 1/1 · db 0/7 · fn 0/2 · e2e 0 |
| `FormBuilderPage` | `/dashboard/form-builder` | Y | real: field_form_templates, save_field_form_template(), set_field_form_active(), delete_field_form_template() | page N · mods 1/1 · db 0/4 · fn 0/0 · e2e 0 |
| `FranchiseCommandCenterPage` | `/dashboard/franchise` | Y | real: franchise_groups, franchise_locations, get_pending_franchise_invites(), get_franchise_dashboard_stats(), respond_to_franchise_invite() | page N · mods 0/1 · db 0/5 · fn 0/0 · e2e 0 |
| `FranchiseGovernancePage` | `/dashboard/franchise/governance` | Y | real: franchise_groups, franchise_locations, franchise_price_policies, franchise_territories, franchise_requirements +9 | page N · mods 0/2 · db 0/13 · fn 0/1 · e2e 0 |
| `FuelCardsPage` | `/dashboard/fuel-cards` | Y | real: fuel_cards, fuel_card_settings, vehicles, fuel_transactions, fuel_anomalies +9 | page N · mods 0/1 · db 0/14 · fn 0/0 · e2e 0 |
| `GalleryPage` | `/dashboard/gallery` | Y | real: job_photos, jobs, pair_job_photos(), unpair_job_photo() | page N · mods 0/1 · db 1/4 · fn 0/0 · e2e 0 |
| `GdprDpaPage` | `/gdpr-dpa` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `GiftCardsPage` | `/dashboard/gift-cards` | Y | real: invoices, gift_cards, gift_card_transactions, create_invoice_from_quote(), get_invoice_for_token() +13 | page N · mods 4/4 · db 0/18 · fn 0/0 · e2e 0 |
| `GlossaryPage` | `/glossary` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `GoalOrchestratorPage` | `/dashboard/goals` | Y | real: strategic_goals, goal_strategies, goal_actions, fn:goal-decomposition-orchestrator | page N · mods 0/1 · db 0/3 · fn 0/1 · e2e 0 |
| `GoogleBookingPage` | `/dashboard/google-booking` | Y | real: service_areas, gbp_sync_proposals, get_google_structured_data(), get_google_booking_settings(), update_google_booking_settings() +4 | page N · mods 1/1 · db 1/7 · fn 0/2 · e2e 0 |
| `HelpArticlePage` | `/help/:slug` |  | real: newsletter_subscribers, submit_help_feedback() | page Y · mods 0/2 · db 0/2 · fn 0/0 · e2e 0 |
| `HelpCenterPage` | `/help` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `HiddenTechnicianPage` | `/dashboard/hidden-technician` | Y | real: ht_settings, team_members, telematics_job_visits, jobs, capacity_waitlist_entries +5 | page N · mods 0/1 · db 1/9 · fn 0/0 · e2e 0 |
| `HomeCapitalPlanPage` | `/dashboard/homes/:siteId/capital-plan` |  | real: home_capital_actions, home_capital_plans, customers, quotes, jobs +14 | page N · mods 2/5 · db 3/16 · fn 0/1 · e2e 0 |
| `HomeDemandExchangePage` | `/dashboard/demand-exchange` | Y | real: home_demand_opportunities, customers, equipment, equipment_failure_predictions, weather_surge_events +16 | page N · mods 1/3 · db 3/19 · fn 0/0 · e2e 0 |
| `HomeHealthPage` | `/dashboard/home-health` | Y | real: customers, home_health_scores, home_health_actions, dismiss_home_health_action(), fn:home-health-agent | page N · mods 0/2 · db 1/4 · fn 0/1 · e2e 0 |
| `HomeLifetimeGraphPage` | `/dashboard/homes/:siteId` |  | real: agent_action_catalog, agent_permissions, agent_spending_limits, agent_action_log, customer_sites +14 | page N · mods 1/4 · db 3/18 · fn 0/0 · e2e 0 |
| `HomePage` | `/` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 1 |
| `HomePassportNetworkPage` | `/dashboard/homes/:siteId/passport` |  | real: job_evidence_chain_entries, job_evidence_chain_requirements, equipment_passport_links, job_outcomes, equipment +34 | page N · mods 4/6 · db 3/34 · fn 0/3 · e2e 0 |
| `HomeServicePassportPage` | `/dashboard/home-passport` | Y | real: customers, equipment, jobs, customer_sites, job_equipment +8 | page N · mods 2/3 · db 3/13 · fn 0/0 · e2e 0 |
| `HoursAuditPage` | `/dashboard/hours-audit` | Y | real: hours_audit_templates | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `HrOnboardingPage` | `/dashboard/hr` | Y | real: employees, hr_onboarding_templates, hr_onboarding_template_items, hr_onboardings, hr_onboarding_tasks +5 | page N · mods 0/1 · db 10/10 · fn 0/0 · e2e 0 |
| `InHomeSalesPage` | `/dashboard/sales` | Y | real: estimate_templates, quote_events, financing_connections, financing_offers, job_photos +16 | page N · mods 3/5 · db 1/17 · fn 0/4 · e2e 0 |
| `IncentiveEnginePage` | `/dashboard/incentives` | Y | real: quotes, incentive_assessments, incentive_programs, quote_truth_settings, quote_competitor_benchmarks +6 | page N · mods 1/4 · db 0/9 · fn 0/2 · e2e 0 |
| `IndustriesPage` | `/industries` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `IndustryPage` | `/industries/:slug` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `InsightsPage` | `/dashboard/insights` | Y | real: ai_insights, business_profile, vertical_intelligence_signals, fn:generate-insights | page N · mods 0/2 · db 1/3 · fn 0/1 · e2e 0 |
| `InsightsPublicPage` | `/insights` |  | real: newsletter_subscribers, insights_settings, insights_consent_log, insights_public_periods(), insights_public_indexes() +3 | page N · mods 0/2 · db 5/8 · fn 0/0 · e2e 0 |
| `InsightsSettingsPage` | `/dashboard/insights` | Y | real: insights_settings, insights_consent_log, insights_public_periods(), insights_public_indexes(), insights_member_indexes() +2 | page N · mods 0/1 · db 5/7 · fn 0/0 · e2e 0 |
| `InspectionReportPublicPage` | `/inspection/:token` |  | real: newsletter_subscribers, fn:inspection-reports, fn:inspection-report-public | page N · mods 1/2 · db 0/1 · fn 0/2 · e2e 0 |
| `InspectionReportsPage` | `/dashboard/inspection-reports`<br>`/dashboard/inspection-reports/:id` | Y | real: signature_requests, signature_events, get_signature_request_for_signer(), fn:inspection-reports, fn:inspection-report-public +2 | page N · mods 1/2 · db 0/3 · fn 0/4 · e2e 0 |
| `InstallCloseoutPage` | `/dashboard/install-closeout` | Y | real: closeout_evidence, closeout_steps, closeout_cases, closeout_programs, closeout_settings +6 | page N · mods 1/2 · db 5/10 · fn 0/0 · e2e 0 |
| `InstallProjectsPage` | `/dashboard/projects`<br>`/dashboard/projects/:projectId` | Y | real: invoices, install_projects, install_project_phases, install_project_milestones, install_project_billing +7 | page N · mods 0/1 · db 5/12 · fn 0/0 · e2e 0 |
| `InsuranceClaimsPage` | `/dashboard/insurance-claims` | Y | real: insurance_claims, leads, jobs, signature_requests, signature_events +3 | page N · mods 0/2 · db 2/6 · fn 0/2 · e2e 0 |
| `IntegrationDetailPage` | `/integrations/:slug` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `IntegrationsHubPage` | `/integrations` |  | partial: newsletter_subscribers, roadmap_items, roadmap_votes ⚠ unresolved: request_marketplace_integration() | page N · mods 1/2 · db 0/4 · fn 0/0 · e2e 0 |
| `InventoryCountsPage` | `/dashboard/inventory/counts` | Y | real: inventory_counts, inventory_count_events, inventory_count_options(), get_inventory_count_lines(), start_inventory_count() +7 | page N · mods 1/1 · db 3/12 · fn 0/0 · e2e 0 |
| `InventoryPage` | `/dashboard/inventory` | Y | real: inventory_locations, inventory_parts, parts_availability, low_stock_alerts, job_parts_readiness +17 | page N · mods 1/2 · db 5/22 · fn 0/0 · e2e 0 |
| `InvisibleRevenueMapPage` | `/dashboard/revenue-map` | Y | real: equipment_maintenance_alerts, jobs, customers, referral_codes, equipment +9 | page N · mods 0/2 · db 3/12 · fn 0/1 · e2e 0 |
| `InviteAcceptPage` | `/invite/:token` |  | real: newsletter_subscribers, get_invite_for_token(), accept_team_invite() | page N · mods 0/2 · db 0/3 · fn 0/0 · e2e 0 |
| `JobAutopsyPage` | `/dashboard/job-autopsy` | Y | real: job_autopsy_candidates, job_autopsy_reports | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `JobBoardOfferPage` | `/job-board/offer/:token` |  | real: job_board_posts, job_board_recipients, job_board_bids, job_board_events, jobs +2 | page N · mods 1/1 · db 2/6 · fn 0/0 · e2e 0 |
| `JobBoardPage` | `/dashboard/job-board` | Y | real: job_board_posts, job_board_recipients, job_board_bids, job_board_events, jobs +2 | page N · mods 1/1 · db 2/6 · fn 0/0 · e2e 0 |
| `JobQualityGateSettingsPage` | `/dashboard/job-quality-gate` | Y | real: jobs, job_quality_checklist_templates, job_checklist_completions, job_quality_requirements, job_quality_gate_report() | page N · mods 0/2 · db 1/5 · fn 0/0 · e2e 0 |
| `JobSummariesPage` | `/dashboard/job-summaries` | Y | real: job_summaries, job_summary_settings, job_photos, get_portal_job_summaries(), fn:job-summary-engine +1 | page N · mods 0/1 · db 0/4 · fn 0/2 · e2e 0 |
| `JobSummaryPublicPage` | `/summary/:token` |  | real: newsletter_subscribers, job_summaries, job_summary_settings, job_photos, get_portal_job_summaries() +2 | page N · mods 0/2 · db 0/5 · fn 0/2 · e2e 0 |
| `JobTemplatesPage` | `/dashboard/job-templates` | Y | real: inventory_parts, price_book_items, job_templates, job_checklist_items, save_job_template() +3 | page N · mods 1/2 · db 2/8 · fn 0/0 · e2e 0 |
| `JoinMembershipPage` | `/join/:planSlug` |  | real: newsletter_subscribers, get_public_membership_plan(), fn:membership-join-checkout | page N · mods 1/2 · db 0/2 · fn 0/1 · e2e 0 |
| `KnowledgeBasePage` | `/dashboard/knowledge` | Y | real: knowledge_articles, knowledge_article_versions, knowledge_gaps, knowledge_manual_uploads, import_faqs_to_knowledge() +6 | page N · mods 0/1 · db 0/7 · fn 0/4 · e2e 0 |
| `KnowledgeCapturePage` | `/dashboard/knowledge-capture` | Y | real: kce_rules, kce_evidence, kce_rule_versions, kce_captures, kce_get_overview() +11 | page N · mods 0/1 · db 0/14 · fn 0/1 · e2e 0 |
| `LaborMarketplacePage` | `/dashboard/labor-marketplace` | Y | real: profiles, labor_marketplace_listings, labor_marketplace_matches | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `LandingPagesPage` | `/dashboard/landing-pages` | Y | real: landing_pages, landing_domains, get_landing_page_analytics(), get_landing_utm_breakdown(), get_landing_daily_series() +5 | page N · mods 0/1 · db 1/9 · fn 0/1 · e2e 0 |
| `LeadAssignmentPage` | `/dashboard/lead-assignment` | Y | real: lead_assignment_settings, team_members, lead_assignment_agents, lead_assignment_rules, lead_assignment_rule_agents +4 | page N · mods 1/1 · db 8/8 · fn 0/0 · e2e 0 |
| `LeadMarketplacesPage` | `/dashboard/lead-marketplaces` | Y | real: lead_marketplace_sources, lead_marketplace_events, lead_marketplace_cost_report(), fn:lead-marketplace-ingest | page N · mods 1/1 · db 0/3 · fn 0/1 · e2e 0 |
| `LeadQualificationPage` | `/features/lead-qualification` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `LeadershipPage` | `/leadership` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `LeakReportPage` | `/dashboard/leak-report` | Y | real: leak_report_settings, leak_report_sources, leak_report_call_events, calls, business_profile +7 | page N · mods 1/2 · db 3/11 · fn 0/1 · e2e 0 |
| `LearningCompilerPage` | `/dashboard/learning-compiler` | Y | real: job_outcomes, team_members, learned_policies, learned_policy_events, record_learning_run() +2 | page N · mods 0/1 · db 0/6 · fn 0/0 · e2e 0 |
| `LifecycleTouchesPage` | `/dashboard/lifecycle` | Y | real: marketing_campaigns, marketing_campaign_steps, lifecycle_touch_settings, lifecycle_touch_log, customer_lifecycle_profiles +5 | page N · mods 0/1 · db 5/10 · fn 0/0 · e2e 0 |
| `ListingsPage` | `/dashboard/listings` | Y | real: fn:listings | page N · mods 1/1 · db 0/0 · fn 0/1 · e2e 0 |
| `LiveCallsPage` | `/dashboard/live-calls` | Y | real: jobs, live_calls, live_call_lines, phone_payment_sessions, phone_payment_audit_events +4 | page N · mods 1/3 · db 6/6 · fn 0/2 · e2e 0 |
| `LiveCopilotPage` | `/dashboard/live-copilot` | Y | real: jobs, equipment, diagnosis_sessions, expert_assist_requests, expert_assist_messages +8 | page N · mods 0/5 · db 2/10 · fn 0/3 · e2e 0 |
| `LiveEscalationPage` | — |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `LiveMapPage` | `/dashboard/live-map` | Y | real: vehicles, vehicle_live_state, team_members, jobs, telematics_connections +3 | page N · mods 0/2 · db 1/7 · fn 0/0 · e2e 0 |
| `LocationCityPage` | `/locations/:city` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `LocationPrivacyPage` | `/dashboard/location-privacy` | Y | real: location_consent_log, get_location_privacy(), save_location_privacy(), get_location_consent_overview(), record_location_consent() +1 | page N · mods 1/1 · db 0/6 · fn 0/0 · e2e 0 |
| `LocationTradePage` | `/locations/:city/:trade` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `LocationsPage` | `/locations` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `LoyaltyPage` | `/dashboard/loyalty` | Y | real: loyalty_settings, loyalty_tiers, loyalty_earn_rules, loyalty_rewards, loyalty_member_summary +16 | page N · mods 0/2 · db 1/21 · fn 0/0 · e2e 0 |
| `MailerRedirectPage` | `/m/:code` |  | real: landing_pages, landing_domains, direct_mail_resolve_scan(), get_landing_page_analytics(), get_landing_utm_breakdown() +7 | page N · mods 1/3 · db 2/10 · fn 0/2 · e2e 0 |
| `MaintenancePage` | `/maintenance` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ManifestoPage` | `/manifesto` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `MarginGuardrailsPage` | `/dashboard/margin-guardrails` | Y | real: business_profile, margin_guardrail_checks | page N · mods 0/1 · db 1/2 · fn 0/0 · e2e 0 |
| `MarketingPage` | `/dashboard/marketing` | Y | real: marketing_segments, marketing_campaigns, lead_scores, referral_codes | page N · mods 0/1 · db 0/4 · fn 0/0 · e2e 0 |
| `MarketplacePage` | `/marketplace` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `MembershipRenewalsPage` | `/dashboard/memberships/renewals` | Y | real: memberships, membership_renewal_cycles, get_membership_renewal_kpis(), get_membership_renewal_for_token(), respond_to_membership_renewal() | page N · mods 1/2 · db 0/5 · fn 0/0 · e2e 0 |
| `MembershipsPage` | `/dashboard/memberships` | Y | real: membership_plans, memberships | page N · mods 0/2 · db 0/2 · fn 0/0 · e2e 0 |
| `MoneyRecoveredStatementsPage` | `/dashboard/recovery/statements` | Y | real: executive_report_settings, executive_reports, money_recovered_settings, money_recovered_baselines, money_recovered_statements +5 | page N · mods 2/2 · db 1/7 · fn 0/2 · e2e 0 |
| `MsaPage` | `/msa` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `MutualAidPage` | `/dashboard/mutual-aid` | Y | real: business_profile, mutual_aid_requests, mutual_aid_offers, get_open_mutual_aid_requests(), fn:mutual-aid-notify | page N · mods 0/1 · db 1/4 · fn 0/1 · e2e 0 |
| `NegativeKnowledgeStorePage` | `/dashboard/negative-knowledge` | Y | real: negative_knowledge_entries, check_negative_knowledge(), record_negative_knowledge_match() | page N · mods 1/1 · db 0/3 · fn 0/0 · e2e 0 |
| `NeighborhoodRevenuePage` | `/dashboard/neighborhood-revenue` | Y | real: neighborhood_campaigns, neighborhood_opportunities, neighborhood_opportunities_overview(), neighborhood_nearby_properties(), neighborhood_campaign_results() | page N · mods 0/1 · db 0/5 · fn 0/0 · e2e 0 |
| `NetworkHandoffsPage` | `/dashboard/network/handoffs` | Y | real: network_handoffs, network_handoff_contacts, jobs, network_handoff_matches, network_handoff_ratings | page N · mods 0/1 · db 1/5 · fn 0/0 · e2e 0 |
| `NetworkHubPage` | `/dashboard/network` | Y | real: network_handoffs, network_handoff_contacts, jobs, network_handoff_matches, network_handoff_ratings | page N · mods 0/1 · db 1/5 · fn 0/0 · e2e 0 |
| `NextBestActionsPage` | `/dashboard/next-best-actions` | Y | real: next_best_actions, cadence_settings, cadence_snapshots, cadence_targets, cadence_priorities +11 | page N · mods 0/2 · db 1/14 · fn 0/2 · e2e 0 |
| `NoSurpriseApprovePage` | `/approve/:token` |  | real: newsletter_subscribers, no_surprise_requests, no_surprise_expire_job(), no_surprise_job_status(), get_no_surprise_room() +2 | page N · mods 0/2 · db 0/6 · fn 0/1 · e2e 0 |
| `NotFoundPage` | `*` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `NotificationRoutingPage` | `/dashboard/notification-routing` | Y | real: team_members, notification_routing_rules, notification_deliveries, notifications, on_call_schedules +4 | page N · mods 0/2 · db 2/7 · fn 0/1 · e2e 0 |
| `NotificationsPage` | `/dashboard/notifications` |  | real: notifications | page N · mods 0/1 · db 1/1 · fn 0/0 · e2e 0 |
| `OfflinePage` | `/offline` |  | partial: get_field_form_templates(), auth.getSession ⚠ unresolved: job_field_artifacts, sync_technician_batch(), get_technician_offline_bundle() | page N · mods 1/3 · db 0/4 · fn 0/0 · e2e 0 |
| `OnCallPage` | `/dashboard/on-call` | Y | real: on_call_schedules, on_call_schedule_members, team_members, escalation_tiers, escalation_events +1 | page N · mods 0/1 · db 2/5 · fn 0/0 · e2e 0 |
| `OnboardingGuidePage` | `/onboarding-guide` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `OpenVoiceBenchmarkPage` | `/open-voice-benchmark` |  | real: newsletter_subscribers, fn:ovb-public, fn:ovb-run | page N · mods 1/2 · db 0/1 · fn 0/2 · e2e 0 |
| `OperatingCadencePage` | `/dashboard/cadence` | Y | real: cadence_settings, cadence_snapshots, cadence_targets, cadence_priorities, strategic_goals +16 | page N · mods 0/3 · db 4/18 · fn 0/2 · e2e 0 |
| `OperationalTruthPage` | `/dashboard/operational-truth` | Y | real: truth_policies, team_members, fn:operational-truth | page N · mods 0/1 · db 0/1 · fn 0/1 · e2e 0 |
| `OperationsCenterPage` | `/dashboard/operations-center` | Y | real: team_members, operations_center_problems, decision_debt_items, record_ops_problem_root_cause(), assign_ops_problem_action_owner() +3 | page N · mods 0/3 · db 0/7 · fn 0/0 · e2e 0 |
| `OperationsSandboxPage` | `/dashboard/operations-sandbox` | Y | real: jobs, team_members, calls, job_outcomes, invoices +2 | page N · mods 0/1 · db 2/6 · fn 0/0 · e2e 0 |
| `OpsExperimentsPage` | `/dashboard/experiments` | Y | real: ops_experiments, ops_experiment_assignments, jobs, team_members | page N · mods 0/1 · db 1/3 · fn 0/0 · e2e 0 |
| `OrganizationalMemoryPage` | `/dashboard/org-memory` | Y | real: org_memory_entries, team_members, search_org_memory(), get_org_memory_summary(), increment_memory_endorsement() | page N · mods 0/1 · db 0/4 · fn 0/0 · e2e 0 |
| `OutboundCampaignsPage` | `/dashboard/outbound-campaigns` | Y | real: outbound_campaigns, outbound_calls, leads, jobs | page N · mods 0/1 · db 2/4 · fn 0/0 · e2e 0 |
| `OutcomeAssurancePage` | `/dashboard/outcome-assurance` | Y | real: jobs, team_members, job_parts_readiness, job_mission_briefs, job_outcomes +10 | page N · mods 1/1 · db 1/13 · fn 0/0 · e2e 0 |
| `OutcomeIntelligenceNetworkPage` | `/dashboard/outcome-network` | Y | real: business_profile, oin_taxonomy, oin_settings, oin_case_records, equipment +7 | page N · mods 0/1 · db 3/12 · fn 0/0 · e2e 0 |
| `OutcomePricingPage` | `/dashboard/outcome-pricing` | Y | real: decision_debt_items, outcome_pricing_settings, customers, equipment, outcome_guarantee_quotes +10 | page N · mods 0/2 · db 2/15 · fn 0/0 · e2e 0 |
| `OutcomeVerifyPage` | `/outcome/:token` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `PartnerApplyPage` | `/partner-portal/apply` |  | real: partners, newsletter_subscribers, apply_for_partner_program() | page N · mods 0/2 · db 0/3 · fn 0/0 · e2e 0 |
| `PartnerCertificatePage` | `/partner-portal/certificate` |  | real: partners, partner_certifications | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `PartnerPortalCertificationPage` | `/partner-portal/certification` |  | real: partner_academy_progress, partner_certifications, record_partner_certification() | page N · mods 0/1 · db 0/3 · fn 0/0 · e2e 0 |
| `PartnerPortalDashboardPage` | `/partner-portal` |  | real: get_partner_dashboard_stats() | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `PartnerPortalReferralsPage` | `/partner-portal/referrals` |  | real: partners, partner_referrals | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `PartnerPortalResourcesPage` | `/partner-portal/resources` |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `PartnerReferralRedirectPage` | `/r/:code` |  | real: track_referral_click(), record_partner_click() | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `PartnersPage` | `/partners` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `PartsIntelligencePage` | `/dashboard/parts-intelligence` | Y | real: inventory_parts, parts_market_sources, parts_market_live_offers, parts_market_offers, parts_market_price_history +47 | page N · mods 4/5 · db 8/51 · fn 0/0 · e2e 0 |
| `PartsMarketPage` | `/dashboard/parts-market` | Y | real: inventory_parts, parts_market_sources, parts_market_live_offers, parts_market_offers, parts_market_price_history +38 | page N · mods 3/3 · db 6/42 · fn 0/0 · e2e 0 |
| `PayByBankPage` | — |  | real: bank_payment_settings, bank_payment_attempts, get_bank_payment_stats(), set_bank_payment_settings(), list_linkable_invoices() +3 | page N · mods 1/1 · db 4/7 · fn 0/1 · e2e 0 |
| `PayCapitalPage` | `/dashboard/pay` | Y | real: pay_transfers, pay_runs, spend_cards, card_transactions, capital_applications +30 | page N · mods 1/3 · db 4/34 · fn 0/1 · e2e 0 |
| `PaymentPlansPage` | `/dashboard/payment-plans` | Y | real: payment_requests, stripe_connect_accounts, payment_plans, payment_plan_events, jobs +9 | page N · mods 1/2 · db 3/11 · fn 0/3 · e2e 0 |
| `PayrollPage` | `/dashboard/payroll` | Y | real: employees, timesheets, commission_records, pay_runs, pay_run_items +5 | page N · mods 0/1 · db 1/10 · fn 0/0 · e2e 0 |
| `PerDiemPage` | `/dashboard/per-diem` | Y | real: chart_of_accounts, journal_entries, ar_invoices, ap_bills, expense_categories +25 | page N · mods 3/4 · db 3/29 · fn 0/1 · e2e 0 |
| `PermitCenterPage` | `/dashboard/permits` | Y | real: permit_applications, permit_application_events, permit_inspections, permit_authorities, job_compliance_reviews +11 | page N · mods 2/2 · db 0/14 · fn 0/2 · e2e 0 |
| `PermitIntelligencePage` | `/dashboard/permit-intelligence` | Y | real: job_compliance_reviews, customer_sites, warranty_claims, customers, team_members +26 | page N · mods 3/5 · db 3/29 · fn 0/1 · e2e 0 |
| `PhonePaymentsPage` | — |  | real: phone_payment_sessions, phone_payment_audit_events, verify_phone_payment_audit_chain(), fn:phone-payment-control, auth.getSession | page N · mods 1/1 · db 3/3 · fn 0/1 · e2e 0 |
| `PlatformPage` | `/platform` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `PlaybooksPage` | `/dashboard/playbooks` | Y | real: business_profile, playbook_applications, knowledge_articles | page N · mods 0/1 · db 1/3 · fn 0/0 · e2e 0 |
| `PodcastPage` | `/podcast` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `PowerDialerPage` | `/dashboard/power-dialer`<br>`/dashboard/power-dialer/:campaignId` | Y | real: dialer_campaigns, dialer_campaign_stats, phone_numbers, dialer_contacts, dialer_import_contacts() +5 | page Y · mods 0/1 · db 0/9 · fn 0/1 · e2e 0 |
| `PredictiveFailurePage` | `/dashboard/predictive-failure` | Y | real: pfn_forecasts, pfn_settings, pfn_equipment_profiles, pfn_my_stats(), pfn_dismiss_forecast() +3 | page N · mods 0/1 · db 0/6 · fn 0/2 · e2e 0 |
| `PreferencesPage` | `/preferences/:token` |  | real: newsletter_subscribers, get_customer_preferences(), update_customer_preferences(), ensure_customer_preference_token() | page N · mods 0/2 · db 0/4 · fn 0/0 · e2e 0 |
| `PressPage` | `/press` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `PrevailingWagePage` | `/dashboard/prevailing-wage` | Y | real: pw_wage_determinations, pw_wage_rates, pw_overtime_rule_sets, jobs, employees +10 | page N · mods 0/1 · db 2/15 · fn 0/0 · e2e 0 |
| `PreventiveMaintenanceCommandCenterPage` | `/dashboard/preventive-maintenance` | Y | real: pfn_forecasts, pfn_settings, pfn_equipment_profiles, equipment, pm_work_items +27 | page N · mods 1/3 · db 5/28 · fn 0/3 · e2e 0 |
| `PriceAccuracyPage` | `/dashboard/price-accuracy` | Y | real: calls, price_lookup_log | page N · mods 0/2 · db 1/2 · fn 0/0 · e2e 0 |
| `PriceBookPage` | `/dashboard/price-book` | Y | real: price_book_items, get_price_book_connections(), fn:price-book-connect-servicetitan, fn:jobber-oauth-start, fn:price-book-connect-housecallpro +1 | page N · mods 0/1 · db 0/2 · fn 0/4 · e2e 0 |
| `PriceListsPage` | `/dashboard/price-lists` | Y | real: price_lists, price_list_items, price_book_items, commercial_contracts, membership_plans +2 | page N · mods 1/1 · db 1/7 · fn 0/0 · e2e 0 |
| `PricingPage` | `/pricing` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 1 |
| `PrivacyPage` | `/privacy` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ProcurementNetworkPage` | `/dashboard/procurement-network` | Y | real: pn_memberships, pn_orders, pn_order_lines, pn_order_savings, pn_rebates +8 | page N · mods 0/1 · db 11/13 · fn 0/0 · e2e 0 |
| `ProcurementPage` | `/dashboard/procurement` | Y | real: vendors, vendor_scorecard, purchase_requests, procurement_pipeline, rfqs +11 | page N · mods 1/1 · db 1/15 · fn 0/0 · e2e 0 |
| `ProfitabilityPage` | `/dashboard/profitability` | Y | real: team_members, price_book_items, job_profitability, job_cost_entries, vendor_bills +9 | page N · mods 1/3 · db 0/11 · fn 0/2 · e2e 0 |
| `ProjectProgressPage` | `/project/:token` |  | real: newsletter_subscribers, team_members, install_project_shares, work_order_visits, jobs +19 | page Y · mods 1/3 · db 10/23 · fn 0/0 · e2e 0 |
| `PromiseTrackerPage` | `/dashboard/promises` | Y | real: promises | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `PropertyManagementPage` | `/dashboard/property-management` | Y | real: pm_connections, pm_sync_runs, pm_sync_log, pm_sync_queue, pm_units +3 | page N · mods 0/1 · db 1/7 · fn 0/1 · e2e 0 |
| `PropertyVisionPage` | `/dashboard/property-vision` | Y | real: customers, property_assets, property_findings, property_events, property_capture_assets +2 | page N · mods 0/2 · db 1/5 · fn 0/1 · e2e 0 |
| `ProtectionPlansPage` | `/dashboard/protection-plans` | Y | real: protection_plan_templates, protection_contracts, warranty_claims, invoices, quotes +5 | page N · mods 1/1 · db 2/10 · fn 0/0 · e2e 0 |
| `PublicChangeOrderPage` | `/change-order/:token` |  | real: change_orders, change_order_events, jobs, install_projects, invoices +5 | page Y · mods 1/2 · db 2/10 · fn 0/0 · e2e 0 |
| `PublicEquipmentPassportPage` | `/e/:code` |  | real: newsletter_subscribers, equipment_passport_links, technician_passport_shares, technician_insurance_policies, verify_equipment_passport() +11 | page N · mods 1/3 · db 0/16 · fn 0/0 · e2e 0 |
| `PublicHomePassportPage` | `/verify/home/:token`<br>`/h/:code` |  | real: newsletter_subscribers, equipment, jobs, customer_sites, job_equipment +8 | page N · mods 2/3 · db 2/13 · fn 0/0 · e2e 0 |
| `PublicLandingPage` | `/lp/:slug` |  | real: landing_pages, landing_domains, get_business_for_booking(), get_booking_window_slots(), create_public_booking() +9 | page N · mods 0/2 · db 1/13 · fn 0/1 · e2e 0 |
| `PublicProtectionPlanPage` | `/protection/:token` |  | real: protection_plan_templates, protection_contracts, warranty_claims, invoices, quotes +5 | page N · mods 1/1 · db 2/10 · fn 0/0 · e2e 0 |
| `PublicTagPage` | `/t/:token` |  | real: newsletter_subscribers, equipment_passport_links, technician_passport_shares, technician_insurance_policies, verify_equipment_passport() +21 | page N · mods 2/4 · db 8/26 · fn 0/0 · e2e 0 |
| `PublicTechnicianPassportPage` | `/verify/technician/:token` |  | real: newsletter_subscribers, technician_passport_shares, technician_insurance_policies, get_technician_trust_passport(), get_technician_identity_passport() +3 | page N · mods 0/3 · db 0/8 · fn 0/0 · e2e 0 |
| `QuoteTruthEnginePage` | `/dashboard/quote-truth` | Y | real: quotes, quote_truth_settings, quote_competitor_benchmarks, quote_truth_analyses, get_quote_for_token() +3 | page N · mods 1/3 · db 0/7 · fn 0/1 · e2e 0 |
| `RebateIntelligencePage` | `/dashboard/rebate-intelligence` | Y | real: customers, equipment, incentive_programs, rebate_applications, fn:rebate-intelligence | page N · mods 1/1 · db 2/4 · fn 0/1 · e2e 0 |
| `RecallCenterPage` | `/dashboard/recalls` | Y | real: recall_outreach_events, get_recall_campaigns(), get_recall_outreach(), recall_scan_my_account(), recall_log_outreach() +1 | page N · mods 0/1 · db 0/6 · fn 0/0 · e2e 0 |
| `ReceivablesIntelligencePage` | `/dashboard/receivables` | Y | real: receivables_intelligence_analyses, get_quote_for_token(), respond_to_quote_by_token(), record_quote_view(), compute_receivables_intelligence() | page N · mods 2/2 · db 0/5 · fn 0/0 · e2e 0 |
| `RecurringJobsPage` | `/dashboard/recurring-jobs` | Y | real: team_members, recurring_agreements, recurring_occurrences, customers, cancel_recurring_agreement() +2 | page N · mods 1/2 · db 1/6 · fn 0/0 · e2e 0 |
| `ReferralPage` | `/referral` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ReferralRedirectPage` | — |  | real: track_referral_click() | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ReferralsPage` | `/dashboard/referrals` | Y | real: referral_reward_rules, referral_conversion_details, customers, referral_codes, get_referral_leaderboard() +2 | page N · mods 0/1 · db 1/7 · fn 0/0 · e2e 0 |
| `RefundPolicyPage` | `/refund-policy` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `RefundsPage` | `/dashboard/refunds` | Y | real: refunds, get_refundable_payments(), fn:issue-refund | page N · mods 0/1 · db 0/2 · fn 0/1 · e2e 0 |
| `RegionalDemandPage` | `/dashboard/regional-demand` | Y | real: business_profile, regional_demand_snapshots, calls, leads, jobs +2 | page N · mods 0/1 · db 4/5 · fn 0/1 · e2e 0 |
| `RegretConsolePage` | `/dashboard/regret-console` | Y | real: regret_console_decisions, jobs, job_outcomes, team_members, cash_flow_settings +1 | page N · mods 0/2 · db 1/5 · fn 0/0 · e2e 0 |
| `RemoteResolutionPage` | `/dashboard/remote-resolution` | Y | real: remote_resolution_cases, remote_resolution_signals, rr_devices, equipment, get_remote_resolution_room() +8 | page N · mods 0/2 · db 1/11 · fn 0/2 · e2e 0 |
| `RemoteResolutionRoomPage` | `/resolve/:token` |  | real: newsletter_subscribers, remote_resolution_cases, remote_resolution_signals, rr_devices, equipment +8 | page N · mods 0/2 · db 1/12 · fn 0/1 · e2e 0 |
| `RenewMembershipPage` | `/renew/:token` |  | real: membership_renewal_cycles, get_membership_renewal_kpis(), get_membership_renewal_for_token(), respond_to_membership_renewal() | page N · mods 1/1 · db 0/4 · fn 0/0 · e2e 0 |
| `RepairReplaceAdvisorPage` | `/dashboard/repair-replace` | Y | real: customers, equipment, incentive_programs, rebate_applications, job_equipment +18 | page N · mods 4/5 · db 3/21 · fn 0/2 · e2e 0 |
| `ReportPage` | `/report` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ReportsPage` | `/dashboard/reports` | Y | real: saved_reports | page N · mods 1/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ReputationPage` | `/dashboard/reputation` | Y | real: fn:reputation | page N · mods 1/1 · db 0/0 · fn 0/1 · e2e 0 |
| `ReschedulePage` | `/reschedule/:token` |  | real: newsletter_subscribers, get_job_for_reschedule(), get_business_booked_slots(), reschedule_job_by_token() | page N · mods 0/2 · db 0/4 · fn 0/0 · e2e 0 |
| `RescueLoopPage` | `/dashboard/rescue-loop` | Y | real: rescue_sla_settings, rescue_save_sla_settings(), rescue_loop_cases(), rescue_loop_events() | page N · mods 1/1 · db 0/4 · fn 0/0 · e2e 0 |
| `ResolutionProbabilityPage` | `/dashboard/resolution-probability` | Y | real: jobs, team_members, review_requests, diagnosis_sessions, job_equipment +30 | page N · mods 1/4 · db 9/32 · fn 0/2 · e2e 0 |
| `ResourcePage` | `/resources/:slug` |  | real: newsletter_subscribers, capture_resource_lead() | page N · mods 0/2 · db 0/2 · fn 0/0 · e2e 0 |
| `ResourcesPage` | `/resources` |  | real: newsletter_subscribers, capture_resource_lead() | page N · mods 0/2 · db 0/2 · fn 0/0 · e2e 0 |
| `ResponsibleAiPage` | `/responsible-ai` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `RevenueProtectionPage` | `/dashboard/revenue-protection` | Y | real: revenue_protection_cases, revenue_protection_settings, revenue_recovery_events, arp_run_scan(), arp_start_recovery() +5 | page N · mods 0/2 · db 0/10 · fn 0/0 · e2e 0 |
| `RevenueRecoveryLedgerPage` | `/dashboard/recovery` | Y | real: revenue_recovery_events, log_recovery_follow_up(), write_off_revenue_recovery(), mark_revenue_recovered_manually(), backfill_revenue_recovery_events() | page N · mods 0/1 · db 0/5 · fn 0/0 · e2e 0 |
| `ReviewSubmitPage` | `/review/:token` |  | real: newsletter_subscribers, get_review_request(), submit_customer_review(), get_technician_review_context(), submit_customer_review_v2() +1 | page N · mods 0/3 · db 0/6 · fn 0/0 · e2e 0 |
| `ReviewsPage` | `/dashboard/reviews` | Y | real: review_requests, business_profile | page N · mods 0/1 · db 1/2 · fn 0/0 · e2e 0 |
| `RiskIntelligencePage` | `/dashboard/risk-intelligence` | Y | real: jobs, team_members, risk_policies, compliance_requirements, technician_credentials +9 | page N · mods 0/2 · db 3/13 · fn 0/0 · e2e 0 |
| `RoadmapPage` | `/roadmap` |  | partial: newsletter_subscribers, roadmap_items, roadmap_votes ⚠ unresolved: request_marketplace_integration() | page N · mods 1/2 · db 0/4 · fn 0/0 · e2e 0 |
| `SalesPresentationPage` | `/dashboard/sales/present/:id` |  | real: estimate_templates, quote_events, financing_connections, financing_offers, job_photos +16 | page N · mods 3/5 · db 1/17 · fn 0/4 · e2e 0 |
| `SandboxPage` | `/sandbox` |  | real: newsletter_subscribers, fn:api-v1 | page N · mods 1/2 · db 0/1 · fn 0/1 · e2e 0 |
| `ScheduledReportsPage` | `/dashboard/reports/scheduled` | Y | real: saved_reports, scheduled_reports, scheduled_report_deliveries, fn:scheduled-reports-run | page N · mods 2/2 · db 0/3 · fn 0/1 · e2e 0 |
| `SdksPage` | `/sdks` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `SdsLibraryPage` | `/safety/sds` | Y | real: sds_documents, sds_job_links, sds_acknowledgements, attach_sds_to_job(), detach_sds_from_job() +1 | page Y · mods 1/1 · db 0/6 · fn 0/0 · e2e 0 |
| `SecurityPage` | `/security` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `SecurityPortalPage` | `/trust/security` |  | real: newsletter_subscribers, data_regions, tenant_residency, residency_change_requests, dedicated_tenants +14 | page N · mods 0/2 · db 0/18 · fn 0/1 · e2e 0 |
| `SecurityWhitepaperPage` | `/security/whitepaper` |  | real: newsletter_subscribers | page Y · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ServerErrorPage` | `/error` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ServiceAgreementDetailPage` | `/dashboard/agreements/:id` |  | real: commercial_contracts, customers, contract_intelligence_profiles, agreement_assets, agreement_services +12 | page N · mods 1/2 · db 3/17 · fn 0/0 · e2e 0 |
| `ServiceAgreementsPage` | `/dashboard/agreements` | Y | real: commercial_contracts, customers, contract_intelligence_profiles, agreement_assets, agreement_services +12 | page N · mods 1/1 · db 3/17 · fn 0/0 · e2e 0 |
| `ServiceAreasPage` | `/dashboard/service-areas` | Y | real: team_members, territories, service_areas, service_area_technicians, service_area_settings +3 | page N · mods 1/3 · db 1/5 · fn 0/2 · e2e 0 |
| `ServiceCatalogPage` | `/dashboard/service-catalog` | Y | none | page Y · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `ServiceGuaranteePage` | `/dashboard/service-guarantee` | Y | real: jobs, team_members, job_parts_readiness, job_mission_briefs, job_outcomes +23 | page N · mods 2/2 · db 1/26 · fn 0/0 · e2e 0 |
| `ServiceGuaranteePublicPage` | `/guarantee/:token` |  | real: newsletter_subscribers, service_guarantee_settings, service_guarantees, service_guarantee_checkpoints, service_guarantee_claims +24 | page N · mods 2/3 · db 1/27 · fn 0/0 · e2e 0 |
| `ServiceRecoveryPage` | `/dashboard/service-recovery` | Y | real: service_recovery_signals, fn:send-service-recovery-response | page N · mods 1/2 · db 0/1 · fn 0/1 · e2e 0 |
| `ServiceTwinPage` | `/dashboard/service-twin` | Y | real: service_twin_interventions, job_profitability, job_cost_entries, vendor_bills, service_twin_evaluate() +1 | page N · mods 1/2 · db 0/6 · fn 0/0 · e2e 0 |
| `ServicesPage` | `/services`<br>`/solutions` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `SharedDashboardPage` | `/shared/dashboard/:token` |  | real: dashboard_snapshots, dashboard_snapshot_views, create_dashboard_snapshot(), revoke_dashboard_snapshot(), get_dashboard_snapshot() +1 | page N · mods 0/1 · db 0/6 · fn 0/0 · e2e 0 |
| `SignDocumentPage` | `/sign/:token` |  | real: newsletter_subscribers, signature_requests, signature_events, get_signature_request_for_signer(), fn:send-signature-request +1 | page N · mods 0/2 · db 0/4 · fn 0/2 · e2e 0 |
| `SiteSketchEditorPage` | — |  | real: site_sketches, jobs, quotes, save_site_sketch(), delete_site_sketch() | page N · mods 0/1 · db 1/5 · fn 0/0 · e2e 0 |
| `SiteSketchesPage` | — |  | real: site_sketches, jobs, quotes, save_site_sketch(), delete_site_sketch() | page N · mods 0/1 · db 1/5 · fn 0/0 · e2e 0 |
| `SitemapPage` | `/sitemap` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `SkillMarketPage` | `/dashboard/network/skill-market` | Y | real: jobs | page N · mods 0/1 · db 1/1 · fn 0/0 · e2e 0 |
| `SlaPage` | `/sla` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `SmsTermsPage` | `/sms-terms` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `SmsTextBackPage` | `/features/sms-text-back` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `SopLibraryPage` | `/dashboard/sop-library` | Y | real: sop_documents, sop_quiz_questions, sop_assignments, sop_template_links, sop_checklist_links +14 | page N · mods 1/1 · db 14/18 · fn 0/0 · e2e 0 |
| `SopTrainingPage` | `/dashboard/training` | Y | real: sop_documents, sop_quiz_questions, sop_assignments, sop_template_links, sop_checklist_links +14 | page N · mods 1/1 · db 14/18 · fn 0/0 · e2e 0 |
| `SpeedToLeadPage` | — |  | real: speed_to_lead_settings, speed_to_lead_sources, speed_to_lead_requests, speed_to_lead_metrics(), speed_to_lead_revoke() +2 | page N · mods 0/1 · db 0/6 · fn 0/1 · e2e 0 |
| `SplitPayerPayPage` | `/pay-share/:token` |  | real: invoices, invoice_split_payers, invoice_payments, invoice_refunds, invoice_reminders +23 | page Y · mods 5/6 · db 0/23 · fn 0/3 · e2e 0 |
| `SsoLoginPage` | `/sso-login` |  | real: custom_roles, team_members, ip_allow_rules, security_policies, sso_domains +5 | page N · mods 0/1 · db 0/6 · fn 0/1 · e2e 0 |
| `StaffOpenVoiceBenchmarkPage` | `/staff/open-voice-benchmark` |  | real: newsletter_subscribers, fn:ovb-public, fn:ovb-run | page N · mods 1/2 · db 0/1 · fn 0/2 · e2e 0 |
| `StaffProcurementNetworkPage` | `/staff/procurement-network` |  | real: pn_memberships, pn_orders, pn_order_lines, pn_order_savings, pn_rebates +8 | page N · mods 0/1 · db 11/13 · fn 0/0 · e2e 0 |
| `StaffTrustAdminPage` | `/staff/trust-admin` |  | real: data_regions, tenant_residency, residency_change_requests, dedicated_tenants, tenant_encryption_keys +13 | page N · mods 0/1 · db 0/17 · fn 0/1 · e2e 0 |
| `StaffValueScoreboardPage` | `/staff/value-scoreboard` |  | real: value_settings, business_profile, value_events, value_event_reviews, value_statements +11 | page N · mods 2/2 · db 7/13 · fn 0/2 · e2e 0 |
| `StaffingForecastPage` | `/dashboard/staffing-forecast` | Y | real: staffing_forecast_runs, get_or_create_staffing_settings(), update_staffing_forecast_settings(), fn:staffing-forecast, auth.getSession | page N · mods 0/1 · db 0/3 · fn 0/1 · e2e 0 |
| `StatusPage` | `/status` |  | real: status_subscribers, newsletter_subscribers, fn:status-feed | page N · mods 0/3 · db 0/2 · fn 0/1 · e2e 0 |
| `StatusUnsubscribePage` | `/status/unsubscribe` |  | real: newsletter_subscribers, fn:unsubscribe-status-updates | page N · mods 0/2 · db 0/1 · fn 0/1 · e2e 0 |
| `SubprocessorsPage` | `/subprocessors` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `SuccessCenterPage` | `/dashboard/success` | Y | real: get_my_success_snapshot(), nps_should_prompt(), submit_nps_response(), set_success_item_state(), clear_success_item_state() +1 | page N · mods 0/1 · db 0/6 · fn 0/0 · e2e 0 |
| `SupplierApplyPage` | `/supplier-portal/apply` |  | real: pn_memberships, pn_orders, pn_order_lines, pn_order_savings, pn_rebates +8 | page N · mods 0/1 · db 11/13 · fn 0/0 · e2e 0 |
| `SupplierAuditPage` | `/dashboard/supplier-audit` | Y | real: profiles, supplier_audit_log, supplier_statements, supplier_statement_lines, supplier_programs +14 | page N · mods 0/2 · db 0/15 · fn 0/1 · e2e 0 |
| `SupplierCatalogPage` | `/dashboard/supplier-catalog` | Y | real: parts_order_cart, supplier_price_imports, supplier_feed_keys, inventory_vendors, inventory_locations +11 | page N · mods 0/2 · db 8/15 · fn 0/1 · e2e 0 |
| `SupplierIntelligencePage` | `/dashboard/supplier-intelligence` | Y | real: vendors, vendor_scorecard, purchase_requests, procurement_pipeline, rfqs +38 | page N · mods 3/4 · db 6/42 · fn 0/0 · e2e 0 |
| `SupplierPortalPage` | `/supplier-portal` |  | real: pn_memberships, pn_orders, pn_order_lines, pn_order_savings, pn_rebates +8 | page N · mods 0/1 · db 11/13 · fn 0/0 · e2e 0 |
| `SupplyChainOutcomePage` | `/dashboard/supply-chain-outcomes` | Y | real: inventory_parts, parts_market_sources, parts_market_live_offers, parts_market_offers, parts_market_price_history +43 | page N · mods 4/4 · db 6/47 · fn 0/0 · e2e 0 |
| `SupportInboxPage` | `/staff/support-inbox` |  | real: support_conversations, support_messages, support_attachments, auth.getSession, auth.signInAnonymously | page N · mods 0/3 · db 0/3 · fn 0/0 · e2e 0 |
| `SupportTicketsPage` | `/dashboard/support` | Y | real: support_conversations, support_messages, support_attachments, auth.getSession, auth.signInAnonymously | page N · mods 0/2 · db 0/3 · fn 0/0 · e2e 0 |
| `SurveyResponsePage` | `/s/:token` |  | real: survey_templates, survey_invitations, survey_recovery_cases, team_members, jobs +3 | page N · mods 0/1 · db 1/6 · fn 0/1 · e2e 0 |
| `SurveysPage` | `/dashboard/surveys` | Y | real: survey_templates, survey_invitations, survey_recovery_cases, team_members, jobs +3 | page N · mods 0/1 · db 1/6 · fn 0/1 · e2e 0 |
| `SwitchGuidePage` | `/switch/:slug` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `SwitchGuidesPage` | `/switch` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `SystemRequirementsPage` | `/system-requirements` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `TagsPage` | `/dashboard/tags` | Y | real: profiles, equipment, equipment_passport_links, resolve_equipment_tag(), record_tag_action() +16 | page N · mods 2/4 · db 9/20 · fn 0/0 · e2e 0 |
| `TakeoffDetailPage` | `/dashboard/takeoff/:id` |  | real: takeoff_projects, takeoff_rooms, takeoff_items, quotes, fn:takeoff-analyze | page N · mods 0/1 · db 0/4 · fn 0/1 · e2e 0 |
| `TakeoffPage` | `/dashboard/takeoff` | Y | real: takeoff_projects, takeoff_rooms, takeoff_items, quotes, fn:takeoff-analyze | page N · mods 0/1 · db 0/4 · fn 0/1 · e2e 0 |
| `TalentBoardPage` | `/talent` |  | real: newsletter_subscribers, talent_profiles, talent_credentials, talent_references, talent_postings +26 | page N · mods 1/2 · db 0/29 · fn 0/2 · e2e 0 |
| `TalentJobPage` | `/talent/jobs/:slug` |  | real: newsletter_subscribers, talent_profiles, talent_credentials, talent_references, talent_postings +26 | page N · mods 1/2 · db 0/29 · fn 0/2 · e2e 0 |
| `TalentNetworkPage` | `/dashboard/talent` | Y | real: talent_profiles, talent_credentials, talent_references, talent_postings, talent_applications +25 | page N · mods 1/1 · db 0/28 · fn 0/2 · e2e 0 |
| `TalentReferencePage` | `/talent/reference/:token` |  | real: newsletter_subscribers, talent_profiles, talent_credentials, talent_references, talent_postings +26 | page N · mods 1/2 · db 0/29 · fn 0/2 · e2e 0 |
| `TalentWorkerPage` | `/talent/me` |  | real: newsletter_subscribers, talent_profiles, talent_credentials, talent_references, talent_postings +26 | page N · mods 1/2 · db 0/29 · fn 0/2 · e2e 0 |
| `TasksPage` | `/dashboard/tasks` | Y | real: tasks, team_members, customers, leads, jobs +1 | page N · mods 0/1 · db 4/5 · fn 0/0 · e2e 0 |
| `TaxCenterPage` | `/dashboard/tax` | Y | real: tax_rates, tax_settings, tax_classes, tax_class_state_rules, customers +8 | page N · mods 0/1 · db 1/12 · fn 0/0 · e2e 0 |
| `TeamChatPage` | `/dashboard/team-chat` | Y | real: chat_channels, chat_messages, chat_members, push_subscriptions, chat_people() +5 | page N · mods 1/2 · db 9/10 · fn 0/0 · e2e 0 |
| `TechEarningsPage` | `/tech/earnings` |  | real: inventory_parts, inventory_vendors, truck_stock_status, job_dispatch_readiness, job_parts_sourcing +42 | page Y · mods 3/4 · db 9/47 · fn 0/0 · e2e 0 |
| `TechTruckTransfersPage` | `/tech/truck-transfers` |  | real: inventory_parts, inventory_vendors, truck_stock_status, job_dispatch_readiness, job_parts_sourcing +51 | page N · mods 5/5 · db 15/56 · fn 0/0 · e2e 0 |
| `TechnicianApprenticeshipPage` | `/dashboard/apprenticeship` | Y | real: team_members, jobs, review_requests, simulator_attempts, apprenticeship_plans +5 | page N · mods 1/3 · db 1/8 · fn 1/1 · e2e 0 |
| `TechnicianCapacityPage` | `/dashboard/technician-capacity` | Y | real: team_members, jobs, technician_capacity_events | page N · mods 0/1 · db 1/2 · fn 0/0 · e2e 0 |
| `TechnicianDepositsPage` | `/tech/deposits` |  | real: get_job_payment_summary(), record_manual_payment(), void_job_payment(), get_deposit_overview(), create_deposit_batch() +1 | page N · mods 1/1 · db 0/5 · fn 0/1 · e2e 0 |
| `TechnicianDvirPage` | `/tech/dvir` |  | real: dvir_checklist_items, vehicles, vehicle_faults, vehicle_inspections, signature_requests +9 | page N · mods 1/2 · db 0/11 · fn 0/2 · e2e 0 |
| `TechnicianJobBoardPage` | `/tech/job-board` |  | real: job_board_posts, job_board_recipients, job_board_bids, job_board_events, jobs +2 | page N · mods 1/1 · db 2/6 · fn 0/0 · e2e 0 |
| `TechnicianJobBriefPage` | `/tech/job/:jobId` |  | real: expert_assist_requests, expert_assist_messages, job_compliance_reviews, payment_requests, stripe_connect_accounts +52 | page N · mods 6/10 · db 10/52 · fn 0/5 · e2e 0 |
| `TechnicianJobThreadPage` | `/tech/messages/:jobId` |  | real: jobs, job_messages, get_account_owner_id(), get_job_thread_summaries(), mark_job_thread_read() +1 | page N · mods 2/3 · db 1/4 · fn 0/0 · e2e 0 |
| `TechnicianLeaderboardPage` | `/dashboard/leaderboard` | Y | real: leaderboard_settings, spiff_rules, commission_plans, commission_plan_tiers, commission_records +20 | page N · mods 0/2 · db 1/25 · fn 0/0 · e2e 0 |
| `TechnicianMessagesPage` | `/tech/messages` |  | real: job_messages, get_job_thread_summaries(), mark_job_thread_read(), get_technician_today_jobs(), get_my_crew_jobs() +4 | page N · mods 1/2 · db 0/9 · fn 0/0 · e2e 0 |
| `TechnicianPayPage` | `/tech/pay` |  | real: pay_transfers, pay_runs, spend_cards, card_transactions, capital_applications +30 | page N · mods 1/3 · db 4/34 · fn 0/1 · e2e 0 |
| `TechnicianPerformancePage` | `/dashboard/technician-performance` | Y | real: team_members, jobs, review_requests, technician_scorecards, arrival_window_notifications +8 | page N · mods 0/3 · db 4/12 · fn 0/0 · e2e 0 |
| `TechnicianProfilePage` | `/tech/profile` |  | real: team_members, technician_credentials, technician_preferences, get_my_team_member_id(), set_my_technician_availability() +1 | page Y · mods 0/1 · db 0/5 · fn 0/0 · e2e 0 |
| `TechnicianRetentionPage` | `/dashboard/technician-retention` | Y | real: tech_risk_scores, team_members, retention_actions, retention_schedule_freezes, approve_retention_action() +4 | page N · mods 1/1 · db 0/6 · fn 0/1 · e2e 0 |
| `TechnicianSimulatorPage` | `/dashboard/technician-simulator` | Y | real: simulator_attempts, get_technician_simulator_summary(), fn:technician-simulator | page N · mods 1/1 · db 0/2 · fn 1/1 · e2e 0 |
| `TechnicianSkillGraphPage` | `/dashboard/skill-graph` | Y | real: team_members, jobs, review_requests, technician_scorecards, simulator_attempts +2 | page N · mods 1/3 · db 1/5 · fn 1/1 · e2e 0 |
| `TechnicianTimesheetPage` | — |  | real: time_shifts, break_violation_reviews, get_technician_today_jobs(), get_my_crew_jobs(), get_job_brief() +11 | page N · mods 0/3 · db 0/16 · fn 0/0 · e2e 0 |
| `TechnicianTrustPassportPage` | `/dashboard/trust-passport` | Y | real: simulator_attempts, get_technician_simulator_summary(), get_technician_trust_passport(), fn:technician-simulator | page N · mods 1/2 · db 0/3 · fn 1/1 · e2e 0 |
| `TelematicsOSPage` | `/dashboard/telematics` | Y | real: team_members, telematics_connections, vehicles, vehicle_live_state, driver_safety_daily +7 | page N · mods 1/2 · db 0/9 · fn 0/2 · e2e 0 |
| `TemplatesPage` | `/dashboard/templates` | Y | real: message_templates, get_message_template_stats(), review_message_template(), record_message_template_use() | page N · mods 0/1 · db 0/4 · fn 0/0 · e2e 0 |
| `TermsPage` | `/terms` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `TestimonialsPage` | `/testimonials` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ThankYouPage` | `/thank-you` |  | real: newsletter_subscribers, demo_bookings, get_booked_demo_slot_starts() | page N · mods 0/2 · db 0/3 · fn 0/0 · e2e 0 |
| `ThirdPartyIntakePage` | `/dashboard/third-party-intake` | Y | real: third_party_work_orders, third_party_work_order_events, third_party_payers, lead_marketplace_sources, lead_marketplace_events +4 | page Y · mods 2/3 · db 0/7 · fn 0/2 · e2e 0 |
| `TimeOffPage` | `/dashboard/time-off` | Y | real: team_members, technician_time_off, company_blackout_dates, technician_availability, jobs | page N · mods 0/1 · db 1/4 · fn 0/0 · e2e 0 |
| `TokensPreview` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `ToolCribPage` | `/dashboard/tools` | Y | real: tool_crib_items, tool_crib_loans, tool_crib_events, tool_crib_options(), save_crib_tool() +8 | page N · mods 1/1 · db 0/13 · fn 0/0 · e2e 0 |
| `TrackingPage` | `/track/:token` |  | real: newsletter_subscribers, jobs, get_job_tracking(), ensure_job_review_request() | page N · mods 1/2 · db 1/4 · fn 0/0 · e2e 0 |
| `TradePacksPage` | `/dashboard/trade-packs` | Y | real: trade_pack_installs, trade_regulated_products, trade_log_entries, team_members, equipment +14 | page N · mods 2/3 · db 2/18 · fn 0/0 · e2e 0 |
| `TradePlaybooksPage` | `/dashboard/trade-playbooks` | Y | real: trade_playbook_installs, trade_playbook_tuning, playbook_learning_suggestions, business_profile, job_outcomes +26 | page N · mods 2/5 · db 2/30 · fn 0/0 · e2e 0 |
| `TrademarkPolicyPage` | `/trademark-policy` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `TrashPage` | `/dashboard/trash` | Y | real: soft_delete_records(), restore_records(), purge_records(), list_trash(), trash_counts() | page Y · mods 1/1 · db 0/5 · fn 0/0 · e2e 0 |
| `TruckOperationsPage` | `/dashboard/inventory/trucks` | Y | real: inventory_parts, inventory_vendors, truck_stock_status, job_dispatch_readiness, job_parts_sourcing +35 | page N · mods 3/3 · db 12/40 · fn 0/0 · e2e 0 |
| `TruckRollEliminationPage` | `/dashboard/truck-roll` | Y | real: jobs, team_members, job_parts_readiness, job_mission_briefs, job_outcomes +18 | page N · mods 2/2 · db 2/21 · fn 0/0 · e2e 0 |
| `TruckStockPage` | `/tech/truck-stock` |  | real: inventory_parts, inventory_vendors, truck_stock_status, job_dispatch_readiness, job_parts_sourcing +34 | page Y · mods 3/3 · db 8/39 · fn 0/0 · e2e 0 |
| `TrustCenterPage` | `/trust` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `TrustPackPage` | `/dashboard/trust-pack` | Y | real: data_regions, tenant_residency, residency_change_requests, dedicated_tenants, tenant_encryption_keys +13 | page N · mods 0/1 · db 0/17 · fn 0/1 · e2e 0 |
| `UncertaintyMapPage` | `/dashboard/uncertainty-map` | Y | real: jobs, customers, integrations, agent_action_log, business_profile +5 | page N · mods 0/2 · db 5/8 · fn 0/1 · e2e 0 |
| `UnderpricedJobsPage` | `/dashboard/underpriced-jobs` | Y | real: underpriced_jobs, technician_underpricing_summary | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `UnifiedInboxPage` | `/dashboard/inbox` | Y | real: dm_conversations, sms_conversations, email_conversations, support_conversations, rich_conversations +9 | page N · mods 2/2 · db 1/10 · fn 0/4 · e2e 0 |
| `UnknownsEnginePage` | `/dashboard/unknowns` | Y | real: jobs, diagnosis_sessions, job_equipment, job_parts_required, customer_sites +7 | page N · mods 2/2 · db 2/12 · fn 0/0 · e2e 0 |
| `UsageDashboardPage` | `/dashboard/usage` | Y | real: calls | page N · mods 0/1 · db 1/1 · fn 0/0 · e2e 0 |
| `UseCasePage` | `/use-cases/:slug` |  | real: newsletter_subscribers | page Y · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `ValuationPage` | `/valuation` | Y | real: valuation_profiles, data_room_items, valuation_snapshots | page Y · mods 1/1 · db 0/3 · fn 0/0 · e2e 0 |
| `ValueAtRiskPage` | `/dashboard/value-at-risk` | Y | real: revenue_recovery_events, jobs, technician_credentials, review_requests, fragility_settings +10 | page N · mods 0/3 · db 2/15 · fn 0/0 · e2e 0 |
| `ValueScoreboardPage` | `/dashboard/results` | Y | real: profiles, executive_report_settings, executive_reports, value_settings, business_profile +15 | page N · mods 3/4 · db 7/15 · fn 0/3 · e2e 0 |
| `VehiclesPage` | `/dashboard/vehicles` | Y | real: vehicles, vehicle_maintenance_schedules, vehicle_documents, vehicle_assignments, vehicle_expenses +13 | page N · mods 1/2 · db 0/16 · fn 0/2 · e2e 0 |
| `VendorManagementPage` | `/dashboard/vendors` | Y | real: vendors, vendor_scorecard, purchase_requests, procurement_pipeline, rfqs +41 | page N · mods 3/3 · db 6/45 · fn 0/0 · e2e 0 |
| `VendorRmaPage` | `/dashboard/inventory/rma` | Y | real: inventory_parts, inventory_locations, parts_availability, low_stock_alerts, job_parts_readiness +33 | page N · mods 1/2 · db 6/38 · fn 0/0 · e2e 0 |
| `VerificationNetworkPage` | `/dashboard/verification-network` | Y | real: verification_checks, technician_credentials, technician_insurance_policies, verification_sources, background_consents +3 | page N · mods 1/1 · db 0/7 · fn 0/1 · e2e 0 |
| `VerifiedServicePage` | `/verified/:token` |  | real: newsletter_subscribers, job_trust_scores, job_trust_events, refresh_job_trust_score(), record_job_trust_event() +3 | page N · mods 1/2 · db 0/8 · fn 0/0 · e2e 0 |
| `VideoSessionRoomPage` | `/live/:token` |  | real: video_sessions, video_session_clips, end_video_session(), delete_video_clip(), attach_video_clip() +4 | page N · mods 0/1 · db 0/8 · fn 0/1 · e2e 0 |
| `VideoSessionsPage` | `/dashboard/video-sessions` | Y | real: video_sessions, video_session_clips, end_video_session(), delete_video_clip(), attach_video_clip() +4 | page N · mods 0/1 · db 0/8 · fn 0/1 · e2e 0 |
| `VoicemailDropsPage` | `/dashboard/voicemail-drops` | Y | real: voicemail_drops, voicemail_drop_stats, get_ai_transparency_registry(), set_ai_transparency_feature(), set_ai_transparency_legal_review() +3 | page N · mods 0/2 · db 0/8 · fn 0/0 · e2e 0 |
| `VulnerabilityDisclosurePage` | `/vulnerability-disclosure` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `WallboardPage` | `/wallboard/:token` |  | real: wallboards, get_wallboard_snapshot(), create_wallboard(), update_wallboard(), revoke_wallboard() | page N · mods 0/1 · db 4/5 · fn 0/0 · e2e 0 |
| `WallboardSettingsPage` | `/dashboard/wallboard` | Y | real: wallboards, get_wallboard_snapshot(), create_wallboard(), update_wallboard(), revoke_wallboard() | page N · mods 0/1 · db 4/5 · fn 0/0 · e2e 0 |
| `WalletLandingPage` | `/w/:token` |  | real: wallet_list_passes(), wallet_candidates(), wallet_void_pass(), get_wallet_landing(), get_portal_wallet_options() +2 | page N · mods 0/1 · db 0/5 · fn 0/2 · e2e 0 |
| `WalletPassesPage` | `/dashboard/wallet-passes` | Y | real: wallet_list_passes(), wallet_candidates(), wallet_void_pass(), get_wallet_landing(), get_portal_wallet_options() +2 | page N · mods 0/1 · db 0/5 · fn 0/2 · e2e 0 |
| `WeatherSurgeIntelligencePage` | `/dashboard/weather-surge` | Y | real: business_profile, weather_surge_events, fn:weather-surge-check | page N · mods 0/1 · db 1/2 · fn 0/1 · e2e 0 |
| `WebhookLogsPage` | `/dashboard/webhook-logs` |  | real: webhook_logs | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `WebinarsPage` | `/webinars` |  | real: newsletter_subscribers | page N · mods 0/2 · db 0/1 · fn 0/0 · e2e 0 |
| `WhatsAppInstagramDMPage` | `/features/whatsapp-instagram-dm` |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `WhatsNewPage` | `/dashboard/whats-new` | Y | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `WorkOrdersPage` | `/dashboard/work-orders` | Y | real: work_orders, work_order_visits, customers, team_members | page N · mods 0/1 · db 1/3 · fn 0/0 · e2e 0 |
| `WorkflowCompilerPage` | `/dashboard/workflow-compiler` | Y | real: compiled_workflows, compiled_workflow_runs, compiled_workflow_audit, compiled_workflow_approvals, set_compiled_workflow_status() +5 | page N · mods 0/1 · db 0/9 · fn 0/1 · e2e 0 |
| `WorkflowsPage` | `/dashboard/workflows` | Y | real: workflow_definitions, workflow_runs, workflow_run_steps, workflow_approvals, revenue_recovery_events +9 | page N · mods 0/2 · db 0/14 · fn 0/0 · e2e 0 |
| `admin/EvidencePartnersAdminPage` | `/staff/evidence-partners` |  | real: evidence_sharing_consent, evidence_products, evidence_patterns, evidence_releases, evidence_partners +9 | page N · mods 1/1 · db 0/14 · fn 0/0 · e2e 0 |
| `admin/FeatureFlagsAdminPage` | `/staff/feature-flags` |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `admin/HiringPage` | `/dashboard/hiring` |  | real: job_postings, job_posting_stats, job_applications, submit_job_application() | page N · mods 0/1 · db 0/4 · fn 0/0 · e2e 0 |
| `admin/PartnerApplicationsAdminPage` | `/staff/partners` |  | real: partners, approve_partner_application(), reject_partner_application() | page N · mods 0/1 · db 0/3 · fn 0/0 · e2e 0 |
| `admin/PayControlsAdminPage` | `/staff/pay-controls` |  | real: pay_transfers, pay_runs, spend_cards, card_transactions, capital_applications +30 | page N · mods 1/3 · db 4/34 · fn 0/1 · e2e 0 |
| `admin/PilotManagementPage` | `/staff/pilots` |  | real: pilot_customers, staff_list_pilots(), staff_pilot_trend(), staff_pilot_quality_flags(), staff_list_pilot_audit() +1 | page Y · mods 0/1 · db 0/6 · fn 0/0 · e2e 0 |
| `admin/StaffCustomersPage` | `/staff/customers` |  | real: staff_audit_log, staff_account_overview(), staff_account_detail(), get_my_success_snapshot(), nps_should_prompt() +5 | page N · mods 1/2 · db 0/9 · fn 0/1 · e2e 0 |
| `admin/StaffReliabilityPage` | `/staff/reliability` |  | real: staff_reliability_overview(), slo_multi_window_counts() | page N · mods 0/1 · db 0/2 · fn 0/0 · e2e 0 |
| `admin/StaffUsagePage` | `/staff/usage` |  | real: staff_usage_report() | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `hangelogPage` | — |  | real: newsletter_subscribers | page N · mods 0/1 · db 0/1 · fn 0/0 · e2e 0 |
| `home/HomeApp` | `/home/*` |  | real: homeowner_consent_events, equipment_passport_links, home_health_scores, home_health_actions, verify_equipment_passport() +12 | page N · mods 2/3 · db 0/13 · fn 0/1 · e2e 0 |
| `home/HomeAssistantPage` | — |  | real: homeowner_consent_events, home_health_scores, home_health_actions, dismiss_home_health_action(), fn:home-health-agent +3 | page N · mods 1/2 · db 0/4 · fn 0/1 · e2e 0 |
| `home/HomeBusinessPage` | — |  | real: homeowner_consent_events, equipment_passport_links, home_health_scores, home_health_actions, verify_equipment_passport() +12 | page N · mods 2/3 · db 0/13 · fn 0/1 · e2e 0 |
| `home/HomeBusinessesPage` | — |  | real: homeowner_consent_events, home_health_scores, home_health_actions, dismiss_home_health_action(), fn:home-health-agent +3 | page N · mods 1/2 · db 0/4 · fn 0/1 · e2e 0 |
| `home/HomeOverviewPage` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `home/HomePrivacyPage` | — |  | real: homeowner_consent_events, home_health_scores, home_health_actions, dismiss_home_health_action(), fn:home-health-agent +3 | page N · mods 1/2 · db 0/4 · fn 0/1 · e2e 0 |
| `home/HomeRequestPage` | — |  | real: homeowner_consent_events, auth.signInWithOtp, auth.verifyOtp, auth.signOut | page N · mods 1/1 · db 0/1 · fn 0/0 · e2e 0 |
| `home/HomeSignInPage` | — |  | real: homeowner_consent_events, auth.signInWithOtp, auth.verifyOtp, auth.signOut | page Y · mods 1/1 · db 0/1 · fn 0/0 · e2e 0 |
| `home/HomeTargetGate` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
| `home/ui` | — |  | none | page N · mods 0/0 · db 0/0 · fn 0/0 · e2e 0 |
