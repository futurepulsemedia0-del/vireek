# Transparency reporting and the public AI incident log

Status: DRAFT process. Not legal advice. **[COUNSEL]** = counsel must decide. **[VERIFY]** = assumption to confirm.
Code: `supabase/migrations/20290312000000_transparency_report.sql`, staff page `/staff/transparency`, public page `/transparency`,
`src/lib/transparencyReport.ts`, `src/lib/incidentRedaction.ts`. Tests: `supabase/tests/database/transparency_report.test.sql`,
`src/lib/transparencyReport.test.ts`, `src/lib/incidentRedaction.test.ts`, `src/pages/TransparencyPage.test.tsx`.
Replaces the manual steps in `transparency-report-template.md` for the figures; the template text still guides the narrative.

## Where each figure comes from (half-year, UTC)

| Section | Table and date column | Notes |
|---|---|---|
| AI incidents | `ai_incidents.detected_at` | All incidents, by type and severity, plus customer/regulator notified. The public log is a curated subset. |
| Takedowns | `dmca_notices.created_at` | Copyright notices only. Legal requests are in their own table. |
| Legal requests | `legal_requests.received_on` | Type, outcome, country, data categories disclosed, accounts affected, nondisclosure orders. |
| Data requests | `data_subject_requests.created_at` | **Verified requests only.** Unverified ones are scrubbed after 24 hours and cannot be counted. |
| Outages | `status_incidents.started_at` | Incidents on the status page, open at period end, minutes to resolve (resolved only). |

Counts are exact in the staff draft. The public snapshot is created at publication from those counts.

## Steps

1. Staff: `/staff/transparency` > Reports > pick the half-year > **Compile figures**. Compile again whenever source records change (an approved report returns to draft only if figures changed).
2. Write the introduction and the reporting rules. State every rule counsel approved. **[COUNSEL]**
3. Counsel approves the text and the small-number rule; enter the approval date.
4. **Mark approved**, then **Publish** (only after the period has ended). Publishing freezes a public snapshot; content cannot be edited afterwards, only corrected or withdrawn.
5. Record the publication date and link in counsel's repository.

## Small-number rule **[COUNSEL]**

Optional `suppress_below` (2 to 100). A count between 1 and k-1 is published as "< k"; zero stays zero. It is applied to every count,
totals included. Whether that prevents inferring a hidden number by subtraction, and what k to use, is counsel's decision.
Nothing here asserts that a threshold is legally required or sufficient. Delays for requests under a nondisclosure order or seal are
**not automated**: counsel decides whether to hold those figures back, and the report text must say what was done.

## Public AI incident log

Entries are written separately from the internal register (`ai_incidents`) and never expose its ids, references, call ids or tenant.

Automated checks (database trigger and the form, same rules): e-mail address, link, UUID, IP address, phone or long number (ISO dates are allowed).
They are defence in depth, not a PII scanner.

Human redaction rules (the reviewer confirms each before approval):

1. No names of customers, callers, employees or technicians.
2. No street addresses or other location detail about a person.
3. No customer business names unless counsel approved them. **[COUNSEL]**
4. No call, ticket, account or internal incident ids.
5. No quotes from calls or transcripts.
6. No detail that helps someone repeat an attack.
7. No guesses about cause or blame; state what is confirmed.

Gates: redaction check date AND counsel approval date before `approved`; any text edit clears both. Published entries are frozen except a
correction note; a mistaken publication is withdrawn (kept as a record, hidden from the public). Nothing is deleted.

## Limits

- Changes made in the SQL editor or with the service role are not written to `staff_audit_log` (no signed-in user).
- Whether a customer or regulator must be told about an incident is **not** decided here (`ai_incidents.customer_notification` is a manual field). **[COUNSEL]**
- The public page is English only. **[VERIFY]**
- Component ids in the outages section are shown as stored. Confirm they match names on the public status page. **[VERIFY]**
