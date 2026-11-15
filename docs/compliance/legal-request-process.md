# Legal request process

Owner: designated legal contact (to be named) **[COUNSEL]**. Audience: anyone at Vireek who might receive legal process.
Status: DRAFT engineering/operations process. **This is not legal advice.** Every step marked **[COUNSEL]** must be
reviewed and approved by qualified counsel before this process is relied on. Items marked **[VERIFY]** are assumptions to confirm.
Nothing here asserts what the law requires; it records how Vireek intends to handle requests and what the system enforces.

Scope: subpoenas, court orders, warrants, preservation requests, emergency disclosure requests, regulator inquiries and
civil discovery that ask for customer or account data. Copyright takedown notices are handled separately (`/dmca`,
table `dmca_notices`) and are not logged here.

## 1. Principles

1. **Counsel decides.** No one other than the designated legal contact and counsel decides whether, how much and when to
   respond. Engineers and support staff never send data in response to a request on their own. **[COUNSEL]**
2. **Minimum necessary.** Disclose only what a validated request requires. **[COUNSEL]**
3. **Customers are told when permitted.** Default is to notify the affected customer unless law or a valid order
   prevents it. **[COUNSEL]** to confirm the default, the notice period and the wording.
4. **Everything is logged.** Each request gets a row in `legal_requests` the day it arrives.
5. **No content in the log.** The log holds categories and counts, never the data disclosed or the documents themselves.

## 2. Intake

- Requests may arrive by mail, email, support, or to any employee. Anyone who receives one forwards it **unopened/unaltered**
  to the legal contact the same business day and does not reply to the requester. **[COUNSEL]** to approve the intake address.
- Do not confirm or deny that an account exists, to the requester or anyone else. **[COUNSEL]**
- Do not alert the account holder yourself; notice is decided in step 5.

## 3. Log it (same day)

Staff add a row to `legal_requests` (staff only; no customer role can read or write it):

| Field | Notes |
|---|---|
| `reference` | Case number in counsel's repository. Unique, case-insensitive. |
| `request_type` | subpoena, court_order, search_warrant, preservation_request, emergency_disclosure, regulator_inquiry, civil_discovery, other |
| `jurisdiction_country`, `jurisdiction_region` | Two-letter country code; state/province or court district. |
| `requesting_authority` | Agency or court name (an organisation, not an officer's name). |
| `received_on`, `due_on` | Dates from the document. |
| `scope_summary` | What **kind** of data is asked for, in one or two sentences. No customer data. |
| `data_categories` | From the fixed list in the table definition. |
| `nondisclosure_order` | True if the request says Vireek may not tell the customer. |
| `customer_notice` | Starts at `pending_counsel`. |
| `outcome`, `closed_on`, `counsel_reviewed_on`, `accounts_affected` | Set when the request is resolved. |

Database guardrails (see the migration header): outcomes other than `pending` need a `closed_on`; a disclosing outcome
(`complied_in_full`, `complied_in_part`) needs `counsel_reviewed_on` except for `emergency_disclosure`; rows are never deleted;
every insert and update writes an audit row (ids and outcome only). The "needs counsel review" guardrail is a policy choice
**[COUNSEL]** to confirm.

Known limits: changes made directly in the SQL editor or with the service role have no signed-in user, so the audit trigger
does not record them. Make changes through a signed-in staff session. There is no admin page for this table yet.

## 4. Validate and scope  **[COUNSEL]**

Counsel decides, and records in the counsel repository (not in this log):

- Is the request valid, properly served and within the requester's authority and the correct jurisdiction?
- Does it conflict with another country's law (for example data located or customers based elsewhere)? **[VERIFY]**
- Can it be narrowed or challenged? If so, set `outcome` to `objected` or `challenged` when decided.
- Which accounts and data categories are in scope? Engineering only identifies the data counsel asks for.

## 5. Customer notice  **[COUNSEL]**

Counsel decides for each request whether the customer is notified, delayed or prevented, and sets `customer_notice`:
`not_applicable`, `pending_counsel`, `notified`, `delayed_by_order`, `prohibited_by_order`. If a nondisclosure order applies,
set `nondisclosure_order` and record when counsel will revisit it. Do not tell the customer anything beyond what counsel approved.

## 6. Preservation  **[COUNSEL]**

If counsel instructs a preservation hold, engineering applies it to the named accounts only for the period counsel
specifies, and the hold is released only on counsel's written instruction. Retention periods are not changed by this document.

## 7. Emergency requests  **[COUNSEL]**

A request claiming imminent danger of death or serious injury may be handled faster. Counsel to define: who may authorise
disclosure out of hours, what evidence of the emergency is required, and what is disclosed. Log it as `emergency_disclosure`
the same day; counsel review follows as soon as practicable and `counsel_reviewed_on` is then recorded.

## 8. Producing data  **[COUNSEL]**

- Only engineers named by counsel pull data, from production, using least access, and hand it only to counsel.
- Counsel transmits it to the requester through a method counsel approves.
- Record what was disclosed by category in `data_categories` and the number of accounts in `accounts_affected`.
  Do not copy the data anywhere else.

## 9. Close out

Set `outcome` (`complied_in_full`, `complied_in_part`, `objected`, `challenged`, `rejected_invalid`, `no_data_found`,
`withdrawn_by_requester`), `closed_on` and, for disclosures, `counsel_reviewed_on`. Confirm any preservation hold and any
notice decision are recorded in counsel's repository.

## 10. Transparency reporting

Use `legal_requests_counts` (half-year, type, country, outcome) with `docs/compliance/transparency-report-template.md`.
Whether, when and how to publish, and how to round or bucket small numbers or delay reporting for sealed or
nondisclosure matters, is a counsel decision. **[COUNSEL]** Do not publish figures that have not been reconciled with
the log and approved.

## 11. Training and review

- Brief anyone who handles support, mail or engineering on section 2 (forward, do not respond). **[COUNSEL]** to approve the briefing.
- Review this process yearly and after each request that exposed a gap. Record the review date here: ____ (not yet reviewed).

## 12. Where this lives

- Schema: `supabase/migrations/20290305000100_legal_requests.sql`. Tests: `supabase/tests/database/legal_requests.test.sql`.
- Public statements about how Vireek handles legal requests must match this document **after** counsel approval. Do not
  state publicly that Vireek notifies customers, challenges requests or publishes a transparency report until that is true **[COUNSEL]**.
