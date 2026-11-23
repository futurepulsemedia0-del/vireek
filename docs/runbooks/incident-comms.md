# Customer incident communication

Who says what, when, and how. This runbook sits on top of `docs/incident/incident-management.md` (severity, roles, lifecycle) and `docs/runbooks/incident-response.md` (technical response). It does not replace them.

**The rule that matters most:** nothing goes to customers until a person has read the exact text and approved it. The admin tool at `/staff/incident-comms` enforces that in the database, not only in the UI.

## 1. Roles: who says what

| Role | Owns | Does not |
|---|---|---|
| Incident commander (IC) | Declares severity, approves SEV1/SEV2 text, decides when to resolve | Write the text |
| Comms lead | Drafts and edits the status post and customer email, posts every update on time | Approve their own SEV1/SEV2 draft |
| Technical lead | Tells the comms lead, in plain words, what customers experience and what has changed | Talk to customers directly during the incident |
| Support | Uses the published wording for replies, escalates anything new | Improvise causes, timelines or promises |

One person can hold several roles in a SEV3. For SEV1/SEV2 (and any major-impact incident) the person who drafted or submitted a message cannot approve it while "Require a second person" is on (default). If you are the only staff member, switch it off for that incident and write why in the incident channel.

## 2. Severity matrix

| Severity | Public status post | Email to status subscribers | First public message | Update cadence | Approval |
|---|---|---|---|---|---|
| SEV1 | Yes | Yes | within 15 min of declaring | every 30 min until mitigated | Second person |
| SEV2 | Yes | Yes | within 30 min | every 60 min | Second person |
| SEV3 | Yes | No | when customer-visible | no fixed cadence; post on change and on resolve | One person |
| SEV4 | No | No | none | none | n/a |

The matrix is enforced by the database and the tool: SEV3/SEV4 cannot email subscribers, SEV4 has no public message, and a draft that promised "next update by 14:30 UTC" cannot be sent after 14:30. Generate a new draft instead. The code source of truth is `SEVERITY_MATRIX` in `supabase/functions/_shared/incident-comms/incidentCommsLogic.ts`.

## 3. When to post

1. **Declare** (IC sets severity). The clock for "first public message" starts here.
2. **Investigating**: post as soon as customers could plausibly be affected, even if the cause is unknown. Silence reads worse than "we are looking".
3. **Identified**: post when the team knows what to fix. Say what is being done, not why it broke.
4. **Monitoring**: post when a fix is applied and being watched.
5. **Resolved**: post when it has held for the agreed observation period. Say plainly if customers need to do anything.
6. Keep the cadence in the table even when there is nothing new: "no change, still working on it, next update by 15:30 UTC".
7. Automatic incidents opened by monitoring get a human-written first update within 10 minutes (see incident-management.md, "Status page automation").

## 4. How to use the tool

1. Open `/staff/incident-comms`, pick the incident.
2. Choose phase, severity, audience. Add "what customers can do" only if there is something to do.
3. **Generate draft**. The text comes from the templates in section 6, filled only from the incident record. It is checked automatically; anything marked "Must fix" blocks submit, approve and send.
4. Edit if needed, then **Submit for approval**. Any later edit resets the approval.
5. The approver reads the text, ticks that they read it, and approves. The approval is bound to the exact text (content hash): if it changes, approval is gone.
6. **Send now** posts the status update (it appears on `/status`) and, if chosen, emails subscribers through the existing `notify-status-subscribers`. Each step has its own marker: a retry after a failure never posts or emails twice.
7. If sending fails part-way, the draft is "Send failed"; **Retry send** repeats only the missing step.

If a draft is stuck in "Sending" for more than 10 minutes, check the status page and the email provider log first. Only if the email did **not** go out, mark it failed with `select public.incident_comms_finish('<actor uuid>', '<draft id>', false, 'manual recovery')` (service role) and retry. If the email did go out, finish it as sent by recording the email step, to avoid a duplicate send.

## 5. Writing rules (the checker enforces the hard ones)

- Say what customers see, not what we think is wrong. No cause until the incident is resolved and confirmed.
- No provider or vendor names, no internal metrics, no customer names, emails, phone numbers, IP addresses or internal ids. (Blocked.)
- No links except the status page. (Blocked.)
- No wording about data exposure, breaches, unauthorized access or "no data was affected". That is a security/privacy notification and goes through counsel, outside this tool. **[COUNSEL]** (Blocked.)
- No guarantees ("will never happen again"). (Warning.)
- Always give the time of the next update, in UTC. (Warning.)
- Short sentences. One apology, at the end of the email, not in every line.

## 6. Template library

Templates are generated from the incident record (title, impact, component, region, start time). Impact `minor` says "running slower or less reliably than usual"; `major` says "unavailable or badly degraded". Component names are customer-friendly ("the AI receptionist", "appointment booking"), never provider names.

| Template id | Phase | Impact | Status post says | Email adds |
|---|---|---|---|---|
| `investigating.minor` | Investigating | minor | "We are investigating a problem: <component> is running slower or less reliably than usual. Started <time>. We will post another update by <time>." | what you may notice; what you can do; next update |
| `investigating.major` | Investigating | major | same, with "unavailable or badly degraded" | same |
| `identified.minor` | Identified | minor | "We have identified the problem affecting <component> and are working on a fix. We will post another update by <time>." | "We know what is wrong ... and are working on the fix." |
| `identified.major` | Identified | major | same | same |
| `monitoring.minor` | Monitoring | minor | "A fix has been applied for <component>. We are monitoring to confirm it holds. We will post another update by <time>." | "A fix is in place ... watching it to be sure it holds." |
| `monitoring.major` | Monitoring | major | same | same |
| `resolved.minor` | Resolved | minor | "Resolved at <time>. <Component> is working normally again. You do not need to do anything." | "The problem with <component> is resolved as of <time>." |
| `resolved.major` | Resolved | major | same | same |

Email subject: the incident title for investigating/identified, "Fix applied: <title>" for monitoring, "Resolved: <title>" for resolved.

### Post-incident (not generated: a person writes it)
Within 5 business days for SEV1/SEV2: what happened in customer terms, how long, what we changed. Facts only; cause stated only if confirmed. Anything touching personal data or contractual duties goes through counsel first. **[COUNSEL]**

## 7. Out of scope (and where it goes)
- Regulatory or contractual notifications (data incidents, SLA credits, enterprise customer notices): **[COUNSEL]**, handled by hand.
- Per-customer targeted email ("affected accounts"): not built; the tool only reaches the public status page and opted-in status subscribers. **[VERIFY]** whether a per-tenant impact mapping exists before adding it.
- Languages other than English for subscriber emails (the status subscriber list has no language field).

## 8. Go-live checklist
1. Apply `20290308000000_incident_comms.sql`.
2. Deploy `incident-comms` (JWT verification ON) and redeploy `notify-status-subscribers` (multi-paragraph rendering).
3. Secrets already used by `notify-status-subscribers` stay as they are (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SITE_URL`, optional `STATUS_NOTIFY_WEBHOOK_SECRET`); `incident-comms` forwards the webhook secret if set.
4. Confirm `/status` renders live incidents (the live feed, not the hand-maintained list) so published updates appear.
5. Do a dry run with a test incident: draft, submit, approve with a second account, send; check `/status`, the subscriber email and the event trail.
