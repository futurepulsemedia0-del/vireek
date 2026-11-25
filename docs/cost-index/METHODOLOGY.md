# Vireek Cost Index — methodology (method `cost-index-1.0.0`)

Status: DRAFT — values marked `TODO(owner)` / `TODO(counsel)` must be filled before the first real release.

## What it is
Percentiles of invoiced price for completed **repair** and **install** jobs, by **trade** and **US Census region**, from opted-in businesses only.

## Inputs (all existing data; nothing new is collected)
| Item | Source | Rule |
|---|---|---|
| Consent | `report_contribution_settings` via `report_eligible_orgs()` | status `granted`; no pending account deletion |
| Trade / region | `report_org_attrs()` | trade from `business_profile.primary_industry` (`other` excluded); region = Census region only |
| Jobs | `jobs` | `job_status = 'completed'`, `invoice_amount` inside the price band, created in the period |
| Repair vs install | `cost_index_service_map` | job counts only if its `service_type` is mapped. **Empty by default** |

## Statistic
Per business and cell: the **median** invoiced amount (businesses with fewer than `minJobsPerOrg` qualifying jobs are dropped). Published: p25 / p50 / p75 **across businesses**. A cell for "all regions" pools the regional cells of the same trade and job kind.

## Parameters (`supabase/functions/_shared/cost-index/schema.ts`, `PARAMS`)
| Parameter | Value | Status |
|---|---|---|
| Price band | $25 – $250,000 | TODO(owner) confirm |
| Min qualifying jobs per business per cell | 3 | TODO(owner) confirm |
| Whether `invoice_amount` includes tax | unknown | TODO(owner) confirm and state on the public page |

## Disclosure control (reused from State of Home Service Calls — thresholds may be raised, never lowered)
1. **k ≥ 10** businesses per published cell.
2. **Dominance cap**: largest single business ≤ 35% of the cell's jobs.
3. **Volume**: ≥ 100 jobs per cell.
4. **Complementary suppression**: if exactly one region of a (trade, job kind) is withheld while its "all regions" cell is published, the smallest published region is withheld too.
5. **Rounding**: prices to $10 (< $1,000), $50 (< $10,000), $100 above; business counts to 5; job counts to 10 (100 from 1,000).
6. **Geography**: Census region only (CHECK constraint).
7. **Release gate**: `assertCostIndexPublishable` re-verifies every finished cell; SQL CHECKs on `cost_index_cells` are the final floor.

Not a formal differential-privacy guarantee. Not a recommendation of what to charge.

## Versioning
Each (period, `release_seq`) is immutable once published. A correction is a new release; the previous one becomes `superseded` and stays downloadable. A withdrawn release returns HTTP 410 with the reason in the history list. Any change to thresholds, rounding, statistic or service mapping logic bumps `METHOD_VERSION`.

## Revocation
Publish re-derives from live consent data and refuses if the hash changed since review. A business that withdraws after publication is excluded from the next release; handling of already-published figures: TODO(counsel).
