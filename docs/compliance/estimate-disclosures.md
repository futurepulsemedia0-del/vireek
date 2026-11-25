# Estimate / quote disclosures by job state

Status: **plumbing only. No state requirement has been confirmed.** Not legal advice.
Everything marked TODO(counsel) or TODO(owner) must be supplied before a clause can appear on a customer document.

## How it works

1. Worklist: `supabase/functions/_shared/compliance-rules/estimateDisclosureMatrix.ts` lists 51 jurisdictions x 3 requirements
   (written estimate notice, cancellation notice, license number display). Each row is a question for counsel, not an answer.
2. Authority: counsel's answers live only as rule versions in Compliance -> Rule review (existing workflow:
   draft -> in review -> approved, with a legal reviewer). Only approved, currently effective versions are enforced.
3. Quote PDF: `buildQuoteDisclosures()` runs the existing engine on surface `quote` for the job's state (service address first,
   phone area code only as a flagged weak guess) and returns clauses, license lines and warnings.
   `downloadQuotePdf(q, businessName, disclosures)` prints them under the notes.

## What is printed, and what never is

| Printed | Source |
|---|---|
| Notice text | `params.text` of an approved `required_notice` rule (noticeId `written-estimate`) |
| Cancellation text | `params.noticeText` of an approved `rescission` rule |
| License line | `params.licenseLabel` + the number in the business compliance profile, for an approved `license_display` rule |

Never printed: text containing `TODO(`, text missing from the rule, or anything from a draft / in-review / retired version.
Each case produces a warning instead (`rule_text_placeholder`, `rule_text_missing`).

## Warnings shown to the owner

`service_state_unknown`, `service_state_from_phone`, `business_state_missing`, `license_missing`, `license_expired`,
`counsel_review_pending` (lists requirements with no approved rule for that state), `deposit_limit`,
`sale_location_assumed`, `rules_unavailable` (rules could not be loaded).

## Adding a rule for one state (staff, in Compliance -> Rule review)

| Requirement | Kind | Required params | Surfaces |
|---|---|---|---|
| Written estimate notice | `required_notice` | `noticeId: "written-estimate"`, `text: <counsel's wording>` | include `quote` |
| Cancellation notice | `rescission` | `days`, `minAmountCents`, `saleLocations`, `noticeText: <counsel's wording>` | include `quote` |
| License number display | `license_display` | `licenseLabel: <counsel's label>`, optional `trades` | include `quote` |

Fill every value from counsel (TODO(counsel)); add the source citation and the legal reviewer before approval.

## Owner fill-in

| Item | Value |
|---|---|
| States served | TODO(owner) |
| Trades served per state | TODO(owner) |
| Business state and license numbers entered in Compliance -> Business profile | TODO(owner) |
| Counsel review date per state | TODO(counsel) |
