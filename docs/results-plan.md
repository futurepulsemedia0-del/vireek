# Results Plan — runbook, setup and decisions

Status: built, **not yet run end-to-end**. Nothing here is live until the checklist below is completed.

## 1. Architecture (one paragraph)
`jobs` (+ new milestone columns) → `results-plan-ingest` (cron, 20 min) runs the pure rules in `_shared/results-plan/qualification.ts`,
appends evidence to the hash-chained `proof_ledger`, and creates `results_plan_charges` (pending) → `results-plan-bill` (cron, 30 min) prices each
charge with `pricing.ts` (caps / guarantee / never-more-than-flat) and posts a Stripe Billing Meter event → owners see everything in
`/dashboard/results-plan`, can dispute within 14 days (`rp_open_dispute`), staff handle the queue in `/staff/results-plan`.

## 2. Setup order
1. Apply the three migrations in order (`20280402000000_…proof_ledger`, `20280402000100_…billing_disputes`, `20280402000200_…hardening`) on **staging** first.
2. Add the two `[functions.*] verify_jwt = false` blocks to `supabase/config.toml`.
3. Deploy `results-plan-ingest`, `results-plan-bill`, `results-plan-enroll`.
4. Secrets: `RESULTS_PLAN_CRON_SECRET`, `STRIPE_SECRET_KEY` (exists), `STRIPE_RESULTS_METER_EVENT`, `STRIPE_RESULTS_METERED_PRICE_ID`,
   `STRIPE_RESULTS_BASE_PRICE_ID` (hybrid only), `STRIPE_FLAT_PRICE_ID_<PLAN>` for each flat plan owners may return to, optional `STRIPE_AUTOMATIC_TAX=true`.
5. Stripe: create a Billing Meter (aggregation: sum, event name = `STRIPE_RESULTS_METER_EVENT`, payload key `stripe_customer_id`, value key `value`);
   a metered Price on that meter at **1 minor currency unit per unit** (the code posts cents); for hybrid, a monthly base Price whose amount equals the approved `base_fee_cents`.
   The enroll function refuses to start checkout if either price differs from the approved terms.
6. Schedule the two cron jobs (SQL in the header of migration 2).
7. Create a DRAFT terms row (ready-made recommended draft: `docs/results-plan-draft-terms.sql`), review the margin table, then approve it with `select rp_staff_approve_terms('<id>')` (approval is refused without a monthly cap, guarantee caps and fair-use minutes).
   Set `is_public = true` only when you want the price on /pricing. Publish the rules with `select rp_staff_publish_rules('rp-rules-v1')`.

The draft file uses the recommended structure ($29 base + $15/verified job, $199 monthly cap, 30-day guarantee capped at $79 / 400 minutes, 1,500 fair-use minutes, confirmed fallback after 14 days). All of it is a placeholder for your decision.

## 3. Decisions you must make (all numbers are PLACEHOLDERS until approved)
| Decision | Placeholder in code |
|---|---|
| Price per verified job; tier prices (service call vs install) | none — no built-in price |
| Model: hybrid (base + per job) or per-job with floor | none |
| Monthly cap / "never more than Flat plan" default | flat-plan cap defaults ON per account (owner can disable) |
| Billing stage | `completed` |
| Existing-work window / duplicate window / cancellation-void window | 30 days / 24 h / 72 h |
| Dispute window | 14 days |
| 30-day guarantee terms (cap amount) | `guarantee_days`, `guarantee_cap_cents` on the terms row |
| Trial days | `trial_days` on the terms row |
| Unit costs (voice/SMS/AI/ops/credit rate) | `unitEconomics.ts` defaults — calibrate from real data |
| Anomaly thresholds | `anomaly.ts` defaults |
| Legal terms | draft below — needs legal review |

## 4. Behaviours added in the hardening phase
- Rework / callback jobs (`jobs.is_rework`, `rework_of_job_id`) are never billed.
- Deterministic rejections (duplicate, existing open job, rework, owner-created, internal test) are written once to the ledger as `rejected` and never re-evaluated, so a prior job closing later cannot turn a rejected booking billable.
- Optional confirmed fallback: when billing at `completed`/`paid`, a confirmed, never-cancelled job becomes billable at the Confirmed stage after `confirmed_fallback_days`. Charges record `billed_at_level` and `via_fallback`; disputes are judged against that level.
- Fair-use minutes are MONITORED, not enforced: staff flag at 80%/100% and the owner gets a notice at 100%. Calls are never cut off automatically.

## 5. Known limitations (honest list)
- Only voice calls (`jobs.call_id → calls`) count as Sarah's first contact; SMS/chat jobs are not billable until those sources are wired.
- The ledger stores references and a hash of the transcript excerpt, not the excerpt itself (immutable storage must not hold personal data); the UI reads call details live under RLS.
- CRM job ID in the evidence chain is `null` until the CRM sync exposes a stable external job reference.
- Milestone columns are filled by a trigger from now on; jobs created before the migration have no `confirmed_at`/`cancelled_at` history (only jobs created after opt-in are ever billed).
- Customer-confirmation SMS ("Did [business] arrive?") is NOT implemented.
- Stripe meter events dedupe on `identifier` for a rolling 24 h; a failed charge retried after 24 h could in theory double-post — monitor `failed` rows.
- Monthly PDF statement is not implemented (CSV is).
- Strings use `t(key, default)`; translation files for other languages are not added (English default shows).
- Team members cannot manage billing (owner only).

## 6. Terms — DRAFT FOR LEGAL REVIEW (not legal advice, not binding)
1. **Verified Job.** A booking is billable only if it meets the published rules version in force when it was verified.
2. **Charges.** You pay the per-job price in your approved terms for each Verified Job, plus any base fee. Monthly limits you or we set are never exceeded.
3. **Evidence and disputes.** Each charge links to its evidence. You may dispute a charge within 14 days; if our records cannot support it, it is credited. Otherwise a reviewer decides in good faith.
4. **Your obligations.** Keep job status reasonably up to date. Systematically withholding completion marks or relabelling jobs to avoid charges may lead to review and suspension of the Results Plan.
5. **Our obligations.** We will not bill existing work, duplicates, spam, wrong numbers, internal tests or jobs you created.
6. **Changes.** Rule or price changes apply only after notice and never to jobs already verified.
7. **Leaving.** You may return to a flat plan at any time once pending verified jobs have been posted.
8. **Records.** The Proof Ledger is append-only; erasure of your account removes it.
