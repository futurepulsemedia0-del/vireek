# Internal audit program

> **PROGRAM DESIGN — DRAFT, NOT APPROVED.** This document describes how Vireek *would* run an internal audit. **No internal audit cycle has been planned, started or completed. No audit report, attestation, certification or opinion exists.** Nothing here is a statement of compliance with SOC 2 or any other framework, and it must not be quoted as one. Owners are proposed roles; no person has been assigned. Tags: **[COUNSEL]** legal or contractual question · **[VERIFY]** fact to confirm outside the repository · **[FILL]** owner-supplied value.

Basis: control registry `docs/compliance/soc2/controls.json` (basis date 2026-11-02, 31 controls), map `docs/compliance/soc2/CONTROL_MAP.md`, narrative `docs/compliance/SOC2_READINESS.md`. The registry is the source of truth for control ids; this program follows it (a test fails if they drift). Supports control MON-01 (CC4.1, CC4.2).

## 1. Purpose, authority, independence

1. **Purpose:** give management evidence-based, repeatable assurance on whether the controls in the registry are designed as described and operating, and surface gaps before a customer, auditor or incident does.
2. **Authority:** management must approve this program, name an accountable program owner and a reviewer, and grant read access to repositories, provider consoles and the evidence store [FILL].
3. **Independence:** a control owner never tests their own control. With a small team, use a peer from another function or an external reviewer for any control the program owner operates. State the residual self-review risk in the report instead of hiding it.
4. **Limits:** an internal audit is not an independent attestation. Repository evidence proves the state of files at a commit (see header of `scripts/compliance/collect-repo.mjs`); it does not prove production configuration or operating effectiveness.

## 2. Annual plan

Cycle year = calendar year. Every control is tested at least once per year; controls with an evidence frequency of 8 days or less are also watched continuously by the scheduled collector run (`.github/workflows/compliance-evidence.yml`). Controls rated `missing` or `partial` in the registry are tested in the earlier half of a quarter slot; a `missing` control is tested for design only (is there anything to operate?).

| Quarter | Focus | Controls (registry ids) | Also this quarter |
|---|---|---|---|
| Q1 | Governance, risk, communication, vendors | GOV-01, GOV-02, GOV-03, COM-01, COM-02, RSK-01, MON-01, VND-01, PHY-01 | Vendor-exit drill (tier 1), Q1 management review, approve the year plan |
| Q2 | Access, boundary, logging | ACC-01, ACC-02, ACC-03, ACC-04, ACC-05, ACC-06, ENV-01, LOG-01, LOG-02 | Vendor-exit drill, Q2 management review |
| Q3 | Change, development, availability | SDL-01, SDL-02, SDL-03, SDL-04, AVL-01, AVL-02, AVL-03, AVL-04 | Restore drill witnessed, vendor-exit drill, Q3 management review |
| Q4 | Incidents, confidentiality, independent testing | INC-01, INC-02, CON-01, CON-02, PEN-01 | Vendor-exit drill, annual management review, next-year plan |

Cycle status (update only with real events):

| Year | Plan approved | Fieldwork | Report issued | Management review held |
|---|---|---|---|---|
| — | not started | not started | none exists | none held |

## 3. Scope per control area

"Evidence" lists existing tooling to reuse; run commands from the repository root. Collector ids are defined in `scripts/compliance/lib.mjs`.

| Area | Controls | What the auditor examines | Procedures | Evidence and scripts |
|---|---|---|---|---|
| Governance and policy | GOV-01, GOV-02, GOV-03 | Approved policies, onboarding/offboarding, training, documentation upkeep | Inspect approval records; confirm each policy in `docs/compliance/policies/` has owner, version and approval; sample leavers for revoked access | `repo.docs`, `manual.policy_approval`, `manual.training` |
| Communication | COM-01, COM-02 | Customer commitments, sub-processor notices, vulnerability-disclosure channel | Compare published trust pages with the claims register; check security.txt validity and expiry | `repo.security_txt`; `node scripts/compliance/gen-subprocessors-by-region.mjs --check`; `npm run claims:check` |
| Risk and monitoring | RSK-01, MON-01 | Risk register, this program, control registry health | Inspect register and its annual review; run registry validation; confirm someone reviews the dashboard `src/pages/admin/StaffComplianceControlsPage.tsx` on a cadence | `npm run compliance:check`, `repo.registry`, `manual.risk_assessment` |
| Access and boundary | ACC-01, ACC-02, ACC-03, ACC-04, ACC-05, ACC-06 | Tenant isolation, MFA, provisioning and access reviews, privileged flags, headers, secrets | Re-run RLS coverage; reperform one access review; test the privileged-flag trigger in a non-production database; confirm secret scanning results | `supabase.rls_coverage`, `supabase.access_review`, `manual.access_review_signoff`, `repo.headers`, `github.secret_scanning`; `docs/security/rls-audit.md` |
| Change and development | SDL-01, SDL-02, SDL-03, SDL-04, ENV-01 | Scanning, review and branch protection, CI gates, migration discipline, environment separation | Sample merged changes for independent review; inspect branch protection; confirm CI gates ran on the sampled changes | `github.branch_protection`, `github.pull_requests`, `github.workflow_runs`, `github.code_scanning`, `github.dependabot`, `repo.change_config`, `repo.migrations` |
| Logging and monitoring | LOG-01, LOG-02 | Audit trail and its tenant scoping, error and security-event monitoring | Sample audit-log entries to source events; confirm alert routing reaches a human | `supabase.audit_summary`; `docs/privacy/read-access-logging.md` |
| Incident management | INC-01, INC-02 | Response procedure, named roles, exercises, status page | Inspect the latest exercise record; sample incidents for timeline and communication | `manual.tabletop`, `supabase.incidents`; `docs/runbooks/incident-response.md` |
| Availability and recovery | AVL-01, AVL-02, AVL-03, AVL-04 | Probes and SLOs, backups, restore drills with measured recovery time, continuity plan | Witness a restore drill; recompute recovery time from the recorded run; confirm RTO/RPO targets are defined | `supabase.slo`, `supabase.backups`, `supabase.restore_drills`, `manual.policy_approval`; `docs/DB_BACKUP_RESTORE.md` |
| Confidentiality and privacy lifecycle | CON-01, CON-02 | Data classification, retention, erasure coverage | Compare data map with live tables; sample erasure requests end to end | `supabase.retention`; `node scripts/compliance/check-erasure-coverage.mjs --check`; `docs/compliance/data-map.md` |
| Vendors and third parties | VND-01, PHY-01 | Vendor inventory, sub-processor list, vendor reviews, exit readiness | Reconcile providers in code with the published list; sample vendors for review evidence; read the latest exit-drill records | `manual.vendor_review`; `node scripts/compliance/gen-vendor-exit.mjs --check`; `docs/vendor-exit/QUARTERLY_DRILL_CHECKLIST.md`; `docs/integrations/providers/OWNER_REGISTER.md` |
| Independent testing | PEN-01 | Third-party penetration test, remediation | Inspect report and remediation tracking; never treat an internal review as a pen test | `manual.pentest`; `docs/compliance/soc2/PENTEST_SCOPE.md` |

## 4. Evidence sampling method

**Population.** For each control and period, the population is every evidence envelope for that control's collectors in the period (evidence store, or `evidence-out` from `node scripts/compliance/evidence.mjs collect --out evidence-out`). For manual controls it is every recorded attestation. Record the population size and how it was obtained.

**Sample sizes (proposed; management approves).**

| Control evidence frequency | Examine |
|---|---|
| 365 days (annual) | the latest instance and the previous one if it exists |
| 90 days | 2 of the last 4, or all if fewer exist |
| 30 days | 3 of the last 12, or all if fewer exist |
| 8 days or less | 5 of the last 52 weeks, or all if fewer exist |
| any | **100%** of `fail`, `error` and `blocked` envelopes in the period |

**Selection.** Random selection with a recorded seed (for example the audit start date), the sorted population list and the selected items stored in the working papers so another person can repeat it. Judgemental additions (a known weak month) are labelled as such.

**Evaluation rules.**
- An empty population is a finding ("control not evidenced"), never a pass.
- `blocked` means the collector could not run; it is not a pass and is followed up (for example a missing token).
- Evidence older than the control's frequency window is stale and cannot support a conclusion for the current period.
- Reperform wherever possible (rerun the script or query, compare results) instead of only reading a stored result.
- Each conclusion cites the envelope id or hash, collection time and who reviewed it. Never paste secret values into working papers.

## 5. Procedure for a cycle

1. **Prepare:** confirm scope and period; run `npm run compliance:check`; run the collectors; export the control map; agree the auditor is independent of the controls tested (section 1).
2. **Test design:** read the control description and its `gap` text in the registry; decide inquire / inspect / observe / reperform per control.
3. **Test operation:** sample per section 4; record exceptions with evidence references.
4. **Conclude per control:** *no exceptions noted*, *exceptions noted*, *design gap*, *not evidenced*, or *not tested* (with reason). These are internal working conclusions, not an opinion.
5. **Report findings** using section 6; agree management responses; set due dates.
6. **Follow up:** retest remediated findings before closing them; carry open findings into the next management review.

## 6. Finding template

```
Finding id:        IA-<year>-<nn>
Control id(s):     <registry id>            Criteria: <from registry>
Title:             <one line>
Severity:          Critical | High | Medium | Low   (see below)
Condition:         what was found (facts, counts, dates)
Expected:          what the control or policy requires
Cause:             why it happened (if known; else "unknown")
Effect/risk:       what could go wrong
Evidence:          envelope ids/hashes, commands run, files, dates; never secret values
Recommendation:    specific action
Management response / owner / due date:   [FILL]
Status:            Open | In progress | Remediated (awaiting retest) | Closed (retest evidence: <ref>) | Risk accepted (by whom, until when)
```

Severity (proposed): **Critical** — active exposure or missing control with likely customer-data impact; **High** — control not operating or tenant-isolation / authentication weakness; **Medium** — partial operation or stale evidence; **Low** — documentation or hygiene. Target remediation windows are for management to set [FILL].

Findings register (add only real findings):

| Id | Control | Severity | Owner | Due | Status |
|---|---|---|---|---|---|
| — | — | — | — | — | none recorded |

## 7. Management review agenda

**Quarterly (60–90 minutes).** Inputs are circulated in advance.
1. Minutes and actions from the previous review.
2. Control dashboard and evidence health (`src/pages/admin/StaffComplianceControlsPage.tsx`): failing, blocked and stale evidence.
3. Findings register: new, overdue, closed, risk-accepted.
4. Vendor exit drills held this quarter and their results (`docs/vendor-exit/`); contract or sub-processor changes [COUNSEL].
5. Incidents and near misses; status-page history.
6. Risk register changes; new threats (`docs/security/THREAT_MODEL.md`).
7. Backup and restore drill results and recovery-time trend.
8. Access review outcome; leavers and privileged accounts.
9. Public claims check: any external statement that needs updating (`docs/claims-register.json`, `src/lib/trust/claims.ts`).
10. Decisions, owners, due dates; resource needs.

**Annual (adds):** approve next year's plan and sample sizes; review program effectiveness and independence; review policy set and owners; confirm the independent penetration test and its remediation; decide which `missing` controls get investment.

Minutes record attendees, decisions and actions; store them where records are kept and register the pointer with `node scripts/compliance/evidence.mjs manual --collector manual.policy_approval ...` when a policy decision is made.

## 8. What may and may not be said about this program

- Allowed: "An internal audit program is documented; the first cycle has not started" — only while true. Update to the facts the day they change.
- Not allowed: that an audit, review or assessment "was completed", "passed", or "found no issues"; that Vireek "is audited", "certified" or "compliant"; any use of an auditor's or standards body's name or logo; marketing copy derived from this document without passing `npm run claims:check` and counsel review [COUNSEL].
- A finding-free conclusion in working papers is an internal note and must say who tested what, when, and with which evidence.

## 9. Pre-cycle items observed in the repository snapshot reviewed on 2026-11-15

Re-run the commands to confirm; the live repository may differ from the snapshot.

1. `npm run compliance:check` exited with an error in the snapshot: 11 registry entries reference files that are not present, and three controls have no automated collector (ENV-01, LOG-02, CON-01). Resolve before the first cycle, because the program relies on a valid registry.
2. Registry status at the basis date: 7 met, 19 partial, 5 missing (`docs/compliance/soc2/CONTROL_MAP.md`). "Met" never means audited.
3. No named owners, no recorded access review, no restore-drill evidence, no recorded tabletop, no risk register, no penetration-test report (registry `gap` texts).
4. No internal audit cycle has ever been recorded.

**Referenced by the registry but not present in the snapshot** (policy drafts live under `docs/compliance/policies/`): `docs/compliance/soc2/policies/01-information-security-policy.md`, `docs/compliance/soc2/policies/04-incident-response-policy.md`, `docs/compliance/soc2/policies/05-business-continuity-dr-policy.md`, `docs/compliance/soc2/policies/06-vendor-management-policy.md`, `docs/compliance/soc2/policies/07-data-retention-disposal-policy.md`, `docs/compliance/soc2/policies/10-risk-assessment-policy.md`, `docs/compliance/soc2/policies/11-onboarding-offboarding-policy.md`, `docs/compliance/soc2/templates/training-records.csv`, `docs/compliance/soc2/templates/access-review-signoff.md`, `docs/compliance/soc2/templates/vendor-review-register.csv`.

## 10. Records

Working papers, evidence exports and minutes are kept at [FILL: location]; retention period [COUNSEL]. Evidence envelopes are hashed pointers; do not store customer personal data or secrets in working papers.
