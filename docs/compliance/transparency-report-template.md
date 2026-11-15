# Transparency report: template

Status: TEMPLATE. Do not publish until counsel has approved the content, the period, and any rounding or delay rules **[COUNSEL]**.
Source of figures: view `legal_requests_counts` (see `docs/compliance/legal-request-process.md`). Fill every bracket from the
database; delete this status block before publishing. No figure may be estimated.

---

# Vireek transparency report: [PERIOD, e.g. 2026-H1]

Published: [DATE] · Covers requests received from [START DATE] to [END DATE] · Prepared by: [NAME/ROLE] · Approved by counsel on: [DATE] **[COUNSEL]**

## About this report

Vireek provides an AI voice receptionist for home-service businesses. This report describes legal requests we received
for customer data during the period. [One paragraph, wording approved by counsel.] **[COUNSEL]**

We count each request once, by the date we received it. Requests about copyright (takedown notices) are not included. [VERIFY]

## Summary

| Measure | Count |
|---|---|
| Legal requests received | [SUM of requests] |
| Requests where some or all data was disclosed (`complied_in_full` + `complied_in_part`) | [N] |
| Requests we objected to or challenged (`objected` + `challenged`) | [N] |
| Rejected as invalid, no data found, or withdrawn | [N] |
| Still pending at the end of the period | [N] |
| Customer accounts affected by disclosures | [SUM of accounts_affected] |
| Requests accompanied by a nondisclosure order | [SUM of nondisclosure_orders] |

## Requests by type

| Type | Received | Disclosed (full/partial) | Objected / challenged | Other outcomes |
|---|---|---|---|---|
| Subpoena | [ ] | [ ] | [ ] | [ ] |
| Court order | [ ] | [ ] | [ ] | [ ] |
| Search warrant | [ ] | [ ] | [ ] | [ ] |
| Preservation request | [ ] | [ ] | [ ] | [ ] |
| Emergency disclosure | [ ] | [ ] | [ ] | [ ] |
| Regulator inquiry | [ ] | [ ] | [ ] | [ ] |
| Civil discovery | [ ] | [ ] | [ ] | [ ] |
| Other | [ ] | [ ] | [ ] | [ ] |

## Requests by country

| Country | Received | Disclosed (full/partial) | Objected / challenged | Other outcomes |
|---|---|---|---|---|
| [ISO code] | [ ] | [ ] | [ ] | [ ] |

## Data categories disclosed

Report which categories were disclosed (subscriber information, call metadata, call recordings, transcripts, messages,
account records, billing records, location data, other) and the number of requests per category. Source: `legal_requests.data_categories`
for requests with a disclosing outcome. [Counts]

## Reporting rules applied  **[COUNSEL]**

State the rules counsel approved, for example:

- Rounding or bucketing of small numbers: [RULE or "none"].
- Delay for requests under a nondisclosure order or seal: [RULE]. Figures for such requests are [included / reported separately / delayed until ___].
- Anything not reported and why: [TEXT].

## Notes

- Counts are drawn from Vireek's internal legal request log, reconciled on [DATE] by [NAME]. [VERIFY]
- Prior reports: [LINKS]. Corrections to earlier figures: [TEXT or "none"].
- Questions: [APPROVED CONTACT ADDRESS].

---

## Preparation checklist (delete before publishing)

1. Pull the half-year from `legal_requests_counts` as a signed-in staff user (the view applies RLS; a non-staff session returns nothing).
2. Confirm the number of requests equals the number of rows received in the period in `legal_requests`.
3. Confirm every closed row has an outcome and, for disclosures, a counsel review date (or `emergency_disclosure`).
4. Apply the rounding/delay rules counsel approved.
5. Counsel approves the final text. **[COUNSEL]**
6. Publish, then record the publication date and link in counsel's repository.
