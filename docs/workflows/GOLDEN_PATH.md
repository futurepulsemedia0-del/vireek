# Golden path: call → cash → QuickBooks → warranty

> **Evidence level: static reading only** of the repo snapshot (`vireek-main.zip`). Nothing was executed: no `tsc`, `vitest`, pgTAP or Playwright run (no `node_modules`, no network, no Postgres in the review sandbox).
> "Coverage" below comes from `docs/product-surface.md` (generated, existence-of-test-file only) plus direct reads of `e2e/*.spec.ts`. It says a test file exists, **not** that it passes.
> Items marked **unverified** were not opened.

## Steps

| # | Step | Page / route | Edge function / RPC | Tables | Coverage (verified by file existence) |
|---|---|---|---|---|---|
| 1 | Inbound call, AI answers | `CallsPage` `/dashboard/calls`, `CallDetailPage` `/dashboard/calls/:id` | `vapi-webhook` | `calls`, `call_dispositions` | Page test for `CallDetailPage` only. No e2e for an inbound call. `e2e/first-call.spec.ts` covers the onboarding test call (mocked), not production inbound. `vapi-webhook` unit tests: **unverified**. |
| 2 | Lead captured | `LeadsPage` `/dashboard/leads`, `LeadDetailPage` `/dashboard/leads/:id` | — | `leads`, `calls`, `customers` | Page test for `LeadDetailPage`. e2e: none. |
| 3 | Booking, capacity-checked, no double-book | `BookingSettingsPage` `/dashboard/booking-settings` | `booking-capacity`; RPC `create_public_booking_with_settings`, `get_booking_busy_window` | `jobs`, `business_profile` | DB-level: exclusion constraint `jobs_no_double_booking` (`20260924000000_double_booking_protection.sql`, per technician or per business when unassigned) plus `20260925000000_technician_capacity_locking.sql`. No pgTAP/e2e proof existed; `golden_path_invariants.test.sql` now adds one (not run). |
| 4 | Dispatch / assign technician | `DispatchBoardPage` `/dashboard/dispatch`, `CalendarPage`, `DispatchRulesPage` | RPC `assign_technician_to_job`; fns `dispatch-auto-assign`, `dispatch-optimizer` | `jobs`, `team_members`, `dispatch_rules`, `dispatch_decisions` | `e2e/auth-and-dispatch.spec.ts` only checks the board loads without a crash, and is skipped without `E2E_TEST_EMAIL/PASSWORD`. |
| 5 | Technician arrives / completes (mobile) | `TechnicianTodayPage` `/tech/today`, `TechnicianSchedulePage` `/tech/schedule` | RPC `advance_job_status` (`20261212000000_technician_mobile_os.sql`); web UI writes `jobs.job_status` directly (`src/lib/jobDetail.ts`); flag-gated state machine `c2c_*` (`20281116000000`) | `jobs`, `job_status_events`, `job_transition_log`, `business_activity_events` | Page test for `TechnicianSchedulePage`. e2e: none. |
| 6 | Quote approved | `QuotesPage`, `QuoteDetailPage`, public `QuoteAcceptPage` `/quote/:token` | 3–4 fns per page (list in product-surface.md) | `quotes`, `quote_events`, `estimate_templates` | Page tests for detail and accept pages. pgTAP `approval_to_cash.test.sql` exists (content **unverified**). `e2e/quote-to-invoice.spec.ts` is a load-only smoke; its header says selectors were deliberately not guessed. |
| 7 | Invoice generated | `InvoicesPage` `/dashboard/invoicing`, `InvoiceDetailPage` `/dashboard/invoicing/:id`, public `/invoice/:token` | RPC `record_invoice_payment`, `record_invoice_refund`, `void_invoice`, `get_invoice_audit_trail`, `get_invoice_for_token`; fn `invoice-email` | `invoices` (jsonb `line_items`), `invoice_payments`, `invoice_refunds`, `invoice_reminders`, `audit_log` | `invoice_total_cents()` is a pure SQL function over `numeric`. pgTAP for it: **unverified**. |
| 7b | Draft invoice from completed job | — | `c2c_draft_invoice_for_job`, `c2c_sweep_completed_jobs` (flag `c2c_orchestration`, default OFF; `20281116000100`) | `invoices.c2c_auto` | pgTAP `c2c_completion_to_invoice.test.sql` exists (not run). |
| 8 | Payment collected (Stripe) | `PaymentsPage`, public `PublicPaymentPage` `/pay/:token` | fns `public-payment`, `stripe-payment-webhook`; RPC `finalize_paid_payment_request` | `payment_requests`, `jobs.invoice_status`, `tips`, `commission_records` | `e2e/golden-path-pay-link.spec.ts` (mocked, not run). See GAP-01, GAP-09. |
| 9 | Synced to QuickBooks | `IntegrationsPage` (`QuickBooksSyncPage` has no route of its own in the manifest) | `qbo-sync-run`, `qbo-webhook`, `qbo-oauth-*` | `qbo_connections`, `qbo_record_links`, `qbo_sync_runs`, `ar_invoices` | pgTAP `qbo_reconciliation.test.sql` exists. Link table `qbo_record_links` is keyed by entity + external/vireek id (idempotency mechanism present; behaviour **unverified**). See GAP-02. |
| 10 | Review / referral request | `JobsPage` / `JobDetailPage` | **No dedicated edge function found by name.** Mechanism **unverified** | `review_requests` (`20260905120000_review_requests.sql`) | Unknown. |
| 11 | Warranty / follow-up | `WarrantyClaimRecoveryPage` `/dashboard/warranty-claims` | `detect-warranty-claims`, `check-warranty-claim-deadlines`, `warranty-register` | `warranty_claims`, `warranty_eligible_jobs` | One e2e spec navigates to the route. |

## Failure branches (current state)

| Branch | Where it would live | Evidence |
|---|---|---|
| Payment declined | `stripe-payment-webhook` (`failed` status update on `payment_requests`) | Code path exists (reads); no test. |
| Technician no-show | `automation-no-show-reschedule` fn exists | Behaviour and tests **unverified**. |
| Customer reschedules | **unverified** | — |
| Double-booking attempt | Step 3 capacity locking | No test proven. |
| Emergency call | `escalate-emergency`, `emergency-mode-activate` fns exist | Behaviour and tests **unverified**. |
| After-hours call | Call flows / routing pages | **unverified** |

## Repo facts the next steps depend on

- Latest migration timestamp is `20290303000000` and **three files share it**; a new migration must sort after it.
- `supabase/migrations/<timestamp>_daily_briefing.sql` has a literal placeholder name.
- `src/lib/surface/surface.manifest.json` does not parse as JSON (error near char 10036). The task text names `src/lib/productSurface.manifest.json`, which does not exist in this snapshot. `CLAUDE.md` is also absent.
