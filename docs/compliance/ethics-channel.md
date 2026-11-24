# Ethics and concerns channel

> **DRAFT: not approved, channel not live.** Owner: _to be assigned_ · Approved by: _pending_ · Last review: _pending_. This document designs a way for people to raise concerns about misconduct, misuse of access or customer data, and unethical behaviour. It does **not** state that Vireek operates such a channel today, that it meets any legal requirement, or that reports are anonymous or protected. Tags used below: **[COUNSEL]** = needs a lawyer's decision; **[VERIFY]** = a fact not confirmed from this repository. See `src/lib/trust/claims.ts` for what may be claimed publicly.

## 1. Purpose and scope

People who work with or for Vireek, or who use it, need a route to raise a concern that does not depend on telling the person the concern is about. In scope:

- misuse of privileged access: impersonation, exports or bulk reads of customer data without a business reason (the technical signals are in `docs/compliance/insider-risk-monitoring.md`);
- bypassing security controls, sharing credentials, or hiding incidents;
- fraud, bribery, falsified records or evidence, misleading customers or investors;
- harassment, discrimination, retaliation, or unsafe working conditions;
- breaches of customer commitments or applicable law.

Out of scope (use the normal route instead): ordinary customer support (`SUPPORT.md`), product bugs, and **security vulnerabilities in the product** (report via `SECURITY.md`; do not use this channel for them).

## 2. Who can report

Employees, contractors, interns, freelancers, partners, customers and their staff, and anyone else who has a concern in a work-related context. Reporting anonymously must be possible; whether it can be technically guaranteed depends on the tool chosen in section 3 **[VERIFY]**.

## 3. How to report (to be set up)

No channel exists yet. The owner must pick and create at least two routes, so a concern about one person never has to go through that person:

| Route | Purpose | Status |
|---|---|---|
| Dedicated mailbox, read by named recipients who are **not** the subject of the report | simple written route | `[TO BE SET UP]`. Do not reuse the personal contact in `public/.well-known/security.txt`; a single recipient cannot receive a concern about themselves |
| Web form or third-party reporting tool that can accept anonymous reports | anonymous route | `[TO BE SET UP]` **[VERIFY]** vendor claims on anonymity and hosting location; **[COUNSEL]** data-processing agreement |
| External contact (lawyer, ombudsperson or advisory board member) | route for concerns about the owner(s) | `[TO BE SET UP]` **[COUNSEL]** |
| Meeting in person or by phone with a named recipient | route for people who prefer to speak | `[TO BE SET UP]` |

Publish the routes internally (onboarding checklist: `docs/compliance/policies/onboarding-offboarding.md`) and, where relevant, to contractors and customers, only after they exist and have been tested end to end.

## 4. What should happen after a report

The steps below are a proposed process. The time targets are **proposals** for the owner to adopt or change, not commitments.

1. **Acknowledge** receipt to the reporter (if they left a way to reply). Proposed: within 7 days **[COUNSEL]** (legal deadlines, if any, may differ).
2. **Log** the report with a case id; record only what is needed (see section 7).
3. **Triage**: is it in scope; is anyone at immediate risk; is there a security incident or a possible legal duty (customer or regulator notification, data breach)? If a security incident, switch to `docs/compliance/policies/incident-response.md` and `RUNBOOK.md` section 6 in parallel.
4. **Assign** an investigator who is independent of the subject and the reporter (section 5).
5. **Investigate**: gather facts; for access misuse, start from the immutable tables (`staff_audit_log`, `staff_impersonation_sessions`, `sensitive_read_log`, `staff_insider_alerts`) and preserve them; hear the person concerned; keep a written record of findings.
6. **Decide and act**: no action / training / process change / disciplinary step / suspension of access / report to authorities. Disciplinary and employment-law steps are **[COUNSEL]** decisions.
7. **Feed back** to the reporter what can be shared (not necessarily the details).
8. **Close** with a short lessons-learned entry; update controls or alert thresholds if a gap was found.

## 5. Conflicts of interest and escalation

- Nobody investigates a case in which they are the subject, a reporter, or directly involved.
- If the concern is about the founder or the only person with admin rights, the case goes to the external contact (section 3) from the start. With a very small team this is the normal case, not the exception.
- If nobody independent is available, record that fact and use the external route rather than proceeding without independence.

## 6. Confidentiality and protection from retaliation

Proposed principles for the owner to adopt: reports are shared only with those who need to know; the reporter's identity is not disclosed without their consent unless a legal duty requires it; retaliation against someone who reports in good faith is itself a conduct violation. **[COUNSEL]** The legal scope of protection, any statutory duties, and the wording that may be promised to reporters. Until counsel has reviewed this, do not promise anonymity or protection in writing to anyone.

## 7. Records and data protection

- Collect the minimum: what happened, when, who is involved, evidence pointers. No special-category data unless it is the substance of the concern.
- Store cases in one access-restricted place (not general chat, not the product database). Recommended: a folder or tool visible only to the case recipients **[VERIFY]** to be chosen.
- Reports contain personal data of reporters and of people named in them. **[COUNSEL]** lawful basis, information duties toward the person concerned, retention period, and handling of access requests.
- Proposed default: delete or anonymise case files when the owner's retention rule says so; keep an anonymous register (date, category, outcome) for the quarterly review.

## 8. Legal frameworks to check

Whether Vireek must operate an internal reporting channel, and with what features, depends on facts not in this repository (legal entity, location, headcount, group structure). Candidates to put to counsel: the EU Whistleblower Directive (Directive (EU) 2019/1937) and its national implementations, including the German Hinweisgeberschutzgesetz (HinSchG), together with data-protection law. **[COUNSEL]** Applicability, thresholds and deadlines **[VERIFY]**. This document must not be cited as proof of compliance with any of them.

## 9. Intake template

| Field | Notes |
|---|---|
| Case id | assigned on receipt |
| Date received, route | mailbox / form / external / in person |
| Reporter | name or "anonymous"; preferred way to reply |
| Concern in brief | facts, not conclusions |
| People or systems involved | |
| Evidence pointers | ticket ids, alert ids from `staff_insider_alerts`, document paths; never paste customer content |
| Triage result | in scope? incident? legal duty? |
| Investigator | independent of the subject |
| Outcome and date | |

## 10. Quarterly review

Together with the access review (`docs/compliance/insider-risk-monitoring.md` section 4), the owner reviews the anonymous register: number of reports by category, time to close, open cases, and whether the routes were tested. With no reports, check that the routes still work before concluding that there is nothing to report.

## 11. Open decisions

- [ ] Assign an owner and a deputy (`docs/OWNERS.md`).
- [ ] Choose and create the routes in section 3 and test each one.
- [ ] Choose the external contact **[COUNSEL]**.
- [ ] Have counsel review sections 4, 6, 7 and 8.
- [ ] Add the channel to onboarding and to the access-review checklist.
