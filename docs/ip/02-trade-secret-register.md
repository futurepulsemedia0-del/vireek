# Trade-secret register

Status: DRAFT register. Not legal advice. Whether any asset below legally qualifies as a trade secret, and what protective steps a jurisdiction requires, is **[COUNSEL]**. An entry here is a *candidate*, not a conclusion.

**This file contains no secrets.** It records that an asset exists, where it lives, who is responsible, and what protects it. It never contains the asset, a summary detailed enough to reproduce it, a credential, a key, a salt, a prompt, a threshold or a customer's data. If you are unsure whether a description is too revealing, shorten it and ask the legal contact.

## 1. Purpose

Counsel can advise how much evidence of secrecy handling a given jurisdiction expects; the working assumption here is that being able to show what was treated as secret, and how, helps. **[COUNSEL]** The register is the one place that answers: what do we treat as secret, why, who may see it, and what do we do to keep it that way. It is reviewed on a schedule, and it is where an invention disclosure ends up when counsel chooses secrecy over patenting or publication (`01-invention-disclosure-template.md`, part G).

## 2. What is not on this register

| Not registered | Why |
| --- | --- |
| Anything already public: marketing pages, public docs, published blog posts, the public site-assistant knowledge base (`knowledge/`, `eval/site-assistant.*`) | Published material is not secret. |
| Open-source dependencies and their licences | Tracked in `docs/compliance/oss-license-policy.md`. |
| Customer data, scripts, pricing, recordings | Owned by the customer (`src/lib/legalDocs/intellectualProperty.ts`). Handled by the data map and DPIA, not here. See `docs/compliance/data-map.md`. |
| Credentials and API keys | Secrets management, not IP. Never stored in the repository. See `SECURITY.md` and `ENVIRONMENT.md`. |
| Personal data | Privacy programme, not IP. |

## 3. Register

Field meanings are in section 4. Only the columns below are recorded. "Evidence" means a pointer to a system, log or document where a control can be checked; it is **[VERIFY]** until someone has actually looked.

| ID | Asset (neutral label) | Category | Where it lives (pointer only) | Business owner (role) | Classification | Access today (role level) | Controls to evidence | Known gaps | Last reviewed | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TS-001 | Voice agent persona and conversation-design material | Know-how / content | `docs/VOICE_PERSONA_BIBLE.md`; agent configuration in the voice provider account | Voice owner (`docs/OWNERS.md`) | Confidential | [VERIFY] repository members; voice-provider account members | Repo access list; provider account member list; NDA on file for non-employees **[VERIFY]** | Whether this document is intended to be published is undecided; if the repository is or becomes public this entry is void **[VERIFY]** | not yet | Candidate |
| TS-002 | Evaluation sets and red-team suites for voice and vertical AI | Test data / methods | `eval/vertical-ai/`, `eval/voice-redteam/` | AI governance owner (assign) | Confidential | [VERIFY] | Same as TS-001 | Public exposure through the repository or CI artifacts not checked **[VERIFY]** | not yet | Candidate |
| TS-003 | Dispatch and scheduling optimisation logic and its tuning parameters | Algorithm / parameters | `docs/DISPATCH_OPTIMIZER.md` (design); implementation in the dispatch modules of `src/lib/` and `supabase/functions/` | Engineering owner | Confidential | [VERIFY] | Code-review rules; repository access list | Product documentation may already describe behaviour publicly; compare with published pages before relying on secrecy **[VERIFY]** | not yet | Candidate |
| TS-004 | Cross-tenant outcome-learning method: signal definitions, attribution rules, thresholds and aggregation approach | Algorithm / data method | Migrations `20290101000000_outcome_learning_foundation.sql`, `20290102000000_outcome_learning_advanced.sql`; related `docs/compliance/cross-tenant-data-flows.md` | Engineering owner | Confidential (method). The aggregates shown to customers are not secret | [VERIFY] | Database role grants; privacy salt kept only in the database and never in code or docs | Migrations are source-controlled and readable by all repository members; the method itself is visible there **[VERIFY]**. Customer-facing descriptions could disclose it **[COUNSEL]** | not yet | Candidate |
| TS-005 | Prompt and tool-orchestration design of customer-facing agents | Know-how | Edge functions under `supabase/functions/` that assemble prompts and tools | Engineering owner | Confidential | [VERIFY] | Function deploy access list; log redaction so prompts are not written to logs **[VERIFY]** | Prompts reach third-party model providers; the provider's retention and training terms are not confirmed **[VERIFY]** | not yet | Candidate |
| TS-006 | Pricing, margin and unit-economics models (internal) | Business information | Internal finance spreadsheets and any `cogs_margin` views; location of master copies unknown | Finance / founders | Restricted | [VERIFY] | Document-store sharing settings; export logs | Master location not identified in the repository **[VERIFY]** | not yet | Candidate |
| TS-007 | Customer-list-level commercial intelligence (pipeline, win/loss reasons, competitor notes) | Business information | CRM / `win_loss_records` once present; sales documents | Sales owner (assign) | Restricted | [VERIFY] | Role-based access; export restrictions | Not inventoried | not yet | Candidate |
| TS-008 | Unpublished product roadmap and architecture plans | Business information | Internal planning documents | Founders | Restricted | [VERIFY] | Document-store sharing settings | Several roadmap-style files sit in the repository root and `docs/`; if the repository is shared with outside parties they are exposed **[VERIFY]** | not yet | Candidate |

Add rows; do not renumber. A retired asset keeps its ID and its row moves to section 7.

## 4. Field meanings

| Field | Rule |
| --- | --- |
| ID | `TS-NNN`, assigned by the legal contact, never reused. |
| Asset | A neutral label. Test: could this be read aloud to a customer without teaching them anything? If not, shorten it. |
| Category | Know-how, algorithm / parameters, test data / methods, business information, data compilation. |
| Where it lives | Repository path, system name or document-store folder. Never a URL with a token, never a snippet. |
| Business owner | A role from `docs/OWNERS.md`, not a person's name, so the register survives departures. |
| Classification | **Restricted** (named people only), **Confidential** (staff and bound contractors who need it), **Internal** (all staff; included only if counsel asks). |
| Access today | Role level only, e.g. "all engineers". Source of truth is the access list in the system, which the owner reviews. |
| Controls to evidence | What would show reasonable steps were taken. Each is **[VERIFY]** until a dated check is recorded in section 6. |
| Known gaps | Honest list. A gap is not a failure of the register, it is its main output. |
| Status | Candidate, Confirmed by counsel, Disputed, Retired. Only counsel moves an entry to "Confirmed". **[COUNSEL]** |

## 5. Handling rules (operational)

These are Vireek's intended working rules. **[COUNSEL]** to confirm which are required, sufficient or excessive for each jurisdiction and to approve wording before they are written into employee or contractor terms.

1. **Need-to-know.** Access follows the classification. Owners remove access when roles change.
2. **Agreements first.** Contractors, vendors, advisors, investors and prospective partners sign a confidentiality agreement approved by counsel before seeing any registered asset. Record who received what and when in section 6. **[COUNSEL]**
3. **Employees and contractors.** Confidentiality and invention-assignment terms exist for everyone with access; confirm and record per person. Not reviewed in this snapshot. **[COUNSEL] [VERIFY]**
4. **Marking.** Restricted and Confidential documents carry a visible label. Labels are a reminder, not a legal protection.
5. **No public surfaces.** Registered assets are never placed in public repositories, public issue trackers, support replies, blog posts, conference material or screenshots. The pre-publication check in `05-defensive-publication-criteria.md` §5 applies to anything technical going public.
6. **Third-party AI and tooling.** Before pasting registered material into a third-party service (LLM, notebook, translation, analytics) the owner checks the provider's retention and training terms. Unknown means do not paste. **[VERIFY]**
7. **Logs and exports.** Prompts, parameters and evaluation sets are kept out of application logs and exports unless redacted. **[VERIFY]**
8. **Departures.** On exit: remove access the same day, remind the person of continuing obligations in the wording counsel approved, collect devices and exports, and record completion. **[COUNSEL]**
9. **Suspected leak.** Tell the legal contact immediately. Do not contact the suspected recipient. Counsel decides on preservation, notices and any outreach. Treat it as a security incident in parallel (`docs/incident/`). **[COUNSEL]**

## 6. Review log

Review each entry at least quarterly **[VERIFY: cadence is an internal choice, not a legal requirement]** and on triggers: departure of a person with access, a new vendor in the data path, a repository visibility change, a customer security questionnaire that asks about it.

| Date | Entry | Reviewer (role) | What was checked (system, list, date) | Result | Follow-up |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

Disclosure log (who outside the company received what, under which agreement):

| Date | Entry | Recipient (organisation) | Agreement reference | Purpose | Return / destruction confirmed |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## 7. Retired entries

| ID | Retired on | Reason (became public, ceased to be valuable, patented, published defensively) | Decision by |
| --- | --- | --- | --- |
| | | | |

## 8. Relationship to other routes

- A patent application requires disclosure. Choosing it means the matching entry here is retired. **[COUNSEL]**
- A defensive publication destroys secrecy on purpose. See `05-defensive-publication-criteria.md`.
- Open-source release of code that implements a registered asset ends its secrecy. Route through counsel first. **[COUNSEL]**
