# Fairness audit — AI call reviewer outcomes

Status: **internal governance tool, not a compliance claim.** Nothing here certifies that Vireek is
"unbiased", "fair" or compliant with any law. Anything legal is marked **[COUNSEL]**; anything not yet
confirmed against production is marked **[VERIFY]**.

## 1. What this checks

Whether the outcomes of the AI call reviewer (`ai_quality_reviews`, `ai_quality_findings`) differ
systematically between groups of calls, along exactly three stratifiers:

| Stratifier | Source | Notes |
|---|---|---|
| Detected language | `calls.detected_language`, reduced to its primary subtag (`es-MX` → `es`) | Missing → `undetected`, reported as its own group because missing detection can itself be a disparity. |
| Region | First digits of the caller's **E.164** number mapped to a country calling code | This is the number's calling code, not the person's location or origin. `+1` stays "North America (NANP)". Non-E.164 → `unknown`; unmapped code → `other`. |
| Customer type | `customers.customer_type` through `calls.customer_id` | No linked customer → `unlinked`. |

**Never used, inferred or proxied:** race, ethnicity, religion, gender, age, disability, national origin,
accent/voice, name, or any other protected attribute. The engine rejects them by name
(`assertAllowedDimension`) and the SQL function has the three stratifiers hard-coded. Do not add a
stratifier without a written review. **[COUNSEL]** Country calling code can correlate with national origin;
counsel should confirm it is acceptable as a stratifier before the report is shared outside the company.

## 2. Outcome metrics (per group vs. all other calls)

| Metric | Direction | Definition |
|---|---|---|
| Mean QA score | higher is better | Mean `overall_score` over successfully reviewed calls. |
| Low-score rate | lower is better | Share of reviewed calls with `overall_score` below the cut-off (default 60). |
| Missed-booking finding rate | lower is better | Reviewed calls with a non-dismissed `missed_booking` finding. |
| Critical finding rate | lower is better | Reviewed calls with a non-dismissed `critical` finding. |
| Review coverage | higher is better | Calls successfully scored ÷ all calls. Low coverage for a group means the reviewer fails or skips more of its calls. |

## 3. Method and thresholds

- **Cells, not calls.** `staff_fairness_overview()` returns counts and sums per group. No phone number, name,
  transcript or call id leaves the database.
- **Minimum samples.** A group is evaluated only with ≥ 30 reviewed calls, ≥ 3 distinct accounts, and a
  comparison population of ≥ 30 reviewed calls. Otherwise it is **suppressed** and reported without counts.
- **Comparison.** Each group against everyone else in the same stratifier.
- **Intervals.** Welch interval for score gaps; Newcombe hybrid-score interval for rate gaps.
- **Multiple comparisons.** Family-wise α = 0.05, Bonferroni-adjusted over every (group × metric) actually tested.
- **Flag = significant AND material.** The interval must exclude zero **and** the gap must be at least 5 score
  points or 5 percentage points. Adverse gaps read "REVIEW (adverse)"; favorable ones are noted, not hidden.
- Thresholds are engineering defaults chosen for review triage, **not** legal standards. **[COUNSEL]** before
  quoting any of them externally.

## 4. Running it

```bash
# Offline, from a saved payload (array of cells or the RPC result)
npm run fairness:audit -- --input cells.json --out docs/ai-governance/reports/fairness-YYYY-MM-DD.md

# Live (service role key from the environment only; never commit it)
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run fairness:audit -- --supabase --days 90 --out report.md

# Tests
npm run test:fairness
```

Staff can see the same numbers at `/staff/fairness-audit`.

## 5. Limits you must state when reporting

1. A flag is a reason to look, not evidence of unfairness; no flag is not proof of fairness.
2. No adjustment for call mix (job type, time of day, tenant). Simpson's-paradox effects are possible.
3. The AI reviewer's own bias is part of what is measured and cannot be separated out.
4. Calls are treated as independent; repeat callers and busy tenants make real uncertainty larger.
5. Language detection and caller region are noisy. **[VERIFY]** the accuracy of `detected_language` per language before relying on small differences.
6. **[VERIFY]** whether demo, test or synthetic-probe calls exist in `calls` in production and should be excluded.
7. **[COUNSEL]** confirm the customer terms / privacy notice cover aggregated internal use of call QA data for fairness monitoring.

## 6. Report template

Copy this block into `docs/ai-governance/reports/fairness-YYYY-MM-DD.md` (or generate it with the script, which fills the tables).

```markdown
# Fairness audit — <YYYY-MM-DD>

- Window: last <N> days · low score = below <N> · min reviewed <N> · min accounts <N>
- Audit owner: <name> · Reviewer: <name> · Engine commit: <sha>
- Data caveats this run (outages, backfills, model or prompt changes in the window): <text>

## Summary
- Groups evaluated / suppressed: <n> / <n>
- Adverse gaps flagged: <n> · favorable: <n>
- Compared with the previous report: <better / same / worse / not comparable> — <one line>

## Findings (one row per REVIEW flag)
| # | Stratifier | Group | Metric | Gap (CI) | Plausible non-bias explanations checked | Decision | Owner | Due |
|---|---|---|---|---|---|---|---|---|

## Decisions
- Investigate / accept with reason / no action, for every flag, with the reason in one sentence.

## Suppressed groups
- Which groups were below threshold, and whether they should be pooled or sampled next period.

## Limits
- Restate section 5 above; add anything specific to this run.

## Sign-off
| Role | Name | Date |
|---|---|---|
| Audit owner | | |
| Reviewer | | |
| [COUNSEL] review (only if shared externally) | | |
```

## 7. Where things live

| Piece | Path |
|---|---|
| Statistics engine (shared) | `supabase/functions/_shared/fairness/audit.ts` |
| CLI | `scripts/fairness/audit.mjs` |
| Tests | `scripts/fairness/audit.test.mjs`, `supabase/tests/database/fairness_audit.test.sql` |
| Data function | `supabase/migrations/20290305000000_fairness_audit.sql` |
| Staff view | `src/pages/admin/StaffFairnessAuditPage.tsx` → `/staff/fairness-audit` |
