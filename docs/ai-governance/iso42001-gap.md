# ISO/IEC 42001 gap assessment (AI management system)

> **Status: INTERNAL DRAFT for the policy owner and counsel.** This is an engineering self-assessment of the repository snapshot dated in section 1. It is **not** a certification, an audit result, a conformity statement or an attestation. Vireek is **not** certified to ISO/IEC 42001 and nothing here may be quoted as a claim of conformity (`src/lib/trust/claims.ts`, `BRAND_GOVERNANCE.md`). Tags: **[VERIFY]** = interpretation or fact not confirmed against the standard text or a live system. **[COUNSEL]** = needs legal judgement. **[FILL]** = value only the owner can supply.

## 1. Basis and limits

| Item | Value |
| --- | --- |
| Snapshot | uploaded `vireek-main` archive (files dated up to 2026-11-16); may be older than the live repository |
| Assessment date | 2026-11-17 |
| Method | static read of repository files, plus two commands actually run in the assessment sandbox (section 5). No production system, vendor console or contract was accessed |
| Standard text | **Not available to the assessor** (paid publication). Clause numbers and area names below follow the published high-level structure (clauses 4-10, Annex A objectives A.2-A.10) as remembered by the assessor and are paraphrased, not quoted **[VERIFY against a licensed copy]** |
| Not assessed | operating effectiveness, production configuration, vendor contracts, any evidence outside the repo |

### Status legend (strict)

| Status | Meaning here |
| --- | --- |
| **Met** | An artifact exists, is not a placeholder, is enforced or evidenced by code/CI in this snapshot, and no contradicting evidence was found. Says nothing about operating effectiveness. |
| **Partial** | Something relevant exists (a draft policy, a tool, a table), but it is unapproved, unowned, unexercised, or covers only part of the area. |
| **Missing** | No artifact found in the repository for this area. |

Because every policy in the repo is a draft and no owners are assigned, **no area is rated Met**. That is a statement about evidence in the repo, not about the quality of the engineering.

## 2. Summary

| Status | Count |
| --- | --- |
| Met | 0 |
| Partial | 26 |
| Missing | 7 |
| **Total rows** | **33** |

Strongest repository evidence (still Partial): caller-facing AI disclosure with a proof ledger, voice red-team gates, AI incident register, kill switches, the AI call-site inventory tool. Weakest: management-system governance (scope, leadership, objectives, competence, management review, statement of applicability) and third-party terms.

## 3. Clause 4-10 (management system requirements)

| ID | Area (paraphrased) | Status | Evidence (repo paths) | Gap / next step |
| --- | --- | --- | --- | --- |
| 4.1 | Organization and its context for AI | Partial | `docs/compliance/dpia-voice-ai.md` (section 2), `docs/compliance/transfers-and-contracts.md` (section 1 roles), `docs/security/THREAT_MODEL.md` | No AI-specific context statement. Provider vs deployer role under AI regulation is open **[COUNSEL]** (`docs/ai-governance/ai-policy.md` section 8, item 2). |
| 4.2 | Interested parties and their requirements | Partial | `docs/compliance/dpia-voice-ai.md` (callers, customers), `docs/customer-advisory/charter.md`, `docs/compliance/voice-consent-and-ai-disclosure.md` (section 4) | No maintained list of interested parties with requirements and owners. |
| 4.3 | Scope of the AI management system | Partial | `docs/ai-governance/ai-policy.md` (section 1 defines "AI use" and scope) | That is a policy scope, not a management-system boundary with exclusions **[VERIFY interpretation]**. |
| 4.4 | Establishing and maintaining the management system | Missing | none (a repo-wide search found no mention of "42001" before this file) | No document set is designated as the AI management system. |
| 5.1 | Leadership and commitment | Missing | `docs/OWNERS.md` (owners "TBD"), `docs/compliance/soc2/controls.json` (GOV-01 `missing`) | Policy owner is `[OWNER: fill]` in `docs/ai-governance/ai-policy.md`. Needs a named accountable executive **[FILL]**. |
| 5.2 | AI policy | Partial | `docs/ai-governance/ai-policy.md` | Marked DRAFT, not adopted; approval date and owner empty. |
| 5.3 | Roles, responsibilities, authorities | Partial | `docs/ai-governance/ai-policy.md` (section 7), `docs/compliance/policies/ai-incident-response.md` (section 5) | Roles are defined, nobody is assigned. |
| 6.1.2 / 8.2 | AI risk assessment (criteria and process, repeated at intervals) | Partial | `docs/compliance/dpia-voice-ai.md` (section 4 risks, unscored), `docs/security/voice-threat-model.md`, `docs/compliance/policies/risk-assessment.md` (stub) | No scored AI risk register with owners and dates; control RSK-01 is `missing` in `docs/compliance/soc2/controls.json`. |
| 6.1.3 / 8.3 | AI risk treatment | Partial | `docs/compliance/dpia-voice-ai.md` (section 5 measures), `supabase/functions/_shared/ai-core/guardrails.ts`, `supabase/functions/_shared/ai-core/aiSecurity.ts` | Measures exist but are not tied to assessed risks in a treatment plan. |
| 6.1.3 (SoA) | Statement of applicability for Annex A controls | Missing | none | The standard expects a justified include/exclude decision per control **[VERIFY]**. This file is a first input, not that statement. |
| 6.1.4 / 8.4 | AI system impact assessment | Partial | `docs/compliance/dpia-voice-ai.md` (draft, sign-off section empty), `docs/ai-governance/fairness-audit.md`, `scripts/fairness/audit.mjs`, `supabase/tests/database/fairness_audit.test.sql` | Voice assistant only; no per-system impact assessment procedure; fairness audit has not been run on production data in the repo. |
| 6.2 | AI objectives and plans to achieve them | Partial | `docs/security/voice-redteam-playbook.md` (gates: zero critical-class successes, false-refusal cap), `.github/workflows/ai-regression.yml`, `docs/SLO.md` | Gates exist as engineering thresholds; no management-approved AI objectives. |
| 6.3 | Planning of changes to the system | Partial | `docs/compliance/policies/change-management.md` (draft), `docs/RELEASE_SAFETY.md`, `docs/FEATURE_FLAGS.md` | Not AI-specific; policy unapproved. |
| 7.1 | Resources | Missing | none | No statement of resources for the AI programme; owners unassigned. |
| 7.2 | Competence | Missing | `docs/compliance/soc2/controls.json` (GOV-02 `missing`) | No AI competence requirements or training records. |
| 7.3 | Awareness | Missing | same as 7.2 | No awareness programme. |
| 7.4 | Communication (internal and external) | Partial | `docs/incident/incident-management.md` (status page), `docs/customer-advisory/charter.md`, `src/lib/subprocessors.ts` | No AI communication plan; sub-processor list is incomplete (see A.10). |
| 7.5 | Documented information | Partial | `docs/compliance/policies/README.md` (draft set), `docs/claims-register.json` (empty `claims`) | No document-control procedure; the generated AI register file is absent (section 5). |
| 8.1 | Operational planning and control | Partial | `scripts/check-agent-governance.mjs`, `scripts/check-direct-llm-calls.mjs`, `supabase/functions/_shared/ai-core/guardrails.ts` | Both ratchet scripts exist but are **not wired into any workflow** in `.github/` (grep found no reference); `ci.yml` has an invalid step block (section 5). |
| 9.1 | Monitoring, measurement, analysis, evaluation | Partial | `supabase/functions/ai-eval-run/index.ts`, `.github/workflows/ai-regression.yml`, `.github/workflows/voice-redteam.yml`, `eval/voice-redteam/scenarios.ts`, `docs/runbooks/voice-observability.md`, `.github/workflows/compliance-evidence.yml` | Per `docs/compliance/soc2/READINESS_REPORT.md` the evidence pipeline has collected 0 records. |
| 9.2 | Internal audit | Partial | `docs/compliance/internal-audit-program.md` | Program design only; the doc states no cycle is planned or run. Scope is SOC 2 controls, not AI. |
| 9.3 | Management review | Missing | `docs/compliance/internal-audit-program.md` (states none held) | No review held, no inputs/outputs defined for AI. |
| 10.1 | Continual improvement | Partial | `docs/incident/incident-management.md` (quarterly review), `docs/ai-governance/ai-policy.md` (section 5 cadence) | Cadence is proposed, not operating. |
| 10.2 | Nonconformity and corrective action | Partial | `docs/compliance/policies/ai-incident-response.md`, `supabase/migrations/20290304000000_ai_incidents.sql`, `src/pages/admin/StaffAiIncidentsPage.tsx`, `supabase/tests/database/ai_incidents.test.sql`, `docs/runbooks/post-incident-template.md`, `docs/security/voice-incident-response.md` | Policy is a draft; no exercise recorded (control INC-01 is `partial`). |

## 4. Annex A (control objectives, area level)

| ID | Objective area (paraphrased) | Status | Evidence (repo paths) | Gap / next step |
| --- | --- | --- | --- | --- |
| A.2 | Policies related to AI | Partial | `docs/ai-governance/ai-policy.md`, `docs/compliance/policies/README.md` | Unapproved; alignment with other policies not documented. |
| A.3 | Internal organization (roles, reporting concerns) | Partial | `docs/compliance/policies/ai-incident-response.md` (section 5), `docs/security/voice-incident-response.md` | No documented internal channel for staff to raise AI concerns; public channel exists (COM-02 `met` in `docs/compliance/soc2/controls.json`). |
| A.4 | Resources for AI systems (documentation, data, tooling, compute, people) | Partial | `docs/voice/PROVIDER_COUPLING.md`, `docs/vendor-exit/vapi.md`, `supabase/functions/_shared/ai-core/costTracking.ts` | Generated register absent; people/competence missing (7.2). |
| A.5 | Assessing impacts of AI systems | Partial | same as row 6.1.4 / 8.4 | Same gap. |
| A.6 | AI system life cycle (requirements, verification, deployment, operation, change, logging) | Partial | `supabase/functions/_shared/ai-core/evalHarness.ts`, `.github/workflows/voice-redteam.yml`, `docs/RELEASE_SAFETY.md`, `docs/SHADOW_MODE.md`, `supabase/functions/ai-disclosure-drift-scan/index.ts` | No per-system lifecycle document with requirements and acceptance criteria. |
| A.7 | Data for AI systems (acquisition, quality, provenance) | Partial | `docs/compliance/data-map.md`, `docs/compliance/transfers-and-contracts.md` (section 4 retention is PROPOSED), `supabase/functions/_shared/ai-transparency/gate.ts` | No data-quality or provenance requirements for model inputs. Vendor no-training terms unverified **[VERIFY]**. |
| A.8 | Information for interested parties (disclosure, system information, incident communication) | Partial | `supabase/migrations/20271112000000_ai_disclosure_proof_ledger.sql`, `src/pages/AiDisclosureLedgerPage.tsx`, `supabase/functions/ai-disclosure-drift-scan/index.ts`, `docs/compliance/policies/ai-incident-response.md` (section 6) | Disclosure wording and notification clocks need legal review **[COUNSEL]**; recording notice is not part of the disclosure text (see `docs/compliance/call-recording-vendor-capability.md`). |
| A.9 | Use of AI systems (responsible use, oversight) | Partial | `docs/ai-governance/ai-policy.md` (sections 3-4), `scripts/check-agent-governance.mjs`, `docs/RELEASE_SAFETY.md` (kill switches), `.github/workflows/kill-switch-drill.yml` | Policy unapproved; kill-switch scope per AI feature unverified **[VERIFY]** (`docs/ai-governance/ai-policy.md` section 8, item 4). |
| A.10 | Third-party and customer relationships | Partial | `docs/compliance/policies/vendor-management.md` (stub with open gaps), `docs/vendor-exit/README.md`, `docs/compliance/data-map.md` (section 3), `docs/compliance/call-recording-vendor-capability.md` | No vendor contract or data-use term is verified in the repo; Anthropic, Cohere, ElevenLabs and Twilio are called from code but absent from the public sub-processor list (`docs/compliance/data-map.md`). |

## 5. What was actually run (sandbox, 2026-11-17)

| Command | Result |
| --- | --- |
| `node scripts/ai-governance/inventory.mjs --check` | **FAILED**: `docs/ai-governance/ai-system-register.md is missing`. CI step `npm run ai-governance:check` (`.github/workflows/ci.yml`) would fail on this snapshot. |
| `node scripts/ai-governance/inventory.mjs --json` | 149 AI call sites detected: 65 gateway, 65 direct-provider, 10 provider-adapter, 9 browser-speech. The register that should list them is not in the snapshot. |

Other observations made while reading (not fixed here, unrelated files): `.github/workflows/ci.yml` contains a step block with a repeated `run` key and a mis-indented step, so the workflow may not parse **[VERIFY by running the workflow]**; `supabase/migrations/20261121000000_disaster_recovery_data_governance.sql` and `supabase/migrations/20280302000000_consent_records.sql` both `CREATE TABLE IF NOT EXISTS public.consent_records` with different column sets, so on a fresh database the second definition is skipped and its indexes/functions may error **[VERIFY against the live schema]**.

## 6. Referenced by repository docs but absent from this snapshot

These paths are mentioned in other documents and do not exist here. They are deliberately not cited as evidence above.

- `docs/ai-governance/ai-system-register.md`
- `docs/generated/INTEGRATIONS.md`
- `scripts/direct-llm-baseline.json`
- `eval/voice-redteam/history.jsonl`

## 7. Suggested order of work (owner decides)

1. Run `node scripts/ai-governance/inventory.mjs`, review rows, fill owners and review dates, commit the register (unblocks the CI step). Risk classes stay `[COUNSEL]`.
2. Name the policy owner and an accountable executive **[FILL]**; adopt or revise `docs/ai-governance/ai-policy.md`.
3. Wire `check:agent-governance` and `check:direct-llm` into CI; repair `ci.yml`.
4. Write a one-page AI management-system scope and an interested-parties list (4.1-4.4).
5. Score the DPIA risks and create the AI risk register with treatment owners (6.1.2, 6.1.3); draft a statement of applicability using section 4 as a starting point.
6. Hold a first management review with documented inputs and outputs (9.3); run one incident exercise (10.2).
7. Verify vendor data-use terms with `docs/compliance/call-recording-vendor-capability.md` (A.10).
