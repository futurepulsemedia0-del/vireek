# Policy set (drafts)

> All policies are **drafts for owner approval**. None is evidence of compliance. Control mapping: `../SOC2_READINESS.md`.

| Policy | File |
|---|---|
| Information Security Policy | `information-security.md` |
| Access Control & Review Policy | `access-control.md` |
| Change Management Policy | `change-management.md` |
| Incident Response Policy | `incident-response.md` |
| AI Incident Response Policy (extends the above) | `ai-incident-response.md` |
| Backup & Disaster Recovery Policy | `backup-disaster-recovery.md` |
| Vendor & Sub-processor Management Policy | `vendor-management.md` |
| Risk Assessment Policy | `risk-assessment.md` |
| Data Classification & Retention Policy | `data-classification-retention.md` |
| Logging & Monitoring Policy | `logging-monitoring.md` |
| Secrets & Key Rotation Policy | `secrets-key-rotation.md` |
| Acceptable Use Policy (internal) | `acceptable-use.md` |
| Business Continuity Policy | `business-continuity.md` |
| Vulnerability Management Policy | `vulnerability-management.md` |
| Onboarding & Offboarding Policy | `onboarding-offboarding.md` |
| Security Awareness Training Policy | `security-training.md` |

## Approval workflow

A policy file is a draft until a named person approves a specific version of its text. Tracking lives in the staff page `/staff/compliance-policies` (see below) and the tables `compliance_policies`, `compliance_policy_versions` and `compliance_policy_acknowledgements`.

1. Edit the policy file and merge as usual. CI (`evidence.mjs sync-policies`) stores a SHA-256 of the normalised text; the policy then shows as not approved or "text changed since approval".
2. A staff member submits a version number (for example `1.0`) at `/staff/compliance-policies`. The submission is bound to the hash CI last saw.
3. An approver approves it with an effective date. The next review date is effective date plus the policy's review period (default 365 days). If the approver is also the submitter it is recorded as **self-approval** and is never counted as independent review.
4. If the file changes after approval the approval no longer matches and the policy shows "text changed since approval" until a new version is approved.
5. Each active staff member acknowledges the approved version for themselves; there is no acknowledge-on-behalf. Pending acknowledgements are counted per policy.

Approval records show who approved which text and when. They do not show that a policy is followed, and they are not a SOC 2 report or certification. Legal wording in any policy remains **[COUNSEL]**.
