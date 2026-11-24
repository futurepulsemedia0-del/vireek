# Financial resilience model — runway scenarios and concentration risk

`scripts/finance/resilience.mjs` answers two questions from numbers **you** supply:

1. How many months of cash are left under the current plan and under a set of stress scenarios?
2. How concentrated is monthly revenue — by customer and by payment processor?

It is offline: no database, no network, no service-role key. Tests: `npm run test:scripts:resilience` (no database needed).

> **Not a forecast, not advice.** Every scenario applies one stated assumption to the figures in the input file and nothing else. The output describes arithmetic on the inputs; it does not predict revenue, estimate probabilities, or recommend an action. Decisions about cash reserves, financing or customer terms belong to finance and the board **[COUNSEL]** where a legal or contractual question is involved.

## Run it

```bash
# fictional sample, Markdown to the terminal
npm run finance:resilience -- --input scripts/finance/resilience.sample.json

# real figures: copy the sample to a git-ignored folder first
mkdir -p reports/finance
cp scripts/finance/resilience.sample.json reports/finance/2026-12.json     # then edit the copy
npm run finance:resilience -- --input reports/finance/2026-12.json --out reports/finance/resilience-2026-12.md

npm run finance:resilience -- --input <file> --format json        # machine-readable
npm run finance:resilience -- --input <file> --fail-under-months 12   # exit code 3 if baseline runway < 12 months
```

Flags: `--input` (required), `--format md|json`, `--out <path>` (file mode 600; refuses to overwrite unless `--force`), `--fail-under-months <n>`, `--help`.
Exit codes: `0` ok · `2` bad usage or invalid input (every problem in the file is listed at once) · `3` baseline runway below `--fail-under-months` · `1` unexpected error.

Real inputs belong under `reports/finance/` (git-ignored). **Never commit real figures**, and use pseudonymous customer ids (`C-0042`), not names or emails: the report prints the labels exactly as given.

## Input format (`schema_version: 1`)

| Field | Required | Meaning |
|---|---|---|
| `schema_version` | yes | Must be `1`. |
| `as_of` | yes | Date of the figures, `YYYY-MM-DD`. Used only to print an approximate cash-out date. |
| `currency` | yes | One ISO 4217 code in capitals, e.g. `"USD"`. **One currency per file.** |
| `cash_minor` | yes | Total cash, integer **minor units** (cents). |
| `restricted_cash_minor` | no (0) | Cash that must not be spent on operations (customer funds, tax reserve, escrow). Excluded from runway. Must not exceed `cash_minor`. |
| `gross_monthly_burn_minor` | yes | Cash operating costs per month **before** revenue is deducted. |
| `revenue[]` | yes (`[]` if pre-revenue) | Rows of `{ "customer", "processor", "monthly_minor" }`. `monthly_minor` is the **net cash expected to reach the bank per month** (after processor fees, refunds and chargebacks you expect). A customer may appear on several rows (several processors); rows are summed. Use `"direct"` or `"bank_transfer"` as the processor for revenue that bypasses a processor. |
| `assumptions` | no | `revenue_growth_pct_per_month` (default 0), `cost_growth_pct_per_month` (default 0), both between −50 and 50; `horizon_months` (default 36, max 120). |
| `thresholds` | no | Review-prompt levels, see below. |
| `scenarios` | no | Replaces the default scenarios, see below. |
| `data_classification` | no | Free label printed in the report. `"SYNTHETIC_SAMPLE"` adds a fictional-data banner. |

Money must be a non-negative **integer** in minor units. Floats, strings and unsafe integers are rejected, not rounded. A row whose `currency` differs from the file currency is rejected: currencies are never converted, added together or guessed (same rule as the [board pack](board-pack-template.md)). If you hold several currencies, run the model once per currency; whether and how to combine them is a policy decision, see [fx-policy.md](fx-policy.md).

## How runway is computed

Month by month for `horizon_months` model months of 30 days:

```
net burn(m) = costs(m) − revenue(m)            (positive means cash goes down)
cash(m)     = cash(m−1) − net burn(m)
```

Runway is the number of months until cash first goes **below zero**, interpolated linearly inside the month where it crosses (`before / net burn` of that month). Status values:

| Status | Meaning |
|---|---|
| `runs_out` | Cash crosses zero inside the horizon. `runway_months` is set. |
| `beyond_horizon` | Net burn is positive in at least one month but cash is still ≥ 0 at the horizon. `runway_months` is `null`; it is **not** "infinite". |
| `self_funding` | Net cash flow is ≤ 0 in every simulated month (revenue covers costs). |
| `no_cash` | Usable cash is zero and month-1 net burn is positive: 0 months. |

Growth assumptions compound monthly from month 1. The cash-out date uses a 30.44-day month and is approximate.

## Default scenarios

| id | What changes |
|---|---|
| `baseline` | Inputs as given. |
| `revenue-20`, `revenue-50` | All revenue 20% / 50% lower from month 1. |
| `lose-top-1`, `lose-top-3` | The 1 / 3 largest customers (by total monthly revenue, ties broken by name) pay nothing from month 1, across **all** their processors. |
| `processor-freeze-14d` | The largest processor holds payouts for 14 days starting month 1. The held amount is treated as not received during the window; **release after the window is not modelled** (conservative). |
| `costs+20` | Costs 20% higher from month 1. |
| `lose-top-1-costs+20` | Both of the above. |

The numbers 20, 50, 3 and 14 are round stress levels chosen for the defaults. They are not benchmarks and not estimates of likelihood. Override them with your own `scenarios`:

```json
"scenarios": [
  { "id": "baseline", "label": "Baseline", "effects": [] },
  { "id": "big-customer-leaves-m4", "label": "Largest customer leaves in month 4",
    "effects": [ { "type": "lose_top_customers", "n": 1, "start_month": 4 } ] },
  { "id": "psp-a-freeze-30d", "label": "Processor A holds payouts 30 days",
    "effects": [ { "type": "processor_freeze", "processor": "FAKE-PROCESSOR-A", "days": 30 } ] }
]
```

Effect types (each takes an optional `start_month`, default 1):

| `type` | Fields |
|---|---|
| `revenue_change` | `pct` from −100 to 1000, applied to all revenue |
| `cost_change` | `pct` from −100 to 1000, applied to gross burn |
| `lose_top_customers` | `n` (integer ≥ 1) |
| `processor_freeze` | `processor` (a label from the revenue rows, or `"@largest"`), `days` 1–365 |

`id` must match `[a-z0-9][a-z0-9_-]{0,39}` and be unique. Keep a scenario with `id: "baseline"`: the review prompt for minimum runway and `--fail-under-months` read it (without one, the first scenario is used).

## Concentration outputs

- **Top customers:** revenue and share for the top 1, 3, 5 and 10 customers (a level with fewer customers than N is labelled with how many exist), plus a ranked list of the top 10.
- **Processor share:** each processor's revenue, share, customer count, and the share of the largest customer *inside* that processor (who would be hit hardest by that processor's outage).
- **HHI:** the sum of squared revenue shares × 10,000 (0–10,000), and its reciprocal, the "effective number of equal-sized parties". The report asserts no "safe" or "unsafe" band; any such banding is a policy choice **[VERIFY]**.
- **Review prompts:** printed when a share is **strictly above** its threshold. Defaults (largest customer 20%, top 3 50%, largest processor 60%, minimum runway 12 months) are internal prompts chosen as starting points, not an industry or regulatory standard. Set the real values in `thresholds` after finance agrees them **[VERIFY]**.
- With no revenue rows, every concentration figure is `not available`, never `0%`.

## What this model does not do

1. **No data fetching.** It does not read Stripe, the bank or the database. Cash, burn and revenue come from finance records you enter; the model cannot tell you whether they are right. (The [board pack](board-pack-template.md) deliberately excludes cash, burn and runway for the same reason.)
2. **No FX.** One currency per file; no rates are bundled or fetched.
3. **No timing detail inside a month**: payroll dates, annual prepayments, tax payments, deposits and refunds are not modelled. Put known one-offs into the monthly figures or run a custom scenario.
4. **No probability weighting** and no correlation between scenarios beyond the combined ones you define.
5. **Processor freeze release is not modelled**, and a freeze is applied to revenue only (costs do not change).
6. **Customer labels are shown as typed.** Use pseudonymous ids.
7. Any statement to lenders, investors or auditors based on this output **[COUNSEL]**.

## Related

- [Monthly board pack](board-pack-template.md) (revenue by currency; excludes cash, burn and runway)
- [COGS and gross-margin assumptions](cogs-assumptions.md)
- [FX policy placeholder](fx-policy.md)
