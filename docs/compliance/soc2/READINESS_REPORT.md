# Vireek — SOC 2 Readiness Report

> **DRAFT for human review. Not an attestation.** Vireek has not completed a SOC 2 audit and holds no SOC 2 report. Only an independent CPA firm can issue one. This report is an engineering assessment of the repository snapshot reviewed on 2026-11-02 (the uploaded `vireek-main` archive, which may be older than your live files).

Companion files: `controls.json` (source of truth) · `CONTROL_MAP.md` (generated) · `policies/` (11 drafts) · `PENTEST_SCOPE.md` · `templates/` · the earlier engineering review `../SOC2_READINESS.md` (findings F1–F8, kept as is).

## 1. Where things stand

| | Count |
|---|---|
| Controls mapped | 31 (Security 25 · Availability 4 · Confidentiality 2) |
| Declared **Met** (implemented + automated evidence collector exists) | 7 |
| **Partial** | 19 |
| **Missing** | 5 |
| Evidence collected so far | **0 records.** The pipeline is new; nothing has run against production. Every "Met" is a statement about the repository, not yet about operation. |
| Named control owners | **0.** Roles are proposed only. |
| Approved policies | **0 of 11** (all drafts) |

Criteria in first-phase scope with no mapped control yet are listed at the bottom of `CONTROL_MAP.md` (for example CC1.2 board oversight, CC5.1/CC5.2 control-activity selection). These need management decisions, not code.

## 2. Gaps ranked by risk and effort

Risk = likelihood an auditor, customer or attacker is affected × impact. Effort = person-days of focused work by someone who already knows the system (rough engineering estimates, not measured).

| # | Gap | Risk | Effort | Why it matters | Type |
|---|---|---|---|---|---|
| 1 | Public claims not backed by evidence: Trust Center "annual third-party penetration test" commitment with none performed; TrustBar "End-to-End Encrypted", "Multi-Region", "99.9% Uptime SLA" (F8) | **High** | 0.5 d | Misrepresentation risk with customers and in an audit | Copy change |
| 2 | Demo user with known password created by migration; may exist in production (F5) | **High** | 0.5 d verify, 1 d remove | Known-credential account | Verify + fix |
| 3 | MFA not enforced for staff and tenant owners/admins | **High** | 2–4 d (staff 1 d) | Core CC6.1 expectation | Code + config |
| 4 | No independent review of changes; no branch protection proof, CODEOWNERS or PR template | **High** | 1 d tooling + a second reviewer | CC8.1; a solo maintainer cannot self-review | Config + people |
| 5 | Backup/restore never evidenced; scheduler, private bucket and Supabase PITR unverified; RTO/RPO undefined | **High** | 1–2 d | A1.2/A1.3; "backups exist" is the most common auditor request | Verify + decide |
| 6 | DR tables readable by every authenticated tenant (F3); `log_audit_event` anon execute (F4); `update_own_profile` column scope (F6) | Medium | 2–3 d | Information exposure / privilege path | Migration |
| 7 | No access reviews; no offboarding checklist; provider consoles not covered | Medium | 1 d process + 0.5 d per quarter | CC6.2/6.3 | Process |
| 8 | No named incident commander, on-call, tabletop record or breach-notification template | Medium | 2 d | CC7.3–7.5 | Process |
| 9 | No risk register / assessment | Medium | 2 d | CC3.* | Process |
| 10 | Policies unapproved, no acknowledgements, no training records, no background-check decision | Medium | 3–5 d (review + approve + roll out) | CC1.*, CC2.* | Management |
| 11 | No vendor reviews or collected attestation reports (Supabase, Vercel, Stripe, Twilio, Vapi, AI providers) | Medium | 3 d + vendor response time | CC9.2 and inherited-control carve-outs | Process |
| 12 | Audit log not protected against the service role; retention undefined | Medium | 1 d | CC7.2 | Migration + decision |
| 13 | Secret rotation cadence undefined; encryption-key re-encrypt procedure missing | Medium | 1–2 d | CC6.1 | Process |
| 14 | Staging/prod separation unverified; authenticated E2E skipped in CI | Low–Medium | 2–4 d | CC8.1 | Config |
| 15 | No central log retention / alert routing to a named on-call | Low–Medium | 2–3 d | CC7.2 | Config |
| 16 | No third-party penetration test | Medium (High for enterprise buyers) | external, see §4 | CC4.1/CC7.1 | Purchase |

Quick wins first: #1, #2, #3 (staff), #4 tooling, #5 verification — roughly 5–7 working days and they remove most of the High risk.

## 3. Findings from this review

| ID | Finding | Severity | Status |
|---|---|---|---|
| F1 | "SOC 2 Ready/aligned" marketing copy | High | **Not found in this snapshot** (only guard comments remain). Re-check live files. |
| F8 | TrustBar still says "End-to-End Encrypted", "99.9% Uptime SLA", "Multi-Region" (`src/components/sections/TrustBar.tsx`); `SecurityPrivacy.tsx` says "End-to-End Encryption" | Medium | Open. Reword or substantiate; the SLA page and `SecurityPrivacy.tsx` already say "target". |
| F9 (new) | `TrustCenterPage.tsx` states a commitment to an annual third-party penetration test; none has been performed | Medium | Open. Reword to "planned" until a report exists. |
| F10 (new) | The uploaded archive contains a `.env` file. Its values are `VITE_*` public-by-design keys (the Supabase key's role claim is `anon`; no service-role, Stripe or webhook secrets found) | Info | Do not include `.env` in zips or share archives; it is correctly gitignored. |
| F2–F7 | See `../SOC2_READINESS.md` | — | Unchanged; this review did not re-verify them against the live database. |

Anything depending on the live Supabase, Vercel or GitHub configuration is **unverified** until the evidence pipeline has run.

## 4. Realistic path to an audit

Assumptions (state them to any auditor): one engineer-founder, no dedicated compliance staff, cloud-hosted on Supabase and Vercel, Security + Availability + Confidentiality in scope. Dates assume work starts on approval and the engineer can give about half their time to this.

| Phase | What happens | Duration |
|---|---|---|
| 0. Decide (now) | Name owner and deputy; choose categories; adopt or edit policies | 1–2 weeks |
| 1. Fix and instrument | Gaps #1–#8; deploy the evidence pipeline; first evidence runs; first access review and restore drill | 4–6 weeks |
| 2. Policies live | Approve policies, acknowledgements, training, risk assessment, vendor reviews, tabletop | 3–4 weeks (overlaps phase 1) |
| 3. Readiness assessment | Auditor or advisor does a gap assessment against your evidence; remediate | 3–4 weeks |
| 4. Penetration test | External test and retest (scope in `PENTEST_SCOPE.md`) | 3–5 weeks lead time + 1–2 weeks testing |
| 5. Type I | Auditor tests control **design** at a point in time | 3–5 weeks fieldwork/report |
| 6. Type II observation | Controls must operate for the whole window; 3 months is the usual minimum for a first report, 6–12 months is more common for buyers | 3–12 months |
| 7. Type II report | Fieldwork and report after the window | 4–6 weeks |

Earliest credible dates (if started now): Type I report in roughly **4–6 months**; first Type II report in roughly **9–15 months**. Evidence must exist for the whole observation window, so the pipeline matters more than the policies.

### Cost outline (rough ranges; NOT quotes; verify with providers)

These are general market ranges for small SaaS companies, from background knowledge and not looked up for this report. Real quotes vary widely by auditor, scope and region.

| Item | Typical one-off | Typical annual |
|---|---|---|
| CPA-firm SOC 2 Type I | USD 5k–20k | — |
| CPA-firm SOC 2 Type II | — | USD 10k–40k |
| Compliance-automation platform (optional; this repo already automates much evidence) | — | USD 6k–25k |
| Third-party penetration test + retest | USD 8k–30k | same, annually |
| Readiness advisor (optional) | USD 3k–15k | — |
| Background checks, training tooling, device management | small | USD 1k–5k |
| Internal time | ~30–50 person-days before Type I, then ~1–2 days/month | |

Decision you must make: whether to use a compliance platform. The pipeline in this change collects technical evidence; it does not provide an auditor portal, employee device checks, HR workflows or a vendor-risk questionnaire.

## 5. What this change does and does not do

Does: maps controls to files (validated to exist), drafts policies, collects and hashes evidence on a schedule, shows status to staff, exports for auditors, and keeps public Trust Center claims at "In progress" unless fresh passing evidence exists.

Does not: make Vireek compliant, assign owners, approve policies, perform access reviews, run restore drills or penetration tests, or prove anything about production until it has run there.

## 6. Manual verification checklist before relying on any of this

- [ ] Apply the migration; confirm `select * from public.public_trust_claims()` as `anon` returns only `in_progress`.
- [ ] Set `COMPLIANCE_INGEST_TOKEN` as a Supabase secret and the three GitHub secrets; deploy the function with `verify_jwt = false`.
- [ ] Run the workflow manually; confirm records appear in `/staff/compliance-controls` and the artifact has a manifest.
- [ ] Confirm GitHub collectors are not "blocked" (token scopes), otherwise SDL/ACC controls stay not-fresh by design.
- [ ] Run the verification queries in `../SOC2_READINESS.md` section 6 and act on F3–F6.
- [ ] Name owners in `controls.json` (`owner`) through a reviewed PR.
