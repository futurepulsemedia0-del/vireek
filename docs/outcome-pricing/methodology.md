# Invoice-recovery outcome pricing — methodology (rule version `oc-rules-v1`)

Written down here and shown in the app and on every statement PDF. Numbers marked **PLACEHOLDER** are defaults, not approved policy. Legal text is **[COUNSEL]**.

## What counts as an outcome
A paid invoice is a billable outcome only if ALL hold:

1. **Logged Vireek action.** An action of type fix, resubmit, follow-up or escalation by actor `vireek` exists in `invoice_outcome_actions`.
2. **At risk at action time.** Recomputed from invoice facts (never trusted from a stored label): not yet paid in full at that moment AND (age since sent/created > **30 days** PLACEHOLDER, OR a payer rejection recorded before the action and not cleared).
3. **Paid afterwards.** A payment arrives at or after the action, within **60 days** PLACEHOLDER, and **after the original due date**. Unknown due date means nothing is attributed.
4. **Confirmed.** A person confirmed the outcome, or the chain is complete (action + stored at-risk snapshot + payment record + known due date). Mode `human_only` requires a person.

## Never counted
Paid within normal terms; invoice disputed; credited (any amount); void / written off; test invoices; amounts already counted in an earlier statement; duplicate invoice ids in the input; invalid timestamps or amounts (fail closed).

## One outcome per invoice
One decision per invoice. With several qualifying actions, the latest one before the first eligible payment is primary and all are kept as evidence. The database also enforces one live counted outcome per invoice (`uq_io_events_counted`); voiding a statement releases its events.

## Fee math (integer cents, half-up)
- `recovered_pct`: per line `round_half_up(recovered * bps / 10000)`.
- `first_pass_per_invoice`: `max(0, accepted − ceil(submitted * baselineRate)) * perInvoice`. No baseline means no fee.
- `none`: base fee only.
- Floor applies only when at least one billable outcome exists. Cap bounds the outcome fee. Monthly maximum bounds base + outcome.
- The difference between the sum of lines and the outcome fee is printed as one **adjustment** line, so lines + adjustment always equal the outcome fee.
- Pilot-free period and "no outcome fee in the first N days": events whose action happened before the cut-off carry no fee. Base fee is also waived while the whole period ends before the cut-off.
- Suspension (measurement unreliable) zeroes the outcome fee only. The global/account kill switch zeroes everything and blocks every transition except void.

## Baseline comparison
Observational only (`causal: false` always). Shown with sample sizes; "insufficient data" below 30 observations or when the baseline is missing; first-pass uses 95% Wilson intervals and calls a change only when intervals do not overlap. **Not wired yet:** the Task C baseline source (see report).

## Statement lifecycle
`draft → approved → invoiced → paid | disputed`, with `void`. `disputed → invoiced | void`. Paid and void are terminal. Enforced twice: `STATEMENT_TRANSITIONS` (TypeScript) and the database trigger. After draft, snapshot, hash, totals, period and terms are immutable. Approval needs a staff user who did not generate the draft. Invoicing needs the **14-day** hold PLACEHOLDER to have elapsed and a Stripe TEST record.

## Disputes
A customer may contest any line while the statement is approved, invoiced or disputed, up to **60 days** PLACEHOLDER after approval, with a 10–2000 character reason. Contested lines are excluded from the billable total until resolved (open / under review / upheld = excluded; rejected / withdrawn = included). SLA PLACEHOLDER: acknowledge within 48 hours, resolve within 10 days. Resolution needs a note; everything is in the append-only audit table.
Known gap: a *paid* statement cannot be contested in-app (it goes to support).

## Marketing-safe claims
`outcomeClaims.ts` emits only claims the account's own data supports, each with qualifiers, never causal wording, and nothing below 5 qualifying outcomes. Cross-customer benchmarks need ≥ 10 distinct accounts, median only, and are flagged **[VERIFY] [COUNSEL]**.
