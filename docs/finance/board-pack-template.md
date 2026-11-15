# Monthly board pack — template and generator guide

`scripts/reporting/board-pack.mjs` fills the template at the bottom of this file from existing database objects and writes a Markdown pack. Everything **above** the `board-pack:template-begin` marker is documentation and is never copied into a pack. Everything **below** it is the template; edit the wording or the order of sections there, but keep every `{{token}}` (the script refuses a template that drops one, so a section can never disappear silently).

## Generate a pack

```bash
# previous full UTC month -> reports/board-pack/YYYY-MM.md (file mode 600, git-ignored)
SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role key> \
npm run report:board-pack

npm run report:board-pack -- --month 2026-10        # a specific month
npm run report:board-pack -- --dry-run              # no network; checks the template, every figure is "not available"
npm run report:board-pack -- --stdout               # print instead of writing
npm run report:board-pack -- --strict               # exit 3 if any section is not fully available (for automation)
npm run report:board-pack -- --allow-partial        # the current, unfinished month, labelled PARTIAL PERIOD
npm run report:board-pack -- --force                # overwrite an existing file (discards hand-written commentary)
```

- The service-role key is needed because every source is service-role-only; the `staff_*` RPCs require a signed-in staff session and cannot be called by a script. Run it from a trusted workstation or a protected CI job, never from a browser or an edge function, and never commit the key. The script only reads, and it never prints the key.
- The script refuses to overwrite an existing pack unless `--force` is given, because the pack is meant to be edited by hand (section 6).
- Tests: `npm run test:scripts:board-pack` (no database needed; a fake PostgREST is used).

## The rule for missing data

A figure is **measured from a registered source or shown as `not available`** with the reason. The generator never estimates, interpolates, extrapolates, back-fills or substitutes a default.

- A source that fails, times out, is not deployed, or returns an unrecognised shape renders as `not available`, never as `0`.
- A measured zero (the source answered and the answer is zero) renders as `0`.
- A ratio with an empty denominator renders as `not available`, not `0%`.
- Percentiles are never averaged across days. The monthly time-to-first-call percentile is therefore `not available`; the daily values are listed in the appendix.
- Currencies are never converted or added together. Each currency gets its own table.

## What each section measures

| Section | Source (registered in `SOURCES` in the script) | Definition | Time basis |
|---|---|---|---|
| 1. ARR / MRR | `growth_period_summary()` over view `growth_mrr_movements_v` | MRR = monthly recurring amount of subscriptions in status `active` or `past_due` (yearly ÷ 12). ARR = closing MRR × 12. Bridge = opening + new + reactivation + expansion − contraction − churn = closing; the script checks that identity and prints `RECONCILIATION FAILED` if it does not hold. | Event-time, reconstructible for any past month |
| 1. Billing snapshot | `growth_digest_snapshot()`, `growth_latest_facts()` | Past-due accounts, trials, ledger gaps, subscriptions with an unresolved discount | State at generation time |
| 2. Retention | same function | Cohort = accounts with MRR > 0 at period start. Logo retention = share still above 0 at period end. GRR = Σ min(opening, closing) ÷ Σ opening. NRR = Σ closing ÷ Σ opening. One month, not annualised. | Event-time |
| 3. Usage | view `first_call_kpi_daily` | Accounts reaching a first answered call, summed over the days of the month | Daily grain |
| 4. Incidents | table `status_incidents`, function `public_status_feed()` | Incidents with `started_at` in the month; time to resolve = `resolved_at − started_at`. Availability is the trailing-30-day figure and is shown only when the pack is generated within 7 days of period end. | Started in period; resolution state at generation time |
| 5. Compliance calendar status | view `compliance_control_status` | Evidence-collection cadence per control: `fresh`, `overdue`, `failing`, `never`, `incomplete`, `not_applicable`, plus next due dates | Snapshot at generation time |

### Known limits (do not paper over them in commentary)

1. **No incident view exists.** Section 4 reads the `status_incidents` table directly (read-only, no summary text). Incidents that were never recorded there are not available to the pack.
2. **No platform-wide usage view exists** for calls handled, active accounts or provider cost. Those rows are listed as `not available` rather than approximated. Adding them needs a metric definition decision and a migration; it is out of scope for this generator.
3. **"Compliance calendar" means the control-evidence calendar.** There is no company-level calendar of legal, regulatory, tax or contract deadlines in the repository **[VERIFY]**. Track those with counsel **[COUNSEL]**.
4. **The subscription ledger starts when it was created.** If `subscription_facts` was not backfilled to the start of the month, opening MRR is understated and "new" MRR overstated. The script warns when the history length suggests this.
5. **MRR can be overstated** where a subscription has a discount the ledger cannot apply (`discount_unresolved`). The script counts such live subscriptions; it does not estimate the amount.
6. **Stripe minor units.** Amounts are formatted using the ISO 4217 exponent. Stripe's special-case currencies **[VERIFY]**.
7. **Not in this pack at all:** cash, burn, runway, headcount, pipeline, cap table. Nothing in the repository sources them. Add them by hand from finance records; do not estimate.

## Review checklist before the pack leaves the company

- [ ] Read "Items needing attention"; resolve or explain each one in section 6.
- [ ] No `RECONCILIATION FAILED` banner; if there is one, do not circulate.
- [ ] Every `not available` is either acceptable for this month or has an owner and a date.
- [ ] Section 5 is described only as readiness tracking. It must not be described as a certification, an audit, an attestation or "SOC 2 compliant". Any external characterisation **[COUNSEL]**.
- [ ] Anything shared outside the company (board members who are not employees, investors, lenders): confirm confidentiality terms and what may be disclosed **[COUNSEL]**.
- [ ] Management commentary is written by a person; the script never writes commentary, targets or forecasts.
- [ ] The final file is stored where the board's records are kept. `reports/board-pack/` is git-ignored on purpose.

## Related

- [Analytics layer and founder KPIs](../ANALYTICS_METRICS.md) (other metric definitions; the MRR definitions used here live in the growth analytics migrations)
- [SOC 2 readiness](../compliance/SOC2_READINESS.md) and [control map](../compliance/soc2/CONTROL_MAP.md)
- [Synthetic monitoring and SLOs](../runbooks/synthetic-monitoring.md)
- [Incident response](../runbooks/incident-response.md)

<!-- board-pack:template-begin -->
# Vireek — Board pack: {{period_label}}

Period: {{period_start}} to {{period_end}} (UTC). Generated: {{generated_at}}.

{{report_status}}

## Summary

{{section.summary}}

### Items needing attention before this goes out

{{section.attention}}

## 1. ARR and MRR

{{section.arr}}

## 2. Retention

{{section.retention}}

## 3. Usage

{{section.usage}}

## 4. Incidents and reliability

{{section.incidents}}

## 5. Compliance calendar status

{{section.compliance}}

## 6. Management commentary and decisions requested

> **To be written by hand before distribution.** The generator never writes commentary, targets or forecasts.

- What changed since last month, citing the table row it comes from: [TO WRITE]
- Explanation of every "not available" and every item under "needing attention": [TO WRITE]
- Decisions requested from the board: [TO WRITE]
- Items for counsel (legal, compliance or disclosure wording): [TO WRITE]

## 7. Data sources and notes

{{section.sources}}
