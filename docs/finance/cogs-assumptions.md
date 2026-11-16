# COGS and gross-margin model: assumptions

Migration: `supabase/migrations/20290305000100_cogs_margin_views.sql`. Dashboard: `/staff/margins` → **Realised COGS** (staff only).
Tests: `supabase/tests/database/cogs_margin_views.test.sql` (pgTAP), `src/lib/cogs.test.ts`, `supabase/functions/_shared/billing/cogsViews.test.ts` (Vitest).

## Reuse (nothing here duplicates existing work)
- Cost source: `cost_ledger` (append-only). Voice rows carry `call_id`; AI rows are `resource_type = 'llm_tokens'` without `call_id`. Voice and AI are never summed from two tables, so nothing is double counted.
- Price source: `supabase/functions/_shared/billing/pricingCatalog.ts` (`CATALOG_PLANS`). `cogs_plan_catalog()` is a SQL mirror; `cogsViews.test.ts` fails CI on drift. No price is invented.
- Existing list-price margin at 100% use (`src/lib/planMargins.ts`) is unchanged. This model is the **realised** counterpart.

## Definitions
| Metric | Definition |
|---|---|
| Cost per call-minute | ledger cost of calls that have ≥1 ledger row ÷ their minutes (`duration_seconds / 60`). Uncosted calls are excluded and shown as *coverage*. |
| AI action | one non-correction `llm_tokens` ledger row with no `call_id`. Cost per action = net cost (corrections included) ÷ actions. |
| Other variable cost | ledger rows with no `call_id` that are not LLM (SMS, maps, storage, other API). |
| Revenue | list monthly price × tenants that are billed (stripe subscription or tier override) in that plan. Enterprise ("from" price, quoted) and free have **NULL** revenue and margin, never 0. |
| Gross margin | revenue − total variable cost (micro-USD ÷ 10,000 = cents). Margin % is NULL when revenue is NULL/0. |

## Known limits (shown to staff, not hidden)
1. **Plan history:** the plan is the tenant's *current* effective tier (`plan_effective_tier`), applied to any month. Past months are approximate. [VERIFY]
2. **Revenue is list price only:** no discounts, coupons, annual proration, overage revenue, taxes, or grandfathered legacy prices (`LEGACY_PLANS`). Legacy accounts are priced at today's catalog price. [VERIFY against Stripe]
3. **Cost is variable usage only:** no phone-number rental, platform hosting (`platform_fixed`), support, payment-processing fees or affiliate commissions. Margins are therefore *higher* than fully loaded margins.
4. **Cost completeness:** only calls with a ledger row are costed. Margin for a plan is flagged *low coverage* below 90% of calls costed (an uncosted call overstates margin).
5. **Estimated vs measured:** ledger `basis` may be `estimated`; AI cost by task shows `estimated_cost_micro`. Provider invoices are reconciled separately in the Ledger tab.
6. **Attribution:** AI rows without `task_type` appear as `unattributed`. Whether every live writer sets `task_type` is [VERIFY].
7. **Minutes** are real duration, not billing-rounded minutes.
8. **Scope:** only owner accounts that are not staff. Ledger rows without `account_id` are excluded.
9. **Performance:** views group by month over `calls` / `cost_ledger` without a month index. Run `EXPLAIN` on staging with production-scale data before relying on it; add an index in a separate `CONCURRENTLY` migration if needed. [VERIFY]

## Changing prices
Edit `pricingCatalog.ts`, then update the JSON in `cogs_plan_catalog()` in a **new** migration (`CREATE OR REPLACE`). CI (`cogsViews.test.ts`) fails until both agree.
