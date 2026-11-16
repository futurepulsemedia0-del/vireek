# Golden-path gaps (revision 2)

> **Evidence levels:** *read* = source read, nothing executed. *executed* = a script was run (Node only, for pure money logic).
> `tsc`, `vitest`, `eslint`, pgTAP and Playwright were **NOT RUN** (no `node_modules`, no Postgres, no network in the review sandbox).
> Revision 2 corrects revision 1: the repo already has an append-only ledger (`business_activity_events`), a job timeline in `JobDetailPage`
> and a flag-gated state machine (`c2c_*`, migration `20281116000000`). Earlier "no guard / no timeline" claims were wrong or incomplete.

| ID | Sev | Gap | Evidence | Status |
|---|---|---|---|---|
| GAP-01 | **High** | A single-payer Stripe payment (`payment_requests`) updates the request and `jobs.invoice_status` but not `invoices`/`invoice_payments`, so the invoice stays unpaid. Later migrations do not redefine `finalize_paid_payment_request` (checked). Online split-payer links do post to `invoice_payments`. | read | **Fix delivered, not applied**: trigger in `20290304000000_golden_path_invariants.sql` (idempotent, capped at balance, cannot fail the webhook). |
| GAP-09 | **High** | `create-payment-request` computes the real balance (`_job_balance`) but still stores `amount = job.invoice_amount` and charges `unit_amount` from `job.invoice_amount`. After a manual/partial payment the customer is asked for the full amount (overcharge). The technician "reuse open request" path keeps a stale amount. | read | **Fix delivered as Ctrl+F edits, not applied.** No automated test possible for the Deno function here. |
| GAP-02 | **High** | Two invoice models: `invoices` (jsonb lines) and ledger `ar_invoices`. The QuickBooks sync reads/writes `ar_invoices`. No automatic `invoices` → `ar_invoices` bridge was found (`create_ar_invoice` is called from `src/lib/accounting.ts`; whether the invoice screen uses it is unverified). | read | **OPEN, not fixed.** Needs a product decision on which table is the system of record. |
| GAP-10 | Medium | `calculateQuoteTotals` keeps fractional cents for fractional quantities (1.25 × 1¢ = 1.25¢) while SQL `invoice_total_cents` rounds. In a sweep of 216,000 combinations, 85,050 produced a fractional total in TypeScript. The invoice UI can then show "partial" for an invoice the DB treats as paid. | **executed** (Node sweep) | **Fix delivered**: `src/lib/invoiceMoney.ts` + one-line patch in `computeInvoiceLedger`. Matches a BigInt reference on 9,648 cases (executed). |
| GAP-05 | Medium | `calculateVat` rounds float dollars: 19 % of 42.50 gives 8.07, exact half-up is 8.08 (reproduced, **executed**). | executed | **Fix delivered** (Ctrl+F). Test in `goldenPathMoney.test.ts`. |
| GAP-03 | Medium | Job state machine exists (`job_transition_rules`, `job_transition_log`, guard trigger) but only acts when feature flag `c2c_orchestration` is ON (seeded OFF). `advance_job_status` itself accepts any status from any status. | read | Completion-needs-technician guard delivered in the new migration (end users only). **Human decision:** enable `c2c_orchestration` per tenant. |
| GAP-04 | Medium | Ledger + timeline exist, but the ledger auto-logs only job created/completed, quote sent/accepted, payment_request paid, review completed. Invoice status, invoice payments, refunds, technician assignment and non-completion status changes are not in it. Also `append_activity_event` writes `actor_id = auth.uid()` into a column that references `profiles(id)`; a team member with no profile row could fail that insert (unverified; existing behaviour). | read | `workflow_events` (append-only, no profile FK) delivered in the migration. **Timeline UI wiring NOT done**: needs `JobDetailPage` rendering code read first. |
| GAP-06 | Medium | e2e does not prove the flow: existing specs are load-only and skip without `E2E_TEST_EMAIL/PASSWORD`. | read | One mocked spec delivered (`e2e/golden-path-pay-link.spec.ts`). The rest is **BLOCKED**: needs a seeded dev project and selectors read from each page. |
| GAP-07 | Low | Review/referral request: no edge function by name; migrations `20260905120000_review_requests.sql` and `20281201000000_review_requests_no_gating.sql` exist, mechanism not traced. | read (names only) | Unverified. |
| GAP-11 | Low | Surge-pricing and refund-to-Stripe (`issue-refund`) math not unit-tested; `weatherSurge.ts` exposes no pure function I could identify. | read | NOT done. |
| GAP-08 | Low | Hygiene: placeholder migration name `<timestamp>_daily_briefing.sql`; three migrations share version `20290303000000`; `surface.manifest.json` is invalid JSON; no `CLAUDE.md`. | read | May be an artefact of the zip export; confirm in git. |

## Needs human
- Apply the migration on a **dev** project, run `supabase test db`, `npm run typecheck`, `npm run lint`, `npm test`, `npx playwright test e2e/golden-path-pay-link.spec.ts`.
- Decide GAP-02 (system of record) and whether to enable `c2c_orchestration`.
- Stripe test-mode card-decline and QuickBooks sandbox runs for real end-to-end proof.

## Release gate
**Not production-ready.** GAP-02 is High and open; GAP-01 and GAP-09 are fixed only on paper until applied and tested; nothing has been executed except pure money logic in Node.
