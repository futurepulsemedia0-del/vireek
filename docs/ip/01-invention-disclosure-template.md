# Invention disclosure template

Status: DRAFT. Not legal advice. Routing, patentability and ownership decisions are **[COUNSEL]**.

## How to use this

1. Copy the form in section 3 to a new file named `YYYY-MM-DD-short-title.md` **outside the public repository** (a private, access-controlled location chosen with counsel). Do not commit filled disclosures to a repository that is or may become public. **[COUNSEL]**
2. Fill every field you can. Write "unknown" instead of guessing. A partial form sent early is better than a complete one sent after a launch.
3. Send it to the legal contact the same business day. Do not post, present, demo outside the company, open-source or write about the idea until counsel replies. **[COUNSEL]**
4. Keep your lab notebook material (sketches, commits, test results). Dates matter later.

Disclose when any of these is true: you solved a problem in a way you have not seen elsewhere; a change measurably improved accuracy, cost, latency, or reliability; you are about to publish, present, or demo something technical; a competitor, customer or partner asked how something works.

Do not include: credentials, API keys, salts, customer data, call recordings or transcripts, or personal data of any individual. Describe the idea, not the data it ran on.

## 2. What counsel does with it (for reference)

| Step | Owner | Notes |
| --- | --- | --- |
| Acknowledge and assign an ID (`INV-YYYY-NNN`) | Legal contact | Within the same business week. Target is internal, not a legal deadline. |
| Check dates, public disclosures, and inventor/assignment status | Counsel | **[COUNSEL]** |
| Prior-art search and patentability view | Counsel | Scope and cost approved before starting. **[COUNSEL]** |
| Route: patent / trade secret / defensive publication / no action | Counsel with engineering lead | Record in section 3, part G. See `02-trade-secret-register.md` and `05-defensive-publication-criteria.md`. |
| Close with a written reason | Legal contact | A "no action" decision is still recorded. |

## 3. Form

Copy from the line below to the end of the file.

```markdown
# Invention disclosure INV-____-___   (legal contact assigns the number)

Confidential. Prepared at the request of counsel. [COUNSEL] to confirm whether this label is appropriate.

## A. Administration
- Title (neutral, do not reveal the secret in the title):
- Date of this form (YYYY-MM-DD):
- Submitted to (legal contact):
- Product area: [ ] voice agent  [ ] dispatch / scheduling  [ ] billing / payments  [ ] analytics / learning  [ ] mobile / field  [ ] integrations  [ ] other: ____

## B. People
For each person who contributed to the **conception** of the idea (not only those who wrote code):
| Name | Employer at the time (company / contractor / other) | Contribution in one sentence | Location (country) when contributed |
| --- | --- | --- | --- |

- Did anyone outside Vireek help or see this (customer, vendor, advisor, university, former employer)? [ ] No  [ ] Yes: who, when, under what written terms (NDA / contract), or "none" ____
- Could any part belong to a previous employer or have been developed using another party's materials or time? [ ] No  [ ] Unsure  [ ] Yes ____

## C. The problem and the idea
1. What problem does this solve, and for whom? (plain language, 3-6 sentences)
2. How is it handled today in Vireek and elsewhere? (products, papers, open-source projects you know of; say "unknown" if you did not look)
3. What did you do differently? Describe the technical idea in steps a peer engineer could follow. Name inputs, outputs and the key decision or calculation.
4. Why does it work? (the reason it beats the alternatives)
5. What are the alternatives you tried or considered and why were they worse?
6. What else could this idea be used for?

## D. Evidence of what it does
- Measured result (metric, method, before/after). Quote only figures you measured, with the date and the data source. Write "not measured" if you did not.
- Where the work lives: repository path(s), pull request or commit identifiers, ticket ids. Paths only, no code pasted here.
- Is it in production? [ ] No  [ ] Behind a flag  [ ] Yes, since (date) ____

## E. Dates (be exact; unknown is acceptable)
| Event | Date | Evidence (commit, note, email id) |
| --- | --- | --- |
| First wrote down or sketched the idea | | |
| First working prototype | | |
| First use in production or by a customer | | |
| First shown outside the company (demo, call, deck, repo, blog, talk) | | |
| Planned launch, talk, post, or release | | |

Anything in the "shown outside" row may limit options. **[COUNSEL]**

## F. Third-party and open-source material
- Open-source libraries, models, datasets or vendor APIs the idea depends on, with licences if known (see `docs/compliance/oss-license-policy.md`):
- Does the idea depend on a vendor's non-public behaviour or terms (voice, telephony, LLM, payments)? ____
- Does it use or derive from customer data? [ ] No  [ ] Yes: describe the category only. [COUNSEL]

## G. Triage record (completed by counsel / legal contact, not the inventor)
- Route chosen: [ ] patent  [ ] trade secret (add to register, ID: TS-___)  [ ] defensive publication (record: ___)  [ ] no action
- Reason, in one or two sentences:
- Decision date and decision-makers:
- Next review date:
- Assignment and inventor-record steps completed: [ ] yes  [ ] no  [COUNSEL]
```

## 4. Handling and retention

- Filed disclosures are access-limited to the inventors, the engineering lead for the area, the legal contact and counsel.
- Retain disclosures and their evidence for as long as counsel says rights could matter. Retention period: **[COUNSEL]**.
- A disclosure that becomes a trade-secret entry is referenced from the register by ID only. The disclosure text does not move into `docs/`.
- If an inventor leaves, the legal contact confirms the disclosure and evidence are complete before the last day. **[COUNSEL]**
