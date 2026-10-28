# Vireek — SOC 2 Readiness Control Map

> **This document is NOT a statement of compliance.** Vireek has not completed a SOC 2 audit and holds no SOC 2 report
> (Type I or II) — consistent with `src/lib/complianceStatus.ts`. This is an internal, engineering-authored mapping of what the
> repository already does, what evidence it produces, and what is missing. It is not an auditor's opinion and must not be quoted
> externally as a compliance claim.

| | |
|---|---|
| Basis | Repository snapshot reviewed 2026-10-28 (code, migrations, workflows, docs). Anything outside the repo (Vercel/Supabase/GitHub settings, HR, contracts) is marked **verify** |
| Framework | AICPA Trust Services Criteria (2017, rev. 2022): Security (CC1–CC9), Availability (A1), Confidentiality (C1). Processing Integrity / Privacy deliberately out of first scope |
| Owner | _TBD — name an accountable security owner_ |
| Review cadence | Quarterly (align with `RUNBOOK.md` §9) |

**Status legend:** ✅ Implemented in code/config (evidence exists) · 🟡 Partial · ⚪ Process outside the repo — verify · ❌ Missing

---

## 1. Control mapping

### 1.1 Access control (CC6.1–CC6.8)

| Control | Repo implementation (evidence path) | Status | Gap |
|---|---|---|---|
| Tenant isolation | Postgres RLS keyed by `get_account_owner_id()` (`supabase/migrations/20260821101104_create_profiles_and_team_members.sql`); migration lint warns on tables without RLS (`scripts/lint-migrations.mjs`) | ✅ | Prove coverage on the live DB — query in §6 |
| Authentication / MFA | Supabase Auth; `ProtectedRoute` forces `/mfa` when an authenticator is enrolled (AAL2) (`src/components/ProtectedRoute.tsx`, `src/lib/mfaChallenge.ts`) | 🟡 | MFA is user-opt-in; no enforced MFA for owners/admins/staff |
| Session policy | Idle timeout / max session age enforced in `ProtectedRoute` via `security_policies` (`enterpriseSecurity.ts`) | ✅ | Defaults not enforced for non-enterprise accounts |
| Network restriction | `ip_allow_rules` + `check-ip-policy` function | ✅ | Enterprise-only |
| RBAC | `profiles.role`, `team_members.permissions`, `custom_roles` (migration `20261103000000_enterprise_identity_security.sql`), `StaffRoute`/`TechnicianRoute`/`PartnerRoute` | ✅ | No periodic access review process |
| Privileged flag protection | `profiles.is_staff` protected by trigger (`20270411000000_protect_profiles_is_staff.sql`) | ✅ | Re-check other privileged columns (`role`, `plan`, billing state) are not client-writable — `update_own_profile` policy has no column restriction |
| Enterprise identity | `admin-sso`, `scim-v2`, `sso_domains`, `scim_tokens`, `trusted-device` | ✅ | — |
| API / agent / device keys | `api-v1` hashes keys with SHA-256, 120 req/min limit; `mcp-server` scoped keys, quotas, approval + idempotency; `pio_devices` keys revocable | ✅ | No key-rotation/expiry policy |
| Secrets handling | Server secrets via `supabase secrets`; `.env` ignored; gitleaks in CI (`.github/workflows/security.yml`, `.gitleaks.toml`) | ✅ | Rotation cadence undefined (`RUNBOOK` §7 says "decide") |
| Internal admin access | `is_vireek_staff()`, `/staff/*` | 🟡 | No staff access logging/review policy; no JIT access |
| Joiner/mover/leaver | — | ❌ | No offboarding checklist for Vercel/Supabase/GitHub/provider consoles |

### 1.2 Change management (CC8.1)

| Control | Evidence | Status | Gap |
|---|---|---|---|
| Automated gates | `ci.yml` (lint, typecheck, unit+coverage, build, E2E); `quality-gates.yml` (migration lint, bundle budget, Lighthouse); `edge-functions.yml` (deno check) | ✅ | — |
| Security scanning | `security.yml`: `npm audit` (high, blocking), CodeQL `security-extended`, gitleaks; Dependabot weekly (`.github/dependabot.yml`) | ✅ | — |
| Review requirements | `CONTRIBUTING.md` §7: second reviewer for auth/RLS/billing/webhooks/secrets/migrations | 🟡 | **No `CODEOWNERS`, no PR template**; branch protection / required reviews cannot be proven from the repo — **verify** in GitHub settings and export a screenshot/API dump |
| Migration discipline | Additive-only policy, destructive-SQL lint, unique-version check (`migrations.yml`) | 🟡 | Clean-replay job is non-blocking; 62 duplicate migration versions documented in `RUNBOOK` §3.3 |
| Deploy controls | Vercel Git integration; edge deploy gated (`EDGE_DEPLOY_ENABLED`, `environment: production`) | 🟡 | Edge deploys are manual by default; E2E auth specs skipped in CI (no test creds) |
| Rollback | `RUNBOOK` §4 | ✅ | — |
| Separation of environments | Staging referenced in docs | ⚪ | Verify a separate staging Supabase project exists; **demo user with known password is created by migration `20260821101216_seed_demo_data.sql`** (RUNBOOK §8.3) |

### 1.3 Logging & monitoring (CC7.1–CC7.3, CC4.1)

| Control | Evidence | Status | Gap |
|---|---|---|---|
| Application audit trail | `audit_log` (actor, action, target, `metadata` before/after), owner-only read, no client INSERT/UPDATE/DELETE policy; viewer `src/pages/AuditLogPage.tsx` | ✅ | Hardened by the included migration (cross-tenant forging); no immutability trigger vs. service role; retention not defined |
| Domain event logs | `billing_events` (idempotent), `ai_usage_logs`, `ai_security_events` (append-only, no raw prompts), `job_status_events`, `quote_events` | ✅ | — |
| Error monitoring | Sentry (cookies stripped, 0.2 trace rate) `src/lib/sentry.ts` | 🟡 | Only if `VITE_SENTRY_DSN` set — verify prod |
| Availability monitoring | `synthetic-probe`, `slo-evaluate`, `status-feed`; `/status` page (`docs/runbooks/synthetic-monitoring.md`) | ✅ | — |
| Platform logs | Supabase/Vercel dashboards | ⚪ | Log retention + export to a SIEM/long-term store not defined |
| Alerting to humans | Slack/Teams webhook (`SLO_ALERT_WEBHOOK_URL`) | 🟡 | No on-call roster/paging (`RUNBOOK` §8.11) |

### 1.4 Backup & recovery (A1.2–A1.3)

| Control | Evidence | Status | Gap |
|---|---|---|---|
| Logical backup | `dr-backup-run` → private bucket `dr-backups`, SHA-256, `platform_backup_runs` | ✅ | Scheduler + bucket privacy must be verified |
| Restore testing | `dr-restore-drill` (checksum, row counts, scratch-schema restore), `platform_restore_drills` incl. `rto_seconds` | ✅ | Define RTO/RPO targets; first real drill evidence |
| Infra backups/PITR | Supabase plan feature | ⚪ | Verify plan, retention, restore owner |
| Retention & erasure | `data_retention_policies`, `deletion_requests`, legal hold, `data-retention-sweep`, `delete-account` | ✅ | — |
| Visibility of DR tables | `platform_backup_runs` / `platform_restore_drills` have `SELECT USING (true)` for **every authenticated tenant** (storage paths, row counts) | 🟡 | See Finding F3 |

### 1.5 Incident response (CC7.3–CC7.5, CC2.3)

| Control | Evidence | Status | Gap |
|---|---|---|---|
| Procedure | `RUNBOOK.md` §6 (severity, triage, containment, playbooks, post-mortem) | ✅ | Severity targets are "suggestions" |
| Customer comms | Status page, `notify-status-subscribers`, maintenance mode | ✅ | No breach-notification template/timelines |
| Vulnerability intake | `public/.well-known/security.txt`, `/vulnerability-disclosure` | ✅ | `security.txt` expires 2027-09-10 — calendar renewal |
| Roles | — | ❌ | No named incident commander, backup, escalation tree |
| Exercises | — | ❌ | No tabletop exercise record |

### 1.6 Other criteria touched

| Area | Evidence | Status | Gap |
|---|---|---|---|
| Vendor management (CC9.2) | `/subprocessors`, `/dpa`, subprocessor notices | 🟡 | No vendor risk assessments / SOC 2 report collection for Supabase, Vercel, Stripe, Twilio, Vapi, AI providers |
| Risk assessment (CC3) | — | ❌ | No risk register |
| Confidentiality (C1) | `pii_field_registry`, `consent_records`, token encryption keys, AI PII modes (`ai_security_settings`) | 🟡 | No data classification policy |
| Governance (CC1/CC2) | — | ❌ | No policy set, training, background checks, board/management oversight record |

---

## 2. Evidence the system already produces

| Evidence | Source | How to export |
|---|---|---|
| Who changed what, when | `audit_log` | SQL export per account, or the Audit Log page |
| CI results per change | GitHub Actions runs (CI, Security, Quality Gates) | Actions API / run logs |
| Vulnerability + secret scans | CodeQL alerts, `npm audit`, gitleaks job | GitHub Security tab / run logs |
| Dependency update history | Dependabot PRs | GitHub PR list |
| Backup runs | `platform_backup_runs` | `select * from platform_backup_runs order by started_at desc` |
| Restore drills + RTO | `platform_restore_drills` | same pattern |
| Uptime / SLO / incidents | `slo-evaluate`, `status-feed` | status feed export |
| Billing events | `billing_events` | SQL |
| AI security events + spend | `ai_security_events`, `ai_usage_logs`, `ai_budget_limits` | SQL |
| Deletion / retention actions | `deletion_requests`, `data_retention_policies` | SQL |
| Migration history | `supabase/migrations/` + Git history | Git log |

## 3. Missing controls and policies (prioritised)

**P0 — before engaging an auditor**
1. Remove/neutralise unsubstantiated "SOC 2 ready/aligned" marketing copy (Finding F1).
2. Information Security Policy (owner, scope, exceptions).
3. Access Control & Review policy: quarterly review of GitHub, Vercel, Supabase, provider-console and `is_staff` users; offboarding checklist.
4. Enforced MFA for all workforce accounts (GitHub, Vercel, Supabase, Stripe, Twilio, Vapi) and for `owner`/`admin` in-app.
5. Change Management policy (reviews required, emergency change process) + GitHub branch protection evidence + `CODEOWNERS` + PR template.
6. Incident Response Plan with named roles, severity SLAs, breach-notification timeline, annual tabletop.
7. Risk register + annual risk assessment.

**P1**
8. Backup/DR policy with RTO/RPO; run and archive first restore drill; verify Supabase PITR.
9. Vendor management policy + vendor inventory with each vendor's attestation status.
10. Data classification, retention and disposal policy (map to existing `data_retention_policies`).
11. Log retention & monitoring policy; centralised log export; on-call/paging.
12. Secrets & key rotation policy (cadence, encryption-key re-encrypt procedure).
13. Security awareness training + background checks record.

**P2**
14. Business continuity plan, vulnerability-management SLAs (e.g. critical 7 d), pen-test (annual, third party), SDLC secure-coding standard, acceptable-use policy, asset inventory.

Choose a compliance-automation/audit path (readiness assessment → Type I → Type II observation window) only after P0 is done.

## 4. Findings needing engineering action

| ID | Finding | Severity | Action |
|---|---|---|---|
| F1 | Marketing says "SOC 2 Ready/aligned" (`TrustBar.tsx`, `SecurityPrivacy.tsx`, `HighlightBanner.tsx` ×2, `AuthParts.tsx`) while `complianceStatus.ts` states no SOC 2 report is held | High (misrepresentation risk) | Replace copy (see change list) |
| F2 | `log_audit_event()` trusted `p_user_id`: any user could write into another tenant's audit log | High | Migration `20271215090000_audit_log_cross_tenant_guard.sql` |
| F3 | DR tables readable by all authenticated tenants (`USING (true)`), and consumed by `src/lib/dataGovernance.ts` | Medium | Needs a design decision (staff-only + a sanitised status RPC) — **not auto-fixed** to avoid breaking the DR health UI |
| F4 | Possible `anon`/PUBLIC EXECUTE on `log_audit_event` (default function grant) | Medium | Verify query §6; revoke only after confirming no anon flow depends on it |
| F5 | Demo account with known password created by migration `20260821101216_seed_demo_data.sql` | High if present in prod | Verify in prod; remove via reviewed procedure |
| F6 | `update_own_profile` has no column restriction beyond `is_staff` | Medium | Review `role`, `plan`, billing/suspension columns |
| F7 | CI skips authenticated E2E; migration replay non-blocking | Low | Add staging creds; make replay required once clean |
| F8 | Public claims "End-to-End Encrypted", "Multi-Region", "99.9% Uptime SLA" | Medium | Confirm each is true and documented, else reword |

## 5. Honest summary

Strong engineering foundations exist for access control, logging, backup/restore testing and CI security scanning. The distance to an audit is mostly **governance, documented policies, enforced MFA, review evidence and vendor management** — none of which can be produced by code alone.

## 6. Verification queries (run in Supabase SQL editor, read-only)

```sql
-- Tables in public WITHOUT row level security
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
order by 1;

-- Can anon / PUBLIC execute the audit writer?
select has_function_privilege('anon', 'public.log_audit_event(uuid,text,text,text,jsonb)', 'execute') as anon_can_execute;

-- Permissive SELECT policies (USING true)
select schemaname, tablename, policyname, roles
from pg_policies
where schemaname = 'public' and cmd = 'SELECT' and qual = 'true'
order by 2;

-- Demo account present?
select id, email from auth.users where email = 'demo@vireek.com';

-- Latest backups and drills
select status, started_at, completed_at from platform_backup_runs order by started_at desc limit 5;
select status, started_at, rto_seconds from platform_restore_drills order by started_at desc limit 5;
```
