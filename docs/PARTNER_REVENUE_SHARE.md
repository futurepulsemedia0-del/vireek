# Partner revenue share: agreements, monthly statements, payouts

Extends the existing partner programme (`20261203000000_partner_portal.sql`, `20290303000000_affiliate_commission_guardrails.sql`,
`20290303000100_affiliate_commission_ledger.sql`). Migration: `supabase/migrations/20290306000100_partner_revenue_share.sql`.
Status: **code delivered, not yet deployed or executed against a database** (see "Verification").

## What already existed (unchanged)
Referral + channel data (`partners`, `partner_referrals`), the append-only `partner_commission_ledger` (earn, clawback,
reinstatement, legacy), the 30-day hold, the 5000-cent minimum payout, refund/dispute clawbacks, `/staff/partner-commissions`.

## What this adds
| Piece | Purpose |
|---|---|
| `partner_agreements` | Versioned contract terms per partner. Staff-only (RLS). Terms freeze on activation. One active per partner. |
| `partner_payouts` | One row per partner per closed UTC month, plus `adhoc` rows from the old payout button. Staff-only (RLS), never deletable, frozen once approved. |
| `calculate_partner_payouts(period, partner?)` | Monthly calculation from the ledger. Callable by staff or service role. Derivation only: never changes a ledger status. |
| `approve_partner_payout`, `mark_partner_payout_paid`, `void_partner_payout` | Workflow. Mark-paid locks every covered ledger entry and aborts with `stale_payout` if anything moved. |
| `create_partner_agreement_draft`, `activate_partner_agreement`, `terminate_partner_agreement` | Agreement lifecycle. Activation applies rate/term through `set_partner_commission_terms()` so the 20 % / 12-month guardrails and their audit trail still apply. |
| `/staff/partner-payouts` | Console: calculate, review, approve, pay, void, agreements, CSV and PDF downloads. |

## Calculation rules
- Period = a **completed** calendar month in UTC. The open month is refused (`period_not_closed`).
- Eligibility is evaluated as of the first instant of the next month, so the result does not depend on the day you run it.
  Earn/reinstatement entries count after the 30-day hold; clawbacks always count; legacy estimates only if staff approved them.
- `gross` = positive payable entries, `clawback` = negative payable entries (≤ 0), `net` = gross + clawback.
  Unpaid entries from earlier months roll in automatically (they are still payable), so a clawback booked after a payout is netted
  into the next statement.
- Outcome: net ≥ minimum → `calculated` (can be approved). Otherwise `carried_forward` with reason `below_minimum`,
  `negative_balance` (clawbacks exceed earnings) or `nothing_due`. Nothing is paid and the entries stay open.
- Minimum = the agreement's `min_payout_cents`, else `affiliate_min_payout_cents()` (5000).
- Re-running a month updates the unapproved statement in place (idempotent). Approved/paid statements and any month older than the
  latest approved/paid statement are locked.

## Rounding
Rounding happens once per invoice, in `record_partner_commission_for_invoice`: `round(base × rate / 100)` on numeric, half away
from zero (12.5 % of 7900 = 987.5 → 988). Pro-rata refund clawbacks use `round(commission × refunded / charged)` per cumulative
target and only claw back the remainder, so the total can never exceed the commission (thirds of 625: 208 + 209 + 208 = 625).
Statements only sum integer cents and re-check every earn line; a mismatch blocks approval and CSV/PDF export.

## Approval gates
Approve requires: status `calculated`, an agreement in force for the period, partner `approved`, zero rounding mismatches, and a
ledger that still matches the statement. Activating an agreement requires a document reference and an explicit legal-review
confirmation **[COUNSEL]**. Agreement activation, termination, payout approval, payment and voiding are written to `audit_log`
(on the partner's account, actor = staff member).

## Statements (CSV / PDF)
- CSV: one row per line + summary rows, UTF-8 BOM, CRLF, formula-injection guard, amounts as cents and USD numbers.
- PDF: shared `DocumentWriter` design system, English/USD only; characters the built-in font cannot draw become `?`.
- Two audiences: `finance` (includes Stripe invoice ids, document ref, payment reference) and `partner` (omits them).
- The footnote wording in `src/lib/partnerStatementPdf.ts` is a factual description of the calculation, **[COUNSEL]** to review before statements go to partners.

## Operations
1. After month end: `/staff/partner-payouts` → pick the month → **Calculate month** (or schedule
   `select public.calculate_partner_payouts(date_trunc('month', now() - interval '1 month')::date);` with pg_cron as service role; not scheduled by this migration).
2. Review the statement, download the partner copy, **Approve**, pay outside Vireek, then **Mark paid** with the bank reference.
3. A statement that is wrong: **Void** (reason ≥ 10 chars), fix the cause, recalculate.
4. Partners without an active agreement show "No agreement": create + activate one first.

## Known limits
USD only; no money movement; no tax forms/withholding/VAT **[COUNSEL]**; the old `pay_partner_approved_commissions` button still works
(it now writes an `adhoc` payout row) but bypasses the agreement and four-eyes checks; `commissionCents()` in
`src/lib/affiliateCommission.ts` uses floating point and is 1 cent off the database for rates such as 19.99 % (not used for payouts; use
`exactCommissionCents()` from `partnerStatement.ts`); the console is English-only like `/staff/partner-commissions`.

## Rollback
See the header of the migration. Keep the tables; they are financial records.

## Tests
`supabase/tests/database/partner_revenue_share.test.sql` (pgTAP), `src/lib/partnerStatement.test.ts`, `src/lib/partnerStatementPdf.test.ts` (Vitest).
