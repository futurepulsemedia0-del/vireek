# RRE risk control ("rrCertify"): math, assumptions, limits

## What it is
A **restrict-only** gate after the existing remote/dispatch decision. It can turn "attempt remotely" into "dispatch". It never turns a dispatch into a remote attempt, never touches the safety screen, and the LLM never reaches it (inputs: integer score, segment key, safety result, stored snapshot). Modes per account: `off` (default), `shadow` (log only), `enforce`. Global kill switch: feature flag `rre_certify`.

## Loss
False resolution = customer confirmed the fix, then within W days a reopen or a linked repeat job. Cases whose window is still open are **excluded** (never counted as success). Cases that never closed as resolved have loss 0.

## Two statements, both computed on the same data
Let `lambda` be the score threshold (allow iff score >= lambda; 101 = never).
1. **Conditional (primary, Learn-then-Test):** with probability >= 1-delta over the calibration sample, `P(false resolution | allowed) <= alpha`. Grid step 5 from the largest decision-time threshold to 100; exact binomial p-value per grid point; Bonferroni over the grid. Needs ~90 allowed clean cases for alpha 5%, delta 10%.
2. **Per attempt (Conformal Risk Control):** `E[1[allowed]*F] <= alpha` with the `(k+1)/(n+1)` finite-sample correction.
The gate uses the smallest grid `lambda` satisfying both. Why both: CRC alone can be met by allowing only a tiny slice that always fails (unit test `KNOWN LIMIT`), so it is not the number an owner means.

## Ladder
segment (n >= minSegmentN) -> pooled (n >= minPooledN; bound holds for the pooled average only, status `pooled_only`) -> **abstain** (always dispatch). Below minPooledN nothing is certified.

## Assumptions (shown in the UI)
1. Exchangeability of calibration and future cases. **Known to be imperfect:** the score uses a prior learned from earlier outcomes, depends on LLM output, trends and seasons.
2. Failures are detectable (reopen / linked repeat job inside W). Undetected failures make measured risk lower than true risk.
3. Only failures inside W count.
4. Only cases the old gate let through are observed, so `lambda >= max decision-time threshold`.
5. Restrict-only; hard exclusions absolute.
Statements are about the calibration procedure on a future exchangeable case. They are **not** per-calibration-set guarantees (in simulation 40-46% of calibration sets give CRC risk above alpha; only the expectation is controlled).

## Drift
Exact binomial tests on the last 30/60/100/200 allowed attempts against the 95% Clopper-Pearson upper bound of the calibration rate; Bonferroni over windows, alarmP 0.01. Early failures in open windows count (valid, conservative). Alarm = always dispatch + owner notification; **sticky** until the owner acknowledges. Measured power is limited (see report).

## UI wording rules
Never "guaranteed"/"certified"/"safe". Bounded statement only when a segment has a valid bound: "Under the stated assumptions, with 90% confidence, at most X% of the remote attempts allowed in this segment end as a false resolution (N closed cases, W-day window)." Otherwise: "Not enough outcome data."
