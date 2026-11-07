# Vireek — SOC 2 Control Map (generated)

> **DRAFT — generated from `docs/compliance/soc2/controls.json`. Do not edit by hand.**  
> Regenerate with `node scripts/compliance/validate-controls.mjs --write`.  
> **This is not a statement of compliance.** Vireek holds no SOC 2 report. "Met" means "implemented in the repository and an automated evidence collector exists" — it does not mean audited or operating effectively.

Registry version: `2026-11-02` · Basis date: `2026-11-02`

**Summary:** 7 Met · 19 Partial · 5 Missing · 31 controls

Owners are **proposed roles**. No person has been assigned; management must name owners before an auditor engagement.

## Security

| ID | Criteria | Control | Status | Proposed owner | Repo evidence of implementation | Evidence collectors | Gap / unverified |
|---|---|---|---|---|---|---|---|
| GOV-01 | CC1.1, CC1.3, CC5.3 | Information security policy set approved and communicated | 🔴 Missing | CEO / accountable security owner (proposed) | `docs/compliance/soc2/policies/01-information-security-policy.md` | `repo.docs`<br>`manual.policy_approval` | All eleven policies are DRAFTS. None is approved, versioned by management, or acknowledged by staff. |
| GOV-02 | CC1.4, CC1.5, CC2.2 | Workforce onboarding, offboarding, background checks and security-awareness training | 🔴 Missing | CEO / People owner (proposed) | `docs/compliance/soc2/policies/11-onboarding-offboarding-policy.md`<br>`docs/compliance/soc2/templates/training-records.csv` | `manual.training` | No training records, no offboarding checklist for GitHub / Vercel / Supabase / provider consoles. |
| GOV-03 | CC2.1, CC2.2 | Security documentation available to internal and external users | 🟡 Partial | Engineering lead (proposed) | `RUNBOOK.md`<br>`ARCHITECTURE.md`<br>`src/lib/securityWhitepaper.ts`<br>`src/pages/SecurityWhitepaperPage.tsx` | `repo.docs` | Documentation exists but has no review cadence or named maintainer. |
| COM-01 | CC2.3 | Security commitments and incidents communicated to customers | 🟡 Partial | CEO (proposed) | `src/pages/TrustCenterPage.tsx`<br>`src/pages/ComplianceStatusPage.tsx`<br>`src/pages/SubprocessorsPage.tsx`<br>`supabase/functions/subprocessor-notice-dispatch/index.ts`<br>`supabase/functions/notify-status-subscribers/index.ts` | `repo.docs` | No breach-notification template or timeline. |
| COM-02 | CC2.3, CC7.1 | Public vulnerability-disclosure channel (security.txt + policy page) | 🟢 Met | Engineering lead (proposed) | `public/.well-known/security.txt`<br>`src/pages/VulnerabilityDisclosurePage.tsx` | `repo.security_txt` | security.txt carries an expiry date; evidence turns 'failing' when it is within 30 days of expiry or already expired. |
| RSK-01 | CC3.1, CC3.2, CC3.3, CC3.4 | Annual risk assessment and risk register | 🔴 Missing | CEO / security owner (proposed) | `docs/compliance/soc2/policies/10-risk-assessment-policy.md` | `manual.risk_assessment` | No risk register exists. |
| MON-01 | CC4.1, CC4.2 | Ongoing evaluation of controls (this program) | 🟡 Partial | Security owner (proposed) | `docs/compliance/soc2/controls.json`<br>`scripts/compliance/validate-controls.mjs`<br>`scripts/compliance/collect-repo.mjs`<br>`.github/workflows/compliance-evidence.yml`<br>`supabase/functions/compliance-evidence/index.ts`<br>`src/pages/admin/StaffComplianceControlsPage.tsx` | `repo.registry` | Program is new: no scheduled run has produced evidence yet, and no owner reviews the dashboard on a cadence. |
| ACC-01 | CC6.1 | Tenant data isolation enforced by Postgres row-level security | 🟢 Met | Engineering lead (proposed) | `supabase/migrations/20260821101104_create_profiles_and_team_members.sql`<br>`scripts/lint-migrations.mjs`<br>`supabase/tests/database/calendar_feeds_rls.test.sql` | `supabase.rls_coverage` | Evidence reports public tables without RLS and permissive USING(true) SELECT policies; any listed table needs a documented reason or a fix (see SOC2_READINESS.md F3). |
| ACC-02 | CC6.1, CC6.2 | Authentication and multi-factor authentication | 🟡 Partial | Engineering lead (proposed) | `src/components/ProtectedRoute.tsx`<br>`src/lib/mfaChallenge.ts`<br>`supabase/functions/trusted-device/index.ts` | `supabase.access_review` | MFA is opt-in; it is not enforced for Vireek staff or tenant owners/admins. Evidence lists staff accounts without a verified MFA factor. |
| ACC-03 | CC6.2, CC6.3 | Provisioning, deprovisioning and role-based access (SCIM / SSO / RBAC) with periodic access review | 🟡 Partial | Security owner (proposed) | `supabase/functions/scim-v2/index.ts`<br>`supabase/functions/admin-sso/index.ts`<br>`supabase/migrations/20261103000000_enterprise_identity_security.sql`<br>`src/components/StaffRoute.tsx`<br>`docs/compliance/soc2/templates/access-review-signoff.md` | `supabase.access_review`<br>`manual.access_review_signoff` | No quarterly access-review sign-off has been performed; provider consoles (GitHub, Vercel, Supabase, Stripe, Twilio, Vapi) are outside the automated export. |
| ACC-04 | CC6.1, CC6.3 | Privileged flag (profiles.is_staff) cannot be changed from the client | 🟢 Met | Engineering lead (proposed) | `supabase/migrations/20270411000000_protect_profiles_is_staff.sql` | `supabase.access_review` | Other privileged columns (role, plan, billing state) are not covered by the same trigger (SOC2_READINESS.md F6). |
| ACC-05 | CC6.6, CC6.7 | Boundary protection: security headers, IP allow-lists, session policy | 🟡 Partial | Engineering lead (proposed) | `vercel.json`<br>`supabase/functions/check-ip-policy/index.ts`<br>`src/lib/enterpriseSecurity.ts`<br>`.github/workflows/vercel-preview-smoke.yml` | `repo.headers` | IP allow-lists and session policies apply to enterprise accounts only; TLS termination is inherited from the hosting providers. |
| ACC-06 | CC6.1, CC6.8 | Secret handling and secret scanning | 🟡 Partial | Engineering lead (proposed) | `.gitleaks.toml`<br>`.github/workflows/security.yml`<br>`RUNBOOK.md` | `github.secret_scanning`<br>`github.workflow_runs` | No rotation cadence defined (RUNBOOK section 7 says 'decide'). GitHub secret-scanning alerts may be unavailable on the current plan; the collector reports that as 'blocked', never as 'pass'. |
| SDL-01 | CC7.1, CC8.1 | Automated vulnerability and dependency scanning (npm audit, CodeQL, gitleaks, Dependabot) | 🟢 Met | Engineering lead (proposed) | `.github/workflows/security.yml`<br>`.github/dependabot.yml`<br>`.gitleaks.toml` | `github.workflow_runs`<br>`github.code_scanning`<br>`github.dependabot` | Remediation SLAs exist only in the DRAFT vulnerability-management policy; evidence reports alerts older than those proposed thresholds. |
| SDL-02 | CC8.1 | Peer review and branch protection for production changes | 🟡 Partial | Engineering lead (proposed) | `CONTRIBUTING.md`<br>`.github/workflows/ci.yml` | `github.branch_protection`<br>`github.pull_requests`<br>`repo.change_config` | No CODEOWNERS file and no PR template in the repository. Branch protection and required reviews can only be proven from the GitHub API; evidence reports merged PRs without an independent approval. |
| SDL-03 | CC8.1, CC7.1 | Automated CI gates: lint, type-check, unit tests, build, migration lint, edge-function check | 🟢 Met | Engineering lead (proposed) | `.github/workflows/ci.yml`<br>`.github/workflows/quality-gates.yml`<br>`.github/workflows/edge-functions.yml`<br>`.github/workflows/migrations.yml`<br>`.github/workflows/database-tests.yml` | `github.workflow_runs` | Authenticated E2E specs are skipped in CI (no test credentials); migration clean-replay is non-blocking. |
| SDL-04 | CC8.1 | Database migration discipline (additive policy, destructive-SQL lint) | 🟡 Partial | Engineering lead (proposed) | `scripts/lint-migrations.mjs`<br>`.github/workflows/migrations.yml`<br>`docs/runbooks/migration-version-repair.md` | `repo.migrations` | Duplicate migration versions documented in RUNBOOK section 3.3. |
| ENV-01 | CC8.1, CC6.1 | Environment separation and no shared or demo credentials in production | 🟡 Partial | Engineering lead (proposed) | `supabase/migrations/20260821101216_seed_demo_data.sql`<br>`RUNBOOK.md` | — (verify outside repo) | A demo user with a known password is created by a migration (SOC2_READINESS.md F5). Whether it exists in production, and whether a separate staging project exists, must be verified outside the repository. |
| LOG-01 | CC7.2, CC4.1 | Application audit trail (audit_log) with tenant-scoped read access | 🟡 Partial | Engineering lead (proposed) | `supabase/migrations/20260831090000_notifications_and_audit_log.sql`<br>`supabase/migrations/20271215090000_audit_log_cross_tenant_guard.sql`<br>`src/pages/AuditLogPage.tsx`<br>`src/lib/auditLog.ts` | `supabase.audit_summary` | No immutability protection against the service role; log retention period is not defined. |
| LOG-02 | CC7.2 | Error and security-event monitoring | 🟡 Partial | Engineering lead (proposed) | `src/lib/sentry.ts`<br>`supabase/migrations/20280401000000_security_events.sql` | — (verify outside repo) | Sentry is active only when VITE_SENTRY_DSN is set in production (verify). No central log store or alert routing to a named on-call person. |
| INC-01 | CC7.3, CC7.4, CC7.5 | Incident response procedure with named roles and annual exercise | 🟡 Partial | CEO / incident commander (proposed) | `RUNBOOK.md`<br>`docs/compliance/soc2/policies/04-incident-response-policy.md` | `manual.tabletop` | Procedure exists in RUNBOOK section 6; no named incident commander, no tabletop exercise record, no breach-notification timeline. |
| INC-02 | CC7.4, CC2.3 | Public status page and subscriber notifications for incidents | 🟢 Met | Engineering lead (proposed) | `src/pages/StatusPage.tsx`<br>`supabase/functions/status-feed/index.ts`<br>`supabase/functions/notify-status-subscribers/index.ts` | `supabase.incidents` | Incident post-mortems are not stored in a structured register. |
| VND-01 | CC9.2 | Vendor inventory, sub-processor list and annual vendor review | 🟡 Partial | Security owner (proposed) | `src/lib/subprocessors.ts`<br>`src/pages/SubprocessorsPage.tsx`<br>`docs/compliance/soc2/policies/06-vendor-management-policy.md`<br>`docs/compliance/soc2/templates/vendor-review-register.csv` | `manual.vendor_review` | No vendor risk assessments or collected SOC 2 / ISO reports for Supabase, Vercel, Stripe, Twilio, Vapi, or AI providers. |
| PEN-01 | CC4.1, CC7.1 | Independent penetration test (annual, third party) | 🔴 Missing | CEO / security owner (proposed) | `docs/compliance/soc2/PENTEST_SCOPE.md`<br>`src/pages/StaffTrustAdminPage.tsx` | `manual.pentest` | No third-party penetration test has been performed. The page that publishes pentest summaries exists; no summary exists. |
| PHY-01 | CC6.4, CC6.5 | Physical and environmental security (inherited from hosting sub-service organizations) | 🟡 Partial | Security owner (proposed) | `docs/compliance/soc2/policies/06-vendor-management-policy.md` | `manual.vendor_review` | Vireek operates no data centers. Reliance on Supabase / Vercel requires their current attestation reports, which have not been collected. |

## Availability

| ID | Criteria | Control | Status | Proposed owner | Repo evidence of implementation | Evidence collectors | Gap / unverified |
|---|---|---|---|---|---|---|---|
| AVL-01 | A1.1 | Availability monitoring: synthetic probes and SLO evaluation | 🟢 Met | Engineering lead (proposed) | `supabase/functions/synthetic-probe/index.ts`<br>`supabase/functions/slo-evaluate/index.ts`<br>`supabase/migrations/20271102000000_synthetic_monitoring_slo.sql`<br>`docs/runbooks/synthetic-monitoring.md` | `supabase.slo` | Probe targets and the alert webhook must be configured in production (verify). Capacity planning is not documented. |
| AVL-02 | A1.2 | Scheduled logical backups to a private bucket with checksum | 🟡 Partial | Engineering lead (proposed) | `supabase/functions/dr-backup-run/index.ts`<br>`supabase/migrations/20261121000000_disaster_recovery_data_governance.sql` | `supabase.backups` | The scheduler, the private 'dr-backups' bucket and Supabase PITR/plan retention cannot be proven from the repository; the evidence shows only whether runs actually happened. |
| AVL-03 | A1.3, CC9.1 | Periodic restore drills with measured recovery time | 🟡 Partial | Engineering lead (proposed) | `supabase/functions/dr-restore-drill/index.ts`<br>`supabase/migrations/20261121000000_disaster_recovery_data_governance.sql` | `supabase.restore_drills` | RTO/RPO targets are not defined; no passed drill has been evidenced yet. platform_restore_drills / platform_backup_runs are readable by all authenticated tenants (SOC2_READINESS.md F3). |
| AVL-04 | A1.2, CC9.1 | Business continuity and disaster recovery plan with RTO/RPO | 🔴 Missing | CEO / Engineering lead (proposed) | `docs/compliance/soc2/policies/05-business-continuity-dr-policy.md` | `manual.policy_approval` | Policy is a draft; targets are proposals. |

## Confidentiality

| ID | Criteria | Control | Status | Proposed owner | Repo evidence of implementation | Evidence collectors | Gap / unverified |
|---|---|---|---|---|---|---|---|
| CON-01 | C1.1 | Identification and classification of confidential data (PII registry, AI PII modes) | 🟡 Partial | Security owner (proposed) | `src/lib/dataGovernance.ts`<br>`src/lib/aiSecurity.ts`<br>`supabase/migrations/20261121000000_disaster_recovery_data_governance.sql` | — (verify outside repo) | No approved data-classification policy; pii_field_registry must be kept current by hand. |
| CON-02 | C1.2 | Data retention, legal hold and secure disposal (retention sweep, erasure workflow) | 🟡 Partial | Security owner (proposed) | `supabase/functions/data-retention-sweep/index.ts`<br>`supabase/functions/delete-account/index.ts`<br>`supabase/migrations/20261121000000_disaster_recovery_data_governance.sql`<br>`docs/compliance/soc2/policies/07-data-retention-disposal-policy.md` | `supabase.retention` | Retention periods for platform logs, backups and evidence are not defined in an approved policy. |

## Criteria with no mapped control yet

`CC1.2`, `CC5.1`, `CC5.2`

These are real gaps in this map, not omissions to hide: each needs a control, a policy decision, or a documented inherited-control statement.

## Public claims and the controls that gate them

A claim is shown as **evidenced** on the Trust Center only when *every* control below is `Met` **and** its latest evidence is fresh and not failing. Otherwise it stays **In progress**.

| Claim key | Gating controls |
|---|---|
| `tenant_isolation_rls` | `ACC-01` |
| `automated_security_scanning` | `SDL-01` |
| `automated_ci_checks` | `SDL-03` |
| `availability_monitoring` | `AVL-01` |
| `vulnerability_disclosure` | `COM-02` |
| `backup_and_restore_testing` | `AVL-02`, `AVL-03` |
| `enforced_mfa_for_staff` | `ACC-02` |
| `independent_penetration_test` | `PEN-01` |
