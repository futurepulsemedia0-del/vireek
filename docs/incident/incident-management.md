# Incident management

## Severity levels
| Level | Definition (any one) | Response | Update cadence | Status page | Postmortem |
|---|---|---|---|---|---|
| **SEV1** | Calls are not being answered, or booking/emergency handling is broken for many customers; data exposure suspected | page immediately, 24/7; IC + comms lead within 10 min | every 30 min | yes, within 15 min | required, within 5 business days |
| **SEV2** | Significant degradation for a region/provider or a core feature; workaround exists | page; respond within 15 min | every 60 min | yes if customer-visible | required |
| **SEV3** | Limited impact, or a degradation that is not customer-visible yet | Slack, business hours / next morning | daily | no | optional (recurring causes are reviewed quarterly) |
| **SEV4** | Hygiene: trend, ticket-level | ticket digest | n/a | no | no |

Severity can be raised or lowered by the incident commander at any time; when unsure, pick the higher one.

## Roles
Incident commander (IC: decides, delegates, owns severity), Operations lead (hands on keyboard), Comms lead (status page + customer notices), Scribe (timeline in the incident channel). One person may hold several roles in a SEV3.

## On-call rotation
- One primary and one secondary, weekly rotation, hand-off on Monday 10:00 local with a 15-minute review of open alerts and recent changes.
- Pager = PagerDuty service "Vireek Voice" fed by `observability-alerts` (SEV1/SEV2). Chat alerts go to `#voice-alerts`.
- Escalation: primary has 10 min to acknowledge, then secondary, then engineering manager.
- Alert fatigue rules (implemented in code, see `alertRules.ts`): volume gate, confirmation before opening, hysteresis before resolving, cooldown re-notify (SEV1 30 min, SEV2 2 h, SEV3 12 h, SEV4 weekly), one page per rule across regions, page budget of 6/hour (overflow goes to chat, SEV1 never downgraded), inhibition of the milder rule while the severe rule is firing, maintenance windows. If a page was not actionable, file a "noisy alert" ticket the same day and tune the rule.
- Handing over mid-incident: write the state, hypotheses and next step in the channel before leaving.

## Status page automation
`observability-alerts` opens a status incident (`synthetic_open_incident`) when a SEV1/SEV2 rule that has a public component opens, and resolves it when the alert resolves; subscribers are notified by the existing `notify-status-subscribers`. Copy is generated from templates (`statusCopy`) and never contains metric values, provider names or customer data. The comms lead must review the text within 10 minutes and post the first human update. SEV3 never auto-publishes.

## Lifecycle
Detect -> Declare (channel `#inc-YYYYMMDD-short-name`) -> Mitigate first, diagnose second -> Communicate -> Resolve -> Postmortem -> Action items tracked to done.

## Quarterly review of recurring causes
Once a quarter (first week) the on-call lead reviews: pages per week and per rule, % of pages that needed action, top 5 root-cause categories (provider, deploy, DB, config, tool, telephony), incidents by severity, MTTA/MTTR, error-budget burn per SLO, and open postmortem actions older than 30 days. Output: rules to tune or delete, automation to add, one reliability theme for next quarter. Useful queries: `select rule... from observability_alert_log` (pages per rule), and `/staff/reliability` + `/staff/voice-observability`.
