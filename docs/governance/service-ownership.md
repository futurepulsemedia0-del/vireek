# Service ownership

> Generated from `docs/governance/ownership-map.json` by `npm run owners:generate`. Do not edit by hand.

Every area of the repository has a **primary** and a **backup** owner. `.github/CODEOWNERS` is generated from the same map,
so this document and the review rules cannot drift apart. Person-level accountability for operational areas (security, voice,
billing, integrations, support, compliance) lives in `docs/OWNERS.md`; keep the two consistent.

## How to fill in the owners

1. Edit the `primary` and `backup` values under `roles` in `docs/governance/ownership-map.json`. Use a GitHub user (`@alice`), a team (`@your-org/security`) or an e-mail address of a GitHub user.
   Every owner needs **write** access to the repository, otherwise GitHub ignores it. [VERIFY in your GitHub organization]
2. Run `npm run owners:generate` and commit the regenerated `.github/CODEOWNERS` and this file.
3. Run `npm run owners:check`. When no placeholder is left, set `"enforcePlaceholders": true` in the map so CI fails if one ever comes back.
4. Enable "Require review from Code Owners" in branch protection. [VERIFY in repository settings]

A role may use the same person as primary and backup only when `"allowSamePrimaryBackup": true` is set on that role (a deliberate, reviewed exception).

## Roles

| Role | Responsibility | Primary | Backup |
|---|---|---|---|
| `PLATFORM` | Platform, CI and supply chain | `@OWNER_PLATFORM` | `@BACKUP_PLATFORM` |
| `FRONTEND` | Web frontend | `@OWNER_FRONTEND` | `@BACKUP_FRONTEND` |
| `MOBILE` | Mobile (Capacitor iOS/Android) | `@OWNER_MOBILE` | `@BACKUP_MOBILE` |
| `BACKEND` | Backend and edge functions (core) | `@OWNER_BACKEND` | `@BACKUP_BACKEND` |
| `DATA` | Database, migrations, analytics | `@OWNER_DATA` | `@BACKUP_DATA` |
| `SECURITY` | Security and trust | `@OWNER_SECURITY` | `@BACKUP_SECURITY` |
| `COMPLIANCE` | Compliance, privacy and registers | `@OWNER_COMPLIANCE` | `@BACKUP_COMPLIANCE` |
| `VOICE` | Voice, telephony and messaging | `@OWNER_VOICE` | `@BACKUP_VOICE` |
| `BILLING` | Billing, payments and financing | `@OWNER_BILLING` | `@BACKUP_BILLING` |
| `INTEGRATIONS` | Third-party integrations and sync | `@OWNER_INTEGRATIONS` | `@BACKUP_INTEGRATIONS` |
| `GROWTH` | Growth, marketing and reputation | `@OWNER_GROWTH` | `@BACKUP_GROWTH` |

## Domains

| Area | Domain | Role | Primary | Backup |
|---|---|---|---|---|
| Repository | Fallback for anything not listed below | `PLATFORM` | `@OWNER_PLATFORM` | `@BACKUP_PLATFORM` |
| Frontend | App shell, routes, contexts, hooks | `FRONTEND` | `@OWNER_FRONTEND` | `@BACKUP_FRONTEND` |
| Frontend | Pages (marketing and dashboard) | `FRONTEND` | `@OWNER_FRONTEND` | `@BACKUP_FRONTEND` |
| Frontend | Shared components | `FRONTEND` | `@OWNER_FRONTEND` | `@BACKUP_FRONTEND` |
| Frontend | Client libraries and API clients | `FRONTEND` | `@OWNER_FRONTEND` | `@BACKUP_FRONTEND` |
| Frontend | Design tokens, styles, accessibility | `FRONTEND` | `@OWNER_FRONTEND` | `@BACKUP_FRONTEND` |
| Frontend | Localization (i18n, locales) | `FRONTEND` | `@OWNER_FRONTEND` | `@BACKUP_FRONTEND` |
| Frontend | Static assets and end-to-end tests | `FRONTEND` | `@OWNER_FRONTEND` | `@BACKUP_FRONTEND` |
| Frontend | Native bridge in the web app | `MOBILE` | `@OWNER_MOBILE` | `@BACKUP_MOBILE` |
| Frontend | Trust pack client code | `SECURITY` | `@OWNER_SECURITY` | `@BACKUP_SECURITY` |
| Frontend | Public .well-known files | `COMPLIANCE` | `@OWNER_COMPLIANCE` | `@BACKUP_COMPLIANCE` |
| Edge functions | Core edge functions (default group) | `BACKEND` | `@OWNER_BACKEND` | `@BACKUP_BACKEND` |
| Edge functions | Shared edge code (_shared) | `BACKEND` | `@OWNER_BACKEND` | `@BACKUP_BACKEND` |
| Edge functions | Growth, marketing, reputation, surveys | `GROWTH` | `@OWNER_GROWTH` | `@BACKUP_GROWTH` |
| Edge functions | Analytics, BI, learning and intelligence | `DATA` | `@OWNER_DATA` | `@BACKUP_DATA` |
| Edge functions | Billing, payments, financing | `BILLING` | `@OWNER_BILLING` | `@BACKUP_BILLING` |
| Edge functions | Accounting, CRM, calendar, payroll, listings integrations | `INTEGRATIONS` | `@OWNER_INTEGRATIONS` | `@BACKUP_INTEGRATIONS` |
| Edge functions | Voice, telephony, SMS and messaging channels | `VOICE` | `@OWNER_VOICE` | `@BACKUP_VOICE` |
| Edge functions | Authentication, access control, security and trust | `SECURITY` | `@OWNER_SECURITY` | `@BACKUP_SECURITY` |
| Edge functions | Privacy, retention, exports and compliance | `COMPLIANCE` | `@OWNER_COMPLIANCE` | `@BACKUP_COMPLIANCE` |
| Edge functions | Reliability, DR, observability | `PLATFORM` | `@OWNER_PLATFORM` | `@BACKUP_PLATFORM` |
| Edge functions | AI core shared code | `SECURITY` | `@OWNER_SECURITY` | `@BACKUP_SECURITY` |
| Edge functions | Voice security shared code and Vapi webhook | `VOICE` | `@OWNER_VOICE` | `@BACKUP_VOICE` |
| Database | SQL migrations (schema review gate) | `DATA` | `@OWNER_DATA` | `@BACKUP_DATA` |
| Database | Database tests and Supabase config | `DATA` | `@OWNER_DATA` | `@BACKUP_DATA` |
| Database | Seed and demo data | `DATA` | `@OWNER_DATA` | `@BACKUP_DATA` |
| Security | Security tooling and docs | `SECURITY` | `@OWNER_SECURITY` | `@BACKUP_SECURITY` |
| Security | AI governance scripts | `SECURITY` | `@OWNER_SECURITY` | `@BACKUP_SECURITY` |
| Compliance | AI governance documents | `COMPLIANCE` | `@OWNER_COMPLIANCE` | `@BACKUP_COMPLIANCE` |
| Mobile | Native projects and release docs | `MOBILE` | `@OWNER_MOBILE` | `@BACKUP_MOBILE` |
| Voice | Voice red-team evals and docs | `VOICE` | `@OWNER_VOICE` | `@BACKUP_VOICE` |
| Platform | CI, governance scripts, supply chain | `PLATFORM` | `@OWNER_PLATFORM` | `@BACKUP_PLATFORM` |
| Platform | Licence policy and asset licences | `COMPLIANCE` | `@OWNER_COMPLIANCE` | `@BACKUP_COMPLIANCE` |
| Compliance | Compliance and business registers (not legal advice) | `COMPLIANCE` | `@OWNER_COMPLIANCE` | `@BACKUP_COMPLIANCE` |

## Path patterns per domain

Patterns follow CODEOWNERS rules: the **last** matching pattern wins, so later domains override earlier, broader ones.

### Fallback for anything not listed below

Area: Repository - role `PLATFORM`

- `*`

### App shell, routes, contexts, hooks

Area: Frontend - role `FRONTEND`

- `/src/`
- `/src/App.tsx`
- `/src/routes/`
- `/src/contexts/`
- `/src/hooks/`

### Pages (marketing and dashboard)

Area: Frontend - role `FRONTEND`

- `/src/pages/`

### Shared components

Area: Frontend - role `FRONTEND`

- `/src/components/`

### Client libraries and API clients

Area: Frontend - role `FRONTEND`

- `/src/lib/`

### Design tokens, styles, accessibility

Area: Frontend - role `FRONTEND`

- `/src/styles/`
- `/src/index.css`
- `/vireek-a11y/`
- `/.storybook/`

### Localization (i18n, locales)

Area: Frontend - role `FRONTEND`

- `/src/i18n/`
- `/src/locales/`

### Static assets and end-to-end tests

Area: Frontend - role `FRONTEND`

- `/public/`
- `/e2e/`

### Native bridge in the web app

Area: Frontend - role `MOBILE`

- `/src/lib/native/`

### Trust pack client code

Area: Frontend - role `SECURITY`

- `/src/lib/trustPack/`

### Public .well-known files

Area: Frontend - role `COMPLIANCE`

- `/public/.well-known/`

### Core edge functions (default group)

Area: Edge functions - role `BACKEND`

- `/supabase/functions/`

### Shared edge code (_shared)

Area: Edge functions - role `BACKEND`

- `/supabase/functions/_shared/`

### Growth, marketing, reputation, surveys

Area: Edge functions - role `GROWTH`

- `/supabase/functions/ads-*/`
- `/supabase/functions/marketing-*/`
- `/supabase/functions/growth-*/`
- `/supabase/functions/reputation*/`
- `/supabase/functions/survey-*/`
- `/supabase/functions/feedback-*/`
- `/supabase/functions/blog-*/`
- `/supabase/functions/careers-*/`
- `/supabase/functions/contact-sales/`
- `/supabase/functions/demo-chat/`
- `/supabase/functions/lead-marketplace-*/`
- `/supabase/functions/email-campaign*/`
- `/supabase/functions/direct-mail-*/`
- `/supabase/functions/lifecycle-touch-tick/`
- `/supabase/functions/win-card*/`

### Analytics, BI, learning and intelligence

Area: Edge functions - role `DATA`

- `/supabase/functions/analytics-*/`
- `/supabase/functions/analyze-*/`
- `/supabase/functions/bi-*/`
- `/supabase/functions/compute-*/`
- `/supabase/functions/causal-*/`
- `/supabase/functions/data-platform-*/`
- `/supabase/functions/generate-insights/`
- `/supabase/functions/insights-api/`
- `/supabase/functions/metrics-query/`
- `/supabase/functions/state-of-calls-*/`
- `/supabase/functions/value-scoreboard-run/`
- `/supabase/functions/money-recovered-run/`
- `/supabase/functions/founder-kpis/`
- `/supabase/functions/knowledge-*/`
- `/supabase/functions/learning-policy-monitor/`
- `/supabase/functions/failure-genome-refresh/`
- `/supabase/functions/predictive-failure/`
- `/supabase/functions/shadow-*/`
- `/supabase/functions/telemetry-*/`
- `/supabase/functions/rum-ingest/`
- `/supabase/functions/fx-rates-refresh/`

### Billing, payments, financing

Area: Edge functions - role `BILLING`

- `/supabase/functions/stripe-*/`
- `/supabase/functions/pay-*/`
- `/supabase/functions/payment-*/`
- `/supabase/functions/phone-payment-*/`
- `/supabase/functions/create-checkout-session/`
- `/supabase/functions/create-billing-portal-session/`
- `/supabase/functions/create-payment-request/`
- `/supabase/functions/billing-invoices/`
- `/supabase/functions/send-billing-notices/`
- `/supabase/functions/send-payment-reminders/`
- `/supabase/functions/split-payment/`
- `/supabase/functions/terminal-payments/`
- `/supabase/functions/instant-payouts/`
- `/supabase/functions/issue-refund/`
- `/supabase/functions/public-payment/`
- `/supabase/functions/financing-*/`
- `/supabase/functions/capital-manage/`
- `/supabase/functions/enforce-payment-suspension/`
- `/supabase/functions/manage-subscription-*/`
- `/supabase/functions/membership-*/`
- `/supabase/functions/invoice-*/`
- `/supabase/functions/statements-run/`
- `/supabase/functions/results-plan-*/`
- `/supabase/functions/tax-taxjar/`
- `/supabase/functions/dispute-evidence/`
- `/supabase/functions/sla-credit-run/`
- `/supabase/functions/franchise-royalty-issue/`

### Accounting, CRM, calendar, payroll, listings integrations

Area: Edge functions - role `INTEGRATIONS`

- `/supabase/functions/acct-*/`
- `/supabase/functions/qbo-*/`
- `/supabase/functions/xero-*/`
- `/supabase/functions/intacct-*/`
- `/supabase/functions/ns-*/`
- `/supabase/functions/payroll-*/`
- `/supabase/functions/crm-*/`
- `/supabase/functions/hubspot-*/`
- `/supabase/functions/jobber-*/`
- `/supabase/functions/price-book-*/`
- `/supabase/functions/google-*/`
- `/supabase/functions/microsoft-calendar-*/`
- `/supabase/functions/gbp-sync/`
- `/supabase/functions/listings*/`
- `/supabase/functions/pm-*/`
- `/supabase/functions/provider-*/`
- `/supabase/functions/integration-reconcile/`
- `/supabase/functions/bank-*/`
- `/supabase/functions/chat-*/`
- `/supabase/functions/dm-*/`
- `/supabase/functions/external-world-sync/`
- `/supabase/functions/fabric-ingest/`
- `/supabase/functions/data-import-run/`
- `/supabase/functions/import-framework/`
- `/supabase/functions/event-bus-dispatch/`
- `/supabase/functions/webhook-outbox-worker/`
- `/supabase/functions/wallet-*/`
- `/supabase/functions/telematics-*/`
- `/supabase/functions/job-feeds/`
- `/supabase/functions/punchout-*/`
- `/supabase/functions/talent-*/`

### Voice, telephony, SMS and messaging channels

Area: Edge functions - role `VOICE`

- `/supabase/functions/voice-*/`
- `/supabase/functions/vapi-*/`
- `/supabase/functions/pbx-*/`
- `/supabase/functions/call-*/`
- `/supabase/functions/csr-*/`
- `/supabase/functions/dialer-call/`
- `/supabase/functions/outbound-dialer/`
- `/supabase/functions/live-*/`
- `/supabase/functions/proxy-call-bridge/`
- `/supabase/functions/interpreter*/`
- `/supabase/functions/sms-*/`
- `/supabase/functions/whatsapp-*/`
- `/supabase/functions/messenger-webhook/`
- `/supabase/functions/telegram-webhook/`
- `/supabase/functions/register-a2p-brand/`
- `/supabase/functions/clone-voice/`
- `/supabase/functions/delete-cloned-voice/`
- `/supabase/functions/rich-*/`
- `/supabase/functions/speed-to-lead-intake/`

### Authentication, access control, security and trust

Area: Edge functions - role `SECURITY`

- `/supabase/functions/admin-sso/`
- `/supabase/functions/auth-*/`
- `/supabase/functions/check-ip-policy/`
- `/supabase/functions/login-alert/`
- `/supabase/functions/mfa-recovery/`
- `/supabase/functions/otp-request/`
- `/supabase/functions/scim-v2/`
- `/supabase/functions/security-event-notify/`
- `/supabase/functions/siem-stream/`
- `/supabase/functions/staff-impersonate/`
- `/supabase/functions/trust-*/`
- `/supabase/functions/trusted-device/`
- `/supabase/functions/audit-*/`
- `/supabase/functions/fraud-*/`
- `/supabase/functions/identity-signal-scan/`
- `/supabase/functions/release-guard-tick/`
- `/supabase/functions/check-credential-expirations/`

### Privacy, retention, exports and compliance

Area: Edge functions - role `COMPLIANCE`

- `/supabase/functions/compliance-*/`
- `/supabase/functions/data-retention-sweep/`
- `/supabase/functions/delete-account/`
- `/supabase/functions/homeowner-delete-account/`
- `/supabase/functions/dsar-request/`
- `/supabase/functions/tenant-export/`
- `/supabase/functions/tenant-import/`
- `/supabase/functions/export-run/`
- `/supabase/functions/subprocessor-notice-dispatch/`
- `/supabase/functions/unsubscribe-status-updates/`
- `/supabase/functions/email-unsubscribe/`
- `/supabase/functions/conversation-intel-purge/`
- `/supabase/functions/quote-video-retention-sweep/`
- `/supabase/functions/voice-consent/`
- `/supabase/functions/ai-disclosure-drift-scan/`
- `/supabase/functions/ai-eval-run/`

### Reliability, DR, observability

Area: Edge functions - role `PLATFORM`

- `/supabase/functions/dr-*/`
- `/supabase/functions/observability-alerts/`
- `/supabase/functions/slo-evaluate/`
- `/supabase/functions/synthetic-*/`

### AI core shared code

Area: Edge functions - role `SECURITY`

- `/supabase/functions/_shared/ai-core/`

### Voice security shared code and Vapi webhook

Area: Edge functions - role `VOICE`

- `/supabase/functions/_shared/voice-security/`
- `/supabase/functions/vapi-webhook/`

### SQL migrations (schema review gate)

Area: Database - role `DATA`

- `/supabase/migrations/`

### Database tests and Supabase config

Area: Database - role `DATA`

- `/supabase/tests/`
- `/supabase/config.toml`

### Seed and demo data

Area: Database - role `DATA`

- `/supabase/seed/`
- `/demo-seed.sql`

### Security tooling and docs

Area: Security - role `SECURITY`

- `/scripts/security/`
- `/docs/security/`
- `/SECURITY.md`
- `/.gitleaks.toml`

### AI governance scripts

Area: Security - role `SECURITY`

- `/scripts/ai-governance/`

### AI governance documents

Area: Compliance - role `COMPLIANCE`

- `/docs/ai-governance/`

### Native projects and release docs

Area: Mobile - role `MOBILE`

- `/ios/`
- `/android/`
- `/capacitor.config.ts`
- `/docs/MOBILE_RELEASE.md`

### Voice red-team evals and docs

Area: Voice - role `VOICE`

- `/eval/voice-redteam/`
- `/docs/voice/`

### CI, governance scripts, supply chain

Area: Platform - role `PLATFORM`

- `/.github/`
- `/scripts/governance/`
- `/scripts/supply-chain/`
- `/package.json`
- `/package-lock.json`
- `/docs/adr/`
- `/docs/governance/`

### Licence policy and asset licences

Area: Platform - role `COMPLIANCE`

- `/docs/governance/license-policy.json`
- `/docs/governance/ASSET_LICENSES.csv`

### Compliance and business registers (not legal advice)

Area: Compliance - role `COMPLIANCE`

- `/docs/compliance/`
- `/docs/registers/`
- `/docs/claims-register.json`
- `/scripts/check-claims.mjs`
- `/scripts/registers/`

## Notes

- Migrations have one owner on purpose: every schema change gets the database owners' review. Adding a feature team as a second owner on the same rule would let either approve alone, which weakens that gate.
- A new edge function that matches no group below falls into the core edge-function group (`/supabase/functions/`). `npm run owners:check` lists such functions so they can be classified.
- Where several owners are listed on one line, a review from any one of them satisfies Code Owners review. [VERIFY against GitHub documentation for your plan]
