# NTE Exposure Forecaster — Phase 0 Gate Report

**Status: GATE NOT PASSED — INSUFFICIENT DATA (Phase 1 not started)**

## Evidence
Query run by the owner against the project database (read-only):

| user_id | nte_jobs | breached |
| ------- | -------- | -------- |
| null    | 0        | 0        |

Definition: completed `work_orders` with `not_to_exceed_cents IS NOT NULL`;
breach = sum of `billable_amount_cents` on live visits (status <> 'cancelled',
billing_status <> 'void') > `not_to_exceed_cents`.

## Gate rule
STOP if fewer than ~200 NTE jobs or ~20 breaches. Observed: 0 jobs, 0 breaches.

## Not done / not verified
- No backtest, discrimination, calibration, lead-time or false-alert analysis was run.
- No forecaster, shadow mode, alerts, UI or value events were built.
- Which environment the query ran against was not verified.
- Whether point-in-time history exists for visit amounts and parts additions was not verified.

## Proposed go/no-go thresholds (PROPOSED, pending owner confirmation)
- Data: >= 200 NTE jobs and >= 20 breaches.
- Discrimination: AUROC >= 0.75 at +30 min and better than both baselines
  (80% NTE static, EVM EAC) at equal false-alert rate.
- Calibration: ECE <= 0.05, reliability slope 0.8-1.2.
- Operational: median lead time >= 30 min, precision >= 70%, false-alert rate <= 10%.

## Re-run
Re-execute the gate query periodically. Revisit when the Gate rule is met.
