# Audit report: golden path (call → cash → QuickBooks → warranty)

## Verified (and how)
- **Read only:** page/route/function/table mapping, payment and invoice RPCs, job status paths, ledger, c2c state machine, double-booking constraint.
- **Executed (Node, pure logic only):** `invoiceTotalsSqlParity` vs a BigInt reference over 9,648 cases (0 mismatches); VAT helper vs integer reference (0 mismatches); reproduction of the float VAT bug (19 % of 42.50 → 8.07 vs 8.08) and of the fractional-cent total divergence (85,050 of 216,000 combinations).
- **NOT RUN:** `tsc`, `vitest`, `eslint`, pgTAP, Playwright, any migration, any edge function. No `node_modules`, Postgres or network was available.

## Changed / added (all proposed; nothing applied to your repo)
New files: `supabase/migrations/20290304000000_golden_path_invariants.sql`, `supabase/tests/database/golden_path_invariants.test.sql`,
`src/lib/invoiceMoney.ts`, `src/lib/goldenPathMoney.test.ts`, `e2e/golden-path-pay-link.spec.ts`, `docs/workflows/GOLDEN_PATH.md`, `docs/workflows/GAPS.md`.
Existing files to edit by hand: `src/lib/tax.ts`, `src/lib/invoiceDetail.ts`, `supabase/functions/create-payment-request/index.ts` (Ctrl+F steps given in the chat reply).

## Not done and why
- **B (e2e):** only the public pay link is covered (mocked). Booking, dispatch, tech mobile, quote, invoice, QuickBooks specs need a seeded dev project and selectors read from each page. Card decline needs Stripe test mode.
- **C:** GAP-02 (two invoice models, QuickBooks reads `ar_invoices`) needs a product decision; not changed.
- **E:** surge pricing and Stripe refund math not unit-tested (no pure function identified).
- **F:** `workflow_events` data layer done; rendering it in `JobDetailPage` not wired (page code not read).
- Job transition matrix is enforced only when feature flag `c2c_orchestration` is ON (seeded OFF).

## Residual risks
- New guard `guard_invoice_payment_amount` fires for every `invoice_payments` insert, including loyalty-points migrations/functions that insert there (not inspected); a path that deliberately overpays would now fail.
- New job-completion guard blocks end users completing a job with no `assigned_technician_id` (crew-only jobs: unverified).
- pgTAP fixtures assume `payment_requests` has defaults for any columns added after the original table (unverified).
- Mirror trigger picks the oldest unpaid non-void invoice linked to the job; a job with several invoices may attribute a payment to the wrong one.

## Manual steps for you
1. Copy the new files to the same paths. 2. Apply the three Ctrl+F edits. 3. On a **dev** Supabase project: `supabase db push` (dev only), `supabase test db`. 4. `npm run typecheck && npm run lint && npm test`. 5. `npx playwright test e2e/golden-path-pay-link.spec.ts` (build needs `VITE_SUPABASE_URL`). 6. Review GAPS.md; decide GAP-02 and the `c2c_orchestration` flag. 7. Deploy `create-payment-request` yourself after review.
