# TILA / Reg Z — financing display audit and disclosure matrix

Roadmap item 110. Engineering inventory, **not legal advice**. Every legal statement is `TODO(counsel)` until a lawyer signs off.
Status: DRAFT · Owner: `TODO(owner)` · Counsel reviewer: `TODO(counsel)` · Last audit: 2026-11-25 (static code read, no runtime test).

## 1. Rule enforced in code

A customer-visible APR, finance charge, term or payment amount may only come from a **provider** (lender response stored in `financing_offers` / partner offer / lender quote). Vireek never supplies a default or assumed rate.
Guard: `npm run compliance:financing-rates` (scanner) and `npm run test:scripts:financing-rates` (tests; fail on a hardcoded rate, a rate-claim phrase, or `PLANNING_APR` in a customer-facing file).

## 2. Audit findings (before → after)

| # | Where | Finding | Action |
|---|---|---|---|
| 1 | `src/lib/estimates.ts` `monthlyPaymentCents` | Defaulted to 24 months at 9.99% | Defaults removed; params required |
| 2 | `src/components/quotes/EstimatePresentation.tsx` (customer quote) | "Roughly $X/month over 24 months" from that default | Copy replaced: no number, lender shows terms before apply |
| 3 | `src/components/technician/EstimateDraftCard.tsx` + `voiceLog.json` (en/es/fa) `financingMonthly` | Monthly estimate from the same default | Line and key removed |
| 4 | `src/lib/inHomeSales.ts` `INDICATIVE_TERM` (60 mo, 9.99%) | Fallback APR shown on the in-home sales screen when no lender data | Removed; no terms ⇒ no payment shown |
| 5 | `src/pages/SalesPresentationPage.tsx`, `LadderView.tsx` | Consumed #4; wording "terms recently approved for our customers" | Handles no-terms state; illustration wording; `TODO(counsel)` on showing other customers' approved terms |
| 6 | `src/lib/repairReplaceProposal.ts` | Planning APR + "about X/month" in customer proposal; "No interest" | Only cash or lender-quoted options appear; copy changed |
| 7 | `src/pages/BusinessProfilePage.tsx` | Placeholder suggested "0% APR for 12 months" | Placeholder is now neutral |
| 8 | `src/lib/serviceFinance.ts` `PLANNING_APR` | Planning table in owner-only tools | **Kept**, allowlisted in the guard; rule R3 blocks import into customer-facing files |

Not changed, open: **`financing_note`** is free text written by the owner and shown to customers (`EstimatePresentation`). The owner can still type a rate. `TODO(owner)`: decide whether to block rate patterns on save (the scanner's phrase list is reusable).
Also open: `src/lib/payApi.ts` `capital_offers` (`finance_charge_cents`, `estimated_apr_bps`) is provider data but its display was not audited; business-purpose credit, `TODO(counsel)` which state commercial-financing disclosure laws apply.

## 3. Required disclosures by product (fill in)

Triggering terms (down payment, number/amount of payments, finance charge, any rate) are the reason a payment amount cannot be shown alone. `TODO(counsel)`: confirm the trigger-term and "clear and conspicuous" requirements and the exact wording per product.

| Product | Who is the creditor | Credit type | Where Vireek displays terms | Must appear with any stated payment/rate | Disclosure owner |
|---|---|---|---|---|---|
| Consumer financing via provider (`financing_offers`, public `/financing/:token`) | Provider (`TODO(owner)`: provider name) | Closed-end consumer | `FinancingOfferPage`, `financing.ts` | APR, term, financed amount, payment, `TODO(counsel)` other items | Provider supplies; Vireek only relays |
| Partner financing (`financing-partners`, `QuoteFinancingOptions`) | Partner | Closed-end consumer | Quote page | No rate shown by Vireek; "partner is the lender" notice exists | Partner |
| In-home sales monthly view | Provider | Closed-end consumer | `SalesPresentationPage` | APR + term (shown via `describeTerm`), `TODO(counsel)` amount financed / finance charge / total of payments | Vireek screen, provider data |
| Repair-vs-replace proposal | Provider (lender quote only) | Closed-end consumer | Proposal text/PDF | Same as above | Vireek document, provider data |
| Working capital / capital offers | `TODO(owner)` | Commercial | `payApi.ts` | `TODO(counsel)`: state laws | `TODO(counsel)` |
| Planning tools (`serviceFinance`, `homeCapitalUnderwriting`, advisor) | none | Planning only | Owner-only | Must stay labelled "planning estimate" and never reach a customer | n/a |

## 4. Supply before release

1. Provider names and which entity is creditor per product (`TODO(owner)`).
2. Counsel-approved disclosure wording and placement (`TODO(counsel)`).
3. Decision on `financing_note` rate blocking and on showing other customers' approved terms.
4. Add `npm run compliance:financing-rates` to CI (workflow file not edited here).
