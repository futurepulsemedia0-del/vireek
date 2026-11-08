# Settings Center — Phase 0: Audit, Inventory, Proposed IA

Status: DRAFT for confirmation. Source: uploaded `vireek-main.zip` (static inspection only; nothing was built, run or tested; the ZIP may lag the live repo).

## 1. Verified vs. corrected starting point

| Claim in brief | Result |
|---|---|
| SettingsPage ~465 lines | 485 lines. Holds notification prefs (writes `profiles`), RegionalSettingsCard, PushNotificationsCard, and link-cards to other pages. |
| >=18 routes under /dashboard/settings/* | **Understated: 24 routes today (25 with the new `/settings/account`)** (list in section 2). |
| Nav lists ~11 settings entries | Settings-related entries are spread over a much larger nav array (Business Profile, Branding, Booking Settings, Payment Pricing, Locations, Regional Packs, Team, Billing, Slack & Teams, API Usage, Email, Settings, Chat Widget, Website Widgets, Trust Badge, Call Tracking, ...). Special-case active state is at `DashboardNav.tsx` ~L726-727 (`/dashboard/settings` excludes `/settings/email` by hand). |
| rounded-2xl/3xl ~33 times | 14 in SettingsPage.tsx; 27 files across settings pages/components contain them (not counted line by line). |
| No settings hub/search | Confirmed: SettingsPage is a list of link-cards, not a hub. No settings registry found. |
| Reusable primitives | **Exist, so reuse (do not rebuild):** `src/components/forms/Form.tsx`, `UnsavedChangesDialog.tsx`, `src/hooks/forms/useUnsavedChanges.ts` (route blocker + beforeunload + modal close; needs data router, `DataRouterShell` exists), `CommandPalette.tsx`, `GlobalSearchPalette.tsx`, `src/lib/globalSearch.ts`, `src/lib/keyboardShortcuts.ts`, `ui/{Switch,Select,Input,PageHeader,Panel,StatusDot,Tooltip}`. Scripts: `check-design-system.mjs`, `design/ai-tells.mjs`, `check-raw-locale.mjs`, `color/check-colors.mjs`. e2e dir with `accessibility.spec.ts` exists. |
| Audit infra | `audit_log` (migration `20260831090000_notifications_and_audit_log.sql`); `src/lib/auditLog.ts` is **read-only**: "no client write path", RLS `owner_select_audit_log` = `user_id = auth.uid()`. Consequence: per-setting audit must be written server-side (DB trigger or edge function), and managers with `can_view_audit_log` cannot read it under the current policy. |

### New findings that change the plan
1. **Route-level authorization is absent.** Every settings route in `App.tsx` is only `<ProtectedRoute>`. Permissions (`can_edit_business_profile`, `can_manage_team`, `can_view_billing`, `can_manage_security`, `can_manage_numbers`, `can_view_audit_log`, `can_export_data`) are enforced only by hiding nav items and by each page. A deep link to a hidden page is reachable. The registry + a `RequirePermission` wrapper must close this (UI-level; real enforcement must stay in RLS/edge functions, which I have not audited per table).
2. `SettingsPage.tsx` has **0 `useTranslation` usages**: its strings are not in i18next. (Also L138 reads `useAuth();)` ... — likely a copy artifact; verify in the live file.)
3. Redirect precedent is a single `<Navigate replace>` (App.tsx ~L2590). Client-side `<Navigate>` is not a 301. Real 301s need `vercel.json` / `wrangler.jsonc` rules (both exist, so deployment target must be confirmed — decision D3).
4. Page-level access mixes `isOwner` (SettingsPage) and permission keys (nav) for the same pages: e.g. SMS compliance, Data governance are owner-only in SettingsPage, un-gated at route level.

## 2. Page inventory (verified from App.tsx / DashboardNav.tsx / SettingsPage.tsx)

Columns: route -> component; nav gate (from nav); SettingsPage card gate; proposed group. Storage, save behavior, audit coverage and plan gating per **setting** are NOT yet verified (see section 5).

| Route | Component | Nav gate | Hub-card gate | Proposed group |
|---|---|---|---|---|
| /dashboard/settings | SettingsPage | none | — | My account (+ hub home) |
| /dashboard/settings/security | SecuritySettingsPage | — | isOwner | Security |
| /dashboard/settings/sessions | SessionsPage | — | all | My account / Security |
| /dashboard/settings/locations | LocationsSettingsPage | can_edit_business_profile | — | Business |
| /dashboard/settings/audit-log | AuditLogPage | — | isOwner | Security |
| /dashboard/settings/siem-streaming | SiemStreamingPage | — | isOwner | Security |
| /dashboard/settings/regional-packs | RegionalPacksSettingsPage | can_edit_business_profile | — | Business |
| /dashboard/settings/enterprise-security | EnterpriseSecurityPage | — | isOwner | Security |
| /dashboard/settings/data-governance | DataGovernancePage | — | isOwner | Data & privacy |
| /dashboard/settings/api-keys | ApiKeysPage | — | isOwner | Integrations |
| /dashboard/settings/email | EmailSettingsPage | can_edit_business_profile | isOwner or can_edit_business_profile | Communication |
| /dashboard/settings/api-usage | ApiUsagePage | none | — | Integrations |
| /dashboard/settings/oauth-apps | OAuthAppsPage | — | isOwner | Integrations |
| /dashboard/settings/sms-compliance | SmsCompliancePage | — | isOwner | Communication |
| /dashboard/settings/voice-studio | VoiceStudioPage | — | — | Calls & AI |
| /dashboard/settings/voice | VoiceSettingsPage (route at App.tsx L962) | — | — | Calls & AI |
| /dashboard/settings/assistant | AssistantPersonaPage | — | all | Calls & AI |
| /dashboard/settings/branding | BrandingSettingsPage | can_edit_business_profile | — | Business |
| /dashboard/settings/rich-messaging | RichMessagingSettingsPage | — | — | Communication |
| /dashboard/settings/messaging-channels | MessagingChannelsSettingsPage | — | — | Communication |
| /dashboard/settings/chat-widget | ChatWidgetSettingsPage | can_edit_business_profile | — | Communication |
| /dashboard/settings/website-widgets | WebsiteWidgetsPage | can_edit_business_profile | — | Communication |
| /dashboard/settings/call-tracking | DynamicNumbersPage | can_edit_business_profile | — | Calls & AI |
| /dashboard/settings/trust-badge | TrustBadgeSettingsPage | can_edit_business_profile | — | Business |
| /dashboard/settings/slack-teams | SlackTeamsSettingsPage | can_manage_team | — | Communication |
| /dashboard/business-profile | (L2616) | can_edit_business_profile | — | Business |
| /dashboard/booking-settings | BookingSettingsPage | can_edit_business_profile | — | Booking |
| /dashboard/payment-pricing | PaymentPricingSettingsPage | can_edit_business_profile | — | Billing & payments |
| /dashboard/job-quality-gate | JobQualityGateSettingsPage (L3198) | — | — | Booking & jobs |
| /dashboard/dashboard-builder | DashboardBuilderPage | can_manage_team | — | My account (personalization) |
| /dashboard/team, /team/org-chart, /team/:id | team pages | can_manage_team | — | Team & access |
| /dashboard/billing (+ plans, invoices, update-payment, cancel) | billing pages | can_view_billing | — | Billing (link out) |

Not yet located (named in brief, need a file search in the live repo): WallboardSettingsPage, InsightsSettingsPage, MobileSurfacesSettingsPage, InterpreterSettingsPage route, webhooks UI, `/dashboard/trust-pack`, Google Booking, Agent Readiness. In-page components with their own settings: PasskeysCard, QuietHoursSettings, EscalationSettings, DailyBriefingSettings, VoiceCloningCard, ArrivalWindowSettingsCard, AutoReplySettingsCard, AgentOrchestrationSettings, BookingLinkCard, LanguagePreferences, EnterpriseDataExportPanel, FuelSettingsPanel, JobSummarySettingsForm, FlowSettings (call-routing), InterpreterSettingsCard.

Contradictions already visible: SMS compliance / Data governance owner-only on the hub but un-gated in the router; "Settings" nav item and "Business Profile" nav item share the `Settings` icon; Trust Badge and Website Widgets both use the `Globe` icon; `Email Settings` hard-excluded from Settings active state.

## 3. Proposed information architecture (needs confirmation)

Hub `/dashboard/settings` -> persistent sub-nav. Personal vs. organization shown as two labelled sections.

**Personal**
1. My account: Profile & language, Notifications (channels, quiet hours, daily briefing), Passkeys & sign-in, My sessions, Dashboard personalization
**Organization**
2. Business: Business profile, Branding, Hours, Locations, Regional & compliance packs, Trust badge
3. Team & access: Members, Roles & permissions, Org chart (link to /dashboard/team)
4. Calls & AI: Assistant, Voice & voice studio, Escalation & emergency routing, Call tracking numbers, Interpreter
5. Booking & scheduling: Booking, Arrival windows, Capacity, Job quality gate
6. Communication: Email, SMS compliance, Messaging channels, Rich messaging, Chat widget, Website widgets, Slack & Teams
7. Integrations & developers: API keys, OAuth apps, API usage, Webhooks
8. Security & compliance: Security, Enterprise security, Audit log, SIEM streaming
9. Data & privacy: Data governance, Export, Retention, Deletion (Danger zone lives here)
10. Billing & payments: link out to /dashboard/billing; Payment pricing stays a settings page

Split of "Sessions": **My sessions** -> My account; **org-wide session policy** -> Security (the brief lists it twice).

## 4. Route migration map (proposed; slugs stay, nothing is removed)

Principle: keep every existing URL as canonical wherever possible, so only the 4 non-`/settings/` pages need moving.

| Old | New | Mechanism |
|---|---|---|
| /dashboard/business-profile | /dashboard/settings/business-profile | 301 (host rule) + `<Navigate replace>` fallback |
| /dashboard/booking-settings | /dashboard/settings/booking | same |
| /dashboard/payment-pricing | /dashboard/settings/payment-pricing | same |
| /dashboard/job-quality-gate | /dashboard/settings/job-quality-gate | same |
| /dashboard/settings/* (24 existing + account) | unchanged URL, rendered inside the hub layout | layout route |
Open: `/dashboard/team*` and `/dashboard/billing*` stay outside the hub (linked, not moved).

## 5. What is NOT done yet in Phase 0 (honest list)
- Per-setting rows (id, storage table/column/localStorage, save behavior, audit coverage, plan gating, copy/jargon problems) are not generated. They need a read of ~30 pages + 15 components; I verified route/page level only. Plan: generate with a script (`scripts/docs/gen-settings-inventory.mjs`, similar to existing `gen-surface-inventory.mjs`) and then hand-review.
- Plan gating: no plan field was inspected. Audit coverage per write: not checked; known fact is only that the client cannot write `audit_log`.
- RLS on each settings table: not inspected.
- Nothing executed: no build, tsc, vitest, lint, Playwright.

## 6. Decisions needed from you
D1. Confirm groups/order in section 3 (esp. Sessions split, Team stays outside hub, Billing link-out).
D2. Move the 4 root-level pages under /settings (section 4), or keep their URLs and only list them in the hub?
D3. Production host for real 301s: Vercel (`vercel.json`) or Cloudflare (`wrangler.jsonc` / `cf-build.sh`)? Both exist in the repo.
D4. May managers with `can_view_audit_log` read the audit log / per-setting history? Today RLS is owner-only (`user_id = auth.uid()`), so this needs a policy change.
D5. Two-person approval and step-up re-auth: build now behind a flag, or defer?
