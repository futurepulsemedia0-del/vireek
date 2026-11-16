# AI incident response policy

> **DRAFT — not approved.** Owner: _to be assigned_ · Approved by: _pending_ · Last review: _pending_. Adopting this text is a company decision; it makes no compliance claim (see `src/lib/trust/claims.ts`). Items marked **[COUNSEL]** are legal decisions that must be made by qualified counsel; items marked **[VERIFY]** are facts nobody has confirmed against the live system or a vendor.

## 1. Purpose and scope

How incidents caused by Vireek's AI agents (voice agent, assistants, diagnostic and pricing helpers) are classified, owned, contained, communicated and reviewed. It **extends** — and does not replace — these documents:

| Document | What it already covers |
|---|---|
| `incident-response.md` (this folder) | General incident policy (draft) |
| `docs/incident/incident-management.md` | SEV1–SEV4 definitions, on-call, update cadence, status page, lifecycle |
| `docs/security/voice-incident-response.md` (Persian) | Voice-agent detection sources, kill switch (`voice_set_my_mode` / `voice_set_mode`), audit chain verification, regression steps |
| `RUNBOOK.md` §6 | P1–P3 triage and maintenance mode |

An **AI incident** is any event where an AI agent's output or action caused, or could plausibly have caused, harm to a customer, a customer's end-customer, or Vireek: incorrect or unsafe content, an unauthorised commitment or write, a disclosure of personal data or secrets, or unequal treatment of people. A blocked attack with no effect is a *security event*, not automatically an incident (see §3, prompt injection).

## 2. Register

Every AI incident is recorded in the staff-only register (`ai_incidents`, page `/staff/ai-incidents`, migration `20290304000000_ai_incidents.sql`).

- **Never** put transcripts, prompts, names, phone numbers or e-mail addresses in the register. Use identifiers: `call_id`, the `ai_security_events` id, a ticket or postmortem reference. The database rejects obvious e-mail addresses; it cannot detect other personal data — the person writing is responsible.
- Records cannot be deleted by staff (they are evidence). Corrections are made by editing status and adding a postmortem reference. Retention period: **[COUNSEL]**.
- Tenants have no access to the register. Customer-facing communication is separate (§6).

## 3. Incident taxonomy

Register value in `code`. "Default severity" is the starting point; the incident commander may raise or lower it (when unsure, pick the higher one).

| Type (`code`) | Definition | Typical detection | Default severity | Default owner role | First containment step |
|---|---|---|---|---|---|
| **Wrong diagnosis** (`wrong_diagnosis`) | An AI diagnostic or troubleshooting answer is materially wrong, or omits a safety-relevant warning, and a customer or technician acted on it or was about to. | Technician or customer report, QA review, eval regression | **Medium**; **High** if the guidance involves a safety hazard (e.g. gas, electrical, refrigerant) or was acted on | `engineering_lead` | Disable the affected feature or knowledge source; add a "verify with a qualified person" step until fixed |
| **Wrong price commitment** (`wrong_price_commitment`) | An AI agent quotes, promises, discounts or books at a price or terms that differ from the configured price book or policy, or invents a price. | Customer dispute, invoice mismatch, price-policy check, call review | **Medium**; **High** if more than one customer is affected or the commitment was made in writing (SMS, e-mail, quote) | `support_lead` | Pause AI quoting for the affected tenant(s); decide whether the price is honoured. Whether an AI-stated price binds the business: **[COUNSEL]** |
| **PII leak on a call** (`pii_leak_on_call`) | Personal data (or a secret/canary) is disclosed to someone not entitled to it, spoken, sent by SMS/e-mail, or written to a transcript/webhook. | `ai_security_events` `output_leak`; `voice_security_audit` codes `canary_hit`, `prompt_canary_in_transcript`, `cross_customer`, `secret_in_tool_result`; customer report | **Critical** (confirmed or strongly suspected disclosure) | `security_lead` | Kill switch to `lockdown` for the tenant (or global) per `voice-incident-response.md` §2; rotate secrets if a key or canary leaked |
| **Discriminatory behavior** (`discriminatory_behavior`) | An AI agent treats a person worse, or uses demeaning or stereotyping language, based on a protected characteristic, accent, name, language or perceived disability — in speech, text, routing, prioritisation or pricing. | Customer complaint, QA/eval finding, review of call samples | **High** (single confirmed instance); **Critical** if systematic or affecting service access or price | `ai_safety_lead` | Roll back the prompt/persona/model change that introduced it; suspend any feature using the affected signal. Legal characterisation and exposure: **[COUNSEL]** |
| **Prompt injection** (`prompt_injection`) | Untrusted input (caller speech, web content, a document, a tool result) changes the agent's instructions or behavior. | `ai_security_events` `prompt_injection`, `sandbox_violation`; anomaly score; VDP report | **Low/Medium** blocked attempt (usually *not* an incident — keep as a security event unless it is a campaign); **High** if a control such as step-up was bypassed; **Critical** if data was disclosed or an unauthorised write happened | `security_lead` | Lockdown or restricted mode; block the source; follow `voice-incident-response.md` |
| **Other** (`other`) | AI harm that fits none of the above. Reclassify when a pattern emerges. | Any | Per §4 | `ai_safety_lead` | Per §4 |

An incident may involve more than one type (e.g. an injection that causes a PII leak). Register it under the type with the **highest severity** and describe the rest in the summary.

## 4. Severity levels

Severity uses the register's four values and maps to the existing scales; response, update and status-page targets are **inherited** from `docs/incident/incident-management.md` and are not new commitments.

| Register severity | Existing SEV / P | AI criteria (any one) | Postmortem |
|---|---|---|---|
| **critical** | SEV1 / P1 | Personal data or secrets disclosed; unauthorised write or payment-affecting action; systematic discriminatory behavior; safety-critical wrong guidance acted on | Required, within 5 business days |
| **high** | SEV2 / P2 | A control was bypassed without data loss; a confirmed single discriminatory instance; wrong price committed in writing; several customers affected | Required |
| **medium** | SEV3 / P3 | One customer affected, no disclosure, no binding commitment; wrong guidance caught before it was acted on | Optional; reviewed quarterly if recurring |
| **low** | SEV4 | Near miss or blocked attack worth tracking | No |

Rules: the register refuses to close a **high** or **critical** incident without a postmortem reference. Severity may be changed at any time; record why in the summary.

## 5. Owner roles

These are **roles, not people**. The repository defines no roster or on-call assignment (`RUNBOOK.md` §6.1, item 11); assigning named individuals and deputies is a gap the owner must close before approval.

| Role (`owner_role`) | Responsibility |
|---|---|
| **AI safety lead** (`ai_safety_lead`) | Acts as incident commander for AI-behavior incidents (diagnosis, discrimination); owns severity, the postmortem and the regression case |
| **Security lead** (`security_lead`) | Incident commander for PII leaks and prompt injection; containment (kill switch, key rotation); evidence integrity (`voice_audit_verify_chain`) |
| **Engineering lead** (`engineering_lead`) | Root-cause fix, rollback, eval/red-team regression, monitoring rule |
| **Support lead** (`support_lead`) | Customer contact, remediation (credits, honouring prices), tracking customer complaints |
| **Legal counsel** (`legal_counsel`) | Decides every notification question in §6; reviews customer and regulator wording. Not an employee role by default — **[COUNSEL]** to confirm who fills it |

One person may hold several roles in a medium or low incident. For critical incidents the commander and the counsel contact must be different people.

## 6. Notification clocks

**No notification deadline is stated in this draft.** Legal deadlines depend on jurisdiction, data type, contracts and facts, and are decided by counsel. Engineering's job is to make the decision possible fast: record `detected_at` accurately and bring counsel in early.

| Audience | Trigger to assess | Clock | Decision owner | Register field |
|---|---|---|---|---|
| Incident commander and on-call | Any critical or high incident | Per `docs/incident/incident-management.md` (SEV1: IC and comms lead within 10 minutes) | AI safety lead / Security lead | — |
| Affected customer (account owner) | Any confirmed or suspected disclosure of personal data, an unauthorised action, or a binding wrong commitment | **[COUNSEL]** ___ hours from awareness; contractual DPA terms may set a different clock (see `docs/compliance/gap-list.md` L2) | Legal counsel | `customer_notification` |
| Affected individuals (the customer's own customers/callers) | Personal-data disclosure | **[COUNSEL]** whether Vireek, the customer, or both notify; clock ___ | Legal counsel | `customer_notification` |
| Regulators / supervisory authorities | Personal-data breach, or an AI-specific serious-incident duty | **[COUNSEL]** ___ hours from awareness, per jurisdiction. Counsel to evaluate, non-exhaustively and **[VERIFY]** applicability: GDPR breach duties, US state breach-notification laws and CCPA (as `voice-incident-response.md` §4 already notes), Quebec Law 25 (`gap-list.md` L11), EU AI Act role and incident duties (`gap-list.md` L6) | Legal counsel | `regulator_notification` |
| Sub-processors / providers (model, telephony) | Provider-side cause suspected | **[COUNSEL]** per vendor contract **[VERIFY]** | Security lead with counsel | — |
| Cyber-insurance carrier | Any critical incident | **[COUNSEL]** **[VERIFY]** — no policy is referenced in this repository | Legal counsel | — |
| VDP reporter | Report came through the vulnerability disclosure channel | Acknowledge per `SECURITY.md` | Security lead | — |

**Awareness.** Until counsel defines when a clock starts, engineering treats the register's `detected_at` as the start and records it honestly; do not backdate. **[COUNSEL]** to confirm.

**Register states** for both notification fields: `not_assessed` (default, must not remain on a critical or high incident past triage) → `counsel_review` → `sent` or `not_required`. Use `sent` only after counsel has approved the wording; record who decided and why in the postmortem. Never use `not_required` without counsel's agreement on a critical incident.

**Communication rules:** state facts, no speculation, no personal data, no blame on a vendor; status-page text comes from the existing templates and is reviewed by the comms lead; customer wording is approved by counsel first.

## 7. Response workflow

1. **Detect** — from the sources in §3. A security event alone does not create an incident; a person decides.
2. **Declare** — create the register entry (no personal data); name the owner role; open the incident channel per `incident-management.md`.
3. **Contain** — mitigate first, diagnose second: kill switch / mode change, feature flag off, rollback, key rotation, call termination. The system only *proposes* mode changes; a human decides.
4. **Preserve evidence** — verify the audit chain (`select public.voice_audit_verify_chain('<tenant>');`) before changing anything that could alter it. Keep raw material only where it already lives, with its existing access controls; do not copy it into the register or chat.
5. **Assess notification** — bring in counsel (§6) within the SEV1/SEV2 window; set both notification fields.
6. **Fix and regress** — root cause; add a failing scenario first (`eval/voice-redteam/scenarios.ts` for injection and leakage; the relevant eval suite for diagnosis, pricing and fairness), then confirm it passes. `npm run test:redteam` must keep critical attack-success-rate at 0. Return the tenant to `normal` and monitor 24 hours.
7. **Postmortem** — blameless, within 5 business days for critical/high (§8).
8. **Close** — only when action items have owners and dates; high/critical need the postmortem reference.

## 8. AI-specific postmortem template

Copy into the incident's postmortem document. Reference it from the register's `postmortem_ref`. Contains no personal data.

```markdown
# Postmortem — <ref, e.g. AI-2029-00012>: <short title>

**Type / severity:** <type> · <low|medium|high|critical>   **Commander:** <role>   **Date written:** <date>
**Status of this document:** draft | reviewed by <role>

## 1. Summary (3–5 sentences, plain language)

## 2. Impact
- Customers (accounts) affected: <count>   Calls / sessions affected: <count>
- Categories of data involved (categories only, never values): <e.g. phone number, address, none>
- Money: <quoted vs correct price, credits issued, revenue at risk>   Safety: <yes/no, what>
- Duration: detected <ts> · contained <ts> · resolved <ts>

## 3. Timeline (UTC)
| Time | Event | Source (audit row, alert, ticket id) |

## 4. Detection
How was it found? Which control should have found it, and how long did we miss it?

## 5. AI behavior analysis
- Agent / feature: <name>   Model + provider + version: <>   Prompt / persona version: <>
- Tools called and with what permission level: <>
- Knowledge or retrieval source involved: <>
- Failure class: ☐ model behavior ☐ prompt/persona ☐ retrieval/knowledge ☐ tool or permission scope ☐ guardrail gap ☐ untrusted input ☐ data quality ☐ provider change ☐ human process
- Was a human in the loop? Should one have been? <>
- Was the caller told they were speaking with an AI (disclosure ledger entry)? <yes/no/n.a.>
- Reproducible? <yes: scenario id / no: why>

## 6. Controls review
| Control layer (kill switch, allowlist, injection scan, caller-binding, step-up, confirm-before-write, output filter, audit) | Worked / failed / absent | Note |

## 7. Root cause and contributing factors (blameless)

## 8. Customer remediation and communication
- Remediation decided (price honoured, credit, correction): <> — decided by <role>
- Customer notification: <not required | sent on <ts>> — decision owner **[COUNSEL]**
- Regulator notification: <not required | sent on <ts>> — decision owner **[COUNSEL]**
- Public / status-page communication: <>

## 9. What went well / what went badly / where we got lucky

## 10. Action items
| # | Action | Type (detect / prevent / mitigate / process) | Owner (role) | Due | Done |
Required: at least one **regression test** (scenario id: ______) and one **detection or monitoring** change; or a written reason why not.

## 11. Open questions and anything not verified [VERIFY]
```

## 9. Review and exercises

- Quarterly (with the review in `incident-management.md`): incidents by type and severity, repeat root causes, open postmortem actions older than 30 days, near misses worth promoting to incidents.
- At least one AI-incident tabletop per year covering a PII leak and a discriminatory-behavior case, with counsel present. Cadence is a proposal for the owner to adopt.

## 10. Gaps the owner must close before approval

- Name the people behind each role (§5) and a deputy for each; confirm the counsel contact **[COUNSEL]**.
- Counsel to set every notification clock, the "awareness" definition, record-retention periods and the insurer/vendor duties in §6 **[COUNSEL]**.
- Decide who may use the kill switch outside business hours, and test it in a drill.
- Define the fairness and pricing eval suites referenced in §7 step 6 where they do not yet exist **[VERIFY]**.
