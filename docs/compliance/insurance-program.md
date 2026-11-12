# Vireek — Insurance Program and Underwriting Readiness Pack

> **DRAFT for owner, broker and counsel review. This document does NOT state that Vireek holds, has bound, has applied for, or has been quoted any insurance.** The repository contains no policy, declarations page, binder, certificate, broker engagement or claims history. Its only mention of insurance is the row in `docs/brand/06-entity-dependency-audit.md` listing insurance among "contracts not in repo … UNVERIFIED".
>
> **Tags used below**
> `[R]` verified in the repository snapshot · `[P]` partly in place · `[V]` outside the repo, owner must verify before any answer is submitted · `[N]` not in place · **`[COUNSEL]`** legal, contractual or financial decision for counsel/broker (all amounts, limits, retentions, premiums and legal wording) · **`[VERIFY]`** unverified fact.
>
> **Basis:** static read of the `vireek-main` archive; the compliance docs it relies on are dated 2026-11-02/03. Nothing was executed. The archive may be older than the live repository — re-check every `[R]` against current files before submitting anything to a carrier. This is not legal, financial or insurance advice.

Related evidence (all existing): `docs/compliance/soc2/READINESS_REPORT.md`, `docs/compliance/soc2/controls.json`, `docs/security/partner-security-questionnaire.md`, `docs/compliance/SOC2_READINESS.md`, `docs/compliance/gap-list.md`.

---

## 1. Coverage types to discuss with a broker

Status of every line below: **NOT EVIDENCED — `[VERIFY]` whether any policy exists.** Limits, retentions, sub-limits, retroactive dates, premiums and carriers: **`[COUNSEL]`**. Descriptions are general; the broker confirms how each carrier words them.

| Line | What it generally responds to | Vireek-specific exposure (from the repo) | Limit / retention |
|---|---|---|---|
| **Cyber (first- and third-party)** | Incident response costs, forensics, notification, data restoration, business interruption, extortion, privacy/regulatory defence, third-party claims from a breach | Multi-tenant SaaS: customer, caller and job data in one Postgres (RLS isolation, `ACC-01`). Call audio/transcripts/caller identity (`data-map.md` D1–D4), voice-clone samples (D9), payment references via Stripe (D6), bank links via Plaid (D7), technician location (D10), integration OAuth tokens (QuickBooks/CRM AES-256; Jobber, ServiceTitan, Housecall Pro, HubSpot, Google **not** application-encrypted today — partner questionnaire §2) | `[COUNSEL]` |
| **Technology E&O / professional liability** | Claims that the service failed, was wrong, or caused a customer's financial loss | AI voice agent can mishear callers or give inaccurate output (MSA §11); missed-job/lost-revenue claims; AI quoting and dispatch features; uptime commitment with service credits (`/sla`); emergency handling is disclaimed ("not designed to handle emergencies", MSA §11) | `[COUNSEL]` |
| **Commercial general liability (GL)** | Third-party bodily injury / property damage, advertising injury | Usually low direct exposure for a software company; relevant for office premises, events and contract-required certificates. Technician field work is performed by Vireek's customers, not Vireek `[VERIFY]` | `[COUNSEL]` |
| **Media / advertising / IP (often bundled with tech E&O)** | Content, IP and privacy-in-media claims | Voice cloning and AI-generated customer-facing content (`clone-voice`, ElevenLabs); consent and rights for voice talent are contracts "not in repo" (`06-entity-dependency-audit.md`) | `[COUNSEL]` |
| **Crime / social-engineering / funds-transfer fraud** | Employee-deceived transfers, impersonation, theft | Stripe/Plaid-connected flows and vendor payments; no payment-approval control is documented in the repo | `[COUNSEL]` `[VERIFY]` |
| **D&O, EPLI, workers' compensation, commercial auto** | Management/employment claims; statutory and fleet exposures | Not assessed here. Depend on entity structure, headcount, jurisdictions and any holding-company restructure (see `docs/brand/RESTRUCTURE_RUNBOOK.md`) | `[COUNSEL]` |

**Do not confuse** the customer-facing insurance-claims features (`src/pages/InsuranceClaimsPage.tsx`) with Vireek's own insurance. They are product functionality, not coverage held by Vireek.

### 1.1 Contract interplay the underwriter will ask about (`[COUNSEL]`)

Facts from `src/components/sections/MsaContent.tsx`:
- Liability cap defaults to fees paid in the 3 months before the event, unless an Order Form says otherwise `[R]`.
- The cap and the consequential-damages exclusion do **not** apply to indemnification obligations, breach of confidentiality, or liability that cannot be limited by law `[R]`. Uncapped exposure on confidentiality breach is directly relevant to cyber/E&O limit selection.
- Service credits are the sole and exclusive remedy for uptime failures `[R]` (MSA text; `/sla` target 99.9%, see public-claims gap G13).
- The MSA contains **no** insurance-requirement clause `[R]`. Customer Order Forms, vendor MSAs and any customer-required certificates of insurance are not in the repo `[VERIFY]`.
- Customer indemnity covers call-recording, consent and automated-calling laws `[R]`.

### 1.2 Policy register (fill only from actual policy documents)

| Line | Carrier | Policy no. | Claims-made / occurrence | Retro date | Period | Limit | Retention | Broker | Evidence file |
|---|---|---|---|---|---|---|---|---|---|
| Cyber | — | — | — | — | — | `[COUNSEL]` | `[COUNSEL]` | — | none |
| Tech E&O | — | — | — | — | — | `[COUNSEL]` | `[COUNSEL]` | — | none |
| GL | — | — | — | — | — | `[COUNSEL]` | `[COUNSEL]` | — | none |

All cells stay empty until a declarations page is in hand. Never populate from memory, quotes or marketing material.

---

## 2. Underwriting questionnaire answer sheet

**Rules for using this sheet**
1. "Answer today" is the most favourable statement the repository actually supports. If it is not a plain yes/no, give the nuance — do not round up.
2. Any row tagged `[V]`, `[VERIFY]` or `[COUNSEL]` must be resolved by the named role before submission. The security owner is currently **unnamed** (`READINESS_REPORT.md` §1; control owners: 0).
3. An officer signs the application; inaccurate statements can have coverage consequences `[COUNSEL]`.
4. Re-run the evidence check (§3) on the submission date; update this sheet if any linked file changed.

### A. Company and exposure

| # | Typical question | Answer today | Tag | Evidence / owner |
|---|---|---|---|---|
| A1 | Legal entity, state/country, year founded | Not in repo; contracting entity and establishment are open decisions | `[VERIFY]` `[COUNSEL]` | `docs/compliance/transfers-and-contracts.md` §1 |
| A2 | Annual revenue, headcount, customer count | Not in repo | `[VERIFY]` | Finance / founder |
| A3 | Description of services | Multi-tenant SaaS for home-service businesses: booking, dispatch, AI call handling, invoicing, integrations | `[R]` | `docs/security/partner-security-questionnaire.md` §1 |
| A4 | Hosting / cloud providers | Supabase (database, auth, edge functions; US) and Vercel (frontend; US) | `[R]` | `src/lib/subprocessors.ts` (updated 2026-09-12) |
| A5 | Data residency | US control plane. EU/CA regions are **not** offered or enforced; UK/AU not representable. Do not advertise residency | `[R]` | `docs/compliance/data-map.md` §2 |
| A6 | Number of records of personal information held | Not measured in repo | `[VERIFY]` | Run row counts on `customers`, `calls`, `leads` per `docs/DB_AUDIT.md` |
| A7 | Types of sensitive data | Caller identity and call audio/transcripts, customer/job data, bank-link data (Plaid), voice-clone samples, technician location. Card data is handled by Stripe; Vireek does not store raw card data. **No HIPAA BAA offered** | `[R]` | `data-map.md` D1–D14; `src/lib/complianceStatus.ts`; `docs/pci-pay-by-phone.md` |
| A8 | PCI DSS compliance | Vireek holds **no** PCI DSS attestation of its own; Stripe maintains its own | `[R]` | `src/lib/complianceStatus.ts` |
| A9 | SOC 2 / ISO 27001 | **None held.** SOC 2 readiness map only; no audit performed | `[R]` | `READINESS_REPORT.md` header |

### B. Governance and policies

| # | Question | Answer today | Tag | Evidence |
|---|---|---|---|---|
| B1 | Named security officer | **No** | `[N]` | `READINESS_REPORT.md` §1 |
| B2 | Written security policies | 15 policy **drafts** exist; **none approved**, none acknowledged by staff | `[P]` | `docs/compliance/policies/`; control `GOV-01` missing |
| B3 | Risk assessment performed | No formal risk register or annual assessment | `[N]` | `RSK-01` missing; `policies/risk-assessment.md` |
| B4 | Security awareness training | None found in repo | `[N]` | `policies/security-training.md`; `GOV-02` |
| B5 | Background checks | No decision recorded | `[N]` | `GOV-02` |
| B6 | Independent penetration test | **Not performed.** Scope document drafted | `[N]` | `docs/compliance/soc2/PENTEST_SCOPE.md`; `PEN-01` |
| B7 | Vulnerability disclosure program | Yes — `security.txt` and `/vulnerability-disclosure` (targets, not commitments) | `[R]` | `SECURITY.md`, `public/.well-known/security.txt` (expires 2027-09-10) |

### C. Access control and MFA

| # | Question | Answer today | Tag | Evidence |
|---|---|---|---|---|
| C1 | MFA for remote/email access | Not answerable for workforce accounts (GitHub, Vercel, Supabase, Stripe, Twilio, Vapi, email) | `[V]` | `policies/access-control.md` gap |
| C2 | MFA for admin / privileged accounts | MFA (authenticator) is available and the app forces a challenge (AAL2) **once enrolled**; it is **not mandatory** for tenant owners/admins or Vireek staff. A `require_mfa_for_team` setting exists (default false); no enforcing code path was found beyond the enrolled-AAL2 check | `[P]` `[VERIFY]` | `src/components/ProtectedRoute.tsx`, `src/lib/mfaChallenge.ts`, `src/lib/enterpriseSecurity.ts`; `ACC-02` partial |
| C3 | Tenant data segregation | Postgres RLS keyed by `get_account_owner_id()`; migration linter warns on tables without RLS; live-DB coverage query still to be run | `[R]` + `[V]` | `ACC-01` met; `docs/security/rls-audit.md` |
| C4 | Privileged-access protection | `profiles.is_staff` cannot be changed from the client; staff gated by `is_vireek_staff()`; no JIT access, no staff-access review | `[P]` | `ACC-04` met; `docs/security/staff-impersonate-grant-gate.md` |
| C5 | Periodic access reviews / offboarding | No review process or offboarding checklist covering provider consoles | `[N]` | `ACC-03` partial; `policies/onboarding-offboarding.md` |
| C6 | SSO / SCIM offered | Yes (enterprise): `admin-sso`, `scim-v2` | `[R]` | `partner-security-questionnaire.md` §2 |
| C7 | Shared or default credentials | A demo user with a known password is created by migration and **may exist in production** | `[V]` | `READINESS_REPORT.md` gap #2; `ENV-01` partial |

### D. Backups and disaster recovery

| # | Question | Answer today | Tag | Evidence |
|---|---|---|---|---|
| D1 | Regular backups | Logical backup function `dr-backup-run` covers ~17 of ~1,500 tables into a private bucket with SHA-256; Supabase PITR/physical backups are the primary layer but plan, retention and restore owner are **unverified** | `[P]` `[V]` | `docs/DB_BACKUP_RESTORE.md`; `RUNBOOK.md` §5; `AVL-02` |
| D2 | Backups tested / restore drills | A drill function exists (checksum, row counts, sample restore); **no drill evidence recorded**; no full restore has been timed | `[P]` | `supabase/functions/dr-restore-drill`; `AVL-03`; results table in `DB_BACKUP_RESTORE.md` is empty ("NOT MEASURED") |
| D3 | Stated RTO / RPO | **Not defined or measured.** Do not report the drill's `rto_seconds` as an RTO | `[N]` | `DB_BACKUP_RESTORE.md`; `AVL-04` missing |
| D4 | Offline / immutable backups | Not evidenced | `[V]` | — |
| D5 | Business continuity / DR plan | Draft policy only; no continuity plan or communication tree | `[N]` | `policies/business-continuity.md` |
| D6 | Availability monitoring | Synthetic probes, SLO evaluation, public `/status` page | `[R]` | `docs/runbooks/synthetic-monitoring.md`; `AVL-01` met |

### E. Incident response

| # | Question | Answer today | Tag | Evidence |
|---|---|---|---|---|
| E1 | Written IR plan | Yes, as documentation: `RUNBOOK.md` §6 and `docs/runbooks/incident-response.md` (marked DRAFT) plus `docs/incident/incident-management.md` (severity levels, roles, on-call design) | `[P]` | files listed |
| E2 | Named roles / on-call roster | **No** — roster and paging tool are "TBD" in the runbook. `incident-management.md` describes a PagerDuty rotation; whether it is configured is unverified | `[N]` `[V]` | `docs/runbooks/incident-response.md`; `RUNBOOK` §8 |
| E3 | IR plan tested (tabletop) in last 12 months | **No record** | `[N]` | `INC-01` partial |
| E4 | Breach-notification procedure and legal timelines | Not asserted; decision owner and obligations are open | `[COUNSEL]` | `policies/incident-response.md` gap; `docs/security/voice-incident-response.md` §4 |
| E5 | Retained IR firm / breach counsel | Not in repo | `[VERIFY]` `[COUNSEL]` | — |
| E6 | Customer incident communication | Public status page with subscriber notifications | `[R]` | `INC-02` met |
| E7 | AI/voice-specific containment | Tenant and global kill switch (`voice_set_my_mode`, `voice_set_mode`), audit chain verification, red-team regression | `[R]` | `docs/security/voice-incident-response.md`; `docs/security/voice-redteam-playbook.md` |

### F. Vendor and third-party management

| # | Question | Answer today | Tag | Evidence |
|---|---|---|---|---|
| F1 | Inventory of critical vendors | Public sub-processor list exists but **omits 13 providers** called from code | `[P]` | `src/lib/subprocessors.ts`; `docs/compliance/gap-list.md` E6 |
| F2 | Vendor security reviews / attestation reports collected | **None collected** (Supabase, Vercel, Stripe, Twilio, Vapi, AI providers) | `[N]` | `READINESS_REPORT.md` gap #11; `VND-01` partial |
| F3 | Contracts / DPAs with vendors | DPA status per provider not tracked; no executed SCC annexes in repo | `[N]` `[COUNSEL]` | `docs/compliance/transfers-and-contracts.md`; `policies/vendor-management.md` |
| F4 | Customer notice of sub-processor changes | Yes — process in DPA §5 plus `subprocessor-notice-dispatch` | `[R]` | `src/components/sections/DpaContent.tsx` |
| F5 | Vendor-failure contingency | Multi-provider AI fallback; telephony/hosting single-provider dependence not assessed | `[P]` | `policies/business-continuity.md` |

### G. Secure development, change management and data protection

| # | Question | Answer today | Tag | Evidence |
|---|---|---|---|---|
| G1 | Automated security scanning | CI workflows for `npm audit`, CodeQL, gitleaks, Dependabot are defined; confirm they run on the live repo | `[R]` + `[V]` | `.github/workflows/security.yml`, `.github/dependabot.yml`; `SDL-01` met |
| G2 | Peer review / branch protection | Policy requires a second reviewer for sensitive paths; `CODEOWNERS` exists but its owner tokens are **placeholders** (protects nothing yet); branch-protection settings unproven | `[P]` `[V]` | `.github/CODEOWNERS`, `.github/pull_request_template.md`; `SDL-02` |
| G3 | Encryption in transit | HTTPS to Supabase/Vercel and providers | `[R]` `[V]` | partner questionnaire §2 |
| G4 | Encryption at rest | Platform-managed by Supabase `[V]`. Application-level AES-256 only for QuickBooks and CRM tokens; **other integration tokens are plaintext today**. Do not say "all data encrypted" | `[P]` | partner questionnaire §2 and §4 |
| G5 | Key and secret management | Secrets as Supabase secrets; rotation cadence undefined; leak-response steps documented | `[P]` | `RUNBOOK.md` §7 |
| G6 | Data retention and deletion | Retention sweep and deletion workflow exist; erasure covers 15 tables and misses provider-side data; known defects in the sweep | `[P]` | `docs/compliance/gap-list.md` E1–E5 |
| G7 | Logging and monitoring | `audit_log` (tenant-readable), `ai_security_events`; Sentry if DSN set; no central retention or alert routing to a named on-call | `[P]` `[V]` | `src/pages/AuditLogPage.tsx`; `LOG-01`, `LOG-02` |

### H. E&O, contracts and regulatory

| # | Question | Answer today | Tag | Evidence |
|---|---|---|---|---|
| H1 | Standard customer contract and limitation of liability | MSA with liability cap (3 months of fees default), AI disclaimer, indemnities as summarised in §1.1 | `[R]` | `src/components/sections/MsaContent.tsx` |
| H2 | Uptime commitment / SLA credits | Published target 99.9% with credits as sole remedy; no measured uptime evidence is in the repo | `[R]` + `[V]` | `src/components/sections/SlaContent.tsx` |
| H3 | Contractual insurance requirements from customers | Unknown; no insurance clause in the MSA | `[VERIFY]` | Order Forms not in repo |
| H4 | Call recording / consent and automated-calling compliance | Recording consent is US-area-code based only; no DE/EU/UK/CA/AU logic; legal review outstanding | `[P]` `[COUNSEL]` | `gap-list.md` E7, L4; `docs/compliance/voice-consent-and-ai-disclosure.md` |
| H5 | AI governance and testing | AI security events, red-team scenarios in CI, DPIA draft, Responsible AI page. Whether customer data trains any model is **not asserted**; confirm against `src/lib/aiSecurity.ts` and provider terms | `[P]` `[V]` | `docs/compliance/dpia-voice-ai.md`; `.github/workflows/voice-redteam.yml`; `src/pages/ResponsibleAiPage.tsx` |
| H6 | Accuracy of public security statements | Known mismatches: "End-to-End Encrypted", "Multi-Region", "99.9% Uptime SLA" badges; Trust Center annual pen-test commitment with none performed | `[N]` | `READINESS_REPORT.md` F8, F9; `docs/compliance/PUBLIC_CLAIMS_INVENTORY.md` |

### I. Prior insurance, claims and incidents

| # | Question | Answer today | Tag |
|---|---|---|---|
| I1 | Current or prior insurance, carrier, limits, retro date | Not in repo. Answer only from policy documents | `[VERIFY]` `[COUNSEL]` |
| I2 | Declined, cancelled or non-renewed coverage | Not in repo | `[VERIFY]` |
| I3 | Claims, incidents, regulatory inquiries or circumstances that could give rise to a claim (last 5 years) | Not in repo; founder to answer from personal knowledge and incident records. Misstatement risk is high | `[VERIFY]` `[COUNSEL]` |
| I4 | Security incidents or breaches to date | No incident log was found in the repo; absence of a log is not evidence of absence | `[VERIFY]` |

---

## 3. Evidence index

Verified to exist in the snapshot. Attach only after the "Status" column is resolved.

| Topic | File | Status |
|---|---|---|
| MFA / access | `src/components/ProtectedRoute.tsx`, `src/lib/mfaChallenge.ts`, `docs/compliance/policies/access-control.md` | MFA opt-in; policy draft |
| Backups / DR | `docs/DB_BACKUP_RESTORE.md`, `RUNBOOK.md` §5, `docs/compliance/policies/backup-disaster-recovery.md`, `supabase/functions/dr-backup-run`, `supabase/functions/dr-restore-drill` | No measured RTO/RPO; no drill record |
| Incident response | `RUNBOOK.md` §6, `docs/runbooks/incident-response.md`, `docs/incident/incident-management.md`, `docs/security/voice-incident-response.md`, `docs/compliance/policies/incident-response.md` | Roster TBD; no tabletop |
| Vendor management | `docs/compliance/policies/vendor-management.md`, `src/lib/subprocessors.ts`, `docs/compliance/transfers-and-contracts.md`, `docs/compliance/data-map.md` | No vendor reviews; list incomplete |
| Security programme | `docs/compliance/soc2/READINESS_REPORT.md`, `docs/compliance/soc2/controls.json`, `docs/compliance/soc2/CONTROL_MAP.md`, `docs/compliance/soc2/PENTEST_SCOPE.md` | Readiness only; 0 evidence records, 0 named owners |
| Questionnaire precedent | `docs/security/partner-security-questionnaire.md` | Needs owner confirmation |
| Public-claims control | `src/lib/complianceStatus.ts`, `docs/compliance/PUBLIC_CLAIMS_INVENTORY.md` | Open items F8/F9 |
| Contracts | `src/components/sections/MsaContent.tsx`, `src/components/sections/SlaContent.tsx`, `src/components/sections/DpaContent.tsx` | `[COUNSEL]` review |

**Referenced by existing docs but not present in the snapshot** (do not cite as evidence): `docs/runbooks/incident-templates.md`, `docs/generated/INTEGRATIONS.md`, `docs/governance/BRANCH_PROTECTION.md`, `scripts/governance/check-codeowners.mjs`, `docs/runbooks/security-txt-renewal.md`, and `docs/compliance/soc2/policies/` (cited by `controls.json`; the policies live in `docs/compliance/policies/`, whose `README.md` also lists some file names that differ from the actual ones). These may exist in the live repo — `[VERIFY]`.

---

## 4. Gaps list

Ranked by likely underwriting impact. Effort figures are the engineering estimates in `READINESS_REPORT.md` where one exists; otherwise not estimated. Whether a gap changes insurability or pricing is a broker question `[VERIFY]`.

| ID | Gap | Why an underwriter cares | Source | Effort | Type |
|---|---|---|---|---|---|
| G1 | MFA not enforced for staff, tenant owners/admins or evidenced for workforce accounts | MFA on remote and privileged access is a standard cyber application question | `READINESS_REPORT` #3; `ACC-02` | 2–4 d (staff 1 d) | Code + config |
| G2 | Backup/restore never evidenced; PITR unverified; RTO/RPO undefined | Business-interruption and restoration exposure | `READINESS_REPORT` #5; `AVL-02/03/04` | 1–2 d | Verify + decide |
| G3 | No named security owner; policies unapproved; no training, risk register | Governance questions A–B cannot be answered "yes" | `GOV-01/02`, `RSK-01` | 3–5 d + 2 d | Management |
| G4 | No incident-response roster, on-call or tabletop; breach-notification owner undefined | IR readiness is scored directly | `READINESS_REPORT` #8; `INC-01` | 2 d | Process |
| G5 | No vendor reviews or attestation reports; public sub-processor list omits 13 providers | Third-party/supply-chain risk | `READINESS_REPORT` #11; `gap-list` E6 | 3 d + vendor time | Process |
| G6 | No independent penetration test | Often requested for E&O/cyber at higher limits | `PEN-01`; `PENTEST_SCOPE.md` | external | Purchase |
| G7 | Integration tokens for Jobber, ServiceTitan, Housecall Pro, HubSpot, Google stored without application-level encryption | Weakens the encryption answer (row G4 in §2) | partner questionnaire §2 | not estimated | Code |
| G8 | Demo user with known password may exist in production | Shared/default credentials | `READINESS_REPORT` #2 | 0.5 d verify, 1 d remove | Verify + fix |
| G9 | Code review unproven: `CODEOWNERS` placeholders, branch protection unverified | Change-management answers | `SDL-02` | 1 d tooling + second reviewer | Config + people |
| G10 | Tenant-isolation and function-exposure findings (DR tables readable by authenticated tenants, `log_audit_event` anon execute, `update_own_profile` scope) | Direct breach-likelihood drivers | `READINESS_REPORT` #6 | 2–3 d | Migration |
| G11 | Erasure and retention defects; no provider-side erasure | Regulatory-exposure and notification scope | `gap-list` E1–E5 | not estimated | Code |
| G12 | Audit-log retention undefined; no central log retention or paging | Forensics capability after an incident | `READINESS_REPORT` #12, #15 | 1 d + 2–3 d | Migration + config |
| G13 | Public claims not backed by evidence (E2E encryption, Multi-Region, 99.9% SLA badge, annual pen-test commitment) | Misrepresentation risk in contracts and applications `[COUNSEL]` | `READINESS_REPORT` #1, F8, F9 | 0.5 d | Copy change |
| G14 | **Insurance-specific:** no broker, no policy inventory, no claims-made/retro-date tracking, no customer COI requirements map, no claims/incident history on file | Cannot complete §2 Section I or manage renewals | this document | not estimated | Management |
| G15 | **Insurance-specific:** no record of record counts, revenue by customer segment or data volumes for exposure sizing | Limit selection and pricing | §2 A2, A6 | 0.5 d | Data |
| G16 | Contract position unreviewed against insurance: uncapped indemnity/confidentiality carve-outs, no insurance clause, SLA credit exclusivity | Limit adequacy and policy exclusions (contractual liability) | §1.1 | counsel time | `[COUNSEL]` |
| G17 | Recording-consent and automated-calling compliance only US-area-code based; legal review outstanding | Regulatory defence and privacy-claim exposure | `gap-list` E7, L4 | counsel + engineering | `[COUNSEL]` |

Quick wins that most improve questionnaire answers: G1 (staff), G2 verification, G4 roster + tabletop, G9 owner tokens, G13 copy fixes.

---

## 5. Working process

1. Founder names the accountable owner for this document and a deputy; broker is selected `[COUNSEL]`.
2. Resolve every `[V]`/`[VERIFY]` row in §2 against live systems (GitHub settings, Supabase plan/backups, provider consoles, PagerDuty, email/Workspace MFA) and attach screenshots or exports to a dated folder; record the location in the Evidence column.
3. Complete §1.2 only from real policy documents.
4. Counsel reviews §1.1, H, I and all `[COUNSEL]` items.
5. Re-run the evidence check on the submission date; an officer signs.
6. Review at least annually, at renewal, and after any material change (entity restructure, new data class, major incident, new region, new AI feature).

## 6. Change log

| Date | Change | Author |
|---|---|---|
| 2026-11-12 | Initial draft from the `vireek-main` snapshot | Claude (draft for owner review) |
