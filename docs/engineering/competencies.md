# Engineering competencies and levels

> **DRAFT — not approved.** Owner: _to be assigned_ · Approved by: _pending_ · Last review: _pending_. This is a proposal for management to adopt, change or reject. It sets no pay, title, promotion rule or employment term, and it makes no compliance claim. Anything that touches employment terms, performance management or promotion is **[COUNSEL]** (the rules differ by country). Level names below are working labels, not job titles.

Companion page: [`onboarding.md`](onboarding.md) (the first week). The expectations here come from how this repository already works: [`CONTRIBUTING.md`](../../CONTRIBUTING.md), [`.github/pull_request_template.md`](../../.github/pull_request_template.md), [`ARCHITECTURE.md`](../../ARCHITECTURE.md) and [`RUNBOOK.md`](../../RUNBOOK.md). Where a sentence below describes a practice, the file that defines it is named, so you can check it.

## How to read this

- **A level describes a pattern of work, not a checklist.** Someone is at a level when most of their work, over a sustained period, looks like that level. One good quarter, or one big incident handled well, is a signal, not a verdict.
- **Each level includes the ones before it.** Level 3 does not stop doing what level 2 does; it does more, and it makes others better at it.
- **Scope grows before anything else.** The first difference between levels is the size of the problem a person can be handed and trusted to land: a task, a feature, a system, a set of systems.
- **Judgment counts more than output.** Vireek is a production system with paying customers. Preserving existing behaviour and making the smallest correct change is a skill, and it is rated as one.
- **Evidence beats impressions.** Use real examples: a PR, a migration and its pgTAP test, an incident write-up, a review comment, a design note. A manager should be able to point at them.
- **People do not need to hit every cell.** Strength in some dimensions and growth in others is normal. What matters is that the weak ones are not the ones that can hurt customers: tenancy, security, and production safety.

## Levels at a glance

| Level | Working label | Typical scope | How they work with others |
|---|---|---|---|
| L1 | Associate Engineer | A well-defined task inside one area, with review | Asks early, learns the codebase and its rules, is guided |
| L2 | Engineer | A feature or a bug that crosses a few files or layers | Works independently on clear problems, asks about unclear ones |
| L3 | Senior Engineer | A feature area end to end, including the backend, the migration and the rollout | Others rely on them for reviews and for hard bugs; they mentor |
| L4 | Staff Engineer | A system or a cross-cutting concern across several areas (tenancy, billing, voice, integrations, data) | Sets direction others follow; resolves ambiguity; grows seniors |
| L5 | Principal Engineer | The technical health of the company: strategy, risk and the long bets | Shapes how the company builds; trusted on decisions that are hard to reverse |

A management track is **not** defined here. Whether and how it branches off is a company decision.

## The seven dimensions

### 1. Code and design quality

| Level | Expectations |
|---|---|
| L1 | Follows the conventions without being reminded: Prettier, TypeScript strictness, `@/` imports, logic in `src/lib/<domain>.ts` and I/O in `<domain>Api.ts`, UI primitives from `components/ui/`. Keeps changes small and readable. Does not bring in a dependency to solve a small problem. |
| L2 | Chooses the right layer and the existing pattern without help, and reuses shared helpers instead of writing a second one. Notices when a request duplicates a module that already exists, and says so. Leaves the code a little clearer than they found it, inside the scope of the change. |
| L3 | Designs a feature area so the next change is easy: clear boundaries, imports going downward only (`ARCHITECTURE.md` section 2.2), pure logic that can be tested without React. Rejects clever when simple is enough, and can explain the trade-off. Spots design problems in review before they are merged. |
| L4 | Defines the shape of a shared capability that several teams build on (for example the connector kernel, the AI core, the entitlement model) and keeps it coherent as it grows. Writes the decision down in `docs/adr/`. Pays down debt where it reduces risk, not where it is only untidy. |
| L5 | Sets the architectural principles that survive staff turnover. Knows which decisions are cheap to change and which are not, and spends their attention on the second kind. Makes the build-versus-buy and provider-dependence calls with the exit cost in view (`docs/vendor-exit/`). |

### 2. Tenancy, security and privacy

| Level | Expectations |
|---|---|
| L1 | Never puts a secret in code, tests, migrations or screenshots. Filters by the account owner id, not `user.id`. Uses `ConfirmDialog` rather than `window.confirm`, and does not use `dangerouslySetInnerHTML`. Asks when unsure whether data may be shown to a given role. |
| L2 | Applies the tenancy and RLS rules by default in new queries, policies and edge functions. Knows that a client-sent account id is never trusted. Declares a new edge function's auth model in `docs/security/function-policy.json`. Knows what counts as personal data and does not add a new flow without updating `docs/compliance/data-map.md`. |
| L3 | Designs for isolation: a new table comes with RLS, indexes on the policy columns and a pgTAP test for own-tenant success and cross-tenant denial. Reviews others' code for privilege escalation, injection, replay and duplicate-operation risks. Handles webhooks with signatures and idempotency. Leaves a clear note on what was not verified. |
| L4 | Owns a security or privacy outcome across systems: tenant isolation, secrets and key rotation, data residency, sub-processor changes. Finds the class of bug, not just the instance, and closes the class. Works with the compliance owner and counsel and does not make legal claims for them **[COUNSEL]**. |
| L5 | Sets the company's technical security posture and its trade-offs. Decides what must be built before a customer or auditor asks, and what can wait. Ensures public claims about security match what the code and operations do (`npm run claims:check` exists for this reason). |

### 3. Testing and verification

| Level | Expectations |
|---|---|
| L1 | Runs lint, typecheck and tests before every PR (`CONTRIBUTING.md` section 2). Adds a test next to the code they change. Reports what they ran and what they could not run. |
| L2 | Writes the failing test first for a bug when practical. Covers failure paths and edge cases, not only the happy path. Picks the right kind of test: Vitest for logic, pgTAP for RLS and migrations, Playwright for flows. Does not lower a coverage threshold to make a PR pass. |
| L3 | Treats tests as design: pushes logic into pure functions so it can be tested, and designs a rollout so it can be verified. Tests for malicious input, unauthorized access and duplicate operations. Distinguishes a static check, an executed test and a verified end-to-end result, and reports each as what it is. |
| L4 | Raises the verification level of a whole area: closes gaps such as skipped authenticated E2E, or a non-blocking database-test job that should block. Builds the guardrails (checks, baselines, drills) that make the safe path the easy path. |
| L5 | Shapes the company's quality strategy and its release-safety model. Decides where the money goes: which failures are unacceptable, which are tolerable, and how the team will know before customers do. |

### 4. Production safety and operations

| Level | Expectations |
|---|---|
| L1 | Knows the release checklist exists (`RUNBOOK.md` section 1) and where the incident steps are. Escalates quickly instead of improvising on production. Never points a `.env` at production. |
| L2 | Writes migrations that are forward-only, idempotent and carry a rollback note (`npm run lint:migrations`). Knows how to roll back a deploy. Adds `captureError` for handled errors worth tracking and removes `console.log`. Takes part in an incident when asked and follows the process. |
| L3 | Ships risky changes safely: staged, behind a flag, with a recovery plan written in the PR. Considers concurrency, retries, idempotency and partial failure by default. Diagnoses production problems from logs and data, and writes the post-incident note (`docs/runbooks/post-incident-template.md`). |
| L4 | Owns the reliability of a system: defines what "healthy" means, adds the monitoring and the alerts that tell the truth, runs the drills (restore, vendor exit, kill switch) and fixes what the drills find. Reduces the number of incidents of a class, not only the time to recover. |
| L5 | Owns the company's resilience model: failure domains, provider dependence, data recovery targets, incident command. Makes the calls where reliability, cost and speed pull in different directions, and records why. |

### 5. Delivery and ownership

| Level | Expectations |
|---|---|
| L1 | Finishes what they start, or says early that they are stuck. Keeps the PR small and the description honest. Follows up on review comments. |
| L2 | Breaks a feature into safe steps and delivers them in order. Keeps the product surface rules (`docs/naming-guide.md`) and does not add pages or nav items without the checklist. Estimates honestly and says when an estimate changes. |
| L3 | Takes an ambiguous feature from idea to production: clarifies the problem, proposes the approach, sequences the migration, the backend and the UI, and lands it with tests and a rollback plan. Cuts scope to protect quality and says what was cut. |
| L4 | Drives an initiative that spans areas and quarters. Turns a vague risk into a plan with owners and checkpoints. Unblocks others. Decides what not to do. |
| L5 | Sets the technical plan the company can commit to. Decides which large efforts are worth the cost, and stops the ones that are not, even when they are interesting. |

### 6. Communication and honesty about evidence

| Level | Expectations |
|---|---|
| L1 | Writes clear PR descriptions and asks clear questions. Says "I did not verify X" when that is true. |
| L2 | Explains the why of a change, not only the what. Gives and receives review comments constructively. Marks unverified vendor or legal facts as **[VERIFY]** or **[COUNSEL]** rather than stating them as fact. |
| L3 | Writes the design note or the ADR that lets others disagree usefully. Reviews with care, with specific and kind feedback that makes the author better. Explains technical risk to non-engineers in plain words. |
| L4 | Makes complex trade-offs understandable to leadership and to customers' technical reviewers. Writes the document people reuse (a runbook, a standard, a threat model). Corrects a wrong claim quickly, including their own, in public. |
| L5 | Is trusted by the board, auditors and key customers on technical matters because what they say is accurate and what they do not know is labelled. Never lets a claim go out that the evidence does not support. |

### 7. Judgment, collaboration and leadership

| Level | Expectations |
|---|---|
| L1 | Learns from review. Asks the buddy before guessing about a critical contract. Takes feedback without defensiveness. |
| L2 | Understands the customer problem behind a ticket and flags when the ticket and the need differ. Helps a newer colleague unblock. Contributes to docs when they find them wrong (the onboarding page asks for exactly this). |
| L3 | Mentors L1 and L2 through real work, not only advice. Makes the team's reviews faster and better. Weighs product value against engineering cost and says which side they are on, and why. |
| L4 | Grows seniors. Builds shared ownership of a system so it does not depend on one person. Handles conflict between teams or priorities and resolves it with evidence. Influences without relying on title. |
| L5 | Shapes the engineering culture and the way the company hires, learns and decides. Leaves behind people and systems that run well without them. |

## Behaviours that cap a level

These are not about seniority. At any level, repeated occurrences hold a person at their current level until they change, because customers carry the risk.

- Claiming a check passed, or a migration ran, when it was not run.
- Using `user.id` instead of the account owner id, or shipping a table without RLS and a cross-tenant test.
- Weakening a security control, a test or a coverage threshold to make a change pass.
- Stating an unverified vendor, legal or compliance fact as if it were established.
- Changing unrelated files or product behaviour inside a bug fix.
- Hiding a mistake instead of reporting it quickly.

## Using this in practice

- **Self-assessment:** the engineer picks, for each dimension, the row that best describes their last six months and attaches one or two pieces of evidence. The manager does the same independently, and they compare. The gaps are the conversation.
- **Hiring:** the same rows describe what to look for at each level. They are a guide to questions, not a pass mark.
- **Growth plans:** pick one or two dimensions at a time. Growth in tenancy and production safety usually comes first at every level.
- **Review of this document:** revisit it when the product or the team changes, and whenever someone finds a row that does not match how good work here actually looks.

## What this document does not decide

These need an owner and a decision, and some need counsel **[COUNSEL]**:

- Titles, pay bands, equity and how levels map to them.
- The promotion process: who decides, how often, how it is calibrated across managers, what the appeal path is.
- How these expectations are used in performance management, and the legal limits on doing so in each country where people work.
- A management track and its expectations.
- On-call expectations. The repository defines no on-call roster, paging tool or SLA targets (`RUNBOOK.md` section 8, item 11), so none are assumed here.
- Whether apprenticeship-style programmes (for example the technician apprenticeship in `src/lib/technicianApprenticeship.ts`) share this framework. They are a different job family and are not covered.
