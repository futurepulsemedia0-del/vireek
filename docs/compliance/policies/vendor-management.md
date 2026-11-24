# Vendor and sub-processor management policy

> **DRAFT — not approved.** Owner: _to be assigned_ · Approved by: _pending_ · Last review: _pending_. Adopting this text is a company decision; it makes no compliance claim (see `src/lib/trust/claims.ts`).

## Purpose and scope
How third-party providers are selected, contracted and reviewed.

## Existing technical controls (evidence in this repository)
- Provider inventory from code: `docs/generated/INTEGRATIONS.md`
- Transfers and contracts: `docs/compliance/transfers-and-contracts.md`; data map: `docs/compliance/data-map.md`

## Vendor review register
The register is the table `vendor_reviews` (migration `supabase/migrations/20290307000000_vendor_review_register.sql`): vendor, criticality, last review, outcome, evidence links, next due date. It is Vireek-internal (staff only through RLS) and has no delete: a vendor that is gone is retired, so the review history stays.

- **Seeded from code, not by hand.** Every external provider found in `supabase/functions` (the vendor-exit scan, `docs/vendor-exit/`) plus the published sub-processor list (`src/lib/subprocessors.ts`) has a row. `node scripts/compliance/gen-vendor-review-seed.mjs --check` fails when a vendor appears in code without a row; `--emit-missing` prints the idempotent INSERT for a new migration. `npm run test:scripts:vendor-review` runs the guard tests.
- **Criticality is a proposal.** It is derived from the vendor-exit tier (tier 1 critical, tier 2 high, tier 3 medium; tenant-chosen connectors and public data APIs low). Management decides; an edit in the register is recorded as `manual`. **[VERIFY]**
- **A review needs evidence.** Recording one means setting `last_reviewed_on`, `last_review_outcome` and at least one evidence link (an https URL or a repository path under `docs/`; no credentials, no secrets). The database rejects a review without evidence. `next_due_on` follows automatically (`review_interval_months`, default 12 = "annual review"; the policy owner must confirm the interval per criticality **[VERIFY]**).
- **Reminders.** A daily job (`vireek-vendor-review-evaluate`, pg_cron, 06:23 UTC when pg_cron is enabled) opens one reminder per vendor that is never reviewed, due within 30 days, or overdue. The edge function `vendor-review-reminders` (header `X-Cron-Secret` = `TRUST_CRON_SECRET`; schedule it once a day from the external scheduler) e-mails one digest to Vireek staff; overdue reminders repeat every 7 days. Reminder lead time and repeat interval are proposals. **[VERIFY]**
- **What the register does not prove.** A row is a record that someone looked, not evidence that the vendor is secure, contracted, or compliant. All seeded vendors start as "never reviewed"; no review, outcome or evidence has been recorded by the migration.

## Gaps the owner must close before approval
- DPA status per provider (not tracked in the register; see `docs/compliance/transfers-and-contracts.md`) **[COUNSEL]**
- Approve the review interval and reminder lead time per criticality, and name an owner role per vendor (`owner_role` is empty)
- Run the first review of every critical and high vendor and attach the evidence
- A staff screen for the register (today staff use the table through RLS or the SQL editor)
