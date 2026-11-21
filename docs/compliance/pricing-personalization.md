# Personalized-pricing audit

> **Status: engineering audit, not a legal opinion.** Everything marked **[COUNSEL]** needs a lawyer's decision.
> Everything marked **[VERIFY]** is a fact this audit could not confirm from the repository alone.
> Nothing here states that Vireek, or any business using Vireek, complies with any pricing, privacy or
> consumer-protection law. The disclosure component described in section 5 is a mechanism, not a compliance claim.

- **Scope:** every code path that produces a price a customer can be shown or told.
- **Method:** static reading of the repository snapshot (the uploaded `vireek-main` zip), tracing each price from its
  inputs to the place it is shown or spoken. No production data, no running system, no database contents were inspected.
- **Companion code:** `src/lib/pricingPersonalization.ts` (registry), `src/components/pricing/PersonalizedPricingNotice.tsx`
  (notice), flag `personalized_pricing_notice` (default OFF). A unit test fails if a path in the registry is missing from
  this document, so the two cannot drift silently.

## 1. Classification used

| Class | Meaning | Notice shown (flag on) |
|---|---|---|
| `none` | The same inputs from any buyer give the same price (job scope, time of day, payment method, owner-set tiers). | No |
| `location_derived` | The price changes with the buyer's **service address** (zone fee, zone surge). | Yes — "location" wording |
| `account_specific` | The price comes from rules tied to **this buyer's account** (customer, contract, membership, tags). | Yes — "account" wording |
| `profile_modeled` | An automated model prices from data about **this buyer or their property/equipment history**. | Yes — "modeled" wording |

A price a **third party** sets (a lender's APR) is never covered by Vireek's notice; that party owns its own disclosures.

**[COUNSEL]** Which of these classes legally counts as "personalized pricing" (or as pricing based on personal data /
automated decision-making) differs by jurisdiction and by customer type (consumer vs business). The defaults in the code
err towards showing a notice for any class other than `none`; counsel may decide to narrow or widen that.

## 2. Summary

| Path id | Where | Personal data read | Class | Set by | Customer sees it where |
|---|---|---|---|---|---|
| `service_area_surge` | `src/lib/serviceAreas.ts` (`computeAreaQuote`, `isSurgeActive`); Deno twin `supabase/functions/_shared/service-areas/resolve.ts`; spoken in `supabase/functions/vapi-webhook/index.ts` | Service address / postal code → zone | `location_derived` | Owner rule | Voice call (spoken); owner preview in `ServiceAreasPage` |
| `service_area_travel_fee` | same as above | Service address → zone | `location_derived` | Owner rule | Voice call (spoken); owner preview |
| `outcome_pricing` | `src/lib/outcomePricing.ts`, `outcomePricingApi.ts`, `OutcomePricingPage.tsx` | Customer record; equipment age, repair history, operating hours | `profile_modeled` | Vireek model, owner approves | Owner tool only in this snapshot |
| `price_list_override` | `src/lib/priceLists.ts`, `PriceListsPage.tsx` | Customer id, type, tags, active contracts, active memberships | `account_specific` | Owner rule | Owner simulator only in this snapshot |
| `tiered_estimate` | `src/lib/estimates.ts`, `TieredEstimateBuilder.tsx`, `EstimatePresentation.tsx` | None | `none` | Owner rule | Public estimate page (`QuoteAcceptPage`) |
| `field_estimate_ai` | `src/lib/fieldEstimate.ts`, `supabase/functions/field-estimate` | Job photos/video/voice (scope diagnosis) | `none` | Owner reviews draft | Becomes a tiered estimate |
| `after_hours_fee` | `business_profile.after_hours_fee`, read in `vapi-webhook` | None | `none` | Owner rule | Voice call |
| `payment_method_pricing` | `supabase/functions/_shared/payments/pricing.ts`, `src/lib/paymentPricing.ts` | None | `none` | Owner rule | Pay page |
| `financing_offer` | `src/lib/financing.ts`, `financingPartners.ts` | Applicant data → lender | (lender decides) | Third party | Lender flow |
| `price_playbook_voice` | `src/lib/pricePolicy.ts`, `_shared/price-playbook/engine.ts` | None | `none` | Owner rule | Voice / SMS |
| `pricing_flywheel` | `src/lib/pricingFlywheel.ts` | Job cost data in aggregate | `none` | Owner approves | Shared Price Book |
| `quote_truth_advisory` | `src/lib/quoteTruth.ts`, `_shared/quote-truth/engine.ts` | Customer history (acceptance risk) | `none` | Advisory only | Owner tool only |

## 3. Detail on the three requested paths

### 3.1 Surge pricing — `service_area_surge` (and its sibling `service_area_travel_fee`)
- **How it works.** `computeAreaQuote(area, baseCents, now)` multiplies the base price by `surge_multiplier` only while
  `isSurgeActive()` is true (`surge_enabled`, multiplier > 1, `surge_ends_at` not passed). The travel fee is added flat after the
  multiplication. All values are integer cents, rounded once. The multiplier is bounded 1×–5× (`MIN_SURGE`/`MAX_SURGE`).
- **Which "area" applies.** The caller's service address is resolved to a zone (postal-code list or polygon; geocoding on demand
  in `_shared/service-areas/resolve.ts`). The multiplier and fee belong to the zone, not to the person.
- **Personal data.** The service address is personal data. The price is a function of *zone + clock*; nothing else about the
  buyer is read. Within one zone every buyer gets the same multiplier at the same moment.
- **Who sets it.** The business owner, per zone, optionally with an end time. No model, no learning.
- **Where the customer meets it.** By voice: `vapi-webhook` tells the AI to say the surge rate and travel fee **before the caller
  confirms** (three places: area check, booking note, booking confirmation). On the web it appears in the owner preview only.
- **Classification:** `location_derived`. **[COUNSEL]** whether a zone-level rule counts as personalized pricing, and whether a
  spoken disclosure is enough.
- **Parity risk.** The browser and Deno implementations must agree; `src/lib/serviceAreasParity.test.ts` exists for that.

### 3.2 Outcome-based pricing — `outcome_pricing`
- **How it works.** `outcomePricing.ts` turns an uptime target into a contract price: an empirical-Bayes failure rate per asset
  (equipment-type prior blended with the asset's own repair history), a preventive-maintenance plan search, a Monte Carlo
  simulation of 12 months, then price = (expected cost + risk margin) / (1 − overhead − margin − credit load). It is
  deterministic: the same input gives the same quote. Guardrails can refuse or flag a quote for review.
- **Inputs (`AssetInput`).** Equipment type, age, expected lifespan, service interval, months since service, observed failures
  over an observation window, operating hours per year, and the customer's downtime cost per hour (value story). The quote is
  attached to a `customer_id`.
- **Personal data.** Repair history and operating profile of *this customer's* equipment are inputs, so two customers with
  different histories get different prices. For a residential customer this is data about a person's home; for a business
  customer it is business data plus contact details. **[COUNSEL]** whether this is personal data and whether B2B-only use changes
  the analysis.
- **Who sets it.** A Vireek model; the owner reviews and approves (`decision`: offerable / needs_review / not_offerable).
- **Where the customer meets it.** Owner-side page only in this snapshot; no public/portal page renders these quotes **[VERIFY:**
  customer-facing PDF or proposal export outside the files read**]**.
- **Classification:** `profile_modeled` — the strongest class in this audit.

### 3.3 Tiered estimates — `tiered_estimate`
- **How it works.** `estimates.ts` holds a Good / Better / Best ladder. Totals are integer cents (`optionTotals`, mirrored by the
  SQL function `quote_option_total_cents()`). Options are ordered by total (`sortOptionsByValue`); one option is marked
  `recommended` by the person who built the estimate. The monthly-payment illustration uses a fixed 9.99% APR, 24 months.
- **Personal data.** None is read to set the figures. The ladder is built by a person or drafted by AI from job scope
  (`field_estimate_ai`), then reviewed. Which option is "recommended" is a manual flag, not a prediction about the buyer.
- **Caveat.** If a future change fills a ladder from `price_list_override` or `outcome_pricing`, that source path carries the
  class, not the ladder. The registry exists so that change is visible.
- **Classification:** `none`. The notice must not appear here (a test asserts it).

## 4. Other price paths traced
- **`price_list_override`** — a price list overrides the Price Book for a customer, a contract, or a tier (commercial /
  membership / contractor). Resolution is deterministic and documented in `priceLists.ts`. It reads customer id, type, tags,
  contracts and memberships (`buildPricingContext`). In this snapshot `resolvePrice` is called **only** from `PriceListsPage`
  (a simulator); no quote-creation code applies it **[VERIFY:** database-side or edge-function use; none found by search**]**.
  If it is wired into quotes later, the notice applies (`account_specific`).
- **`after_hours_fee`** — a flat fee the owner enters; time-based, same for everyone. Not personalized.
- **`payment_method_pricing`** — surcharge / convenience fee / cash discount chosen by the owner, with state caps that
  **restrict** the surcharge. Depends on the payment method chosen, not on who the buyer is. **[COUNSEL]** surcharge rules themselves
  are outside this audit.
- **`financing_offer`** — APR, term and approval come from the lender after the customer applies. Vireek shows the lender's result.
  The lender owns those disclosures. **[COUNSEL]**
- **`price_playbook_voice`** — what the AI may say about price comes from the Price Book and owner policy. No buyer data varies it.
- **`pricing_flywheel`** — learns from aggregate completed-job costs and proposes Price Book increases the owner must approve;
  it changes a shared price, never one buyer's. **[COUNSEL]** use of customer job data in aggregate for pricing.
- **`quote_truth_advisory`** — reads customer history (completed jobs, lifetime revenue, earlier accepted/declined quotes) as
  "acceptance & trust risk"; the engine reports `impact_cents: 0` for it. If an owner raises or lowers a price because of that
  output, the owner's decision becomes personalized pricing, outside Vireek's code. **[COUNSEL]**
- **AI discount authority** (`ai_max_discount_pct`, `ai_quote_mode` in `serviceCatalog.ts`; Price Playbook caps). The AI may
  discount within owner caps. Different callers can end up with different prices through negotiation. **Not traced to the end in
  this audit [VERIFY]**; **[COUNSEL]** whether negotiated discounts are in scope.
- **Not traced:** Vireek's own subscription prices (`src/lib/pricing.ts`, currency switching), `enterpriseQuote.ts` (staff-only
  cost-plus calculator), AI cost re-pricing (`aiRepricing.ts`, internal accounting), `underpricing.ts`/`priceAccuracy.ts`
  (internal analytics). They set no customer-specific price for a business's customers, but whether Vireek's *own* plan prices
  vary by buyer was not checked in depth **[VERIFY]**.

## 5. The disclosure mechanism
- **Flag:** `personalized_pricing_notice`, default OFF, per-account via the normal flag system.
- **Component:** `<PersonalizedPricingNotice path="…" applied={…} learnMoreHref="…" />`. It renders nothing unless the flag is on,
  the path is personalized in the registry, no third party sets the price, and `applied` is not false.
- **Where it is mounted today:** next to the area quote preview (`ServiceAreasPage`) and the outcome price (`OutcomePricingPage`).
  Both are owner-facing, so the owner sees exactly the wording a customer-facing surface would carry.
- **Gap, deliberately not papered over:** there is **no customer-facing web surface** for the personalized paths in this snapshot.
  Surge and travel fees reach customers by voice (already disclosed in the AI's instructions). Any future customer-facing surface
  for `outcome_pricing`, `price_list_override` or zone fees must mount this component or equivalent wording.
- **Wording:** English, Persian and Spanish are provided; other languages fall back to English. All wording is a draft. **[COUNSEL]**

## 6. Questions for counsel
1. Which classes are "personalized pricing" in each market Vireek's customers operate in, for consumers and for businesses? **[COUNSEL]**
2. Is a spoken surge/travel-fee notice sufficient, or must a written one accompany it? **[COUNSEL]**
3. Required wording, placement, and language for any mandatory algorithmic-pricing disclosure (for example the transparency rules for
   personalised prices in EU consumer law, and recent US state algorithmic-pricing disclosure laws). Treat these as pointers to check,
   not as conclusions. **[COUNSEL] [VERIFY]**
4. Does `outcome_pricing` engage profiling / automated-decision rules under privacy law when the customer is an individual? **[COUNSEL]**
5. Who is the "seller" for disclosure purposes — the business using Vireek or Vireek? **[COUNSEL]**
6. Is the notice enough, or are record-keeping and an opt-out / human-review route also needed? **[COUNSEL]**

## 7. Keeping this current
Adding a price path means: add it to `PRICE_PATHS`, add its row here, and decide its class. The registry test fails if a path is
missing from this file or points at a file that does not exist. A new path that reads buyer data must not ship classified `none`
without a reviewer saying why.
