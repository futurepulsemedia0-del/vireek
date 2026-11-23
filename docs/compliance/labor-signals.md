# Labor-compliance signals

> [COUNSEL] [VERIFY] — This document describes software behaviour. It makes no statement about what any law requires.

## What it is
`/dashboard/labor-signals` flags **time-clock records that deserve a human look**. A signal is a prompt, never a finding.
The UI never says a law was or was not followed; every rule number is editable data.

## What already existed (reused, not duplicated)
| Capability | Where |
|---|---|
| Clock in/out, breaks, jobs, timesheets | `20271009000000_tech_time_clock.sql` |
| Meal/rest break rules, jurisdiction sets, violation reviews | `20271210000000`, `20271215000000`, `src/lib/breakRules.ts` |
| Prevailing-wage tables, rule sets, per-job worker classification | `20271102000000_prevailing_wage_engine.sql` |

Break signals are produced by the existing engine (`evaluateShifts`) and shown **read-only**; they are reviewed on the Break Compliance page.

## What this adds
- `labor_worker_classifications` — what the business has *recorded* (hourly / apprentice / exempt / contractor / not recorded). Vireek does not decide or verify it.
- `labor_rule_configs` — per-account overtime thresholds and wage-table check switches. Starts as **needs counsel** ([COUNSEL]) and **not verified** ([VERIFY]). Changing the numbers clears both records.
- `labor_signal_reviews` + `labor_audit_log` — acknowledgement, "no action needed", "sent to counsel" (records only; nothing is sent), and who changed what.

## Signals
| Code | Meaning (neutral) | Needs a rule saved |
|---|---|---|
| `daily_hours_above_threshold` | clocked hours in a day exceed the configured daily number | overtime |
| `weekly_hours_above_threshold` | clocked hours in a workweek exceed the configured weekly number | overtime |
| `payroll_overtime_below_clock` | payroll overtime hours are lower than the hours the clock shows above the configured thresholds (never flagged the other way) | overtime |
| `seventh_day_clocked` | time recorded on all 7 days of a workweek | overtime |
| `open_shift_long` | a shift has been open longer than the configured hours (probable missed clock-out) | overtime |
| `classification_with_clock_use` | a worker recorded as exempt/contractor (or a 1099 payroll record) uses the time clock | none |
| `pw_classification_missing` | time on a job with a wage table, no classification recorded for the worker | prevailing wage |
| `pw_pay_below_table` | recorded hourly pay + plan fringe lower than the table rate for the recorded classification | prevailing wage |
| `break_*` | existing break engine output, read-only | break compliance enabled |

Hour-based signals are **skipped** for workers recorded as exempt/contractor (or 1099 in payroll); a count is shown so nothing is hidden silently.

## Known approximations (tell counsel)
- Threshold hours layer daily second tier → daily first tier → regular hours past the weekly number. It is a comparison aid, **not a pay calculation**.
- The workweek is a single fixed day per account (default Monday, matching the time clock).
- Wage-table checks use hourly rate + plan fringe vs. table base + fringe on the shift date; rate-lock dates, fringe crediting, apprentice ratios and coverage are **not** evaluated.
- Day grouping uses the shift's `work_date` as recorded by the clock.
- Night shifts, travel time and unpaid-time disputes are not modelled.

## Items for counsel before anyone relies on this [COUNSEL]
1. Which starter set (if any) fits each state / contract; every pack ships with `lastReviewed: null`.
2. Wording of the signal texts in `src/locales/*/laborSignals.json` (non-English text stays "awaiting human review" under `docs/i18n/reviewed-keys.json`).
3. Whether recording a classification inside the product has any consequence for the business.
4. Retention of `labor_audit_log` / `labor_signal_reviews`.

## Permissions
View: owner or `can_view_billing`. Edit classification/rules: owner, or `can_view_billing` **and** `can_edit_business_profile` (same gates as the prevailing-wage engine). Technicians cannot read any of it. Enforced in the database (RLS + RPC checks), not only in the UI.

## Changing a rule / adding a starter pack
Edit `src/lib/laborSignals/rules.ts`. Keep `lastReviewed: null` until a person compares the pack with the source, keep the `[VERIFY]` marker in `citation`, and keep `summary` neutral (a test fails on words such as "must", "required", "violation").
