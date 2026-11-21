# Vireek analyst relations plan

Status: Draft for Brand-owner and Trust-owner review · Owner: Brand owner · Evidence: Trust owner
Related: `docs/brand/category-narrative.md`, `docs/brand/architecture.md`, `BRAND_GOVERNANCE.md`, `docs/compliance/SOC2_READINESS.md`.

**[VERIFY]** = not in a claims register and no linked proof. **[COUNSEL]** = needs a lawyer. No analyst firm's program, price, criteria, calendar or contact is stated as fact here; all of those are **[VERIFY]** until someone reads the firm's current published material.

## 1. Position today (what an analyst can be told)

Register state on 2026-11-20 (`docs/claims-register.json` is empty; `src/lib/trust/claims.ts` has ten entries):

- Verified: the SLA commits to 99.9% monthly uptime with service credits. It is a commitment, not measured performance.
- Not held: SOC 2, HIPAA, PCI DSS (own attestation), ISO 27001, end-to-end encryption, multi-region hosting, customer counts, review-site ratings.
- Planned: independent penetration test. In progress: measured uptime history.

An analyst briefing today would carry no customer count, no reference customers, no certification, and no measured uptime. That is a legitimate position for an early-stage vendor, but it determines what kind of engagement is worth doing now.

## 2. Goal and non-goals

**Goal (12 months):** be accurately described, in the right context, by analysts and reviewers who cover voice AI and field-service software, using only evidence we can hand over.

**Non-goals:**

- Being named in a ranked report or quadrant. Inclusion criteria usually require customers, revenue or references we do not hold. Whether Vireek would qualify for any specific report is **[VERIFY]**.
- Paying for coverage and then describing it as independent. Any paid relationship must be disclosed as paid. Terms **[COUNSEL]**.
- Shaping or "correcting" an analyst's opinion. We correct facts, with evidence.

## 3. Readiness gate: do not brief until these are true

| # | Gate | Evidence required | State |
|---|---|---|---|
| G1 | Claims register is the single source of truth | One register (merge or designate canonical), `npm run claims:check` passes | **Not met.** Two registers; check failed in the last audit (`docs/_audit/final-convergence-audit.md`) |
| G2 | Public copy matches the register | `/roi`, `/security`, case-study copy reviewed | **Not met.** `CustomerRoiPage.tsx` says "verified"; `CaseStudies.tsx` says "illustrative" |
| G3 | At least three real customers have consented to be referenced | Outcome kit: consent records and audit trail (`docs/proof/roi-method.md`) | **Not met.** No consented cases exist |
| G4 | Security evidence binder exists and is current | Pen test report (planned), sub-processor list, policies in `docs/compliance/policies/` | **Partly.** Pen test not done |
| G5 | One reviewed product demo path for each pillar | Recorded, dated, scripted, using a sandbox tenant | **[VERIFY]** |
| G6 | Named spokesperson and named owner of corrections | Names in `BRAND_GOVERNANCE.md` §1 (all currently `_assign_`) | **Not met** |

Until G1–G3 are met, run only the **foundation track** (§5, phase 0). Do not request briefings.

## 4. Who to engage and why (categories, not a target list)

| Audience type | Why they matter | What they will ask for | Notes |
|---|---|---|---|
| Large generalist research firms | Procurement shortlists | Customers, revenue, roadmap, references | Likely out of reach now **[VERIFY]** |
| Vertical or field-service specialists | Closest to the buyer's actual problem | Product depth, trade fit, integration list | Best early fit **[VERIFY]** |
| Voice-AI and conversational-AI analysts | Technical comparison | Accuracy method, latency, escalation behaviour, safety | Needs evaluation evidence (see `eval/vertical-ai/`) |
| Independent reviewers and newsletters | Practical credibility with owners | Free access, honest limits | Disclose any free access and any commercial relationship |
| Trade associations | Direct reach to owner-operators | Fit and training value | Not analysts, but related **[VERIFY]** |

Which named firms and individuals are active in each row, and under which program, must be researched from current primary sources before any outreach **[VERIFY]**.

## 5. Phased plan

### Phase 0: foundation (start now, no analyst contact)

1. Resolve G1 and G2 (owner: Trust owner + Engineering owner).
2. Build the evidence binder (§6) from what exists.
3. Run the outcome kit with real, consenting customers (`docs/proof/roi-method.md`).
4. Complete buyer interviews to confirm the category language (`docs/brand/category-narrative.md` §2).
5. Name owners (G6).

Exit: G1–G3 met, binder reviewed by the Trust owner.

### Phase 1: first conversations (after exit of phase 0)

1. Pick 3–5 specialist audiences (§4). Verify current programs from their own published pages **[VERIFY]**.
2. Send a one-page brief, not a deck. Ask for a 30-minute product conversation, not a rating.
3. Run the demo from a sandbox tenant. Share the binder on request.
4. Log every question we could not answer with evidence (§8).

Exit: each conversation has a written follow-up and a list of fact corrections or evidence gaps.

### Phase 2: sustained cadence

1. Quarterly update to engaged analysts: what changed, with register diffs.
2. Respond to inquiries within a stated time **[VERIFY]**: set after capacity is known.
3. Review the narrative against analyst feedback twice a year.

## 6. The evidence binder

All items must exist and be current before sharing. Share by request, under NDA where the item is confidential **[COUNSEL]**.

| Item | Source in repo | State |
|---|---|---|
| Claims register with plain statuses | `src/lib/trust/claims.ts`, `docs/claims-register.json` | Exists, empty or negative-heavy |
| Product surface and tiers | `docs/product-surface.md` | Generated, exists |
| Security whitepaper | `src/lib/securityWhitepaper.ts` | Exists. Review against register before use **[VERIFY]** |
| Sub-processors and regions | `/subprocessors`, `docs/compliance/subprocessor-reconciliation.md` | Exists |
| SOC 2 readiness (not a report) | `docs/compliance/SOC2_READINESS.md` | Exists. Must be presented as readiness work only |
| Policies | `docs/compliance/policies/` | Exists. Gap list in `docs/_audit/DOCUMENTATION_GAP_REPORT.md` |
| AI governance and responsible AI | `docs/ai-governance/*`, `/responsible-ai` | Exists |
| Customer outcome case studies | Outcome kit | **None yet** |
| Pen test summary | none | **Planned** |
| Measured uptime | status page | **In progress** |
| Accessibility conformance | `/accessibility/conformance` | Internal. Independent audit not held (see `BRAND_GOVERNANCE.md` §6) |

## 7. Briefing pack contents

1. **One page:** who it is for, what it does, pillar by pillar, limits (from `category-narrative.md` §5).
2. **Demo script:** one path per pillar, sandbox data, timed.
3. **Evidence index:** §6 as a table with dates.
4. **Open questions we cannot yet answer,** stated plainly.
5. **Contact and corrections process** (§9).

What is excluded from the pack: market sizing, competitor comparisons, customer counts, benchmark numbers, roadmap dates, and any quote not in the outcome kit.

## 8. Questions to expect, and the honest answer today

| Question | Answer from evidence | Gap |
|---|---|---|
| How many customers? | We publish no customer counts (register: `customers.counts`, not_held) | Get consented count and a policy for publishing it **[VERIFY]** |
| Reference customers? | None consented yet | Outcome kit |
| Certifications? | None held. See register negatives | Pen test planned; SOC 2 readiness only |
| Uptime? | SLA commits 99.9%; measured history in progress | Status-page samples |
| Where is data hosted? | Single US region | Regional planes not available |
| How accurate is the voice AI? | **[VERIFY]**. Internal eval exists; method and results need a reviewed write-up | Publish method and limits, not a headline percentage |
| Who decides credit in Capital? | A licensed lending partner. Product is sandbox | Partner and licensing **[COUNSEL]** **[VERIFY]** |
| What happens to our data in Common Failures? | Aggregate-only layer; see `docs/compliance/cross-tenant-data-flows.md` | Counsel-reviewed wording **[COUNSEL]** |

## 9. Rules of engagement

1. **Facts only, with evidence.** If an item is not in the register, say so and say what is being done.
2. **Never describe a conversation as an endorsement.** No "recognised by", "analyst-validated", "as seen in" unless the firm has agreed in writing to that wording **[COUNSEL]**.
3. **Disclose commercial relationships** wherever the analyst or we reference the engagement.
4. **No pre-release promises.** Roadmap statements are labelled as intent.
5. **Corrections process:** a single owner logs factual errors in third-party coverage, replies with evidence, and records the outcome. Opinions are not "corrected".
6. **Use analyst material under its licence.** Quoting, excerpting or reprinting a report needs the firm's permission **[COUNSEL]**.
7. **Names and terms** follow `docs/brand/architecture.md`. In analyst conversations use the plain label with the code name alongside once (for example "Common Failures (internally, the Failure Genome)").

## 10. Measures

Track only what we can observe, not what we hope:

| Measure | Source | Review |
|---|---|---|
| Factual errors found in third-party coverage and how many were corrected | Corrections log | Quarterly |
| Questions we could not answer with evidence | Briefing log | After each briefing |
| Time to answer an evidence request | Briefing log | Quarterly |
| Gaps closed (G1–G6, binder items) | This document's tables | Monthly in phase 0 |

No vanity targets (mentions, impressions, rankings) are set. Any target for inclusion in a named report is **[VERIFY]** because inclusion criteria are the firm's and change.

## 11. Roles

| Role | Does |
|---|---|
| Brand owner | Narrative, briefing pack, spokesperson prep |
| Trust owner | Register, binder, legal review gate, final say on any claim |
| Engineering owner | Demo environment, uptime and eval evidence |
| Customer success | Customer consent and outcome kit runs |
| Founder/executive sponsor | Runs briefings. Name **[VERIFY]** |

## 12. Open decisions

1. Which single register is canonical (G1)?
2. Do we pursue paid advisory or research subscriptions? Default: no, until G1–G3 are met. **[COUNSEL]** on disclosure language if yes.
3. Who is the spokesperson (G6)?
4. Are any customers willing to be referenced to analysts under NDA, separate from public consent?

| Date | Change | Approved by |
|---|---|---|
| 2026-11-20 | Initial draft | _assign_ |
