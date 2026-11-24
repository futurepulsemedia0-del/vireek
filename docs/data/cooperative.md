# Data cooperative — design and fill-in template

> **Status: DRAFT. Not legal advice.** Everything marked `TODO(owner)` is a decision only you can make; everything marked
> `TODO(counsel)` needs a lawyer before it is shown to a customer. Nothing here moves money.
> Code: `supabase/migrations/20290312000000_data_cooperative_ledger.sql`, `src/lib/cooperativeBenefits.ts`.
> Builds on (does not replace): `20270215000000_service_data_exchange.sql` (consent, k-anonymity, give-to-get) and
> `docs/compliance/cross-tenant-data-flows.md`.

## 1. What it is
A contractor who opts in to a data domain contributes **cohort statistics only** (raw rows never leave the account) and earns
benefits. The "cooperative" label is a product description; whether it creates any legal entity or member rights is `TODO(counsel)`.

## 2. What contributors give
| Domain | Contribution (already enforced by the SDE) | Source |
|---|---|---|
| failure / equipment / pricing / labor / parts / outcomes | Per-account facts exist only inside a temp table during the nightly refresh; only cohorts with k ≥ 5 (8 for pricing) are published | `sde_refresh_exchange()` |
Opt-in is per domain, owner-only, revocable (`sde_set_consent`). Not changed by this work.

## 3. What contributors get
| Benefit | How it works | Status |
|---|---|---|
| Benchmarks and intelligence | Give-to-get: a product unlocks only for domains the account contributes | **Live** (`sde_get_intelligence`) |
| Credit units | Rule-driven accrual into an append-only ledger (`coop_benefit_ledger`) | **Built, inactive** — no rule has numbers |
| Redemption of credit units | `coop_record_redemption()` (service_role, idempotent, balance-checked) | **Hook only** — no consumer exists |
| Governance rights / revenue share | — | **Not built.** `TODO(owner)`: decide if wanted. `TODO(counsel)`: securities / membership implications |

Credit units are abstract. They are **not** a currency, not a stored balance of money, and nothing converts them to cash.
`TODO(owner)`: what can units be spent on (e.g. a product discount)? Convert only through a separately reviewed feature.

## 4. Calculation
`units = records/1000 × units_per_1000_records + cohorts × units_per_cohort`, clamped so the trailing 30 days never exceed
`max_units_per_30d`. Counts come from `sde_contribution_ledger`, which only counts rows in cohorts that actually cleared k-anonymity.
One accrual per account × domain × day (unique index); consent is re-checked live at accrual.

Fill in per domain (staff RPC `staff_coop_set_rule`, every change is audited in `coop_rule_audit`):
| Domain | units_per_1000_records | units_per_cohort | max_units_per_30d | counsel_ref |
|---|---|---|---|---|
| failure | TODO(owner) | TODO(owner) | TODO(owner) | TODO(counsel) |
| equipment | TODO(owner) | TODO(owner) | TODO(owner) | TODO(counsel) |
| pricing | TODO(owner) | TODO(owner) | TODO(owner) | TODO(counsel) |
| labor | TODO(owner) | TODO(owner) | TODO(owner) | TODO(counsel) |
| parts | TODO(owner) | TODO(owner) | TODO(owner) | TODO(counsel) |
| outcomes | TODO(owner) | TODO(owner) | TODO(owner) | TODO(counsel) |
A rule **cannot be activated** without a `counsel_ref` and at least one rate (CHECK constraint).

## 5. Governance
- Rule changes: staff only, reason ≥ 10 chars, full before/after in `coop_rule_audit`.
- Manual corrections: `staff_coop_adjust` writes a visible `adjustment` entry (note required). Rows are never edited or deleted by clients.
- Who may change terms, how members are notified, any member vote: `TODO(owner)` / `TODO(counsel)`.
- Fairness guard-rails already present: per-account cap on cohort facts (25), dominance cap (40 %), k-floor. Anti-gaming for accrual
  (e.g. synthetic jobs): `TODO(owner)` — currently only the SDE caps apply.

## 6. Withdrawal
| Event | Behaviour today |
|---|---|
| Revoke a domain | Excluded from the next nightly cohort rebuild; accrual stops on the next run (consent joined live) |
| Units already earned | **Kept.** Whether they expire or are clawed back is `TODO(counsel)` / `TODO(owner)` |
| Data already folded into published aggregates | Cannot be disaggregated; disclosure wording `TODO(counsel)` (see cross-tenant register) |
| Account deletion | Ledger rows cascade-delete with the profile |
| Ledger retention | `TODO(counsel)` (SDE ledger keeps 400 days; this ledger has no purge) |

## 7. Payments
No payments automation. No invoice credit, payout or tax reporting is created. If units ever become redeemable for value:
`TODO(counsel)` (consumer-protection, tax, unclaimed-property treatment).

## 8. Operations
Accrual runs nightly at 04:30 (after `sde_refresh_exchange` at 04:10) when `pg_cron` exists. Manual: `select public.coop_accrue_benefits(current_date);`
Rollback: see the header of the migration.

## 9. What the owner must supply
1. Rates and caps per domain (section 4). 2. What units can be spent on. 3. Terms/disclosure text (`TODO(counsel)`).
4. Withdrawal policy for earned units. 5. Whether a member-facing page is wanted (not built).
