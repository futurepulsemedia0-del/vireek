# Edge function catalog

> Generated from `supabase/functions/*/index.ts` and `supabase/config.toml` by a static scan. "Purpose" is the first header comment (blank = no header comment; open the file). `verify_jwt` shows `supabase/config.toml` only; functions not listed there use the Supabase default.

Total function folders: **396**. `verify_jwt = false` entries in config.toml: **41** of 41.

Columns: **Auth** = verify_jwt setting; **Guards** = signature/secret patterns detected by grep (not a security review); **Env** = `Deno.env.get` names.

## AI, voice & telephony (54)

| Function | Purpose (header comment) | Auth | Guards | Env vars |
|---|---|---|---|---|
| `ads-oauth-callback` | Deploy: supabase functions deploy ads-oauth-callback --no-verify-jwt | default (true) | — | `ADS_STATE_SECRET`, `SITE_URL`, `SUPABASE_URL` |
| `agent-runtime` | Vireek AI Agent Marketplace — runtime broker ("sandbox"). | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `ai-assistant-query` | SECURITY MODEL (read this before changing anything below) | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `ai-disclosure-drift-scan` | Detects drift between business_profile.ai_disclosure_script and the LIVE | default (true) |  + cron secret | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VAPI_PRIVATE_KEY` |
| `ai-eval-run` | یک eval suite کامل رو اجرا و نتیجه رو ثبت می‌کنه. فقط برای owner/admin | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `analyze-callback-root-cause` | On-demand (same shape as capacity-demand-insight/index.ts): runs AS the | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `auto-reply-review` | Human-approval endpoint for AI drafts (Unified Inbox → "Approve & send" / "Reject"). | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `call-bridge-voice` | Public Twilio webhook (verify_jwt=false) for BOTH call masking and the power dialer. | false | HMAC/secret header | `CALL_BRIDGE_WEBHOOK_BASE`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TWILIO_AUTH_TOKEN` |
| `call-quality-review` | AI Quality Center reviewer. Scores finished calls, flags hallucinations / | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `call-queue-sms` | One-click text from the Priority Call Queue. Same compliance posture as | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `call-script-simulate` | Test-call simulator for the Call Scripts dashboard page. Runs AS the | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `chat-slack-oauth-callback` | Slack redirects the browser here after the user approves the app. | default (true) | — | `CHAT_TOKEN_ENCRYPTION_KEY`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET` |
| `chat-teams-oauth-callback` | Entra redirects the browser here. We only need the tenant id (`tid`) — no Graph permissions are requested. | default (true) | — | `TEAMS_OAUTH_CLIENT_ID`, `TEAMS_OAUTH_CLIENT_SECRET`, `TEAMS_STATE_SECRET` |
| `clone-voice` | Takes an already-uploaded voice sample from the private `voice-samples` | default (true) | — | `ELEVENLABS_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `conversation-intel-analyze` | Conversation Intelligence — analyse ONE consented in-home recording. | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `conversation-intel-purge` | Retention + deletion worker for Conversation Intelligence. | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `csr-call-transfer` | Live-transfers an in-progress Vapi call to a human from the CSR desk | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VAPI_PRIVATE_KEY` |
| `demo-chat` | Public, unauthenticated endpoint powering the "Talk to Sarah" widget. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `diagnosis-copilot` | AI Diagnosis-to-Resolution Copilot. | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `dialer-call` | "Call" button of the power dialer. Runs AS the signed-in agent. Order of checks (all on the server): | default (true) | — | `CALL_BRIDGE_WEBHOOK_BASE`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |
| `dispatch-copilot` | "Ask AI Copilot" on the Dispatch Board (src/pages/DispatchBoardPage.tsx). | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `estimate-recovery-agent` | Estimate-to-Cash Recovery Agent | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `first-call-start` | "Call Sarah now": rings the OWNER's phone with their own Sarah assistant via Vapi. | false | HMAC/secret header | `FIRST_CALL_ALLOWED_CODES`, `FIRST_CALL_CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VAPI_PRIVATE_KEY` |
| `followup-agent-dispatcher` | Replaces outbound-dialer. Runs on the same kind of schedule (every few | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VAPI_PRIVATE_KEY` |
| `followup-agent-enroller` | Replaces outbound-queue-builder as the thing an external cron hits on a | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `google-calendar-oauth-callback` | Deploy: supabase functions deploy google-calendar-oauth-callback --no-verify-jwt | default (true) | — | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_STATE_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `home-health-agent` | Autonomous Home Maintenance Agent. | default (true) | HMAC/secret header | `CRON_SECRET`, `SITE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `homeowner-assistant` | Vireek Home assistant. The model only sees a compact FACT PACK built from the | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `knowledge-embed` | Re-embeds knowledge articles whose content changed. | default (true) |  + cron secret | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `knowledge-search` | — | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `listings-oauth-callback` | Deploy: supabase functions deploy listings-oauth-callback --no-verify-jwt | default (true) | HMAC/secret header | `LISTINGS_STATE_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `live-call-control` | "Take over" / "Transfer to team" for a call that is happening right now. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VAPI_PRIVATE_KEY` |
| `live-copilot` | Live Multimodal Technician Copilot. | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `mcp-server` | Vireek Agent Network — one governed door for external AI agents. | default (true) | — | `SITE_URL`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `membership-lifecycle-agent` | Membership / Service Agreement Lifecycle Agent | default (true) | HMAC/secret header | `CRON_SECRET`, `SITE_URL`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `microsoft-calendar-oauth-callback` | Deploy: supabase functions deploy microsoft-calendar-oauth-callback --no-verify-jwt | default (true) | — | `MICROSOFT_CALENDAR_CLIENT_ID`, `MICROSOFT_CALENDAR_CLIENT_SECRET`, `MICROSOFT_CALENDAR_STATE_SECRET`, `MICROSOFT_CALENDAR_TENANT_ID`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY` … |
| `operator-agent` | OPERATOR AGENT — multi-step requests from Cmd+K | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `outbound-dialer` | — | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VAPI_PRIVATE_KEY` |
| `ovb-call-webhook` | Server URL for the Vapi *caller bot* used by phone runs (see startPhoneCall in | default (true) | HMAC/secret header | `OVB_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `ovb-public` | Public (no-JWT) endpoint of the Open Voice Benchmark. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `ovb-run` | Open Voice Benchmark orchestrator. Staff JWT (profiles.is_staff) OR X-Cron-Secret. | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `pbx-actions` | Authenticated actions for the softphone and Phone System pages. Every action | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `pbx-voice` | Twilio Voice webhook router for the business phone system. Public endpoint | false | HMAC/secret header | `PBX_TICK_SECRET`, `PBX_WEBHOOK_BASE`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TWILIO_AUTH_TOKEN` |
| `permit-transaction-agent` | Permit Transaction Agent - "prepare" step. | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `price-book-connect-housecallpro` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `property-intelligence-agent` | Property Intelligence OS — the autonomous physical-world loop. | default (true) | HMAC/secret header | `CRON_SECRET`, `SITE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `proxy-call-bridge` | "Call customer" button for technicians (and dispatchers). Runs AS the signed-in user: the database | default (true) | — | `CALL_BRIDGE_WEBHOOK_BASE`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |
| `reputation-oauth-callback` | Deploy: supabase functions deploy reputation-oauth-callback --no-verify-jwt | default (true) | HMAC/secret header | `REPUTATION_STATE_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `service-recovery-agent` | Service Recovery & Complaint Prevention Agent | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `site-assistant` | Public, unauthenticated endpoint powering the site-wide "Ask Vireek" | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `tribal-knowledge-manual-ingest` | Company Brain — Manual / Spec-Sheet Ingestion | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `tribal-knowledge-voice-capture` | Company Brain — Technician Voice Note → Knowledge Article | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `vapi-webhook` | — | default (true) | HMAC/secret header |  |
| `video-ice` | Issues short-lived ICE servers (STUN + TURN) for a live video session. | false | — | `CF_TURN_API_TOKEN`, `CF_TURN_KEY_ID`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TURN_CREDENTIAL`, `TURN_URLS` … |

## Accounting / CRM / ERP / payroll (29)

| Function | Purpose (header comment) | Auth | Guards | Env vars |
|---|---|---|---|---|
| `acct-oauth-callback` | OAuth redirect target for Xero and Zoho Books. Secrets: see acct-oauth-start/index.ts. | false | — | `ACCT_STATE_SECRET`, `ACCT_TOKEN_ENCRYPTION_KEY`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `acct-oauth-start` | Starts (or, for NetSuite, completes) the connection to Xero, Zoho Books or NetSuite. | default (true) |  + cron secret | `ACCT_STATE_SECRET`, `ACCT_TOKEN_ENCRYPTION_KEY`, `NETSUITE_M2M_ALG`, `NETSUITE_M2M_CERT_PEM`, `NETSUITE_M2M_PRIVATE_KEY`, `SUPABASE_ANON_KEY` … |
| `acct-sync-run` | Two-way sync of accounts, customers, items, invoices and payments with Xero, Zoho Books and NetSuite. | false | HMAC/secret header | `ACCT_TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `NETSUITE_M2M_ALG`, `NETSUITE_M2M_PRIVATE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` … |
| `acct-webhook` | Receives Xero webhooks (an invoice or contact changed) and asks acct-sync-run to pull right away, so Xero | false | HMAC/secret header | `CRON_SECRET`, `SUPABASE_URL`, `XERO_WEBHOOK_KEY` |
| `crm-oauth-callback` | OAuth redirect target for Salesforce, Pipedrive and Zoho CRM (mirrors | default (true) | — | `CRM_STATE_SECRET`, `CRM_TOKEN_ENCRYPTION_KEY`, `SALESFORCE_LOGIN_URL`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` … |
| `crm-oauth-start` | Starts the OAuth connection for Salesforce, Pipedrive or Zoho CRM. | default (true) |  + cron secret | `CRM_STATE_SECRET`, `CRM_TOKEN_ENCRYPTION_KEY`, `SALESFORCE_LOGIN_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_URL`, `ZOHO_ACCOUNTS_URL` |
| `crm-sync-run` | Two-way sync of contacts, leads and deals with Salesforce, Pipedrive and Zoho CRM. | default (true) | HMAC/secret header | `CRM_TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `fx-rates-refresh` | Daily cron (see migration header). Stores USD-based rates in fx_rates. | default (true) | HMAC/secret header | `FX_CRON_SECRET`, `FX_RATES_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `hubspot-oauth-callback` | Deploy: supabase functions deploy hubspot-oauth-callback --no-verify-jwt | default (true) | — | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_STATE_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `hubspot-oauth-start` | Required secrets: | default (true) | — | `HUBSPOT_CLIENT_ID`, `HUBSPOT_STATE_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `intacct-connect` | Connects a Sage Intacct company (NOT LIVE-VERIFIED). Intacct web services use a sender id (Vireek's own | default (true) |  + cron secret | `INTACCT_ENCRYPTION_KEY`, `INTACCT_SENDER_ID`, `INTACCT_SENDER_PASSWORD`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `intacct-sync-run` | Two-way sync of GL accounts, customers, invoices and payments with Sage Intacct. | default (true) | HMAC/secret header | `CRON_SECRET`, `INTACCT_ENCRYPTION_KEY`, `INTACCT_SENDER_ID`, `INTACCT_SENDER_PASSWORD`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` … |
| `jobber-oauth-callback` | — | default (true) | — | `JOBBER_STATE_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `jobber-oauth-start` | — | default (true) | — | `JOBBER_CLIENT_ID`, `JOBBER_STATE_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `ns-connect` | Connects a NetSuite account with Token-Based Authentication (NOT LIVE-VERIFIED). | default (true) | — | `NS_TOKEN_ENCRYPTION_KEY`, `QBO_TOKEN_ENCRYPTION_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `ns-sync-run` | Sync of customers, service items, invoices and payments with NetSuite (SuiteTalk REST, token auth). | default (true) | HMAC/secret header | `CRON_SECRET`, `NS_TOKEN_ENCRYPTION_KEY`, `QBO_TOKEN_ENCRYPTION_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `payroll-connect` | Connects a payroll provider (Gusto first). One function, two entry points: | default (true) | — | `GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET`, `GUSTO_ENVIRONMENT`, `PAYROLL_STATE_SECRET`, `PAYROLL_TOKEN_ENCRYPTION_KEY`, `SITE_URL` … |
| `payroll-connector` | Server side of /dashboard/payroll-connectors for the Gusto API connection (the file providers | default (true) | — | `GUSTO_API_VERSION`, `GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET`, `GUSTO_ENVIRONMENT`, `PAYROLL_STATE_SECRET`, `PAYROLL_TOKEN_ENCRYPTION_KEY` … |
| `payroll-connector-oauth-callback` | OAuth redirect target for Gusto. Secrets: see payroll-connector/index.ts. | false | — | `GUSTO_API_VERSION`, `GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET`, `GUSTO_ENVIRONMENT`, `PAYROLL_STATE_SECRET`, `PAYROLL_TOKEN_ENCRYPTION_KEY` … |
| `payroll-sync` | All payroll-provider actions after connecting. Every call needs the user's JWT and can_manage_payroll_sync(). | default (true) | — | `GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET`, `PAYROLL_TOKEN_ENCRYPTION_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `qbo-oauth-callback` | OAuth redirect target for QuickBooks Online. Secrets: see qbo-oauth-start/index.ts. | default (true) | — | `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT`, `QBO_STATE_SECRET`, `QBO_TOKEN_ENCRYPTION_KEY`, `SITE_URL` … |
| `qbo-oauth-start` | Starts the QuickBooks Online connection (Intuit OAuth 2.0, authorization-code flow). | default (true) |  + cron secret | `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_STATE_SECRET`, `QBO_TOKEN_ENCRYPTION_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `qbo-sync-run` | Two-way sync of accounts, customers, items, invoices and payments with QuickBooks Online. | default (true) | HMAC/secret header | `CRON_SECRET`, `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_TOKEN_ENCRYPTION_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` … |
| `qbo-webhook` | Receives Intuit webhooks (a record changed in QuickBooks) and asks qbo-sync-run to pull right away, | default (true) | HMAC/secret header | `CRON_SECRET`, `QBO_WEBHOOK_VERIFIER_TOKEN`, `SUPABASE_URL` |
| `supplier-price-feed` | Lets ONE supplier (or an integration acting for it) push catalog prices and order delivery | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `xero-oauth-callback` | OAuth redirect target for Xero. Secrets: see xero-oauth-start/index.ts. | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_STATE_SECRET` … |
| `xero-oauth-start` | Starts the Xero connection (OAuth 2.0 authorization-code flow). The browser calls this with the | default (true) |  + cron secret | `SUPABASE_ANON_KEY`, `SUPABASE_URL`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_STATE_SECRET`, `XERO_TOKEN_ENCRYPTION_KEY` |
| `xero-sync-run` | Sync of accounts, contacts, items, invoices, payments and tax rates with Xero (multi-currency aware). | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` … |
| `xero-webhook` | Receives Xero webhooks (an invoice or contact changed) and asks xero-sync-run to pull right away. | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_URL`, `XERO_WEBHOOK_KEY` |

## Billing & payments (43)

| Function | Purpose (header comment) | Auth | Guards | Env vars |
|---|---|---|---|---|
| `billing-invoices` | Read-only feed for /dashboard/billing/invoices: the account's Vireek | default (true) | — | `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `capital-manage` | Owner/admin: Vireek Capital. Vireek NEVER decides credit. | default (true) | — |  |
| `commercial-collections-run` | Daily cron: commercial follow-up ladder + overdue ledger sync. | default (true) | HMAC/secret header | `COMMERCIAL_COLLECTIONS_CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `create-billing-portal-session` | Creates a Stripe Billing Portal session pre-scoped to the "update payment | default (true) | — | `SITE_URL`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `create-payment-request` | — | default (true) | — | `SITE_URL`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `dispute-evidence` | Authenticated actions on one dispute: { action: 'submit' \| 'accept' \| 'sync', dispute_id: <stripe_disputes.id> } | default (true) | — | `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `enforce-payment-suspension` | The actual "cut off service" half of dunning. `stripe-webhook` reacts to | default (true) |  + cron secret | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `instant-payouts` | — | default (true) | — | `INSTANT_PAYOUT_MIN_ACCOUNT_AGE_DAYS`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `invoice-email` | Sends (or re-sends / reminds about) an invoice by email and records it in | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `invoice-followup-ladder` | Approval-to-Cash follow-up ladder (cron). | false | HMAC/secret header | `APPROVAL_TO_CASH_CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `invoice-split-email` | Emails a payer their private pay link for one share of a split invoice. | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `lien-waiver-email` | Emails a lien-waiver signing link (kind = "request") or the signed copy (kind = "copy"). | default (true) | — | `SITE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `manage-subscription-cancellation` | Backend for /dashboard/billing/cancel (src/pages/CancelSubscriptionPage.tsx). | default (true) | — | `STRIPE_SECRET_KEY`, `STRIPE_WINBACK_COUPON_ID`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `manage-subscription-plan` | Backend for /dashboard/billing/plans. One authenticated POST endpoint with | default (true) | — | `SITE_URL`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `money-recovered-run` | Weekly "Money Recovered" statement generator + scheduler. | false | HMAC/secret header | `MONEY_RECOVERED_CRON_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SITE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` … |
| `pay-by-bank-actions` | Authenticated owner/billing actions: { action: 'capability_status' } \| { action: 'enable_capability' } | default (true) | — | `STRIPE_ACH_DEBIT_ENABLED`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `pay-by-bank-reconcile` | Cron (every 30 min, see migration header). Secret header: X-Cron-Secret = PAY_BY_BANK_CRON_SECRET. | default (true) | HMAC/secret header | `PAY_BY_BANK_CRON_SECRET`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `pay-card-manage` | Owner/admin: issue a spend card, freeze/unfreeze/cancel it, change limits, and (sandbox only) | default (true) | — |  |
| `pay-transfer-request` | Technician-facing: quote and request an instant payout or an earned-wage advance. | default (true) | — |  |
| `pay-webhook` | Provider webhooks for LIVE partners (and signed sandbox events). One endpoint, three kinds: | false | — |  |
| `payment-plan-actions` | Authenticated actions: { action: 'send', plan_id } \| { action: 'charge_now', installment_id } | default (true) | — | `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `payment-plan-pay` | PUBLIC link target (deploy with --no-verify-jwt). The UUID in the URL is the capability (same model as | default (true) | — | `SITE_URL`, `STRIPE_ACH_DEBIT_ENABLED`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `payment-plan-runner` | Hourly cron (see migration header). Order matters: late fees -> auto-charges (so a fee is included in the charge) -> reminders. | default (true) | HMAC/secret header | `PAYMENT_PLAN_CRON_SECRET`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `payment-plan-webhook` | Dedicated endpoint (secret: STRIPE_PLAN_WEBHOOK_SECRET). Events: checkout.session.completed, payment_intent.succeeded. | default (true) | Stripe signature | `STRIPE_PLAN_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `phone-payment-control` | Staff-initiated secure card capture on a live call: { action: "start", vapi_call_id, job_id } or | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `phone-payment-webhook` | Twilio <Pay> callbacks (step=status for progress, step=action for the result). | default (true) | HMAC/secret header | `PCI_SESSION_HMAC_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TWILIO_AUTH_TOKEN` |
| `public-payment` | — | default (true) | — | `SITE_URL`, `STRIPE_ACH_DEBIT_ENABLED`, `STRIPE_ACSS_DEBIT_ENABLED`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY` … |
| `punchout-return` | punchout-return — PUBLIC endpoint the supplier's website posts the shopping cart to | false | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `punchout-session` | punchout-session — dashboard-called API for supplier cXML PunchOut connections and sessions. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `send-payment-reminders` | — | default (true) | HMAC/secret header | `PAYMENT_REMINDER_CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `sla-credit-run` | Monthly SLA settlement. Suggested schedule: daily at 02:00 UTC (idempotent). | default (true) | HMAC/secret header | `STRIPE_SECRET_KEY` |
| `split-payment` | Public pay page backend for one payer's share of a split invoice. | default (true) | — | `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `statements-run` | Customer statements of account — email delivery. | default (true) | HMAC/secret header | `CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `stripe-connect-onboarding` | — | default (true) | — | `SITE_URL`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `stripe-dispute-webhook` | Dedicated endpoint for charge.dispute.* so the existing payment webhook is untouched. | default (true) | Stripe signature | `STRIPE_DISPUTE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `stripe-payment-webhook` | — | default (true) | Stripe signature | `STRIPE_PAYMENT_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `stripe-webhook` | Receives Stripe billing events and drives the dunning lifecycle: | default (true) | Stripe signature | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SITE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` … |
| `supplier-statement-parse` | Reads ONE supplier statement/invoice (PDF or image) from the private `supplier-statements` bucket and returns | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `tax-taxjar` | POST { action: "connect", api_key }            -> validates the key, stores it server-side | default (true) | — |  |
| `terminal-payments` | Stripe Terminal / Tap to Pay backend for the technician app. | default (true) | — | `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `wallet-issue` | Issues (or re-uses) a wallet pass and optionally texts the customer the "Add to Wallet" link. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `wallet-pass` | PUBLIC wallet endpoint (Apple's web service + customer downloads). | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `wallet-sync` | Cron worker: drains wallet_push_outbox (filled by DB triggers when an ETA, technician, balance, status or | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |

## Messaging & notifications (32)

| Function | Purpose (header comment) | Auth | Guards | Env vars |
|---|---|---|---|---|
| `arrival-window-notify` | Arrival-window customer notifications — cron worker. | default (true) | HMAC/secret header | `CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `blog-newsletter` | Double opt-in newsletter for the blog. POST JSON { action: 'subscribe' \| 'confirm' \| 'unsubscribe', ... } | default (true) | — | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `chat-integrations` | Backend for /dashboard/settings/slack-teams. One function, two jobs: | default (true) | — |  |
| `chat-notify-admin` | Authenticated (owner-only) helper for the Integrations UI. | default (true) | — |  |
| `chat-slack-oauth-start` | Starts the Slack OAuth (v2) install flow. Owner-only. | default (true) | — | `SLACK_CLIENT_ID`, `SLACK_STATE_SECRET` |
| `chat-slack-webhook` | Single Request URL for Slack's "Interactivity & Shortcuts" (button clicks) AND "Event Subscriptions" | default (true) | HMAC/secret header | `SLACK_SIGNING_SECRET` |
| `chat-teams-bot` | Bot Framework messaging endpoint ("Messaging endpoint" of your Azure Bot): | default (true) | — | `TEAMS_BOT_APP_ID` |
| `chat-teams-oauth-start` | Starts the Microsoft Entra sign-in that links a Microsoft 365 tenant to the Vireek account. Owner-only. | default (true) | — | `TEAMS_OAUTH_CLIENT_ID`, `TEAMS_STATE_SECRET` |
| `direct-mail-send` | Sends (or resumes) a postcard campaign through the print API. Authenticated; the caller must be a manager. | default (true) | — | `LOB_API_VERSION`, `SITE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `direct-mail-settings` | Stores the account's print-provider (Lob) credentials ENCRYPTED. The browser never receives them back. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `direct-mail-verify` | Checks every unverified, still-queued recipient of a campaign against Lob's US address verification. | default (true) | — | `LOB_API_VERSION`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `direct-mail-webhook` | Public endpoint for print-provider (Lob) tracking events: | default (true) | HMAC/secret header | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `email-campaigns` | Authenticated API behind /dashboard/email-campaigns. All campaign STATE | default (true) |  + cron secret | `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `email-preview-send` | email-preview-send — emails a preview of a kit template to the CALLER's own address only. | default (true) | — | `ENABLE_EMAIL_PREVIEW_SEND`, `SITE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `email-send` | Sends a reply from the Unified Communications Inbox's Email pane, via | default (true) | — | `INBOUND_EMAIL_DOMAIN`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `email-settings` | Email Settings API for /dashboard/settings/email. | default (true) | — | `INBOUND_EMAIL_DOMAIN`, `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `email-track` | Public open/click tracker (no JWT — recipients' mail clients call it). | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `email-unsubscribe` | Public unsubscribe endpoint (no JWT). | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `email-webhook` | Inbound email webhook for the Unified Communications Inbox's Email | default (true) | — | `EMAIL_WEBHOOK_SECRET`, `INBOUND_EMAIL_DOMAIN`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `feedback-cluster` | Staff-only. Proposes themes for un-themed feedback using the Vireek AI Core. Output is stored as | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `feedback-retention` | Daily cron (header X-Cron-Secret = CRON_SECRET). Removes expired screenshots through the Storage API | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `lifecycle-touch-tick` | Customer lifecycle touches: birthday · home-purchase anniversary · equipment-install anniversary · | default (true) | HMAC/secret header | `LIFECYCLE_CRON_SECRET`, `LIFECYCLE_OFFER_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `mutual-aid-notify` | Fires the two SMS side-effects for the Disaster Mutual-Aid Network. | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `notify-status-subscribers` | Emails everyone in `status_subscribers` about an incident on | default (true) | HMAC/secret header | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SITE_URL`, `STATUS_NOTIFY_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `pm-notify-customer` | Preventive Maintenance Command Center: notify the customer about a scheduled maintenance visit. | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `resend-events` | Resend webhook receiver (Svix-signed). Records delivery, and suppresses the | default (true) | HMAC/secret header | `RESEND_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `security-event-notify` | security-event-notify — emails + notifies the user about an account-security change. | default (true) | HMAC/secret header | `PUSH_DISPATCH_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `send-chat-push` | Web Push for ONE chat message, to the specific people who should hear about it | default (true) | HMAC/secret header | `PUSH_DISPATCH_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` |
| `send-comment-email` | Emails the person a comment notification (@mention or thread reply) is for. | default (true) | HMAC/secret header | `PUSH_DISPATCH_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `send-push-notification` | Delivers a real push notification for a `notifications` row to every device the | default (true) | HMAC/secret header | `PUSH_DISPATCH_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` |
| `sms-send` | Sends a reply from the Unified Communications Inbox's SMS pane. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `sms-webhook` | Twilio inbound SMS webhook — set this function's URL as the "A MESSAGE | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |

## Other (159)

| Function | Purpose (header comment) | Auth | Guards | Env vars |
|---|---|---|---|---|
| `adaptive-diagnostic` | Vireek Adaptive Customer Diagnostic — customer-facing step API. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `adaptive-diagnostics` | VIREEK Adaptive Diagnostic Network - session orchestrator. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `ads-conversions` | Deploy: supabase functions deploy ads-conversions | default (true) |  + cron secret |  |
| `ads-optimizer` | Deploy: supabase functions deploy ads-optimizer | default (true) | HMAC/secret header |  |
| `ads-sync` | Deploy: supabase functions deploy ads-sync | default (true) | HMAC/secret header |  |
| `analytics-embed` | PUBLIC, token-authenticated analytics for partners (no Supabase JWT). The page that renders it is | false | — |  |
| `api-v1` | The real, public Vireek API — documented in /docs. Authenticated with a | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `ask-vireek` | ASK VIREEK — "Business Brain" | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `automation-insurance-claim-status-update` | Cron-triggered sweep: texts the customer whenever their insurance_claims | default (true) | HMAC/secret header | `INSURANCE_CLAIM_CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `automation-seasonal-maintenance-reminder` | (no index.ts) | default | — |  |
| `bank-connect` | POST { action: "link_token" \| "exchange" \| "reauth_token" \| "disconnect", ... } | default (true) | — | `SUPABASE_URL` |
| `bank-insights` | POST { horizon_days?: 30..180, save_brief?: boolean } -> { insights } | default (true) | — |  |
| `bank-intelligence` | Direct Bank Intelligence — authenticated API (actions: link_token, exchange, | default (true) | — | `PLAID_WEBHOOK_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `bank-sync` | User call:    POST {}                       -> sync all of the caller's connections | default (true) |  + cron secret |  |
| `bank-webhook` | Plaid webhook receiver — verifies the Plaid-Verification JWT, then syncs + | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `bi-admin` | Configuration for BI Connectors. The browser never sees credentials or token hashes and never writes | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_URL` |
| `bi-export-run` | BI export: scheduled, signed CSV delivery to a customer's S3 / GCS bucket, plus read-only Postgres logins | false | HMAC/secret header | `SUPABASE_URL` |
| `bi-gateway` | Read-only live access for BI tools. Authenticated with a BI token (Authorization: Bearer vbi_… or | false | — | `SUPABASE_URL` |
| `bi-sftp-upload` | Internal SFTP transport. The ONLY function that loads an SSH library, so an SSH/runtime problem can never | false | HMAC/secret header |  |
| `browser-extension` | API for the Vireek Chrome extension (chrome-extension/): quick lead capture + click-to-call. | default (true) | — | `SITE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |
| `business-decision-engine` | — | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `business-drift-scan` | Direction that counts as "bad" for each metric — used to decide | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `business-immune-scan` | Business Immune System — deterministic anomaly scanner. | default (true) |  + cron secret | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `business-scientist-cycle` | Autonomous Business Scientist — Research + Hypothesis stage. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `calendar-feed` | Public (no-auth) ICS calendar subscription endpoint: | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `capacity-demand-insight` | Mirrors regional-demand-insight/index.ts's shape. Runs the deterministic | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `careers-sitemap` | Serves /sitemap-careers.xml (proxied by a rewrite in vercel.json): /careers plus one URL per OPEN | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `cash-flow-forecast` | — | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `cash-flow-war-room` | — | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `causal-outcome-tracker` | Runs on a schedule (e.g. daily via pg_cron -> net.http_post, same | default (true) | HMAC/secret header | `CAUSAL_TRACKER_CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `causal-shock-simulator` | — | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `causal-world-simulator` | — | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `check-contract-renewals` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `check-credential-expirations` | Same alert-once-per-stage pattern as check-warranty-alerts: a | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `check-margin-guardrail` | Dynamic Margin Guardrails + Discount Governance: called right before a | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `check-usage-alert` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `commitment-monitor-tick` | Scans open commitments (from the Commitment Graph — calls, SMS, chat, | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `compute-benchmarks` | — | default (true) | HMAC/secret header | `BENCHMARK_CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `compute-fleet-economics` | Scheduled function (same idiom as analyze-equipment-lifecycle): for every | default (true) | HMAC/secret header | `FLEET_ECONOMICS_CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `compute-fleet-intelligence` | compute-fleet-intelligence — turns raw telematics into Fleet Intelligence. | default (true) | HMAC/secret header | `FLEET_INTELLIGENCE_CRON_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `compute-regional-demand` | — | default (true) | HMAC/secret header | `BENCHMARK_CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `compute-telematics-chain` | compute-telematics-chain — turns raw GPS/events into the operational chain: | default (true) | HMAC/secret header | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TELEMATICS_CRON_SECRET` |
| `contact-sales` | Public enterprise "contact sales" endpoint. Validates, honeypots, rate-limits per IP (hashed), then calls | default (true) | — | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SALES_NOTIFY_EMAIL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `contract-intelligence-extract` | Extracts structured, evidence-backed terms from a service contract | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `create-checkout-session` | Starts (or updates) a subscription for the plan the customer picked on | default (true) | — | `SITE_URL`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `detect-service-recovery-signals` | Service Recovery & Complaint Prevention Agent — detection half. | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `dm-connect` | Connects / disconnects a tenant's Telegram bot or Facebook Page for the Unified Inbox. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `dm-send` | Sends a human reply from the Unified Inbox to a Telegram or Messenger conversation. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `dm-suggest` | "Suggest reply" for the Unified Inbox (Telegram / Messenger): drafts a reply from the tenant's | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `emergency-mode-activate` | دکمه‌ی "Activate/Deactivate Emergency Mode" در داشبورد این را صدا می‌زند. | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `emergency-network-orchestrator` | Vireek Autonomous Emergency Network — the orchestrator. | default (true) | HMAC/secret header | `CRON_SECRET`, `DEFAULT_TIMEZONE`, `SITE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `emergency-ops-broadcast` | مخابرات جمعی: پیامک به مشتریانِ کارهای باز، به کل تیم، یا فقط on-call | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `energy-intelligence` | Vireek Energy Intelligence. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `escalate-emergency` | Records that an emergency call is being escalated to a technician/contact | default (true) | HMAC/secret header | `ESCALATION_WEBHOOK_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `escalation-tick` | Scans active escalation_events. When a tier's delay_minutes has | default (true) | HMAC/secret header | `CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `event-register` | Public (no login) endpoint behind the registration form on /events. | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `evidence-marketplace-api` | The partner-facing Vireek Evidence Marketplace API. Partners (OEMs, parts | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `executive-report-run` | Executive Monthly Report generator + scheduler. | default (true) | HMAC/secret header | `EXECUTIVE_REPORT_CRON_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `expense-receipt-ocr` | Reads ONE receipt (photo or PDF) from the private `expense-receipts` bucket and | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `export-run` | Async data exports (CSV / XLSX / PDF) for /dashboard/exports. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `external-world-sync` | external-world-sync | default (true) | — | `EIA_API_KEY`, `NRI_COUNTIES_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `fabric-ingest` | Vireek Data Fabric — universal ingestion gateway. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `failure-genome-refresh` | Scheduled fallback for the nightly Failure Genome rebuild + emerging-pattern scan, | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `field-scientist-hypothesize` | AI Field Scientist — candidate-cause stage. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `financing-create-offer` | Same dual-client convention as create-payment-request: a single | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `financing-webhook` | Same shape as stripe-payment-webhook: verify signature, look up the | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `fleet-telemetry-ingest` | Fleet telemetry ingest — the front door for GPS / OBD / dashcam data. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `flywheel-engine` | Compounding Intelligence Flywheel — Harvest, Promote, Measure. | default (true) |  + cron secret | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `franchise-royalty-issue` | دکمه‌ی "Generate & Notify" در Franchise Governance این را صدا می‌زند: | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `gbp-sync` | gbp-sync — applies an OWNER-APPROVED services proposal to Google Business Profile. | default (true) | — | `GBP_APPLY_ENABLED`, `GOOGLE_BUSINESS_CLIENT_ID`, `GOOGLE_BUSINESS_CLIENT_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `generate-insights` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `generate-mission-brief` | AI Pre-Arrival Intelligence. | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `geo-grid-scan` | geo-grid-scan — local rank tracking (geo-grid) for /dashboard/geo-grid. | false | HMAC/secret header | `CRON_SECRET`, `GEO_GRID_MONTHLY_POINT_LIMIT`, `GOOGLE_MAPS_API_KEY`, `GOOGLE_PLACES_API_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` … |
| `geocode-address` | geocode-address | default (true) |  + cron secret | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `goal-decomposition-orchestrator` | Goal Decomposition Orchestrator — the tenant states one high-level goal | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `identity-signal-scan` | — | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `incentive-decision-engine` | Vireek Incentive Decision Engine: "which incentives apply to this project, | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `insights-api` | Vireek Insights subscriber API: privacy-safe, k-anonymous industry indexes. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `inspection-report-public` | Public (no-auth) read endpoint behind the customer share link | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `inspection-reports` | Inspection Reports API for /dashboard/inspection-reports (staff side). | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `iot-ingest` | Telemetry ingestion endpoint for sensors / gateways / BMS bridges. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `issue-refund` | — | default (true) | — | `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `kce-extract` | Vireek Knowledge Capture Engine - extraction half. | default (true) | HMAC/secret header | `CRON_SECRET`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `lead-marketplace-ingest` | Webhook receiver for lead marketplaces (Angi, HomeAdvisor, Thumbtack, | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `listings` | Listings API for /dashboard/listings (staff side). | default (true) | — | `LISTINGS_STATE_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `listings-sync` | Deploy: supabase functions deploy listings-sync --no-verify-jwt | default (true) | HMAC/secret header | `LISTINGS_CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `login-alert` | login-alert — records a completed sign-in and, when it comes from a new | default (true) | — | `ALLOWED_ORIGINS`, `GEOIP_LOOKUP_URL`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `marketing-creative-generate` | Marketing Creative Studio: turns a REAL completed job or a REAL positive | default (true) | — | `GEMINI_API_KEY`, `GEMINI_IMAGE_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `marketing-engine-tick` | Runs on a schedule (suggested: hourly). Per account: | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `marketing-track` | PUBLIC, unauthenticated endpoint. Called from the marketing site (not | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `messenger-webhook` | Facebook Messenger webhook for the Unified Inbox (one Meta App for the platform, one Page per tenant). | false | HMAC/secret header | `MESSENGER_VERIFY_TOKEN`, `META_APP_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `metrics-query` | The semantic metrics API. One endpoint, one definition of every number: dashboards, reports and | default (true) | — |  |
| `microsoft-calendar-disconnect` | Deploy: supabase functions deploy microsoft-calendar-disconnect | default (true) | — | `MICROSOFT_CALENDAR_CLIENT_ID`, `MICROSOFT_CALENDAR_CLIENT_SECRET`, `MICROSOFT_CALENDAR_TENANT_ID`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `microsoft-calendar-sync` | Two-way Microsoft 365 / Outlook sync. | default (true) | HMAC/secret header | `MICROSOFT_CALENDAR_CLIENT_ID`, `MICROSOFT_CALENDAR_CLIENT_SECRET`, `MICROSOFT_CALENDAR_TENANT_ID`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `mine-organizational-memory` | Organizational Memory Genome — mining half. | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `next-best-actions` | Proactive Customer Care / Next Best Action Engine. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `no-surprise-assess` | Vireek «No-Surprise» Engine — AI disclosure drafter. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `onboarding-concierge` | AI-native Onboarding Concierge — authenticated, streaming chat that | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `operational-truth` | Vireek Operational Truth Engine — API. | default (true) |  + cron secret | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `opportunity-cost-scan` | — | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `outbound-queue-builder` | Scans active escalation_events. When a tier's delay_minutes has | default (true) | HMAC/secret header | `CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `outcome-benchmark-advisor` | Runs entirely with the CALLER's JWT (no service-role key): every number the | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `pm-sync-run` | Property-management integrations: Buildium, Propertyware, Rentvine, AppFolio, Yardi. | default (true) | HMAC/secret header | `CRON_SECRET`, `PM_EXTRA_ALLOWED_HOSTS`, `PM_TOKEN_ENCRYPTION_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `portal-home-inventory` | Customer portal Home Inventory: signed uploads, OCR of labels / receipts / warranty cards, file viewing and | false | — |  |
| `predictive-failure` | VIREEK Predictive Failure Network - orchestrator. | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `price-book-connect-servicetitan` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `price-book-sync` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `property-intelligence` | Vireek Property Intelligence Graph — dashboard API. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `property-intelligence-enrich` | property-intelligence-enrich | default (true) | — | `CENSUS_API_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `property-vision-analyze` | Persistent Property Vision: Photo -> Vision -> Equipment -> Model -> Serial -> Condition -> | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `PROPERTY_VISION_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `rebate-intelligence` | Vireek Energy + Rebate Intelligence. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `regional-demand-insight` | — | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `register-a2p-brand` | Submits a tenant's legal business info to Twilio for A2P 10DLC Brand | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |
| `remote-resolution` | Vireek Remote Resolution Engine — one "turn" of the conversation. | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `reputation` | Reputation API for /dashboard/reputation (staff side). | default (true) | — | `REPUTATION_STATE_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `reputation-sync` | Deploy: supabase functions deploy reputation-sync --no-verify-jwt | default (true) | HMAC/secret header | `REPUTATION_CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `rich-fallback-sweep` | RCS / Apple Messages worker (cron). Three jobs, one tick: | false | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `rich-send` | Sends from the Unified Communications Inbox's RCS / Apple Messages pane, and sends rich | default (true) |  + cron secret | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `rich-webhook` | Aggregator webhook for RCS Business Messaging + Apple Messages for Business (Sinch Conversation API). | false | — | `SINCH_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `rr-device-ingest` | Vireek Remote Resolution Engine — sensor / IoT ingestion. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `self-healing-orchestrator` | Self-Healing Operations — Autonomous Service Recovery | default (true) | HMAC/secret header | `CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `send-service-recovery-response` | Sends the apology / recovery message a human approved on the Service Recovery page | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `send-signature-request` | — | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `send-team-invite` | Sends a branded invite email to a newly added (or re-invited) team member | default (true) | — | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `service-guarantee-tick` | Vireek Verified Service — cron worker. | default (true) | HMAC/secret header | `CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `shadow-digest` | Day 1 / 3 / 7 progress emails for Shadow Mode. Scheduler only (suggested: hourly): | default (true) | HMAC/secret header | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SHADOW_CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `shadow-replay` | Shadow Mode replay + finalisation. | default (true) | HMAC/secret header | `SHADOW_CRON_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `shadow-report` | Proof-of-Value report for the caller's own Shadow Mode trial. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `siem-stream` | SIEM log streaming (Splunk HEC / Datadog Logs) for enterprise security events. | false | HMAC/secret header | `SIEM_CRON_SECRET`, `SIEM_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `sign-document-action` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `slo-evaluate` | Every 5 minutes: read SLI counts, evaluate multi-window burn-rate rules per SLO and region, | false | HMAC/secret header | `SLO_ALERT_WEBHOOK_URL`, `STATUS_NOTIFY_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `speed-to-lead-intake` | Public webhook for web-form / ad leads that carry captured consent. | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VAPI_PRIVATE_KEY` |
| `staffing-forecast` | Vireek Staffing Forecast. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `status-feed` | Public status feed (no auth). GET /status-feed            -> JSON | false | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `switching-shield` | Customer Switching Shield — Save Customer Agent. | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `synthetic-probe` | Synthetic test calls through the REAL AI path. Two actions, both driven by cron every minute: | false |  + cron secret | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VAPI_PRIVATE_KEY` |
| `synthetic-webhook-sink` | Receiver for the probe tenant's outbound webhook. dispatch-webhook POSTs { event, data } to the URL | false | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `takeoff-analyze` | AI Takeoff: plans / blueprints / photos in the private `takeoff-plans` bucket | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TAKEOFF_GEMINI_MODEL` |
| `talent-background-webhook` | Receives screening-provider webhooks (Checkr). Deployed with verify_jwt = false (see supabase/config.toml); | false | HMAC/secret header | `CHECKR_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `talent-network` | Talent Network orchestrator (JWT required). | default (true) | — | `CHECKR_API_BASE`, `CHECKR_API_KEY`, `CHECKR_DEFAULT_PACKAGE`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SITE_URL` … |
| `telegram-webhook` | Telegram bot webhook for the Unified Inbox (one bot per tenant). | false | HMAC/secret header | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `telematics-connect` | telematics-connect — dashboard-called management API for telematics connections. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `telematics-ingest` | telematics-ingest — public webhook receiver (server-to-server, no user JWT). | default (true) | HMAC/secret header | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `telematics-sync` | telematics-sync — scheduled poller for providers without push (Samsara snapshot). | default (true) | HMAC/secret header | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TELEMATICS_CRON_SECRET` |
| `telemetry-analyze` | The Telemetry -> Anomaly -> Failure probability -> Parts prediction stages. | default (true) | HMAC/secret header | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TELEMETRY_CRON_SECRET` |
| `telemetry-ingest` | Public ingest endpoint for Building Telemetry Intelligence. Any BACnet / | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `third-party-intake` | API intake for warranty / insurance / manufacturer / property-manager partners | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `unsubscribe-status-updates` | Removes a row from `status_subscribers` given its unsubscribe_token. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `value-scoreboard-run` | Monthly "Results" statement generator + sender. | false | HMAC/secret header | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VALUE_SCOREBOARD_CRON_SECRET` |
| `verification-network` | VIREEK Verification Network - orchestrator. | default (true) |  + cron secret | `SOCRATA_APP_TOKEN`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `verify-custom-domain` | Verifies ownership of the custom domain claimed in brand_settings. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` |
| `vertical-ai-pipeline` | Orchestrator for the Proprietary Vertical AI / Data Pipeline — see | default (true) | HMAC/secret header | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VERTICAL_AI_CRON_SECRET` |
| `weather-surge-check` | weather-surge-check | default (true) | HMAC/secret header | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `WEATHER_SURGE_CRON_SECRET` |
| `whatsapp-connect` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `whatsapp-webhook` | Phase 1 of the WhatsApp channel: verifies Meta's webhook handshake, | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `WHATSAPP_VERIFY_TOKEN` |
| `workflow-compiler` | Vireek Workflow Compiler — "tell Vireek what should happen" -> executable graph. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `workflow-engine-executor` | Cron-driven executor for the Call-to-Cash Workflow Engine | default (true) | HMAC/secret header | `CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VAPI_PRIVATE_KEY` |
| `workflow-graph-executor` | Durable runtime for graphs produced by workflow-compiler. | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `workforce-equilibrium-engine` | — | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |

## Scheduling, jobs & field (47)

| Function | Purpose (header comment) | Auth | Guards | Env vars |
|---|---|---|---|---|
| `analyze-equipment-lifecycle` | Scheduled function (same idiom as check-warranty-alerts): scans active | default (true) |  + cron secret | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `analyze-job-autopsy` | On-demand (same shape as analyze-callback-root-cause/index.ts): runs AS | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `analyze-job-compliance` | AI Permit / Code / Compliance Engine. | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `automation-no-show-reschedule` | Cron-triggered (same pattern as weather-surge-check): every few minutes, | default (true) | HMAC/secret header | `NO_SHOW_CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `booking-capacity` | Capacity-based smart booking endpoint. | false | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `cadence-meeting-recap` | Emails the recap of a COMPLETED weekly meeting (notes + action items) to its | default (true) | — | `SITE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `chat-alerts-dispatch` | Called by the dispatch_chat_alerts() Postgres trigger through pg_net — | default (true) | HMAC/secret header | `PUSH_DISPATCH_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `chat-notify-dispatch` | Server-to-server: called by the `chat_dispatch_event()` Postgres trigger (pg_net) for each new chat_events row, | default (true) | HMAC/secret header | `PUSH_DISPATCH_SECRET` |
| `check-warranty-alerts` | A unit gets its first alert this many days before warranty_expires_at. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `check-warranty-claim-deadlines` | A claim gets a "due_soon" alert WARNING_WINDOW_DAYS before claim_deadline and a separate, | false | HMAC/secret header | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `WARRANTY_CLAIM_CRON_SECRET` |
| `closeout-deadline-engine` | Daily Install Closeout deadline engine. | false | HMAC/secret header | `CLOSEOUT_CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `daily-briefing` | Composes and delivers the daily briefing (push / email / in-dashboard card). | default (true) | HMAC/secret header | `BRIEFING_CRON_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY` … |
| `daily-log-assist` | Helpers for Project Daily Logs. Both actions run AS THE CALLER (anon key + the caller's JWT), so RLS applies | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `deferred-message-dispatcher` | Schedule every 5 minutes (same X-Cron-Secret pattern as outbound-dialer). Claims due rows | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `detect-warranty-claims` | Daily warranty-claim detector. Finds completed jobs whose equipment was still under warranty and that have | default (true) | HMAC/secret header | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `WARRANTY_CRON_SECRET` |
| `dispatch-auto-assign` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `dispatch-webhook` | Called internally by the `dispatch_customer_webhook()` Postgres trigger | default (true) | HMAC/secret header | `PUSH_DISPATCH_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `email-campaign-dispatcher` | Cron worker (every 5 minutes). Authenticated by the service-role key only. | default (true) |  + cron secret | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `equipment-nameplate-scan` | Technician data-plate scan: photo -> OCR -> equipment record -> equipment passport + warranty status. | default (true) | — |  |
| `event-bus-dispatch` | Called internally by the `dispatch_event_bus()` Postgres trigger and by | default (true) | Stripe signature, HMAC/secret header | `PUSH_DISPATCH_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `feedback-followup-dispatch` | Cron (every ~10 min, header X-Cron-Secret = CRON_SECRET). Sends follow-up emails that staff queued in | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `field-estimate` | AI Photo + Voice-Based Estimating. | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `google-booking-feed` | google-booking-feed | false | — | `SITE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `job-context-engine` | Vireek Real-World Context Engine — builds the pre-dispatch Context Graph for one job. | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `job-feeds` | Public XML job feeds for Indeed, ZipRecruiter and LinkedIn, built from OPEN careers postings. | false | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `job-summary-engine` | Automatic post-job summaries ("what we did"). | default (true) | HMAC/secret header | `CRON_SECRET`, `SITE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `job-summary-public` | Public (no-auth) read endpoint behind the customer link /summary/:token. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `landing-domain-verify` | Verifies custom-domain ownership (DNS TXT via DNS-over-HTTPS), then | default (true) | — | `LANDING_A_RECORD`, `LANDING_CNAME_TARGET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VERCEL_API_TOKEN` … |
| `marketing-campaign-dispatcher` | Runs on a schedule (suggested: every 15 minutes). Sends the next due | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `notification-router` | Applies the owner's notification_routing_rules to a `notifications` row: | default (true) | HMAC/secret header | `PUSH_DISPATCH_SECRET`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `optimize-route` | optimize-route | default (true) | — | `GOOGLE_MAPS_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `quote-ar-public` | Public (no-auth) endpoint behind the customer quote link /quote/:token. | false | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `quote-truth-engine` | Vireek Quote Truth Engine: "is this quote actually reasonable, and what will | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `quote-video-public` | Public (no-auth) endpoint behind the customer quote link /quote/:token. | false | — | `DAILY_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `quote-video-retention-sweep` | Scheduled job (suggested: daily). Physically deletes quote-video files that | default (true) | HMAC/secret header | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `quote-video-session` | Technician-side live video estimate (Daily.co). | default (true) | — | `DAILY_API_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `recurring-jobs-cron` | recurring-jobs-cron | default (true) | HMAC/secret header | `RECURRING_JOBS_CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `rescue-sla-monitor` | Cron entry point for the Rescue Loop first-response SLA monitor. | default (true) | HMAC/secret header | `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `scheduled-reports-run` | Two entry points, one delivery pipeline: | default (true) | HMAC/secret header | `CRON_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `subprocessor-notice-dispatch` | Emails a posted sub-processor change notice to (a) verified portal subscribers and | default (true) | HMAC/secret header | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SITE_URL` |
| `survey-dispatcher` | Post-job NPS/CSAT survey dispatcher. | default (true) | HMAC/secret header | `CRON_SECRET`, `SITE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `technician-retention-engine` | Technician Retention Engine - weekly, rule-based, explainable. | false | HMAC/secret header | `CRON_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `technician-simulator` | AI Technician Simulator. | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `verify-job-evidence` | Field Safety + Quality Verification via Computer Vision: downloads 1-6 | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `visual-estimate` | Visual AI Estimating: downloads 1-3 photos the caller already uploaded to | default (true) | — | `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `warranty-claim-detector` | Cron-only detector: creates "needs_review" manufacturer warranty claims for completed jobs whose | false | HMAC/secret header | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `WARRANTY_CLAIM_CRON_SECRET` |
| `warranty-register` | Public, unauthenticated endpoint behind /warranty/register. | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |

## Security, trust, privacy & data (32)

| Function | Purpose (header comment) | Auth | Guards | Env vars |
|---|---|---|---|---|
| `admin-sso` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VIREK_MANAGEMENT_TOKEN`, `VIREK_PROJECT_REF` |
| `ads-oauth-start` | Deploy: supabase functions deploy ads-oauth-start | default (true) | — | `ADS_STATE_SECRET`, `SUPABASE_URL` |
| `audit-api` | Public JSON API for the Missed-Call Audit. verify_jwt = false (public); every action is gated inside the service | default (true) | — | `AUDIT_ALLOWED_ORIGINS`, `AUDIT_BASE_URL` |
| `audit-runner` | Cron-driven worker (pg_cron -> net.http_post with X-Cron-Secret). verify_jwt = false; authenticated by a shared secret | default (true) | HMAC/secret header | `AUDIT_CRON_SECRET` |
| `automation-vip-customer-tag` | Thin wrapper around the apply_vip_customer_tags() SQL sweep — logic lives | default (true) | HMAC/secret header | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `VIP_TAG_CRON_SECRET` |
| `check-ip-policy` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `compliance-evaluate` | Evaluates the account's applicable, counsel-approved rule packs for a call, | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `data-import-run` | Runs a CSV-based competitor data import (customers or job history). | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `data-platform-admin` | Configuration for the Data Platform. The browser never sees credentials and never writes the | default (true) | — |  |
| `data-platform-run` | Runs warehouse syncs, reverse-ETL pushes and the daily metric snapshot. | false | HMAC/secret header |  |
| `data-retention-sweep` | Scheduled job (suggested: daily). Two jobs in one pass: | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `delete-account` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `dr-backup-run` | Scheduled job (suggested: daily, off-peak). Takes an application-level | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `dr-restore-drill` | Scheduled job (suggested: weekly). Proves the latest backup from | default (true) | — | `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `dsar-request` | Public (unauthenticated) endpoint behind /data-request. One function, three | default (true) | HMAC/secret header | `DSAR_NOTIFY_EMAIL`, `DSAR_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `exit-dataroom-public` | Public (no-auth) read endpoint behind the buyer link  <app>/data-room#<token>. | default (true) | HMAC/secret header | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `findings-package-public` | Public (no-auth) endpoint behind the customer link /findings/:token. | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `google-calendar-oauth-start` | Required secrets: | default (true) | — | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_STATE_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `homeowner-delete-account` | Permanently deletes a Vireek Home account (NOT a business account): removes | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `homeowner-document-url` | Returns a short-lived signed URL for a document a business shared with the | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `leak-report-ingest` | Server-to-server webhook for call events (call-tracking providers, Twilio status callbacks, | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `membership-join-checkout` | Public (no login) endpoint behind /join/:planSlug. Deploy with | default (true) | — | `SITE_URL`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `mfa-recovery` | Recovery codes for Supabase Auth MFA (which has TOTP but no recovery codes). | default (true) | HMAC/secret header | `MFA_RECOVERY_PEPPER`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `microsoft-calendar-oauth-start` | Required secrets (see docs/MICROSOFT_CALENDAR_SETUP.md): | default (true) | — | `MICROSOFT_CALENDAR_CLIENT_ID`, `MICROSOFT_CALENDAR_CLIENT_SECRET`, `MICROSOFT_CALENDAR_STATE_SECRET`, `MICROSOFT_CALENDAR_TENANT_ID`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `rum-ingest` | PUBLIC beacon endpoint for real-user web vitals (no JWT; the browser cannot sign beacons). | false | — |  |
| `scim-v2` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `staff-impersonate` | Audited "sign in as customer" for Vireek staff. | default (true) | — | `SITE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
| `trust-bank-alerts` | Reads get_trust_erosion_alerts() (real ledger data, RLS-scoped to the | default (true) | — | `SUPABASE_ANON_KEY`, `SUPABASE_URL` |
| `trust-keys` | Customer-managed encryption keys (CMEK) for the Enterprise Trust Pack. | default (true) | — | `TRUST_AWS_ACCESS_KEY_ID`, `TRUST_AWS_PRINCIPAL_ARN`, `TRUST_AWS_SECRET_ACCESS_KEY` |
| `trust-subscribe` | Public double-opt-in subscription to sub-processor change notices (security portal). | default (true) | — | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SITE_URL` |
| `trust-vault` | Opens sealed data for authorised users and runs vault maintenance. | default (true) | HMAC/secret header |  |
| `trusted-device` | — | default (true) | — | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` |
