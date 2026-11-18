# Business continuity policy

> **DRAFT — not approved.** Owner: _to be assigned_ · Approved by: _pending_ · Last review: _pending_. Adopting this text is a company decision; it makes no compliance claim (see `src/lib/trust/claims.ts`).

**Placeholders.** `[NAME: role]` = a named person the company must fill in. `[DECISION]` = a choice only the company can make. `[VERIFY]` = a fact not established by this repository. `[COUNSEL]` = a legal point that needs a lawyer. Nothing in square brackets has been filled in, and no person, vendor setting, objective or legal duty below should be read as already confirmed.

## Purpose and scope
Keeping critical services (call answering, dashboard, billing) running through disruptions.

This policy covers three things the technical runbooks do not: (1) what happens when a **person** who holds critical knowledge or access is unavailable, (2) how staff regain control of **provider and infrastructure accounts** without secrets being stored in documents, and (3) how the company **communicates** during a crisis. It extends, and does not replace, the technical procedures listed below.

## Existing technical controls (evidence in this repository)
- Maintenance/degraded modes and live-call design: `RUNBOOK.md` §6.2; multi-provider AI fallback
- Backups, restore drills and restore procedure: `RUNBOOK.md` §5; real state and limits (no RTO/RPO measured): `docs/DB_BACKUP_RESTORE.md`; `dr-backup-run`, `dr-restore-drill`
- Incident severity, roles, on-call rotation, status-page automation: `docs/incident/incident-management.md` (SEV1–SEV4). `RUNBOOK.md` §6.1 uses P1–P3 for the same purpose; the owner must reconcile the two scales **[DECISION]**. This policy uses SEV1–SEV4.
- Secret rotation and leak response: `RUNBOOK.md` §7
- Voice resilience: `docs/runbooks/voice-resilience.md`
- In-app owner break-glass (time-boxed, notifies another owner, mandatory review): `src/lib/authz/jitAccess.ts` (`breakGlass`, 5–60 min, `BREAK_GLASS_REVIEW_HOURS = 24`). Scope is **application permissions only**. `docs/security/identity-authz-audit.md` §8 records the SQL side as not executed and DB break-glass as not done, so this policy does not rely on it.

## 1. Critical services and recovery objectives
Targets are not defined anywhere in the repository and none has been measured (`docs/DB_BACKUP_RESTORE.md`). The company sets them; do not publish them as commitments until a drill has measured them.

| Service | Depends on (from `RUNBOOK.md` §0, §6.3) | RTO | RPO | Degraded-mode fallback |
|---|---|---|---|---|
| Inbound call answering | Vapi, Twilio, `vapi-webhook` edge function, Supabase | [DECISION] | [DECISION] | Live-call path is served by Vapi + edge functions, not the SPA (`RUNBOOK.md` §6.2) |
| Dashboard (SPA) | Vercel, Supabase Auth/Postgres | [DECISION] | [DECISION] | Maintenance/degraded screen (`RUNBOOK.md` §6.2) |
| Billing | Stripe, `billing_events` webhooks | [DECISION] | [DECISION] | Failed Stripe events can be resent; ids are deduplicated (`RUNBOOK.md` §6.3) |
| SMS / email | Twilio (A2P, DNC/STOP gating), Resend | [DECISION] | [DECISION] | [DECISION] |
| Customer data | Supabase (PITR if the plan has it), `dr-backups` bucket | [DECISION] | [DECISION] | Restore procedure, `RUNBOOK.md` §5 |

## 2. Role-criticality matrix
**Tiers (proposed, [DECISION]).**
- **Tier 1** — unavailability of the holder for more than [DECISION: hours] blocks declaring or leading a SEV1 response, restoring service, or reaching a Tier 1 system.
- **Tier 2** — unavailability slows response or recovery, but a workaround exists.
- **Tier 3** — affects business functions, not service continuity, within seven days.

**Rules (proposed, [DECISION]).**
1. Every Tier 1 and Tier 2 role has a primary and a **named backup**; the two are different people.
2. The backup holds **their own** account and role in each system. Sharing a login is never a backup arrangement.
3. One person is not the sole holder of two Tier 1 roles. Where the company is too small to avoid this, record it in the "Single point of failure" column and treat it as an open risk.
4. The matrix is reviewed when someone joins, leaves or changes role (see `onboarding-offboarding.md`), after every SEV1 postmortem, and at least annually.

| Role | Why it matters | Can unlock | Tier | Primary | Named backup | Single point of failure? |
|---|---|---|---|---|---|---|
| Executive owner | Authorises external statements, spend and legal contact; likely legal owner of provider accounts **[VERIFY]** | Provider ownership, contracts, press | 1 | [NAME: executive owner] | [NAME: backup executive] | [DECISION] |
| Engineering lead | Architecture, deploy and database decisions | Repo, deploys, Supabase | 1 | [NAME: engineering lead] | [NAME: backup engineer] | [DECISION] |
| Incident commander (on-call primary / secondary) | Owns severity and decisions during an incident (`docs/incident/incident-management.md`) | Incident channel, PagerDuty | 1 | [NAME: on-call primary] | [NAME: on-call secondary] | [DECISION] |
| Release & CI owner | Rollback and deploy (`RUNBOOK.md` §2, §4) | GitHub, Vercel, edge-function deploy | 1 | [NAME: release owner] | [NAME: backup release owner] | [DECISION] |
| Database & backup owner | Restore decisions; the repo leaves "who can trigger a restore" undecided (`RUNBOOK.md` §5) | Supabase, `dr-backups` | 1 | [NAME: database owner] | [NAME: backup database owner] | [DECISION] |
| Telephony & voice owner | Live call answering, A2P registration | Twilio, Vapi | 1 | [NAME: telephony owner] | [NAME: backup telephony owner] | [DECISION] |
| Security & compliance owner | Secret rotation, breach-notification decision owner (open gap in `incident-response.md`) | Secrets, audit logs | 1 | [NAME: security owner] | [NAME: backup security owner] | [DECISION] |
| Domain, DNS & workforce identity admin | Loss of DNS or the identity/email provider stops the site and recovery emails. Registrar and identity provider are not named in the repo | Registrar, DNS, email/SSO | 1 | [NAME: DNS / identity admin] | [NAME: backup DNS / identity admin] | [DECISION] |
| Billing & payments owner | Stripe, webhook secrets, refunds | Stripe | 2 | [NAME: billing owner] | [NAME: backup billing owner] | [DECISION] |
| Communications lead | Status page and customer notices (`incident-management.md` roles) | Status provider, `notify-status-subscribers` | 2 | [NAME: comms lead] | [NAME: backup comms lead] | [DECISION] |
| Customer support lead | Customer contact during outages | Support inbox | 2 | [NAME: support lead] | [NAME: backup support lead] | [DECISION] |
| Finance / administrator | A lapsed payment can suspend a provider account **[VERIFY per provider]** | Provider billing, invoices | 2 | [NAME: finance owner] | [NAME: backup finance owner] | [DECISION] |
| External legal counsel / privacy contact | Regulator and breach-notice advice | — | 2 | [NAME: counsel firm / contact] | [NAME: second contact] | [COUNSEL] |

## 3. Named backup per critical system
Each system needs two humans who can administer it under their own identities. Break-glass (section 4) is the last resort when both are unreachable, not a substitute for this table.

| System | What stops without it (source) | Account owner role | Primary admin | Backup admin | Recovery / break-glass note |
|---|---|---|---|---|---|
| Supabase (Postgres, Auth, Realtime, Storage, Edge Functions, `pg_cron`) | Nearly everything (`RUNBOOK.md` §0) | Executive owner | [NAME] | [NAME] | Org/project owner transfer path **[VERIFY]**; service-role key leak = SEV1 (`RUNBOOK.md` §7) |
| Vercel | Dashboard SPA, headers/rewrites (`vercel.json`) | Release owner | [NAME] | [NAME] | Team ownership transfer **[VERIFY]** |
| GitHub (repo, Actions) | CI, security gates, edge deploy | Release owner | [NAME] | [NAME] | Org owner count and branch protection **[VERIFY]** |
| Domain registrar and DNS | Site, email authentication, provider callbacks | DNS / identity admin | [NAME] | [NAME] | Registrar and DNS host **[VERIFY]**; registrar-lock and recovery contact **[VERIFY]** |
| Workforce identity / email | Every provider's account-recovery email | DNS / identity admin | [NAME] | [NAME] | Provider not named in the repo **[VERIFY]** |
| Stripe | Billing, checkout, webhooks | Billing owner | [NAME] | [NAME] | Resend failed events after recovery (`RUNBOOK.md` §6.3) |
| Twilio | Telephony, SMS, A2P brand/campaign | Telephony owner | [NAME] | [NAME] | A2P registration is tied to the legal business name/EIN (`docs/brand/RESTRUCTURE_RUNBOOK.md`) |
| Vapi | Voice assistant, call webhooks | Telephony owner | [NAME] | [NAME] | Server URL secret must match `VAPI_SERVER_SECRET` (`RUNBOOK.md` §6.3) |
| Resend | Transactional email | Telephony owner | [NAME] | [NAME] | — |
| Plaid | Bank connections (customer-optional) | Billing owner | [NAME] | [NAME] | — |
| AI providers (Gemini, Groq, Cerebras, Cloudflare Workers AI, OpenRouter; others per `ARCHITECTURE.md`) | AI answers; chain falls back automatically (`RUNBOOK.md` §6.3) | Engineering lead | [NAME] | [NAME] | Keys held per `docs/generated/ENV_USAGE.md` |
| Status page provider | Customer-facing incident status (`VITE_STATUS_API_URL`) | Comms lead | [NAME] | [NAME] | Provider not named in the repo **[VERIFY]** |
| PagerDuty / chat | Paging (`incident-management.md` names PagerDuty and `#voice-alerts`) | Incident commander | [NAME] | [NAME] | Out-of-band contact list in section 5 |
| Secret vault / password manager | Custody of break-glass credentials | Security owner | [NAME] | [NAME] | None is named in the repo **[DECISION]** |

## 4. Break-glass access procedure for infrastructure and provider accounts
**Purpose.** Regain control of a provider or infrastructure account when its named admins (section 3) cannot act and the action is needed to restore or protect service.

**What this document must never contain:** passwords, API keys, recovery codes, MFA seeds, session tokens, or screenshots of any of them. It records only *who*, *where the sealed item is kept* and *how access is requested* (see `RUNBOOK.md` §7: never paste secrets into chats or tickets; gitleaks runs in `security.yml`).

### 4.1 Custody (company decisions to fill in)
| Item | Held by (role) | Location pointer (not the secret) | Second custodian |
|---|---|---|---|
| Break-glass account credentials per Tier 1 system | [NAME: security owner] | [DECISION: approved vault entry name or sealed envelope location] | [NAME: second custodian] |
| Hardware MFA keys / recovery codes for those accounts | [NAME: custodian] | [DECISION: physical safe location] | [NAME: second custodian] |
| Out-of-band contact list (phone numbers) | [NAME: executive owner] | [DECISION: location] | [NAME: second custodian] |

Principles: two custodians in different places; the MFA factor and the password are not stored together; break-glass accounts are named and logged, never shared daily-use logins; MFA is never switched off to make access easier. Mandatory workforce MFA is an open gap in `access-control.md` and should be closed first.

### 4.2 When it may be used
All of the following:
1. A SEV1 or SEV2 incident is declared, or a Tier 1 role is unavailable and a Tier 1 system is blocked.
2. The primary **and** backup admin for that system have been tried by phone through the out-of-band list and cannot act within [DECISION: minutes].
3. The needed action is specific (for example, rotate a leaked key, roll back a deploy, transfer account ownership), and the provider's normal account recovery would take too long.

### 4.3 Steps
1. **Declare.** Post in the incident channel: incident id, system, why admins are unreachable, intended action. Start the break-glass register entry (4.5).
2. **Two-person rule.** A second authorised person — the incident commander or executive owner, and not the person who will use the access — approves in writing in the channel.
3. **Retrieve.** The custodian releases the credential through the custody method in 4.1, with the second custodian present or informed. Record the time.
4. **Use narrowly and briefly.** Do only the approved action. Keep the session within [DECISION: proposed ≤ 60 minutes, matching the in-app break-glass maximum in `jitAccess.ts`]. Narrate each action in the channel.
5. **Do not widen.** No unrelated changes, no new permanent users, no weakened auth or RLS (`RUNBOOK.md` golden rules). If a permanent fix needs a new admin, create a normal named account afterwards.
6. **End.** Sign out. **Rotate** the break-glass credential and any secret that was exposed (`RUNBOOK.md` §7), and re-seal the new credential with the custodians. Re-issue MFA recovery material if it was used.
7. **Review within 24 hours** by someone who did not use the access (mirrors `BREAK_GLASS_REVIEW_HOURS`). Compare the register with the provider's own audit log where one exists **[VERIFY per provider]**. Open follow-ups with owners and dates.

### 4.4 Provider-specific recovery notes
Each provider has its own ownership-transfer and account-recovery process. This repository does not establish what those processes require, so each row is a task for the system's backup admin to verify and record **before** a crisis.

| System | To record in advance (no secrets) |
|---|---|
| Supabase, Vercel, GitHub, Stripe, Twilio, Vapi, Resend, Plaid, registrar/DNS, identity/email | Who the account owner of record is; how many owners exist; what the provider requires to prove ownership or recover the account **[VERIFY]**; support contact path; whether a second owner is configured |

### 4.5 Break-glass register (template; keep outside the repository)
| Date (UTC) | Incident id | System | Used by | Approved by | Reason | Start–end | Actions taken (summary) | Credential rotated (Y/N, when) | Reviewer | Review date |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |

Register location: [DECISION: access-restricted location; never this repository if it would name accounts or hold secrets].

## 5. Crisis plan

### 5.1 Activation
Activate the crisis plan when any of the following occurs:
- A SEV1 is declared (`docs/incident/incident-management.md`).
- A suspected data exposure, ransomware or account takeover.
- A Tier 1 role holder or a Tier 1 provider account becomes unavailable for more than [DECISION: hours].
- A provider outage or legal/regulatory action threatens continuity beyond [DECISION: hours].

The incident commander activates; the executive owner is told immediately. The crisis team reuses the incident roles (incident commander, operations lead, comms lead, scribe) and adds an **executive sponsor** and a **counsel liaison**.

### 5.2 Communication tree
| Step | Who | How reached | Backup if unreachable |
|---|---|---|---|
| 1 | Incident commander | PagerDuty | [NAME: on-call secondary] |
| 2 | Executive owner | [PHONE] | [NAME: backup executive] |
| 3 | Security owner (if data or credentials) | [PHONE] | [NAME: backup security owner] |
| 4 | Counsel / privacy contact | [PHONE / EMAIL] | [NAME: second counsel contact] |
| 5 | Comms lead | [PHONE] | [NAME: backup comms lead] |
| 6 | Affected provider support | [Support contact per provider] | — |

The list must also exist **outside** the systems that may be down (for example paper or a personal-device copy held by two people) **[DECISION]**.

### 5.3 Key-person unavailability playbook
1. **Confirm** the person cannot be reached or acts for the company (phone via the out-of-band list; second attempt by their backup).
2. **Activate the named backup** for each role and system the person held (sections 2–3). Announce it in the incident channel.
3. **Regain access** through the backup's own accounts. Use break-glass (section 4) only if the backup lacks access.
4. **Secure what the person held.** If departure is not routine or trust is in doubt, revoke their sessions and rotate secrets they could reach (`RUNBOOK.md` §7; `onboarding-offboarding.md`). Handle HR and legal aspects with counsel **[COUNSEL]**.
5. **Record** gaps found (missing backup, missing documentation) as actions with owners and dates.
6. **Update** the matrix; a backup who has taken over becomes primary or a new backup is named.

### 5.4 First-hour checklist
- [ ] Severity confirmed and incident channel open; scribe named
- [ ] Executive sponsor informed; crisis team roles assigned
- [ ] Containment decided (maintenance/degraded mode, unschedule a job, revoke a key — `RUNBOOK.md` §6.2)
- [ ] First status-page / customer holding message approved by the executive sponsor (templates below)
- [ ] Legal assessment started if personal data may be involved **[COUNSEL]**
- [ ] Evidence preserved (logs, `audit_log`, provider logs) before changes are made
- [ ] Next update time announced

### 5.5 Approval of external statements
Customer notices: comms lead drafts, executive sponsor approves. Regulator notices and anything about personal data: counsel reviews before sending **[COUNSEL]**. Press: only the named spokesperson [NAME: spokesperson], after executive approval. Statements must not contradict `src/lib/trust/claims.ts`, and must not state a security certification, attestation or audit result that the company does not hold.

## 6. Crisis communication templates
Replace every `[PLACEHOLDER]`. State only facts that have been confirmed; say "we are investigating" for the rest. Do not speculate about cause, do not say "no data was accessed" unless that has been verified, and do not promise a restoration time you cannot meet. Deliver customer notices through the mechanisms in `RUNBOOK.md` §6.2 (status page, `notify-status-subscribers`, maintenance message). Drill sends must use a test list only (section 7).

### 6.1 Customers — service disruption (initial)
> **Subject:** [Vireek] [Service affected] — we are investigating
>
> At [START_TIME_UTC] we identified a problem affecting [SERVICES_AFFECTED]. [Impact in plain words, e.g. "some inbound calls may not be answered by the assistant" — only if confirmed.] We are working on it and will update you by [NEXT_UPDATE_TIME_UTC].
>
> What you can do now: [WORKAROUND_OR_"nothing is needed from you"].
>
> Status: [STATUS_PAGE_URL] · Contact: [SUPPORT_CONTACT]

### 6.2 Customers — update
> **Subject:** [Vireek] Update on [SERVICES_AFFECTED]
>
> As of [TIME_UTC]: [CONFIRMED_FACTS]. [What changed since the last update.] Next update by [NEXT_UPDATE_TIME_UTC] or sooner if the situation changes.

### 6.3 Customers — resolved
> **Subject:** [Vireek] Resolved: [SERVICES_AFFECTED]
>
> The issue affecting [SERVICES_AFFECTED] was resolved at [END_TIME_UTC]. It began at [START_TIME_UTC]. [Confirmed impact.] [Any action the customer should take, e.g. review missed calls between X and Y.] We will publish a summary of what happened and what we are changing by [POSTMORTEM_DATE].

### 6.4 Customers — data incident notice
Send only after the legal assessment **[COUNSEL]**. Customers are usually controllers of their callers' data and Vireek their processor (`docs/compliance/transfers-and-contracts.md`); contractual and legal notice duties to customers **[COUNSEL]**.
> **Subject:** Important: security incident affecting [DATA_CATEGORIES]
>
> On [DISCOVERY_DATE] we discovered [CONFIRMED_DESCRIPTION OF WHAT HAPPENED]. Based on our investigation so far, the following data was involved: [CONFIRMED_DATA_CATEGORIES AND, IF KNOWN, APPROXIMATE NUMBER OF RECORDS]. [What we have done to contain it.] [What we recommend you do.] Our investigation is ongoing and we will update you by [DATE]. Contact: [PRIVACY_CONTACT].

### 6.5 Regulators — initial notification (skeleton)
Which authorities, deadlines and formats apply depends on the jurisdictions, the data involved and Vireek's role as controller or processor. Deadlines and content requirements: **[COUNSEL][VERIFY]**. The text below is a fact skeleton for counsel, **not** a ready-to-send notice. Counsel decides whether notification is required and signs off the final text.
> To: [AUTHORITY_AND_CHANNEL per counsel]
> From: [LEGAL_ENTITY_NAME], [ADDRESS], contact [NAME, ROLE, EMAIL, PHONE]
> 1. Nature of the incident: [CONFIRMED_DESCRIPTION]
> 2. Date/time of occurrence and discovery: [DATES_UTC]
> 3. Categories and approximate number of data subjects and records: [CONFIRMED_OR_"under investigation"]
> 4. Likely consequences: [ASSESSMENT agreed with counsel]
> 5. Measures taken or proposed: [CONTAINMENT_AND_REMEDIATION]
> 6. Whether affected individuals / customers have been or will be notified, and when: [PLAN]
> 7. Further updates: [PROMISED_DATE]
>
> Any item not yet known is stated as "under investigation", with the date the information will follow.

### 6.6 Press — holding statement
> [LEGAL_ENTITY_NAME] is aware of [CONFIRMED_ONE_LINE_DESCRIPTION]. Our teams are working to [restore service / investigate]. We will share verified updates at [STATUS_PAGE_URL]. For questions: [SPOKESPERSON_CONTACT].

### 6.7 Press — statement after facts are confirmed
> On [DATE], [LEGAL_ENTITY_NAME] [CONFIRMED_WHAT_HAPPENED]. [Confirmed impact on customers or data.] We [actions taken]. We have notified [customers / authorities — only if true and counsel-approved]. We are [next steps]. [SPOKESPERSON_CONTACT].

**Press rules:** one spokesperson; no off-the-record comment; no blame on a named provider before facts are confirmed and the provider has been contacted; no number, cause or timeline that is not confirmed; hand every legal or regulatory question to counsel **[COUNSEL]**.

## 7. Annual drill checklist
Cadence: at least once every 12 months, and after any SEV1 that exposed a continuity gap. This matches the 365-day frequency proposed for control AVL-04 in `docs/compliance/soc2/controls.json`. A drill is evidence of an exercise, not of compliance.

**Preparation**
- [ ] Drill lead named [NAME: drill lead] (not the person being tested for the main scenario) and date set
- [ ] Scenarios chosen, at minimum: (a) a Tier 1 key person unreachable, (b) a provider account locked out with admins unreachable, (c) suspected data exposure with external communication
- [ ] Production data is not modified; any live test is on a test account, test list or sandbox; real subscribers are **not** notified
- [ ] Observers and scribe assigned

**Roles and backups**
- [ ] Matrix (section 2) reviewed: every named person still works here and still holds the role
- [ ] Each Tier 1 backup completes a defined task in their own account without the primary (for example a read-only login, a rollback rehearsal in a preview, a test status update)
- [ ] Single points of failure counted; open ones have owners and dates

**Break-glass**
- [ ] Custody list reviewed; both custodians reachable; locations still correct
- [ ] Dry run on a test account or sandbox: request, two-person approval, retrieval, narrow use, sign-out, rotation, 24-hour review
- [ ] Register template used and stored in the restricted location; no secret appeared in chat, ticket or document

**Recovery**
- [ ] Latest `dr-backup-run` and `dr-restore-drill` rows checked in `platform_backup_runs` / `platform_restore_drills` (`RUNBOOK.md` §5)
- [ ] Recovery time actually measured and written into section 1 (replacing [DECISION]) after management agrees the target
- [ ] Rollback (`RUNBOOK.md` §4) rehearsed by the backup release owner

**Communications**
- [ ] Out-of-band contact list tested by phone (answered / not answered recorded)
- [ ] Templates 6.1–6.7 filled in for the drill scenario by the comms lead; approvals followed section 5.5
- [ ] Status-page and email delivery tested to a **test** audience only
- [ ] Counsel confirmed the regulator skeleton (6.5) is still current for the jurisdictions served **[COUNSEL]**

**After action**
- [ ] Timeline, what worked, what failed, within five business days
- [ ] Actions with owner and due date; tracked to done
- [ ] This policy, `RUNBOOK.md` and `docs/incident/incident-management.md` updated where the drill showed a mismatch
- [ ] Record stored at [DECISION: evidence location] and the next drill date set

| Drill record | |
|---|---|
| Date / scenarios | |
| Participants and roles | |
| Measured times (declare, backup takes over, break-glass, first customer message, restore) | |
| Findings | |
| Actions (owner, due date) | |
| Approved by | |

## Document control
Review at least annually, after every SEV1 postmortem, and when a named person leaves or a critical provider is added or replaced. Owner and approver are not yet assigned.

## Gaps the owner must close before approval
- Continuity plan: names for every `[NAME: …]`, objectives for every `[DECISION]`, and the Tier definitions and thresholds adopted
- Critical-service list and communication tree: confirm sections 1 and 5.2 with real people and reachable out-of-band contacts
- Break-glass custody: choose the vault or sealed-envelope method, appoint two custodians, verify each provider's ownership-recovery process **[VERIFY]**
- Mandatory MFA for workforce accounts (open in `access-control.md`)
- Registrar/DNS, identity/email and status-page providers are not named anywhere in the repository **[VERIFY]**
- Counsel review of notice duties, deadlines and all templates in section 6 **[COUNSEL]**
- Reconcile severity scales (SEV1–SEV4 vs P1–P3)
- Evidence pipeline: `docs/compliance/soc2/controls.json` now points to the policies that exist under `docs/compliance/policies/`, and `scripts/compliance/collect-repo.mjs` reads that directory; approval is still reported only as `draft`/`pending` until a human approves. Three evidence templates under `docs/compliance/soc2/templates/` are blank and are not evidence until filled in and signed
