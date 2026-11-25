# Human review of AI calls

> Status: DRAFT template. `TODO(owner)` / `TODO(counsel)` items must be filled by a human.

## Purpose
A person reads a sample of AI-handled calls, scores them against a rubric, and feeds findings back to prompts, evals, knowledge and scripts. Owners get a monthly QA report.

## Sampling (`supabase/functions/_shared/ai-call-qa/sampling.ts`, v1)
| Draw | Population | Default rate | Stratum |
|---|---|---|---|
| Random | all AI calls (voicemail excluded) | 2% | `random` (unbiased baseline) |
| Emergency / price mismatch | flagged calls | 100% | `risk` |
| Complaint | negative sentiment, `complaint` tag or intent | 50% | `risk` |
| Price quote | price lookup or price accuracy status set | 25% | `risk` |
| Human transfer | transfer requested | 25% | `risk` |
- Deterministic hash per call: reruns never change picks. Daily cap per account (default 25); highest priority first.
- A call hit by the random draw is labelled `random` so the baseline stays unbiased.
- Opt-in per account (default OFF). Rates are owner-editable (0-50% random, 0-100% risk).

## Rubric v1 (1-5 per criterion, N/A allowed, >=3 scored)
Accuracy 30, Emergency & safety 25, Disclosure & consent 15, Resolution 20, Tone 10. Score 1->0, 5->100, weighted over scored criteria.
Verdict: >=80 pass, 60-79 needs improvement, <60 fail. A critical failure forces fail. `TODO(owner)`: confirm weights and thresholds.

## Reviewer workflow
Claim next (highest priority, resumes own claim, stale claims freed after 30 min) -> score -> optional suggestion (prompt / eval_case / knowledge / script) -> submit. Skip and release are available.

## Feedback loop
Suggestions land in `ai_call_qa_feedback` (open/accepted/rejected/done). Promotion into the eval set is manual. `TODO(owner)`: decide the owner of the weekly triage and the path from `eval_case` feedback into `eval/`.

## Monthly report
`ai_call_qa_get_monthly_report(month)`: sampled, reviewed, review rate, average score, pass rate, critical failures, by stratum, by risk flag, by criterion, feedback counts. "Low sample" below 10 reviews; empty values are "No data", never 0. `TODO(owner)`: decide whether to also email the report.

## Privacy and access
Reviewers = account owner or members with `can_edit_business_profile`. Transcripts shown with card numbers/SSNs masked; notes PII-scrubbed (names are NOT masked). Retention default 180 days. `TODO(counsel)`: recording-consent / privacy-notice wording for human review, and employee-monitoring rules if reviewers are staff.

## Scheduling (not done automatically)
POST to `ai-call-qa-sample` with header `X-Cron-Secret`: `{"action":"sample"}` hourly, `{"action":"monthly"}` on the 1st, `{"action":"purge"}` daily.
