# PMF measurement

How Vireek measures product-market fit with the "how disappointed would you be" survey and retention by segment.
Written against the repository snapshot. Nothing here has been run against a live database or browser. **[VERIFY]** marks facts that need confirming in production; **[COUNSEL]** marks legal questions.

## 1. The question

> How would you feel if you could no longer use Vireek?

Answers: **Very disappointed**, **Somewhat disappointed**, **Not disappointed**, **I no longer use Vireek**.
Two optional free-text follow-ups: the main benefit (hidden for "no longer use") and what would make Vireek better.

Headline number: `very_disappointed / all responses`, with "no longer use" counted in the denominator.
The 40% line is a widely used rule of thumb for this survey, **not a guarantee and not validated for Vireek's segments [VERIFY]**. The staff page shows "Too few responses" below 40 answers instead of a verdict, because the sampling error is large at small n (at n = 40 and a true rate of 40%, the 95% margin is about ±15 percentage points).

## 2. Who is asked, and when

Server rule (`_pmf_due` in `20290307000100_pmf_survey.sql`; mirrored constants in `src/lib/pmf.ts`):

| Rule | Value |
| --- | --- |
| Account age | at least 30 days |
| Usage threshold | at least 10 calls + jobs in the last 30 days |
| Cadence | shown at most once per 90 days; an answer silences it for 180 days |
| Shared fatigue with CSAT/CES/NPS | nothing else shown or NPS answered in the last 7 days; fewer than 2 surveys shown in 30 days |
| Person's choices | "Ask me later" (snooze) and "Don't ask me again" are stored in `feedback_survey_prefs` and honoured by every survey |
| Never | during a staff impersonation session |

Browser rule (`PmfPrompt.tsx`, reusing `evaluateSurveyGate`): analytics consent present, tab visible and online, not on a critical route (login, checkout, billing, dispatch, field work), no error in the last 5 minutes, no dialog open (so it never stacks on the NPS or CSAT prompt), the person is not typing, and a 45 second quiet delay after load.
Without analytics consent the browser never calls the server, so a "shown" record is never created.

## 3. Consent and privacy

- The gate follows the same consent signal as the other in-app surveys. Treating the survey as consent-gated is a conservative product choice, **not a legal conclusion [COUNSEL]**: whether in-app product research needs consent, and under which lawful basis, depends on jurisdiction.
- Free text is redacted on the server (`feedback_redact`: emails, phone numbers, tokens, card-like numbers, IPs) and capped at 500 characters.
- Segments are coarse buckets (plan, role, trade, team size, account-age bucket, usage bucket). No names, emails or ids leave the database in staff views.
- Staff aggregates merge any group with fewer than 5 responses (or 5 accounts) into "small groups", so a single customer cannot be identified from a segment.
- People can export and delete their PMF data (`export_my_pmf_data`, `delete_my_pmf_data`). Both RPCs exist but are **not yet wired to a settings screen**, and the existing `feedback_retention_apply` job does not cover these tables **[VERIFY: decide a retention period and add it]**. Account deletion removes the rows (foreign keys cascade).

## 4. Segments

Stored on each response at answer time, so later plan or usage changes do not rewrite history:
`plan` and `role` (from the existing feedback segment helper), `trade` and `team_size` (from `signup_qualification`, only if the person completed it), `tenure_bucket` (30-89d, 90-179d, 180d+), `usage_bucket` (light under 10, regular 10-49, heavy 50+ calls+jobs in 30 days).

Because the usage threshold is 10, "light" accounts are not asked. The bucket exists so the thresholds can be changed without a schema change.

## 5. Retention by segment

Definition (`staff_retention_by_segment`): accounts are grouped into weekly cohorts by signup week (UTC, Monday start). An account counts as **active in week N** when it has at least one call or job created in the Nth week after its signup week. Retention for a segment and week N is `active accounts / accounts in cohorts that have reached week N`, summed over the cohorts in the window (4 to 26 weeks).

Built only from existing data: `profiles`, `calls`, `jobs`, `signup_qualification`. No new tracking was added.

Limits, stated plainly:

- **Segment = current plan, not plan at signup.** Vireek keeps no plan history on the account (`profiles` stores only the current plan), so an account that upgraded is counted in its current plan for all its weeks. Compare plans with care.
- "Active" means the account produced a call or job, not that a person logged in. It measures product value delivered, not sessions.
- Owner accounts only; staff accounts are excluded. Team members roll up to their account.
- Calls and jobs are counted by `created_at`, so back-filled or imported rows count in the week they were created.
- Segments with fewer than 5 accounts are merged into "small groups".
- Performance at large scale has not been measured **[VERIFY]**; the view is staff-only, bounded to 26 weeks, and reads one pass over recent calls and jobs.

## 6. How to read the two together

1. Start with the survey table grouped by plan, then by trade. Look only at rows with 40+ responses.
2. A segment at or above 40% **and** with flat or slowly declining retention is the strongest signal.
3. High "very disappointed" with weak retention usually means a good product for a few people who are not being kept active (onboarding or usage problem). Low "very disappointed" with decent retention suggests low-urgency use.
4. Read the "main benefit" answers of the "very disappointed" group to decide who the product is for; read the "improve" answers of "somewhat disappointed" for what blocks them.
5. Never act on one quarter of one small segment.

## 7. Where things live

| What | File |
| --- | --- |
| Tables, eligibility, RPCs, staff views | `supabase/migrations/20290307000100_pmf_survey.sql` |
| Prompt (browser rules, consent) | `src/components/feedback/PmfPrompt.tsx` (mounted in `DashboardNav.tsx` beside `SurveyHost`) |
| Pure logic | `src/lib/pmf.ts`; API wrappers `src/lib/pmfApi.ts` |
| Staff page | `src/pages/StaffPmfPage.tsx`, route `/staff/pmf` |
| Strings | `src/locales/en/pmf.json`, `src/locales/fa/pmf.json` (other languages fall back to English) |
| Tests | `src/lib/pmf.test.ts`, `src/components/feedback/PmfPrompt.test.tsx`, `src/pages/StaffPmfPage.test.tsx`, `supabase/tests/database/pmf_survey.test.sql` |
