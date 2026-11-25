# Preregistration — to be filled by a person BEFORE any real data is touched

Hypothesis (verbatim): "Reliability-weighted repair labels (root cause + part + delayed outcome), using randomized dispatch as an unconfounded validation subset, predict first-visit success better than naive labels and better than a technician's own baseline."

The author of the tooling deliberately did **not** choose these values. Until every field is filled, `evaluate.mjs` prints NO VERDICT.

| # | Item | Value |
|---|---|---|
| 1 | Data source and date range | `<<FILL>>` |
| 2 | Outcome window used for the decision (14 / 30 / 60) | `<<FILL>>` |
| 3 | Evaluate on (`all` uncensored rows, or `randomized` rows only) | `<<FILL>>` |
| 4 | Minimum held-out n for any verdict | `<<FILL>>` |
| 5 | Success criterion: minimum paired log-loss improvement of (b) over BOTH (a) and (c) | `<<FILL>>` |
| 6 | Must the 95% interval exclude the threshold? (true/false) | `<<FILL>>` |
| 7 | Kill criterion: paired log-loss delta whose lower bound at or above this ends the line of work | `<<FILL>>` |
| 8 | Minimum informative items per technician | `<<FILL>>` (code default 20) |
| 9 | Pooling thresholds (tenants, cases, max share, rounding) | `<<FILL>>` (migration defaults 5 / 20 / 0.5 / 5 and 0.05) |
| 10 | Who signs off, and when | `<<FILL>>` |

Machine-readable form passed with `--prereg`:

```json
{
  "min_test_n": null,
  "min_logloss_improvement": null,
  "require_ci_excludes_zero": null,
  "evaluate_on": null,
  "kill_if_logloss_delta_at_least": null
}
```

Rules: no looking at real results before this file is committed; no changing it afterwards without a dated note explaining why; a failed criterion is reported as failed.
