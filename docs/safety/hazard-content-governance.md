# Hazard content governance

Scope: guidance about **gas, carbon monoxide (CO), electrical and refrigerant** hazards that Vireek shows to people or feeds to an AI model, in diagnostic content and AI prompts.
Status: engineering control. It proves that a named person reviewed a text and that the review is still current. It does **not** prove the text is correct, compliant or sufficient. Who may review, to which standard, and how often is a business decision. **[COUNSEL]**

## 1. What was checked

| Area | Verified by | Result |
|---|---|---|
| Code-resident prompts and content | `npm run safety:hazard:check` finds prompt-like files that mention a hazard word | 24 discovered files; 26 registered inventory items; 14 files acknowledged as not hazard guidance, each with a reason |
| Database-resident content | read `vertical_ontology_entries`, `diag_hypotheses`, `diag_questions` migrations | ontology already had `reviewed`, `reviewed_by`, `reviewed_at`, `version`, `expires_on`; diagnostic tables had none |
| Existing enforcement | read `grounding.ts`, `ontology.ts`, `runtime.ts` | unreviewed content was only *hedged* ("uncertain"), never blocked |

Findings that drove the design:

1. No row of any kind had a reviewer identity, a review expiry or a qualification. Today **0 of 26** inventory items and **0 of 43** bundled ontology rows have a review.
2. The bundled ontology (`ONTOLOGY_SEED`) has 15 instructional symptom and permit rows that mention a hazard domain.
3. Hazard detectors exist in seven independent places (voice rules, voice fast path, remote resolution, adaptive diagnostic, DIY policy, mass-incident classes, call scripts). They are floor content (section 2) and are inventoried so that a change to one is visible.

## 2. Tiers (what blocking means)

| Tier | Examples | Unreviewed or expired |
|---|---|---|
| `floor` | "leave the building, call 911", the deterministic detectors, owner alerts | **Never blocked.** Withholding an evacuation instruction because a review lapsed is more dangerous than speaking it. Reported as review backlog. |
| `guardrail` | prompt text that restricts a model near hazards ("never give gas steps") | **Never blocked at runtime** (removing a restriction is less safe). A change to the text without re-review fails CI. |
| `instructional` | diagnostic causes and checks, permit/code statements, call scripts, training scenarios that touch a hazard | **Blocked** from AI use and from publishing. |
| `none` | everything else | not affected |

A blocked row never produces silence about safety: the emergency path (`emergencyRules.ts`, `emergencyFastPath.ts`) does not depend on any instructional row.

## 3. Review record (the four required fields, plus two)

| Field | Ontology row | Diagnostic row | Code-resident text |
|---|---|---|---|
| reviewer (named human, 3+ chars) | `reviewed_by` | `reviewed_by` | `HAZARD_REVIEWS[id].reviewer` |
| review date | `reviewed_at` | `reviewed_at` | `reviewedOn` |
| expiry | `review_expires_on` | `review_expires_on` | `expiresOn` |
| version | `version` | `content_version` | `version` |
| reviewer qualification | `reviewer_qualification` | `reviewer_qualification` | `reviewerQualification` |
| text binding | new version = new row | `content_version` | `contentHash` (whitespace-insensitive) |

A review is **current** only when: reviewer and qualification are present, both dates are valid ISO dates, the review date is not in the future, expiry is after the review date and at most **366 days** later **[COUNSEL: proposed cadence]**, expiry has not passed, the reviewed version equals the content version, and (code-resident) the hash equals the current text. Anything malformed is `invalid`, never approved.

## 4. Enforcement points

| Point | Mechanism | Blocks |
|---|---|---|
| AI use of ontology rows | `applyHazardGate` in `vertical-ai/runtime.ts` (`gateEntriesForAi`), also on the bundled-seed fallback | unreviewed / expired instructional rows never reach the planner; the answer falls back to "a technician will confirm" and handoff |
| Publishing DB content | trigger `trg_hazard_publish_gate` on the three tables (migration `20290311000000`) | inserting or editing instructional hazard content without a current review raises `hazard_content_unreviewed`; domains are auto-filled from the text so a writer cannot under-declare |
| Publishing code-resident content | `safety:hazard:check` in CI | expired, invalid or stale reviews; new hazard-bearing prompt files that are not registered; stale acknowledgements |
| Release | `safety:hazard:check:strict` | any floor / guardrail / instructional item with no current review |

Staged rollout: set the edge secret `HAZARD_CONTENT_GATE=report` to log (`hazard_content_gate` events) instead of withholding. The default is **enforce**. Because no row is reviewed yet, enforce withholds the 15 instructional rows from AI answers until reviews are recorded.

## 5. Recording a review

Database content (service role only; logged in the append-only `hazard_content_review_log`):

```sql
select public.record_hazard_review('ontology', 'hvac:symptom:no_cooling', 1, '<Reviewer Name>', '<qualification, licence id>', date '<expiry, <= 366 days>', '<note>');
select public.record_hazard_review('diag_hypothesis', 'hvac_no_cooling:low_refrig', 1, '<Reviewer Name>', '<qualification>', date '<expiry>', null);
```

Code-resident text: run `npm run safety:hazard:check -- --print-hashes`, then add a record to `HAZARD_REVIEWS` in `supabase/functions/_shared/safety-governance/hazardRegistry.ts` with the printed hash. Never add a record for a review that did not happen. **[VERIFY]** each reviewer's qualification before recording it.

## 6. Verification status

| Check | Status |
|---|---|
| `test:safety:hazard` (governance logic, CI gate, fixtures for stale / expired / unregistered) | PASSED (executed) |
| `safety:hazard:check` on the repository | PASSED, 26 items in backlog |
| `safety:hazard:check:strict` | FAILED by design until reviews exist |
| Migration `20290311000000` and `supabase/tests/database/hazard_content_governance.test.sql` | NOT RUN (no Postgres in the authoring environment); repository migration lint PASSED |

## 7. Open items

- Assign an owner for each inventory row (`[OWNER: assign]`).
- Decide reviewer qualifications per domain and the review cadence. **[COUNSEL]**
- Review and record the 15 withheld ontology rows, the diagnostic catalog and the prompts, then run the strict gate.
- Jurisdiction-specific code and permit statements (`claim.permit-rules`) need legal review per jurisdiction. **[COUNSEL]**
