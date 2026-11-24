# Defensive publication criteria

Status: DRAFT criteria. Not legal advice. Every legal judgment here (what counts as prior art, effect on patent or trade-secret rights, which jurisdictions, how to publish) is **[COUNSEL]**. Statements about how prior art works are orientation only and **[VERIFY]** with counsel.

## 1. What a defensive publication is

Publishing a technical description of an idea, openly, on a dated and findable record, so that the idea becomes public knowledge as of that date. The intended effect is that later patent applications by others covering the same idea may be harder to obtain, which helps keep the idea free for everyone including Vireek. **[COUNSEL]** to confirm the effect in each jurisdiction Vireek cares about and whether a particular publication would in fact serve that goal.

What it gives up: secrecy and, in many systems, the option to patent the idea later (timing rules differ and some allow a grace period; do not rely on one without counsel). Publication is irreversible. **[COUNSEL]**

It is not marketing. A blog post is not automatically a good defensive publication, and a defensive publication is not a substitute for a patent when exclusivity is what Vireek wants.

## 2. Decision flow

Start from a filed disclosure (`01-invention-disclosure-template.md`). Counsel picks one route; this document supports that decision.

```
Is the idea valuable only while others do not know it?  --yes-->  trade secret (02)
        | no
Would exclusivity change our business, and is it likely patentable?  --yes, counsel agrees-->  patent route [COUNSEL]
        | no / not worth the cost
Would a competitor patenting this block or tax us, and can we describe it fully without harming the business?  --yes-->  defensive publication (this file)
        | no
No action (record the reason on the disclosure)
```

## 3. Criteria

An invention is a good candidate for defensive publication when **all of the first group** and **at least one of the second** hold, and **none of the third** applies.

### Group A: must all be true

| # | Criterion | How it is checked |
| --- | --- | --- |
| A1 | Counsel has reviewed the disclosure and agreed that publishing, not patenting and not keeping secret, is the right route for this idea | Disclosure part G records it **[COUNSEL]** |
| A2 | The idea can be described in enough technical detail that a skilled engineer could understand and reproduce the principle without our code | Reviewer reads the draft cold (§5 step 4) |
| A3 | The idea is Vireek's to publish: all inventors are identified, the company has the rights it needs, and no third party (employer, customer, vendor, university, former employer) has a claim or contractual limit | Disclosure part B; counsel **[COUNSEL]** |
| A4 | The description contains no registered trade secret, customer data, personal data, credential, or vendor-confidential information | §5 pre-publication check; register `02-...` |

### Group B: at least one should be true

| # | Criterion | Examples of what to ask |
| --- | --- | --- |
| B1 | A competitor patenting the same idea would plausibly constrain Vireek or its customers | Is the idea close to something a watched company has shown interest in (`04-competitor-ip-monitoring.md`)? |
| B2 | The idea is a natural next step others could reach soon, so secrecy would not last | Is it already visible from the product's behaviour, public docs, or a competitor's trajectory? |
| B3 | Vireek does not plan to enforce a patent on it and the cost of patenting is not justified | Decision by counsel and founders **[COUNSEL]** |
| B4 | Publication would clearly help trust, hiring or partnerships without exposing something worth more as a secret | Brand owner and founders view; counsel confirms no rights lost unintentionally |

### Group C: any one of these means do not publish defensively (revisit with counsel)

| # | Disqualifier |
| --- | --- |
| C1 | The idea gives Vireek an edge that depends on competitors not knowing it (it belongs on the trade-secret register) |
| C2 | The key value is in tuning, data, or know-how that cannot be described in a publication anyway |
| C3 | Counsel advises that a patent is worth pursuing and the idea has not been disclosed publicly |
| C4 | Disclosing would breach a contract, a licence term, or a vendor's confidentiality terms |
| C5 | The only way to explain the idea reveals how Vireek's security, fraud controls, abuse prevention or compliance controls work in a way that helps attackers |
| C6 | Publishing would reveal customer or cross-tenant learning data or the thresholds that protect it (`docs/compliance/cross-tenant-data-flows.md`) |
| C7 | The idea depends on code or a model under a licence that does not permit the publication **[COUNSEL]** |

## 4. Quality bar for the publication itself

A defensive publication only works if people can find and understand it. Aim for:

1. **Specific:** state the problem, the approach, the steps, the inputs and outputs, and at least one worked example with illustrative (not real) numbers. Describe variations and alternatives.
2. **Enabling:** enough detail that a skilled person could implement the idea. Counsel advises on the level needed. **[COUNSEL]**
3. **Dated:** the venue records a reliable publication date and does not allow silent edits. Keep a copy and proof of the date.
4. **Findable:** a descriptive title and abstract using the vocabulary others would search with, in a venue that patent examiners and search tools can reach. Venue choice is for counsel; candidates include dedicated prior-art repositories and widely indexed preprint or journal services. **[COUNSEL] [VERIFY]**
5. **Stable:** a persistent identifier or permanent link; no paywall that blocks examiners.
6. **Neutral in tone:** no promotional claims, no competitor comparisons, no statements about Vireek's legal rights.

## 5. Pre-publication check (every publication, no exceptions)

Complete before anything leaves the company. Record the answers on the publication record (§6).

1. Counsel approval of the route and the final text. **[COUNSEL]**
2. Register check: no `TS-` entry is described or implied; the text has been compared with `02-trade-secret-register.md`.
3. Data check: no customer names, numbers, scripts, transcripts, recordings, personal data, production identifiers, hostnames, keys or internal URLs. Illustrative values only.
4. Cold read: someone outside the team reads the draft and says whether the idea is understandable and whether anything reads like internal-only detail.
5. Vendor and licence check: the text does not reveal vendor-confidential behaviour, contract terms or content covered by third-party licences. **[COUNSEL]**
6. Claims check: no capability, accuracy, compliance or certification claim that is not supported. Route through `docs/claims-register.json` and the Trust owner.
7. Inventor and attribution: inventors and authors agree, in writing, to the publication and how they are credited. **[COUNSEL]**
8. Timing: publication is scheduled; nothing related is announced or demoed first. **[COUNSEL]**
9. Open-source link: if code is released with the publication, `docs/compliance/oss-license-policy.md` is followed and counsel approves the licence. **[COUNSEL]**

## 6. Publication record

Keep one per publication in the private IP folder (not in public `docs/`). Reference it from the disclosure (`INV-...`).

```markdown
# Defensive publication record DP-YYYY-NNN
- Linked disclosure (INV-...):
- Title and abstract as published:
- Decision date; decided by (counsel and founder roles) [COUNSEL]:
- Criteria met (A1-A4; B-number(s); confirmation none of C applies):
- Pre-publication check (§5): items 1-9 each y/n with date and reviewer
- Venue and persistent link; date shown on the venue; archive copy location:
- Inventors / authors and consent evidence:
- Related register entries retired or unchanged:
- Effect noted for other jurisdictions or filings [COUNSEL]:
- Follow-up: monitoring of later filings that cite or resemble this publication (04-...)
```

## 7. After publication

- Update the trade-secret register if any related entry changes status (retire it with the reason "published").
- Tell counsel and the monitoring owner so later filings in the area can be watched. **[COUNSEL]**
- Do not describe the publication in customer or public material as protection, a patent, or an exclusive right.
- Review once a year whether the record, link and archive copy still work.

## 8. Not covered

Patent drafting and filing, licensing the published idea, and any dispute about prior art are counsel's work. **[COUNSEL]**
