# Build / buy / partner policy

> **DRAFT: not approved.** Owner: _to be assigned_ · Approved by: _pending_ · Last review: _pending_. Adopting this text is a company decision. Nothing here states that a contract exists, that a vendor was compared, or that any compliance requirement is met. Weights, thresholds and cadences below are **proposed; management decides** (`[DECISION]`). Tags: `[VERIFY]` unconfirmed fact · `[COUNSEL]` legal or contractual question.

This policy answers one question: **when Vireek needs a capability, do we build it, buy it from a supplier, or partner for it?** It is deliberately separate from the documents that already handle what happens *after* that choice:

| Document | Covers |
|---|---|
| [`vendor-exit/README.md`](../vendor-exit/README.md) | One exit plan per provider, tiers, switch effort, drills |
| [`compliance/policies/vendor-management.md`](../compliance/policies/vendor-management.md) | Draft policy on contracting and reviewing providers (DPA status, annual review) |
| [`voice/ENGINE_DECISION.md`](../voice/ENGINE_DECISION.md) | A worked decision record (voice engine) that this policy generalises |
| [`partner-status.md`](../partner-status.md) | Partner programme state per platform |
| [`adr/0001-feature-store-pilot.md`](../adr/0001-feature-store-pilot.md) | The existing ADR format, used here for build decisions |

## 1. Definitions

- **Build:** Vireek writes and operates it. Includes thin adapters around a vendor when the interface is ours (`_shared/ai-core`, `_shared/voice`, `_shared/voice-resilience`).
- **Buy:** Vireek is the customer of a supplier. The supplier's service runs inside Vireek's product (Stripe, Twilio, Resend, Supabase).
- **Partner:** access to the customer or the channel depends on another platform's programme, review or certification (ServiceTitan, Jobber, QuickBooks, Google Business Profile, Meta). We do not control the terms and they can change.
- **Defer:** a recorded decision not to decide yet, with the evidence that would end the deferral (for example, the landscaping weather provider).

A single capability often mixes these. "Voice" is bought (Vapi) behind an interface that is built. Record the mix, not just the label.

## 2. When to run this policy

Run it, and add a log entry (section 7), when any of these happens:

1. A new external dependency is proposed: a new provider, API, SDK with network egress, or model.
2. A capability is proposed that would take longer than a threshold to build `[DECISION: proposed 2 person-weeks, the same S boundary vendor-exit uses]`.
3. A vendor is being replaced or a second vendor is being added behind an existing seam.
4. A new category of personal data would leave Vireek's systems.
5. A partner programme asks Vireek to apply, certify, list or pay.
6. A review trigger in section 5 fires.

The existing guard rails give an early signal: `node scripts/compliance/gen-vendor-exit.mjs --check` fails when a provider appears in code without an exit page, and `node scripts/check-direct-llm-calls.mjs` fails when a new file reaches an LLM provider without going through `_shared/ai-core`. A failure of either is a reason to run this policy, not only to patch the check.

## 3. Procedure

1. **Frame.** One paragraph: the capability, the users, the volume assumption, the date by which it matters.
2. **Gates (section 4).** Any gate that fails removes an option or stops the work until resolved.
3. **List the options.** At least one Build, one Buy and, where a programme exists, one Partner option. "Do nothing" counts when it is viable. Do not score an option nobody would pick to make another look good.
4. **Score (section 4, scoring sheet).** Score each surviving option on every criterion. Tag the evidence type for each score.
5. **Rate confidence.** If most of the weight rests on unknowns, the right output is a time-boxed measurement, not a decision (this is exactly what `voice/ENGINE_DECISION.md` concluded).
6. **Decide and record.** One log entry, plus an ADR in `docs/adr/` when the decision is expensive to reverse.
7. **Prerequisites before code.** For Buy or Partner: an exit page via `gen-vendor-exit.mjs --init <slug>`, the sub-processor and customer notice review `[COUNSEL]`, data-map entry, and a secret handled through the existing credential vault, never in code.

## 4. Gates and scoring

### Gates (veto, not scored)

| Gate | Fails when | Why |
|---|---|---|
| G1 Personal data | Customer or caller personal data would reach the vendor without a reviewed DPA, sub-processor listing and transfer basis | `[COUNSEL]`. The repository already lists sub-processors found in code but missing from the public list as an open item (D-8 in [`DECISIONS_NEEDED.md`](DECISIONS_NEEDED.md)) |
| G2 Life-safety and legal records | The option makes a life-safety instruction or a legal record depend on unreviewed or model-generated vendor output | Safety lines are fixed templates today (`_shared/emergency/emergencyCore.ts`), by design |
| G3 Card data | The option would put card data in a new scope | `[COUNSEL]`. The recording-pause and phone-payment flow is built around the current engine (`_shared/pci/ports.ts`); a replacement must reproduce it before payments by voice can move |
| G4 Exit path | A tier 1 or tier 2 Buy has no documented seam and no accepted lock-in note | Tiers and effort come from the vendor-exit index |
| G5 Programme terms | The planned integration pattern breaks the partner's published rules | Example on record: the ServiceTitan App Key flow is described as prohibited "tunneling" in `integrations/partner-requirements-matrix.md` |
| G6 Credentials | Credentials would live in code, in plaintext columns, or shared across tenants | Use the `provider_credentials` vault pattern referenced in `partner-status.md` |

### Scoring sheet

Score each option 1 to 5 on every criterion, where **5 is best for Vireek** and 1 is worst, whatever the option type. Weighted score = Σ(weight × score) / 5, a number from 20 to 100. Tag every score with its evidence: **V** verified (repository, contract, invoice, measurement), **E** estimated from repository evidence, **U** unknown. Score unknowns 3 and tag U. Never fill an unknown from memory.

| # | Criterion | Weight | 1 | 3 | 5 |
|---|---|---:|---|---|---|
| C1 | Differentiation fit | 15 | Commodity; every competitor has it | Some Vireek-specific behaviour needed | Core to what customers choose Vireek for |
| C2 | Time to value | 10 | More than a quarter | Weeks | Already running or days |
| C3 | Three-year cost of ownership | 15 | Clearly the most expensive | Unknown or comparable | Clearly the cheapest, including people time |
| C4 | Quality and reliability for this use | 10 | Known problems | Unmeasured | Measured at or above target |
| C5 | Control and customisation | 10 | Vendor schema decides | Partial | Full control |
| C6 | Lock-in and exit cost | 10 | Tier 1 and XL coupling, no seam | Seam exists, effort L | Easily swapped (effort S) |
| C7 | Data, security and compliance exposure | 10 | New sensitive data scope, unresolved gates | Contained scope | No new exposure |
| C8 | Team capacity and maintenance burden | 10 | New on-call surface, no owner | Shared load | Vendor or existing owner absorbs it |
| C9 | Viability and dependency risk | 5 | Single small vendor, no fallback | Unknown | Healthy vendor plus fallback |
| C10 | Programme gating and channel reach | 5 | Programme can block us, uncertain access | Not applicable or neutral | Programme open and access assured |

Weights sum to 100 `[DECISION]`.

**Decision rule (proposed):**

1. An option scoring below 50 is not chosen.
2. The top option wins outright when it leads the next by 10 points or more **and** confidence is Medium or High.
3. Inside 10 points, choose by reversibility: the option with the lower exit cost (C6) and the smaller commitment wins, and the entry names the measurement that would change the answer.
4. Confidence is the share of total weight scored V or E: **High** 80 percent or more, **Medium** 50 to 79, **Low** under 50. Low confidence means: run a time-boxed measurement or spike first, then rescore.

### Worked example (illustrative, not a decision)

Capability: realtime voice engine. Options and evidence come from [`voice/ENGINE_DECISION.md`](../voice/ENGINE_DECISION.md). The scores are one reader's interpretation of that record, shown only to demonstrate the sheet.

| Criterion (weight) | A: stay on Vapi (Buy) | B: LiveKit Agents (Build) | Evidence |
|---|:-:|:-:|---|
| C1 Differentiation (15) | 2 E | 4 E | Vapi limits prompt, VAD, barge-in and tools to its schema; LiveKit gives code-level control |
| C2 Time to value (10) | 5 V | 1 V | Vapi runs in production; LiveKit is a stub with no hosting |
| C3 Cost (15) | 3 U | 3 U | Per-minute cost unknown for both |
| C4 Reliability (10) | 3 U | 3 U | Latency targets exist, measurements do not |
| C5 Control (10) | 2 V | 5 V | Same record |
| C6 Lock-in (10) | 1 V | 4 E | 177 code files mention Vapi; the webhook holds about 25 tool handlers |
| C7 Compliance (10) | 4 E | 2 V | Recording-pause and PCI flow not yet reproducible on LiveKit (named blocker) |
| C8 Maintenance (10) | 4 V | 1 V | Vendor runs the pipeline vs a worker fleet needing on-call |
| C9 Viability (5) | 3 U | 3 U | No evidence either way |
| C10 Programme (5) | 3 | 3 | Not applicable |
| **Weighted score** | **59.0** | **59.0** | |

Confidence: criteria scored V or E carry 65 of 100 weight, so **Medium**. The options tie, so rule 3 applies: pick the more reversible one, which is to stay on Vapi, and run the five measurements the record lists before reconsidering. That matches the recorded decision. The sheet did not create that conclusion, it reproduced it.

Blank copy for new decisions: appendix A.

## 5. Review triggers

A decision is reopened when a trigger fires. Each trigger names where it can be observed.

| # | Trigger | Observed in | Proposed threshold |
|---|---|---|---|
| T1 | A provider appears in code without an exit page, or a measured block is stale | `gen-vendor-exit.mjs --check` | any failure |
| T2 | Coupling tier or blast radius of a vendor rises one tier | Generated index in `vendor-exit/README.md` | any step up (for example S to M) |
| T3 | Exit drill overdue | Drill log in each exit page | tier 1: 1 quarter · tier 2: 6 months · tier 3: 12 months (the vendor-exit cadence) |
| T4 | Vendor price or invoice change | Invoices (not in repo) | `[DECISION]` percentage |
| T5 | Vendor outage or SLA breach on a tier 1 or tier 2 provider | Incident record, voice observability alerts | one major incident or two minor in a quarter `[DECISION]` |
| T6 | Partner programme changes or the status table is stale | `partner-status.md` "Last updated" | older than 90 days, or any programme change |
| T7 | New personal-data category, new region, or a sub-processor-list change | Data map, sub-processor list | any |
| T8 | A built component has no named owner or repeated incidents | `docs/OWNERS.md`, incident log | any |
| T9 | Volume passes the assumption recorded in the entry | Usage data | 2x the recorded assumption |
| T10 | Vendor acquisition, end of life, terms change, or loss of a certification Vireek depends on | Vendor notices | any |
| T11 | Annual review of the full log | Policy calendar | once a year |

Each entry in section 7 carries its own "review when" column, drawn from these.

## 6. Roles

No owner is named anywhere in the repository for any of this. Until management names them:

- **Author:** the engineer or product lead proposing the change.
- **Reviewer:** an engineering owner for technical scoring.
- **Counsel:** every `[COUNSEL]` gate.
- **Approver:** management, for any decision that creates a Tier 1 dependency or a recurring cost above a threshold `[DECISION]`.

## 7. Decision log

**How to read this table.** Two kinds of entry:

- **Recorded:** the repository holds an explicit decision document. The entry points to it.
- **Inferred:** nobody wrote a decision down. The entry is reverse-engineered from code, the vendor-exit register and partner documents. It shows *what the codebase implies was chosen*, not *why*, who chose it, what else was considered, or what it costs. Every inferred entry is a hypothesis for the owner to confirm, correct or replace. Costs, contracts and alternatives are unknown in all inferred entries.

Provider facts (tier, blast radius, coupling, effort) are quoted from the generated index in [`vendor-exit/README.md`](../vendor-exit/README.md) and carry its caveat: switch-effort estimates are `[VERIFY]`, nobody has timed a switch, and no exit drill has ever been performed.

| ID | Capability | Decision | Choice | Basis | Evidence in repository | Confidence | Review when |
|---|---|---|---|---|---|---|---|
| BBP-001 | Realtime voice engine | Buy, behind a built interface | Vapi is the only production engine; a second engine only behind the provider interface; no second engine built or measured | **Recorded** | [`voice/ENGINE_DECISION.md`](../voice/ENGINE_DECISION.md), [`voice/PROVIDER_COUPLING.md`](../voice/PROVIDER_COUPLING.md). Tier 1, coupling L, effort XL | n/a | T2, T5, after the five measurements in the record |
| BBP-002 | Feature store for ML-style scores | Build (pilot only) | Point-in-time `ml_feature_snapshots` table piloted for one engine | **Recorded** | [`adr/0001-feature-store-pilot.md`](../adr/0001-feature-store-pilot.md), status Accepted (pilot only) | n/a | T8, pilot outcome |
| BBP-003 | Weather data for landscaping scheduling | Defer | No provider wired by default (`LANDSCAPING_WEATHER_PROVIDER=none`); adapter interface and mock only | **Recorded** | [`LANDSCAPING_PACK.md`](../LANDSCAPING_PACK.md): a real provider needs a reviewed `WeatherAdapter` | n/a | First tenant needing automatic skips |
| BBP-004 | Production host: Vercel or Cloudflare Worker | Open | Not decided; sub-processor claims depend on it | **Recorded** as open (D-6) | [`DECISIONS_NEEDED.md`](DECISIONS_NEEDED.md) D-6. Index: Vercel tier 2 (effort M), Cloudflare tier 2 (coupling XL, effort M) | n/a | Immediately: blocks accurate DPA text |
| BBP-005 | Backend platform (database, auth, edge functions, storage) | Buy | Supabase | Inferred | Tier 1, blast radius 474 of 480 functions, coupling XL, effort XL | Medium: dependency is unmistakable, rationale unknown | T2, T5, T10 |
| BBP-006 | LLM access | Buy several suppliers behind a built gateway | Gemini is chain position 1; Groq is position 2, Cerebras position 3 and OpenRouter position 5 (last resort), all failover; Anthropic has an adapter but is not in the default chain; Cohere is the only embedding provider and stored vectors are tied to its model. The ratchet script keeps new code on the gateway | Inferred | Index: Gemini tier 1 (blast 85, direct callers 22 that bypass the registry), Cohere tier 2, others tier 3. `scripts/check-direct-llm-calls.mjs`, `_shared/ai-core/registry.ts` | Medium | T1 (new direct caller), T4, T10, model deprecations |
| BBP-007 | Telephony and SMS | Buy, with a built failover seam | Twilio primary (tier 1, blast 109, coupling XL, effort XL); Telnyx as secondary adapter, not exercised against the live API | Inferred | Index; `_shared/voice-resilience/adapters.ts` header says the Telnyx adapter has only been unit-tested against a fake fetch | Medium | T5, T7 (new regions), carrier registration changes |
| BBP-008 | Payments: subscriptions, tenant payments, Connect | Buy | Stripe; pay-by-phone flow built in-house around Stripe, Twilio and Vapi | Inferred | Tier 1, blast 33, effort XL (about 12 to 24 person-weeks, Connect KYC dominates `[VERIFY]`); `_shared/pci/ports.ts` | Medium | T3, T5, G3 on any change `[COUNSEL]` |
| BBP-009 | Transactional email | Buy | Resend; no second email provider appears in the index | Inferred | Tier 1, blast 91, coupling XL, effort L | Low: absence of a second provider may only mean it is outside the scan | T5, T10 |
| BBP-010 | Speech synthesis and video | Buy | ElevenLabs (tier 2), Daily.co (tier 3) | Inferred | Index | Low | T4, T9 |
| BBP-011 | Messaging and calendar channels | Partner (platform-owned channels) | Meta (WhatsApp, Messenger), Telegram, Slack, Microsoft, Apple, Google, Sinch RCS | Inferred | Index tiers 2 and 3; `partner-status.md` lists Google, Microsoft programme gates; Microsoft and Google calendar tokens flagged for audit there | Medium | T6, T10 |
| BBP-012 | Field-service, CRM and accounting integrations | Partner (customers keep their own system) | ServiceTitan, Jobber, Housecall Pro, QuickBooks, Xero, Intacct, NetSuite, HubSpot, Zoho, Salesforce, Pipedrive and others | Inferred | Index `customer` kind, tier 3. State per platform in [`partner-status.md`](../partner-status.md): ServiceTitan not applied and current flow breaks programme rules (G5); QuickBooks described as the strongest integration; HubSpot is an OAuth stub | Medium. **Two sub-decisions are open on record:** ServiceTitan onboarding policy, and whether to build real HubSpot sync or not list it | T6, G5 |
| BBP-013 | Single-purpose supplier APIs | Buy narrow services | Plaid (tier 2), Wisetack, TaxJar, Checkr, Lob (tier 3), property data RentCast and ATTOM (tier 3), Yelp (tier 3) | Inferred | Index | Low | T4, T7 (Plaid and Checkr handle sensitive data) `[COUNSEL]` |
| BBP-014 | Public and open data | Use public data, no contract | NWS, Census, FEMA, NASA, EIA, USGS, Open-Meteo, OSM, OSRM, FX | Inferred | Tier 3 group page in the index | Low | T10 (terms, rate limits) |
| BBP-015 | Paging and on-call alerts | Buy | PagerDuty | Inferred | Tier 3, blast 1 | Low | T5 |
| BBP-016 | Trade playbooks, price book seeds, learning loop, first-time-fix priors | Build | In-house catalog and engines | Inferred | `src/lib/tradePlaybookCatalog.ts`, `tradePlaybooks.ts`, `outcomeLearning.ts`, `firstTimeFixAutopilot.ts`; no vendor in the index. Content process: [`product/new-vertical-playbook.md`](../product/new-vertical-playbook.md) | Medium: no external dependency found, but no one wrote down why | T8, T9 |
| BBP-017 | Cross-tenant outcome benchmarks | Build | Outcome Intelligence Network with k-anonymity thresholds (5 tenants, 10 cases, 50 percent dominance cap) | Inferred | `src/lib/outcomeNetwork.ts`, `20270205000000_outcome_intelligence_network.sql` | Medium | T7 `[COUNSEL]`, T8 |
| BBP-018 | Compliance rules engine | Build engine, content by counsel | Seeded rules are all `in_review` | Inferred | `_shared/compliance-rules/seedRules.ts` | Medium | T7 `[COUNSEL]` |

### What the repository cannot tell us

For every inferred entry: the alternatives that were considered, the real cost, contract terms and renewal dates, who decided and when, and whether the decision is still wanted. None of these can be recovered from code. Owners should answer them and change the entry's basis from Inferred to Recorded, with the date and the decider.

### Keeping the log current

- Add an entry whenever `gen-vendor-exit.mjs` gains a provider, using the entry fields above.
- Entries are append-only. A superseded entry is marked "Superseded by BBP-xxx", not deleted.
- A cross-check between this table and the vendor-exit index is **not implemented**. It would be a small extension to `scripts/compliance/gen-vendor-exit.mjs` and is a suggested follow-up, not part of this change.

## Appendix A. Blank scoring sheet

Copy into the pull request or the ADR.

```
Capability:
Users and volume assumption:
Needed by:
Gates: G1 __ G2 __ G3 __ G4 __ G5 __ G6 __   (pass / fail / n.a. + note)

| Criterion (weight)            | Option A: ____ | Option B: ____ | Option C: ____ | Evidence tag (V/E/U) and source |
|-------------------------------|:--:|:--:|:--:|---|
| C1 Differentiation fit (15)   |    |    |    | |
| C2 Time to value (10)         |    |    |    | |
| C3 3-year cost (15)           |    |    |    | |
| C4 Quality, reliability (10)  |    |    |    | |
| C5 Control (10)               |    |    |    | |
| C6 Lock-in, exit (10)         |    |    |    | |
| C7 Data, security (10)        |    |    |    | |
| C8 Capacity, maintenance (10) |    |    |    | |
| C9 Viability (5)              |    |    |    | |
| C10 Programme, channel (5)    |    |    |    | |
| Weighted score (sum w*s / 5)  |    |    |    | |

Confidence (share of weight scored V or E): __ %  -> High / Medium / Low
Decision (Build / Buy / Partner / Defer):
If Defer or Low confidence: the measurement, its owner and date:
Prerequisites: exit page __  sub-processor review [COUNSEL] __  data map __  secrets via vault __
Review when (trigger IDs):
Approver and date:
```
