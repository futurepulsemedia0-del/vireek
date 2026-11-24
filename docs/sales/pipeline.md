# Internal sales pipeline (Vireek's own deals)

Owner: sales lead **[VERIFY: nobody is named in `docs/OWNERS.md`]**. Status: DRAFT process. Nothing here is legal advice; items marked **[COUNSEL]** need review by qualified counsel, and **[VERIFY]** items are assumptions to confirm.

## 1. What this is, and what it is not

Vireek tracks its own deals in the **existing CRM module** (`crm_deals`, created by `20270503000000_crm_sync.sql`, synced with Salesforce / Pipedrive / Zoho by `crm-sync-run`). No second deals table exists. The module had only a free-text `stage` and a `status`; this change adds:

| Added | Where |
|---|---|
| Stage definitions with win probability, forecast category and CRM match names | table `crm_pipeline_stages` |
| Applied discount per deal | column `crm_deals.discount_pct` |
| Deal-desk policy (switch + two thresholds) | table `crm_deal_desk_settings` |
| Discount approval requests (audit trail, no deletes) | table `crm_deal_discount_requests` |
| Pipeline, forecast, deal desk and setup UI | `/dashboard/sales-pipeline` (`src/pages/SalesPipelinePage.tsx`) |
| Pure logic + tests | `src/lib/salesPipeline.ts`, `salesPipeline.test.ts`; DB tests `supabase/tests/database/sales_pipeline.test.sql` |

It is **account-scoped**, like every tenant table (`user_id` = account owner via `get_account_owner_id()`). It is **not** the staff-only area. Staff have no RLS access to tenant tables by design (`20270504000000_staff_account_explorer.sql`), so Vireek runs its sales in an ordinary Vireek-owned account that uses this page. Other tenants get the same page, but the deal desk is **off** for them until their owner enables it.

Closed-deal analysis is separate and stays separate: after a deal is won or lost, record it in `/staff/win-loss` per [win-loss-interview-guide.md](./win-loss-interview-guide.md). That table is staff-only internal data and is not linked to `crm_deals` (a manual step; linking would need a cross-boundary design decision).

## 2. One-time setup

1. **Create or choose the Vireek-owned account** that will hold the deals **[VERIFY: which account; who the owner is]**. Add the sales team as team members. People who need to approve discounts get `can_edit_business_profile` (the existing flag behind `can_manage_crm()`). A dedicated `can_approve_discounts` flag would need changes to `UserPermissions`, the role editor and `has_account_permission` callers; deliberately not done here.
2. **Apply the migration** `supabase/migrations/20290306000100_sales_pipeline.sql` (idempotent; it stops with a clear message if the CRM sync migration is missing). Order: after `20290306000000_signup_qualification.sql`. **Not executed in the sandbox: review it on staging first.**
3. **Create the stages.** Open `/dashboard/sales-pipeline` as the owner or a person with `can_edit_business_profile` and press *Create default stages* (idempotent RPC `crm_seed_default_pipeline_stages`). Defaults: Qualified 10 %, Discovery/demo 25 %, Proposal 50 %, Negotiation 75 %, Contract sent 90 % (categories pipeline / pipeline / best case / commit / commit). **These weights are placeholders [VERIFY]**: replace them with your measured stage-to-win rates once you have at least 5 decided deals per stage (the same minimum the win/loss page uses).
4. **Map CRM stage names.** If a CRM is connected under CRM Sync, add the exact names that CRM uses to each stage's *Match names* (comparison ignores case and extra spaces). Open deals whose stage matches nothing are **left out of the forecast and counted** on the Forecast tab; fix them by adding a match name.
5. **Decide what `amount` means** (for example first-year contract value) and record it here **[VERIFY]**. The forecast sums `amount` as entered; mixing ARR and one-off fees will mislead.
6. **Set the deal-desk policy** (owner only, Setup tab): enable it and set the automatic and manager limits. Shipped defaults are **10 % and 20 %, placeholders [VERIFY with the sales lead]**; nothing is enforced until the owner enables the desk.

## 3. Day to day

- **Add deals** on the Pipeline tab (or let CRM Sync create them). Move a deal by choosing a stage; mark it Won or Lost. Use one currency per forecast: the most common currency among open deals is shown, and deals in another currency (or without one) are counted as excluded.
- **Forecast tab:** weighted = amount x stage probability, open deals only, bucketed by expected close month for the next 6 months, plus *past expected close*, *no close date* and *later*. Commit / best case / pipeline come from the stage's category; `omitted` stages are excluded. Review the exclusion notice every time: a forecast with silent exclusions is wrong.
- **Weekly review rule [VERIFY]:** deals past their expected close date or without one are fixed before the forecast is quoted.

## 4. Deal desk (discount approvals)

| Requested discount | Needs | Who can decide |
|---|---|---|
| up to the automatic limit | nothing; approved on submit, recorded as `auto` | n/a |
| up to the manager limit | manager approval | someone with `can_edit_business_profile`, **never the requester** (the owner is the only exception) |
| above the manager limit | owner approval | the account owner only |

Rules enforced by database triggers (not just the UI):
- The level, status, requester and account are computed on the server; client-sent values are overwritten.
- One pending request per deal. Rejection requires a note. Decided requests are immutable. Requests cannot be deleted.
- A signed-in user cannot **raise** `crm_deals.discount_pct` above `max(automatic limit, highest approved request for that deal)`. Lowering is always allowed. The CRM sync runs without an end user and is not blocked (it does not write `discount_pct`).
- With the desk off, requests are refused and the guard does nothing.

Metrics on the Deal desk tab (pending count, oldest pending, median and slowest-10 % decision time) use weekdays only (Mon-Fri, UTC, no holidays). Auto-approved requests are not counted as decisions. These feed the revenue-operations trigger in [`docs/adr/org-scaling.md`](../adr/org-scaling.md) (signal O12).

## 5. Known limits (honest list)

- An approval is a **ceiling per deal**, not per quote, and does not expire.
- `discount_pct` is **not synced** to Salesforce/Pipedrive/Zoho (the sync field list is fixed in `crm-sync-run`). Record the approved discount in the CRM by hand, or extend the field map in a separate change.
- Someone with direct SQL or service-role access can bypass triggers. That is outside this model.
- The owner can approve an owner-level request they raised themselves (nobody is above them); the row records who decided.
- The page shows the last 1,000 updated deals and the last 300 requests; older deals are not in the forecast (a notice is shown).
- Stage weights are not learned; calibrating them is a manual review.
- Locales: English and Persian (`fa`) ship; other languages fall back to English. The Persian text was written by the assistant and **needs a native review [VERIFY]**.

## 6. Verification status (this change)

| Check | Result |
|---|---|
| Pure logic tests (`salesPipeline.test.ts`, 31 cases) | PASSED with a local Vitest-compatible shim in Node 22; **real Vitest NOT RUN** (no `node_modules`, no network) |
| `tsc --strict` on `src/lib/salesPipeline.ts` | PASSED |
| Typecheck of the page, API layer and locales test; ESLint; project build | NOT RUN (dependencies not installed) |
| Migration applied twice; `sales_pipeline.test.sql` (pgTAP) | NOT RUN (no PostgreSQL in the sandbox). Run `supabase db reset && supabase test db` |
| Persian/English locale key and placeholder parity | PASSED (node script); the same check is in `salesPipeline.locales.test.ts` (NOT RUN under Vitest) |
| Manual end-to-end in a browser | NOT RUN |

## 7. Rollback

The migration header lists the manual, destructive rollback (drop trigger, tables, column). Export `crm_deal_discount_requests` first: it is the approval audit trail.
