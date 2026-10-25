# Vireek Pay & Capital — foundations, partners and licensing

Status: **foundations built up to the provider boundary. Sandbox only. Nothing here moves real money, issues real
cards or makes credit decisions until a licensed partner is contracted, an adapter is written and staff flip a
product to live.** This document is engineering guidance, not legal advice — every item marked **[COUNSEL]** must be
confirmed by qualified counsel for the states and entity structure you operate in.

## 1. What exists

| Product | Who moves the money / decides | What Vireek builds (this repo) |
|---|---|---|
| Instant payouts | Licensed payment partner | Eligibility (approved pay-run item), fee quote, atomic reservation, ledger, double-pay guard, webhook state machine |
| Earned-wage access (EWA) | Licensed partner funds + moves | Availability from **approved** hours/commission only, fee quote, caps, outstanding-advance tracking, recovery ledger, settlement report |
| Spend cards | Licensed issuer / program manager + sponsor bank | Policy engine (limits, MCC allow/block, receipts), authorization webhook, freeze/cancel, transaction ledger, receipts bucket |
| Capital | Licensed lending partner **decides** | Pre-screen from real paid/unpaid invoices, receivable pledging (no double-financing), partner-offer storage with mandatory disclosure fields |

Control plane (all products): per-product `enabled` (default **off**), `sandbox|live` mode, kill switch, tenant freeze,
fee schedule + caps, versioned disclosures with recorded acceptance, append-only audit. Staff UI: `/staff/pay-controls`.

## 2. Safety model — every layer fails closed

1. `pay_platform_controls.enabled = false` by default.
2. Kill: `staff_pay_kill_all(reason)` or per-product off → next request is refused (`killed`). Card authorizations are declined too.
3. Tenant freeze: one product or all, with reason.
4. `mode = 'live'` is blocked by a CHECK unless a partner agreement reference **and** approver stamp exist, and by
   `pay_product_state` unless the **latest version of every disclosure of that product is `legal_reviewed`**.
5. Live adapter not configured → HTTP 503 `provider_not_configured`. There is **no fallback to sandbox** and no fake success.
6. Sandbox rows carry `sandbox = true` forever; the UI shows a permanent Sandbox banner.
7. Money writes are service-role-only RPCs; ledger money fields are immutable (trigger); one active instant payout per pay-run item (unique index).
8. Ambiguous provider errors (timeout after send) → `needs_review`, never auto-retried; counted against availability until a human resolves it.
9. "Never fake lending decisions": the sandbox lender returns a **fixed, labeled fixture** independent of the applicant's data; offers
   missing total repayment / finance charge / term / estimated APR are rejected in code **and** by NOT NULL + CHECK constraints.

## 3. Eligibility from real data

* **EWA**: `pay_get_ewa_inputs()` returns approved timesheet hours (not yet on a final run), approved commission, rates and outstanding advances;
  `ewaEngine.ts` computes accrued gross → estimated net (employee withholding %) → × `max_pct_of_accrued` (default 50%) − outstanding, capped by
  per-request and per-tenant daily limits, minimum $20. Pending/rejected items never count. Salary accrues pro rata, never beyond one period.
* **Instant payout**: only `net_pay_cents` of items on an **approved**, unpaid pay run; all-or-nothing; nothing to repay.
* **Capital**: `capital_get_revenue_profile()` — revenue = paid invoices + paid payment requests whose job has no paid invoice (counted once);
  open receivables = invoices `sent|viewed` with a positive total. Pre-screen thresholds (defaults in `capitalEngine.ts`, overridable in
  `pay_platform_controls.config.prescreen`): ≥6 months history, ≥$60k paid revenue/12 mo, ≥20 paid invoices, ≤1 lost dispute, ≤2 open disputes,
  no sharp 3-month decline, receivables ≥$250 and ≤90 days old, no customer >40% of the pledged pool, ≥$5k qualifying receivables.
  Output is only `eligible_to_apply | not_yet_eligible` plus **specific reason codes** — never an approval, rate or amount.
  Treat the thresholds as product placeholders to be tuned with the lending partner's own criteria.

## 4. Partner and licensing requirements (verify every item — [COUNSEL])

**Principle:** Vireek stays a software/orchestration layer. A licensed partner holds funds, issues cards and extends credit. Do not take possession of
customer funds or lend your own money without the licenses below.

### 4.1 Instant payouts / EWA — payment partner
* Partner that is a licensed money transmitter or bank-partnered payments platform able to pay out to debit cards / bank accounts (instant rails such as RTP/FedNow/push-to-card) in every state you serve.
* Funds flow: employer funds payroll → partner → technician. Confirm who funds EWA advances (partner-funded vs employer-funded) — this drives lending/money-transmission classification.
* **[COUNSEL]** EWA legal characterization: several states regulate EWA specifically (registration, fee caps/disclosures, "not a loan" safe harbors); federal treatment has changed over time and must be re-verified. Decide per-state availability and keep a state allow-list (add to `config` if needed).
* **[COUNSEL]** Wage-payment and deduction authorization: repayment by payroll deduction needs written employee authorization and must respect minimum-wage/net-pay floors.
* KYC/OFAC on payees (partner), NACHA/card-network rules, chargeback/return handling, 1099/W-2 reporting, state wage-payment timing laws.
* Contractual: SLA, webhook signing scheme, idempotency semantics, sandbox credentials, data-processing agreement.

### 4.2 Spend cards — issuer / program manager + sponsor bank
* Issuing-processor or BaaS program manager with a sponsor bank (BIN sponsorship), PCI DSS scope kept with the issuer (Vireek never stores PAN/CVV — only `last4`, brand, external id).
* Real-time authorization decisioning: partner webhook gives ~2 s; `pay-webhook?kind=cards` answers from the pure policy engine. Confirm the partner's response contract before wiring `parseAuthorizationEvent`.
* Cardholder/commercial agreement, program disclosures, E-Sign consent, Reg E/Reg Z applicability for **business** cards (usually commercial — **[COUNSEL]**), fraud/dispute workflow, lost/stolen process.
* 1099-K/expense reporting and receipt retention policy.

### 4.3 Capital — lending partner
* A licensed commercial lender / bank partner / marketplace that underwrites and funds (and, for state-by-state licensing, holds the commercial-lending, broker or financing licenses). Vireek as a **referrer/data provider** may itself need a broker/solicitation license in some states — **[COUNSEL]**.
* **Commercial-financing disclosure laws** (e.g. CA, NY, UT, FL, GA, CT, KS, MO, TX and others, plus federal developments such as Section 1071 data collection) require specific cost disclosures incl. estimated APR; the partner must supply them — that is why the offer schema requires them.
* **Fair lending**: ECOA/Reg B applies to business credit; keep the reason-code output of the pre-screen, and have the partner own adverse-action notices.
* Disclose any referral compensation Vireek receives (placeholder in the `capital_application` disclosure).
* Data sharing: only on explicit application; package contains aggregates + invoice id/amount/dates + a salted hash of the customer (no names/emails). Re-confirm against your privacy policy and the partner DPA.
* Receivables financing specifics: assignment/notification/UCC filing, customer-payment redirection (if any), dilution/chargeback treatment — partner-defined; the `capital_application_receivables` pledge table prevents double-submission only inside Vireek.

### 4.4 Company-level
* Privacy policy + terms updates (new data flows), SOC 2 / security questionnaire readiness, incident-response plan with the kill-switch runbook, vendor risk reviews, insurance (E&O/cyber), complaint-handling process, record retention (ledgers must **not** be hard-deleted: exclude `pay_*`, `card_*`, `capital_*`, `spend_cards` from account-deletion hard-delete lists; anonymize instead).

## 5. Go-live checklist (per product)

1. Counsel review of the product's disclosures → publish final text with `staff_pay_publish_disclosure`, then **Mark reviewed** in `/staff/pay-controls`.
2. Contract signed; store the agreement ref in "Partner agreement ref".
3. Write `providers/<partner>.ts` implementing the interface in `_shared/pay/types.ts` against the partner's signed docs (endpoints, signatures, idempotency). Register it in `registry.ts`. Set secrets (see §7). Add adapter tests with recorded fixtures.
4. Configure webhooks → `…/functions/v1/pay-webhook?kind=payouts|cards` (deployed `--no-verify-jwt`).
5. Set the real fee schedule and caps in the control page (the seeded values are sandbox placeholders).
6. Run the sandbox end-to-end in staging, run `supabase test db` and `npm test`.
7. Staff: set mode **Live**, enable for the product, pilot with one frozen-by-default tenant list (use tenant freeze to allow-list by exclusion), monitor `pay_transfers` `needs_review` and the audit trail.
8. Rehearse the kill switch.

## 6. Known integration decisions (not hidden)

* **Payroll ledger is untouched.** `approve_and_post_pay_run` posts `total_net_cents`; advance recovery is therefore a **settlement report + recovery ledger**
  (`pay_run_settlement`, `pay_record_advance_recovery`), and the actual deduction happens when net pay is disbursed. Posting a "technician advances"
  clearing entry to the GL needs a chart-of-accounts decision from your accountant.
* Instant payout of a pay-run item sets `pay_run_items.paid_at` (and clears it on reversal). Verify your "mark pay run paid / disburse" flow skips items that already have `paid_at`; the settlement report shows the amount still to disburse per employee.
* Customer-facing 1099 / tax withholding on advances follows the normal paycheck; Vireek does not report anything itself.

## 7. Configuration

| Name | Where | Purpose |
|---|---|---|
| `PAY_SANDBOX_WEBHOOK_SECRET` | Supabase secrets (optional) | Sign sandbox webhook test events (`x-sandbox-signature` = hex HMAC-SHA256 of body). Unset = sandbox webhooks rejected. |
| *(live partner secrets)* | Supabase secrets | Added with the real adapter. Never in the browser. |

Functions: `pay-transfer-request`, `pay-card-manage`, `capital-manage` (JWT on) and `pay-webhook` (`verify_jwt = false`).

## 8. Operations

* Kill everything: `/staff/pay-controls` → reason → **Kill ALL**, or SQL `select staff_pay_kill_all('reason…')` as a staff user.
* Stuck reservations: `pay_flag_stuck_transfers()` runs every 5 min (pg_cron) → `needs_review`. Resolve by checking the partner dashboard, then `pay_finalize_transfer(id,'paid'|'failed',…)` via service role.
* Weekly: reconcile `pay_transfers` (paid, live) against the partner's statements; investigate any `needs_review`.
