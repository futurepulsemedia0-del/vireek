# Results Plan: human approval checklist

Status: **DRAFT.** Two candidate terms rows exist (`Draft - Hybrid 99`, `Draft - Hybrid 249`, migration `20290303000000_results_plan_draft_pricing_terms.sql`).
They are `status = 'draft'`, `is_public = false`, `approved_by/approved_at = NULL`, and rule version `rp-rules-v1` is unpublished.
Nothing in this repository approves, publishes or activates them. Approval is a human action by Vireek staff through the existing staff-only path.

Every number in `src/lib/resultsPlan/scenarios.test.ts` rests on PLACEHOLDER costs (`UNIT_COST_DEFAULTS`). Calibrate them from real data before deciding.

## Decisions required before approval

| # | Decision | Where it lives today | Notes / known gap |
|---|----------|----------------------|-------------------|
| 1 | **Rule version number(s)** | `results_plan_rule_versions` (`rp-rules-v1`, `published_at` NULL, definition says "numbers are placeholders") | Keep `rp-rules-v1` or create a new version? Publishing is irreversible for accounts that enroll. Definition values (existing-work 30 d, duplicate 24 h, cancel 72 h) must be confirmed. |
| 2 | **Price** (base fee, per verified job, monthly cap, fair-use minutes) | Draft rows: 99 / 249 base, 15 / 12 per job, caps 249 / 549, 300 / 700 min | Decide one plan or both; confirm the cost model. Note: Hybrid 249's cap does not bind at 20 jobs (20 x $12 = $240 < $549). |
| 3 | **Guarantee wording** and caps | `guarantee_days` 30, `guarantee_cap_cents` set on the drafts | `guarantee_minutes_cap` is **NULL**: `rp_staff_approve_terms()` raises `GUARANTEE_CAPS_REQUIRED` until it is set. Draft rows cannot be edited by app roles (writes revoked), so the value must be chosen and applied by a trusted operator before approval. Approved rows are immutable. |
| 4 | **Billing level** (booked / confirmed / completed / paid) | `results_plan_accounts.billing_level`, default `completed`; optional `confirmed_fallback_days` | Decide the default and whether the confirmed fallback is offered. |
| 5 | **How a verified booking is confirmed, per integration** | `jobs.confirmed_at/completed_at/paid_at/job_source`, `results-plan-ingest`, `qualification.ts` | Define the evidence for each source (Sarah call/SMS/chat, owner-created, CRM import such as Jobber) and who may mark completion. Owner spam/wrong-number flags stay advisory until staff accept them. |
| 6 | **Dispute handling** | `rp_open_dispute`, `rp_staff_resolve_dispute`, 14-day window (`DISPUTE_WINDOW_DAYS`) | Confirm the window, the auto-credit rules, staff SLA and escalation path. |
| 7 | **Trial economics** | `trial_days` 14 on both drafts | Verify how Stripe handles the base fee during the trial. If it is waived, usage cost accrues with no base revenue (the model does not cover this month). |
| 8 | **Legal review** | n/a | Pricing and guarantee copy, "verified job" definition, refund/credit terms, tax handling, consumer/regional rules. |
| 9 | **Stripe configuration** (names only) | `results-plan-enroll` | `STRIPE_RESULTS_BASE_PRICE_ID`, `STRIPE_RESULTS_METERED_PRICE_ID`, `STRIPE_AUTOMATIC_TAX`. **Gap:** enroll compares the Stripe base price `unit_amount` with the terms' `base_fee_cents`, and only ONE base price id variable exists. Two plans with different base fees (9900 vs 24900) cannot both enroll until a per-terms base price is supported or only one plan is approved. |

## Approval path (human only, in this order)

1. Resolve items 1 to 9 and record the decisions.
2. Set the missing `guarantee_minutes_cap` on the chosen draft (trusted operator, before approval).
3. Publish the rule version (`rp_staff_publish_rules`) only after legal sign-off on the definition.
4. Approve the chosen terms (`rp_staff_approve_terms`). It requires a monthly cap, guarantee caps and fair-use minutes.
5. Only then make terms public (`is_public`) and configure Stripe price ids.

## Rollback of the draft rows

See the header of the migration (deletes only unapproved, unattached drafts and drops the draft-name index).
