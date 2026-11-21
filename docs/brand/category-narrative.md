# Vireek category narrative

Status: Draft for Brand-owner and Trust-owner review · Owner: Brand owner · Claims: Trust owner
Related: `docs/brand/architecture.md`, `docs/brand/analyst-plan.md`, `BRAND_GOVERNANCE.md`, `docs/voice-and-tone.md`, `docs/naming-guide.md`.

**[VERIFY]** marks a fact that is not in a claims register and has no linked proof. **[COUNSEL]** marks wording that needs a lawyer. A narrative is a way of explaining the product. It is not evidence, and it does not move a claim's status.

## 0. What this narrative may rely on

`docs/claims-register.json` is empty. `src/lib/trust/claims.ts` holds ten entries, of which only one is `verified`. This is everything the narrative may state as fact today:

| Register id | Status | Wording allowed |
|---|---|---|
| `sla.uptime-commitment` | verified (commitment, not measured performance) | "The Service Level Agreement commits to 99.9% monthly uptime, with service credits when it is missed." |
| `customers.counts` | not_held | "Vireek is early-stage and publishes no customer counts." |
| `social.review-sites` | not_held | No review-site ratings are shown. |
| `cert.soc2`, `cert.hipaa`, `cert.pci`, `cert.iso27001` | not_held | State the plain negative only. Never imply progress that is not registered. |
| `security.e2e-encryption` | not_held | Not offered. Data is protected in transit and at rest on the hosting platform. |
| `infra.multi-region` | not_held | Customer data is hosted in a single US region. |
| `security.pentest` | planned | Say "planned". Never "tested". |
| `uptime.measured-history` | in_progress | Say "in progress". Show a percentage only when the status page has enough samples. |

Everything else in this document that sounds like a claim is marked **[VERIFY]** and is a drafting aid, not copy.

## 1. The one-sentence narrative

> Home-service businesses lose work when nobody answers, when jobs are scheduled badly, and when money is chased late. Vireek puts the answering, the booking and the getting-paid on one system, with a person in control.

Test for any version of this sentence: every verb is something the product does today in the repository, and no number appears. The three nouns follow the product pillars in `docs/naming-guide.md` rule 9: *Answer*, *Book & Dispatch*, *Grow & Get Paid*.

"With a person in control" is a design statement (AI actions are reviewable and bounded). Whether it holds for every flow is **[VERIFY]** and must be checked against `docs/ai-governance/*` before it goes on a page.

## 2. The category question

The product today is described in two ways that do not fully match:

| Where | Description |
|---|---|
| `src/lib/pdfBrand.ts` | "AI Voice Receptionist for Home Service Businesses" |
| Product surface (`docs/product-surface.md`) | Roughly 600 routed pages: jobs, dispatch, quotes, invoices, payments, warranty and more |

The first is how a buyer finds Vireek. The second is what they get. The narrative must hold both without overclaiming either.

**Options for the Brand owner**

| | Frame | Benefit | Risk |
|---|---|---|---|
| A | "AI receptionist for home services" | Matches how buyers search. Easy to defend. | Undersells dispatch, payments, and the rest. Invites comparison with every answering service |
| B | "Operating system for home-service businesses" | Matches scope | Large claim. "Operating system" is a promise about completeness the pilot surface does not yet make **[VERIFY]** |
| C | "Answer-to-paid system for home services" | Describes the loop the product closes. Plain trade words | A new phrase nobody searches for yet |

**Recommendation (a proposal, not a decision):** lead with A in acquisition copy and C inside the product and in analyst briefings. Do not use B until the pilot-freeze surface (`docs/product-surface.md`, Core tier) is the whole product a customer sees. Do not describe any of these as a "new category" in public copy. Whether a category exists is for analysts and buyers to say, not for the vendor to declare **[VERIFY]**.

## 3. The problem, stated without invented statistics

State the problem in terms the reader can check against their own week:

- A call comes in while the crew is on a roof, in a crawlspace, or asleep. It goes to voicemail.
- The caller rings the next company on the list.
- The job that does get booked lands in the calendar without regard to travel, parts, or who is qualified.
- The invoice goes out days later, and the money arrives later still.

Industry figures that usually accompany this (missed-call rates, share of callers who do not leave voicemail, lifetime value of a lead, average job value) are **[VERIFY]**. Do not quote one without a primary source, a date and a registered entry. `docs/compliance/speed-to-lead-assumptions.md` exists for the speed-to-lead assumptions already reviewed internally; read it before writing any related line.

## 4. The thesis

Three ideas, each testable in a product demo:

1. **Answer first.** The first contact is the most expensive one to lose. Vireek's voice receptionist answers, qualifies and books. *Customer-visible scope: what it can and cannot do is defined by each business's own knowledge setup (Sarah Knowledge).*
2. **One record.** What is learned on the call becomes the job, the customer record, the quote and the invoice, without re-typing. *Proof is a demo path, not a claim.*
3. **Closed loop.** Outcomes flow back. What was booked, what happened on site, what was paid. This is what improves the next call and the next schedule. *"Improves" is a design intent. Measured improvement is [VERIFY] and appears only through the customer outcome kit (§7) with consent.*

## 5. What Vireek is not (say this early and plainly)

This section is a trust asset, because most of it comes straight from the register.

- Not a replacement for the person who does the work. Technicians, dispatchers and owners make the calls that matter.
- Not a lender. Where financing appears, a licensed partner decides (`docs/PAY_AND_CAPITAL.md`).
- Not HIPAA, SOC 2, PCI or ISO 27001 certified. Plain negatives from the register.
- Not end-to-end encrypted. Not multi-region.
- Not a source of customer counts, review ratings, or industry rankings. None are held.

Why lead with it: a buyer in a trade business has been told "guaranteed" and "never miss a call" before. Being exact about limits is the differentiator the register already allows us to prove.

## 6. Messages by audience

Use plain trade words (`docs/naming-guide.md`). Numbers and superlatives are excluded because none are registered.

| Audience | What they worry about | Message | Proof available today |
|---|---|---|---|
| Owner-operator | Missing work while on site | The phone gets answered and the job gets booked while you work. You can read what was said. | Product demo. SLA commitment (§0). No customer counts |
| Office manager / dispatcher | Chaos in the schedule | One record from first call to invoice. | Demo of the Core flow |
| Technician | Another tool to learn | Fewer questions at the door; the job arrives with the context. | Demo. Field usability findings **[VERIFY]** (see `docs/research/`) |
| Multi-location operator | Control and consistency | One configuration, per-location results. | **[VERIFY]**: availability by plan and region. Single US region today |
| IT / security reviewer | Where data lives and who sees it | Plain statements: single US region, encrypted in transit and at rest on the host, no certification held, vulnerability disclosure channel exists. | `/trust`, `/security`, `/subprocessors`, the register |
| Investor or analyst | Is there a category and a moat | See `docs/brand/analyst-plan.md`. No market sizing here | Register only |

## 7. How proof is shown

1. **Customer outcomes come from the outcome proof kit** (`docs/proof/roi-method.md`), with written customer consent and a recorded method. A case study is labelled "not independently audited" unless an independent verifier is recorded.
2. **The three stories currently in `CaseStudies.tsx` are illustrative.** That component calls them "illustrative examples". `CustomerRoiPage.tsx` calls the same data "verified" and "named". Both cannot be true, and the register says no customer counts are held. Until consent and sources are recorded, treat them as illustrative everywhere and fix the `/roi` wording in a separate change. This is flagged, not edited, in this task.
3. **No ratings, no logos, no "trusted by"** until each has a register entry with an owner and a date.
4. **Every number on a page has a date and a scope** ("measured over weeks X–Y, for one business, from its own call log").

## 8. Language rules

Follow `docs/voice-and-tone.md` and add these:

| Avoid | Why | Use instead |
|---|---|---|
| "Never miss a call", "100% answered" | Absolute. Not registered. The register explicitly treats absolutes as copy problems | "Answers calls when you can't" plus a scoped, dated figure if one is registered |
| "Bank-grade", "military-grade", "enterprise-grade" security | Unmeasurable | State what exists: encrypted in transit and at rest on the hosting platform |
| "#1", "leading", "best", "the only" | Superlatives need a register entry | Describe the behaviour |
| "AI-powered" as a headline | Capability, not benefit (`docs/brand/architecture.md` N4) | Say what gets done |
| "Genome", "mesh", "twin", "flywheel" | Metaphors banned in labels | The plain feature label |
| "Replaces your staff" | Untrue by design and alienating | "Covers the phone while your team works" |
| "Certified", "compliant" without a named standard | Implied certification | Say "not certified" or use the register wording |

## 9. Proof gaps that block the narrative from getting bigger

| Gap | Owner | What closes it |
|---|---|---|
| No consented, sourced customer outcomes | Trust owner + Customer success | Outcome kit populated with real customers and consents |
| No measured uptime history | Engineering owner | Status page reaches enough samples (`uptime.measured-history`) |
| No independent pen test | Security | `security.pentest` moves from planned |
| Unknown category language buyers use | Brand owner | Buyer interviews (`docs/research/RESEARCH_PROTOCOL.md`), coded and recorded **[VERIFY]** |
| Voice answer speed has no data (`calls.answer_ms` is not populated, per `docs/_audit/proof-of-value.md`) | Engineering owner | Populate and verify before any speed claim |

## 10. Review checklist

- [ ] Every factual sentence maps to a verified register entry, a not_held negative, or carries [VERIFY]
- [ ] No number without source, date and scope
- [ ] No absolute or superlative
- [ ] Limits in §5 are not softened in any derivative
- [ ] Names follow `docs/brand/architecture.md`
- [ ] Legal wording carries [COUNSEL] and has been reviewed
- [ ] The register and the page agree (`npm run claims:check`)

| Date | Change | Approved by |
|---|---|---|
| 2026-11-20 | Initial draft | _assign_ |
