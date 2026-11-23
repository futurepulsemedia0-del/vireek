# Pricing change control

Status: policy plus tooling. Nothing here has been run against production, Stripe or a live Supabase project.
Legal items are marked **[COUNSEL]** (a lawyer must decide). Facts that could not be confirmed from the repository are marked **[VERIFY]**.

## 1. What is controlled

A "pricing change" is any change to what a customer is charged, what a plan includes, or how usage is billed.

| Guarded file | Why |
| --- | --- |
| `src/lib/pricing.ts` | Plans, prices, allowances, FAQ claims and the Stripe Payment Links shown to customers |
| `supabase/functions/_shared/billing/pricingCatalog.ts` | Documented single source of truth for prices and allowances (skipped by the check if the file is absent) |

The list lives in `GUARDED_FILES` in `scripts/pricing/pricing-change-check.mjs`. Add a path there to guard more files.
Stripe dashboard changes (new prices, links, coupons) are outside the repository. They must still have a `pricing_changes` record (section 4).

## 2. Who can do what

| Role | May | May not |
| --- | --- | --- |
| Any Vireek staff member (`is_vireek_staff`) | Propose a change, withdraw their own proposal, read the list | Approve; record counsel review as completed |
| Approver (row in `pricing_change_approvers`, also staff) | Approve or reject, record counsel review, withdraw | Approve a change they requested |
| Everyone else, including customers and tenant admins | Nothing | Read or write any of it |

Rules enforced by the database, not by the UI:

1. Two-person rule: the approver is never the requester.
2. The approver list is empty after the migration. The owner adds approvers by SQL (see the end of the migration file). Use at least two staff accounts.
3. A change that requires notice cannot be approved until counsel review is recorded as completed, and its effective date must be at least `notice_days` after approval.
4. Records are append-only. Descriptive fields never change; to correct a proposal, withdraw it and propose a new one.

## 3. Grandfathering rules

What the code does today (verified by reading the repository, not by running it):

- Existing subscribers keep the allowance stored on their account (`profiles.minutes_included`); the `LEGACY_PLANS` table in `pricingCatalog.ts` exists only so legacy Stripe prices are recognised and never silently upgraded.
- `docs/pricing-overhaul-release-checklist.md` instructs keeping the OLD Stripe prices active and not archiving them, so current subscribers stay on them.

Each change must choose exactly one rule and record it in `grandfathering`:

| Value | Meaning |
| --- | --- |
| `not_applicable` | No existing customer is affected (for example a brand-new plan, or a baseline record) |
| `grandfathered` | Existing customers keep their current terms; only new sales get the new terms |
| `migrate_at_renewal` | Existing customers move to the new terms at their next renewal, after notice |
| `immediate` | New terms apply to existing customers on the effective date, after notice |

Default: `grandfathered`. `immediate` and `migrate_at_renewal` change what a current customer pays, so they always set `notice_required = true`.
Price decreases and added features that cost the customer nothing may use `not_applicable` or `immediate` with no notice, but the record is still required.

## 4. Process

1. **Propose.** A staff member calls `staff_pricing_change_propose(...)` (title, summary, effective date, grandfathering, affected plans, notice days if any). The database allocates `PC-YYYY-NNNN`.
2. **Counsel** (only if notice is required). The approver records `staff_pricing_change_set_counsel(id, 'completed')` after counsel has reviewed the notice text and period. **[COUNSEL]**
3. **Approve.** A different approver calls `staff_pricing_change_decide(id, 'approve')`. Rejection requires a written reason.
4. **Pull request.** The author adds one entry to `docs/pricing/pricing-changes.json` (same `change_ref`, requester, approver, approval date, effective date, grandfathering, notice) and the new fingerprints printed by `npm run pricing:change-check -- --fingerprint`. Entries are append-only.
5. **CI** (`.github/workflows/pricing-change-control.yml`) fails the pull request if a guarded file changed without a NEW matching entry, if an old entry was edited or removed, or if an entry is malformed.
6. **Notify customers** per section 5, before the effective date.
7. **Deploy, then mark effective.** After release on or after the effective date, call `staff_pricing_change_mark_effective(id, <git commit>, <fingerprints>)`.

Emergency changes (for example a wrong price shown publicly) follow the same steps with a short effective date. There is no bypass. If both approvers are unavailable, fix the page with a revert (a revert to previously approved content still needs the matching, already-approved entry).

## 5. Notice requirements **[COUNSEL]**

This document does not state any legal notice period. The required notice depends on the contract terms customers accepted, the jurisdictions of those customers, and the billing arrangement. Counsel must fill this table; the tooling only enforces the number that is entered.

| Situation | Notice period (days) | Channel | Text approved by counsel |
| --- | --- | --- | --- |
| Price increase for monthly subscribers | **[COUNSEL]** | **[COUNSEL]** | **[COUNSEL]** |
| Price increase for annual subscribers (at renewal) | **[COUNSEL]** | **[COUNSEL]** | **[COUNSEL]** |
| Reduction of included minutes, seats or features | **[COUNSEL]** | **[COUNSEL]** | **[COUNSEL]** |
| Enterprise customers on a signed contract | **[COUNSEL]** | **[COUNSEL]** | **[COUNSEL]** |
| Customers in the EU/UK and other regulated regions | **[COUNSEL]** | **[COUNSEL]** | **[COUNSEL]** |

Existing public wording (`PRICING_FAQS` in `pricing.ts`) says plan changes take effect on the next billing cycle with proration. Whether Terms of Service, the Refund Policy and the SLA need to change alongside any price change is a **[COUNSEL]** decision (the legal pages are allowlisted as "DECISION" in `scripts/check-pricing-drift.mjs`).

## 6. What the CI check proves, and what it does not

Proves: a well-formed ledger entry exists for the exact current content of each guarded file (fingerprints ignore comments and formatting, not values), the entry names an approver from the ledger's approver list who is not the requester, the effective date respects the entered notice days, and no earlier entry was rewritten.

Does not prove: that the named person really approved, or that counsel really reviewed. That rests on the database workflow and on code-owner review of `docs/pricing/**` and `src/lib/pricing.ts`.
**[VERIFY]** `.github/CODEOWNERS` currently contains only placeholder owners (`@OWNER_*`), which GitHub ignores, so no review is enforced yet. After replacing them, add a rule for `/docs/pricing/` and `/src/lib/pricing.ts`, and make "Pricing change control" a required status check in branch protection (both are repository settings, not files).

The database record and the repository ledger are separate copies of the same decision. Nothing reconciles them automatically (CI has no database credentials). Compare them when marking a change effective.

## 7. One-time setup checklist

1. Run the migration `20290307000000_pricing_changes.sql`.
2. Insert at least two approvers (SQL at the end of the migration).
3. Edit `docs/pricing/pricing-changes.json`: set `approvers`, and the baseline entry's `approved_by`, `approved_at`, `effective_date` to real values. The check rejects placeholders on purpose.
4. Mirror the baseline in the database with `staff_pricing_change_propose(..., 'baseline')`, approve it with a second person, and mark it effective with the current commit.
5. Enable the required status check and replace the CODEOWNERS placeholders.
6. Counsel fills section 5.
