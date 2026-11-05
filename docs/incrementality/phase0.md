# Incrementality of answered calls — Phase 0 (natural variation only)

Status: **method and tooling delivered; NO estimate has been computed.** The author of this document had
the repository only, not production data. Any number you see later comes from running the tooling below
on a real account, and must be read with the limits in sections 4 and 5.

Nothing in Phase 0 changes call routing, withholds an answer from a caller, or writes to the value ledger.

## 1. Question

How much booked revenue exists **because** Sarah answered, versus what would have happened to the same
calls without an answer? "Attributed" ROI (a booked job after an answered call) answers a different,
easier question and overstates the effect whenever the calls that get answered are the calls that would
have booked anyway.

## 2. What the repository records (verified by reading migrations, not by running them)

| Need | Source | Verdict |
|---|---|---|
| Call time, emergency flag, source, intent | `calls.call_datetime`, `is_emergency`, `source_channel`/`lead_source`, `intent` | Available |
| Reached Sarah vs voicemail | `calls.is_voicemail` | Available |
| Booked revenue | `jobs.call_id` + `jobs.invoice_amount` + `invoice_status = 'paid'` | Available (paid only, 14-day window) |
| Outages / forwarding failures | no table records them as such | **Not available**; only their voicemail effect is visible |
| Calls that hung up before voicemail | not guaranteed to be logged | **Unknown; must be checked per account** |
| Onboarding date / staggered rollout | `profiles.created_at`, phone provisioning dates | Proxy only; confirm what the date means |
| Overflow periods | `call_routing_configs` (current + published versions only) | No history of past routing changes unless versions were kept |

Read-only extract: `public.incrementality_phase0_call_dataset(p_from, p_to)` (migration
`20281103000000_incrementality_value_tier.sql`). Owner-scoped via `get_account_owner_id()`.

## 3. Designs and why

1. **Coarsened exact stratification (matching), within one business.** An answered call is compared only
   with unanswered calls in the same business, time block (weekday/weekend x overnight/early/day/evening in
   the business's own time zone), intent, urgency (emergency vs routine) and source. The estimand is the
   effect on answered calls (ATT). Calls with no comparable unanswered call are dropped, not extrapolated;
   the share kept is reported as `overlapShare`.
2. **Difference-in-differences at business level** for staggered onboarding or an outage window: change in
   booking outcome after the event for affected businesses minus the change for unaffected ones, with a
   pre-trend slope check. A violated parallel-trend check blocks any "supported" verdict.
3. **Uncertainty:** cluster bootstrap (1,000 resamples, seeded). For one account the cluster is the
   calendar week; with fewer than 5 clusters the result is `insufficient_data` (a single cluster would give a
   falsely tight interval).
4. **Sensitivity:** E-value (VanderWeele and Ding, 2017) on the booking-rate ratio, for the point and the
   interval bound nearest zero.

Emergency calls are excluded from the contrast: they are always answered by design, so they have no valid
comparison group.

Code: `src/lib/incrementality/estimators.ts` (methods), `phase0.ts` (runner). Tests simulate data with a
known effect (see section 6).

## 4. Where confounding is likely

- **Urgent callers choose to call back.** A caller who reaches voicemail and still leaves a message, or
  calls again, is more motivated than one who does not. Voicemail callers are therefore a selected group
  and the comparison is biased in either direction. Urgency recorded in `is_emergency` only partly captures
  it. This is the main threat and cannot be removed with the available covariates.
- **Who gets logged.** If hang-ups before voicemail are missing from `calls`, the unanswered group is
  filtered to the more persistent callers, which makes answering look less valuable than it is.
- **Time of day and season.** Matching on time block handles the coarse part; weather, promotions and
  one-off events are not modeled.
- **Repeat callers.** The same person can appear as voicemail first and answered later. Without
  `customer_id` they look like two independent callers.
- **Outage periods are not random.** Outages can coincide with storms, which also change demand.
- **Booking attribution.** Revenue is credited only through `jobs.call_id` and 14 days; bookings made by
  text or a later call are missed on both sides, unevenly.

## 5. When the data cannot support a conclusion

The tool returns `insufficient_data` or `inconclusive` instead of a number when any of these holds
(defaults in `THRESHOLDS`, judgment-based, easy to tighten):

- fewer than 5 clusters, fewer than 100 answered or 30 unanswered calls in matched strata, or less than 60%
  of answered calls have a comparable unanswered call;
- the interval includes zero, or its half-width exceeds the size of the estimate;
- the difference-in-differences pre-trend check fails;
- the result would be erased by a confounder with modest strength (E-value for the interval bound < 1.5):
  reported as a caveat.

The strongest verdict is `supported_with_caveats`. There is no "proven". Accounts with few unanswered
calls, which is the normal case for a business that Sarah answers almost always, will usually land on
`insufficient_data`; that is an honest result, not a failure of the tool.

## 6. Verification status

| Check | Result |
|---|---|
| Strict TypeScript on the new modules | PASSED (compiler run in sandbox) |
| Estimator tests on simulated data with known effects | PASSED (13 tests, run with a Node test-runner shim, not Vitest) |
| Same tests under real Vitest | NOT RUN (dependencies could not be installed offline) |
| SQL migration and dataset function against Postgres | NOT RUN (no database available) |
| Any estimate on real Vireek data | NOT RUN (no data access) |

## 7. How to run on a real account (read-only)

1. Apply the migration. 2. Call the RPC for a window of at least 6 months. 3. Pass the rows through
`toObservations(rows, accountId, timeZone)` and `runPhase0(...)`. 4. Read `assessment.verdict` and
`reasons` before reading any number. 5. Do not write the result to `value_events`: observational output is
not the experimentally measured tier.

## 8. Phase 1 status

Not started. A holdout that routes real callers to a fallback needs your explicit approval and a separate
design review (consent, emergency always answered, stop rules). Until then the "experimentally measured"
tier in the ledger has no write path and displays an empty state.
