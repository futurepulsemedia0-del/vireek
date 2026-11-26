# Crisis communications

> **Status: DRAFT fill-in template. Not legal advice.** Every holding statement below is a draft until counsel has approved it (`TODO(counsel)`). Names, phone numbers, addresses and time limits are `TODO(owner)`.
> This page decides **who says what, to whom, through which channel, with whose approval**. It sits on top of the technical runbooks and does not replace them.
> Owner: `TODO(owner)` · Counsel: `TODO(counsel)` · Last drill: `TODO(owner)` · Next review: `TODO(owner)`

## 1. Start here

| If it is... | Technical runbook | Comms path | Section |
|---|---|---|---|
| Data breach / suspected exposure of personal or customer data | [incident-response](../runbooks/incident-response.md), [breach-notification](../runbooks/breach-notification.md) | Counsel-led, **outside** the status tool | 5 |
| The AI voice agent behaved wrongly on a call | [voice-incident-response](../security/voice-incident-response.md) (Persian), [ai-policy](../ai-governance/ai-policy.md) | Affected customer first; becomes a breach if data was exposed | 5 |
| Outage or degradation | [voice-provider-outage](../runbooks/voice-provider-outage.md), [database-outage](../runbooks/database-outage.md), [incident-response](../runbooks/incident-response.md) | Status tool, templates already exist | 5 |
| Legal claim, demand letter, regulator inquiry | [legal-request-process](../compliance/legal-request-process.md) (covers requests for customer data only) | Counsel decides everything | 5 |

Severity, on-call and lifecycle: [incident-management](../incident/incident-management.md) (data exposure suspected is SEV1 there). Customer wording for outages: [incident-comms](../runbooks/incident-comms.md). Post-incident write-up: [post-incident-template](../runbooks/post-incident-template.md). Public status page: route `/status` (`src/pages/StatusPage.tsx`).

## 2. Rules for every message

1. Nothing leaves the company until a named person has read the exact text and approved it.
2. Facts only: what customers see, what we are doing, when the next update comes (UTC). No cause until it is confirmed.
3. No guarantees, no blame, no speculation, no customer names or personal data, no provider or vendor names.
4. One voice: only the comms lead or spokesperson speaks. Everyone else forwards.
5. Anything about personal data, security exposure, legal duties or money goes through counsel first. `TODO(counsel)`
6. Keep the update cadence even when nothing changed ("no change, next update by `<time>`").
7. Write down every sent message with time, author, approver, channel. The incident channel `#inc-YYYYMMDD-short-name` is the record.

## 3. Roles

Roles match [incident-management](../incident/incident-management.md); one person may hold several roles in a SEV3.

| Role | Does | Must not | Primary | Backup |
|---|---|---|---|---|
| Incident commander (IC) | Declares severity, owns decisions, approves SEV1/SEV2 outage text | Draft the text they approve | `TODO(owner)` | `TODO(owner)` |
| Comms lead | Drafts, posts, keeps the cadence, logs every message | Approve their own SEV1/SEV2 draft | `TODO(owner)` | `TODO(owner)` |
| Technical lead | Tells the comms lead in plain words what customers experience | Talk to customers or press | `TODO(owner)` | `TODO(owner)` |
| Executive / owner | Final approval for breach, legal and media statements | | `TODO(owner)` | `TODO(owner)` |
| Counsel | Reviews and approves anything on data, legal duties, regulators, claims | | `TODO(counsel)` | `TODO(counsel)` |
| Spokesperson (press, regulators, public) | The only voice outside customers and status | Improvise | `TODO(owner)` | `TODO(owner)` |
| Support lead | Uses published wording only; escalates anything new | Explain causes or promise outcomes | `TODO(owner)` | `TODO(owner)` |
| Scribe | Timeline in the incident channel | | `TODO(owner)` | `TODO(owner)` |

Where only one person exists: see [owner-incapacity-emergency-access](../runbooks/owner-incapacity-emergency-access.md) and name an outside deputy here: `TODO(owner)`.

## 4. Channels

| Channel | Audience | Who can use it | Notes |
|---|---|---|---|
| Status page `/status` | Everyone | Comms lead via `/staff/incident-comms` | Outages and degradations only. Never breach or legal wording. |
| Email to status subscribers | Subscribers | Same tool, SEV1/SEV2 only | Through `notify-status-subscribers`; the tool enforces approval. |
| Direct email or call to affected account owners | Named customers | Comms lead after approval | Contact source: `TODO(owner)`. Breach and AI-call notices go here, with counsel's text. |
| Support replies | Customers who write in | Support lead | Published wording only. Macro in section 6. |
| Internal incident channel | Staff | All | `#inc-YYYYMMDD-short-name`; alerts: `#voice-alerts`. |
| Regulators, insurers, law enforcement | Authorities | Counsel / executive | `TODO(counsel)`: who is told, by when. |
| Press and social media | Public | Spokesperson only | Default is no comment beyond the approved holding statement. `TODO(owner)`: accounts and who holds them. |
| In-app notice, partner and reseller notice | Users / partners | `TODO(owner)` | Confirm whether the product supports it before promising it. |

## 5. Scenarios

### 5.1 Data breach (suspected or confirmed)

- **First 30 minutes:** IC declares SEV1, starts [breach-notification](../runbooks/breach-notification.md) in parallel with containment, writes down the time of awareness, calls counsel. Nobody posts anything.
- **Approval path:** comms lead drafts → counsel reviews → executive approves → comms lead sends. Time limit for counsel's first review: `TODO(owner)`.
- **Channels:** direct notice to affected account owners first; status page only for the service impact, never for data wording; regulators and individuals as counsel decides.
- **Do not:** say "no data was affected" before it is confirmed, name a cause, name a vendor, or send through the status tool (it blocks this wording on purpose).
- **Deadlines:** `TODO(counsel)`. The runbook records what customers were already promised and the open legal questions; do not restate them here.

### 5.2 AI voice agent misbehaves on a call

- **Triage:** Voice IR classification and kill switch (`lockdown` / `restricted`) are in [voice-incident-response](../security/voice-incident-response.md). The IC maps that to a severity.
- **Approval path:** no personal-data exposure → IC and comms lead approve (two people). Exposure of data, a wrong emergency instruction, or a call that reached a third party's data → treat as 5.1.
- **Channels:** the affected account owner first, directly. Status page only if other customers are or could be affected.
- **Say:** what happened on the call in plain words, what was done (only if done), when we will report back. **Do not say:** why the model did it, that it "cannot happen again".
- Keep call IDs and evidence; after resolution add the scenario to the red-team set as the Voice IR runbook says.

### 5.3 Outage or degradation

- Use `/staff/incident-comms` and its template library ([incident-comms](../runbooks/incident-comms.md), section 6). Severity matrix, first-message deadlines and approvals are enforced there: SEV1 within 15 min and SEV2 within 30 min, both needing a second approver.
- Support replies with the status wording. Escalate new facts to the comms lead.
- After resolution: post-incident write-up within 5 business days for SEV1/SEV2 ([incident-management](../incident/incident-management.md)).

### 5.4 Legal claim, demand letter, regulator inquiry

- **Anyone who receives one** forwards it unaltered to counsel the same business day and does not reply. Do not confirm or deny anything about any account.
- **Approval path:** counsel decides whether, what and when; executive approves; spokesperson delivers. No engineer or support statement.
- **Channels:** none by default. Customers affected by the claim are told only on counsel's advice.
- Requests for customer data (subpoenas, warrants, preservation) have their own log and steps in [legal-request-process](../compliance/legal-request-process.md). A claim *against* Vireek is not covered there: `TODO(counsel)` add the process.
- Preserve documents: legal hold owner `TODO(counsel)`.

## 6. Holding statements (drafts)

`< >` are filled from the incident record, only with facts that are true at that moment. Delete any sentence you cannot support. **None is approved until the status line below says so.**

| # | Use | Approval status |
|---|---|---|
| A | Outage, first post | Use the generated `investigating.*` template; no separate text needed |
| B | AI call issue, to the affected account owner | `TODO(counsel)` not yet approved |
| C | Security incident, to affected account owners | `TODO(counsel)` not yet approved |
| D | Legal claim, if asked | `TODO(counsel)` not yet approved |
| E | Support macro | `TODO(owner)` not yet approved |

**A. Outage (status page).** Generated from the incident record, in this shape: "We are investigating a problem: `<component>` is running slower or less reliably than usual. Started `<time UTC>`. We will post another update by `<time UTC>`."

**B. AI call issue (to the account owner).**
> Hello `<name>`, we are writing about a call on `<date, time UTC>` that our AI receptionist handled for your account and that did not go as it should. We are reviewing it now. `<Only if true: We have limited the feature for your account while we review.>` We will update you by `<time UTC>`. Contact: `<TODO(owner) name and channel>`.

**C. Security incident (to affected account owners).** *Entire text `TODO(counsel)`.*
> Hello `<name>`, we are investigating a security incident that may involve `<categories of data, only if known>`. We have not confirmed `<what is not yet confirmed>`. We will send confirmed facts as we have them and will update you by `<time UTC>`. Contact: `<TODO(owner)>`.

**D. Legal claim (if a journalist or customer asks).** *Entire text `TODO(counsel)`.*
> We are aware of `<the matter, as counsel permits>` and are reviewing it with our legal advisers. We do not comment further on legal matters.

**E. Support macro.**
> Thanks for writing. We are aware of the issue and are working on it. The latest information is on our status page: `<status page URL>`. We will not be able to share more detail until it is confirmed.

## 7. After the incident

- [ ] All sent messages are in the incident channel with author, approver, time.
- [ ] Post-incident write-up done ([template](../runbooks/post-incident-template.md)); customer-facing summary approved by counsel if it touches data or contracts.
- [ ] Update this page: what slowed approval, which statement was missing, who was not reachable.
- [ ] Drill this page: scenarios and cadence `TODO(owner)`.

## What the owner must supply

Named roles with backups and contact details; counsel and their review time limit; time limits for approvals; who may speak to press and regulators; the customer contact source; social/media accounts; the legal-hold owner; counsel's approved wording for statements B, C, D and the "who must be told, by when" list; the drill cadence.
