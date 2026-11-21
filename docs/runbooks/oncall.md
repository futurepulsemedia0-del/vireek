# On-call and paging

**DRAFT. Nothing here is a commitment to customers.** No roster, paging vendor or SLA is defined in the repo, so every person, tool and response time below is a template or a **PROPOSED** value to be confirmed by the owner. Complements [RUNBOOK.md](../../RUNBOOK.md) §6, [incident-response.md](incident-response.md) and [../SLO.md](../SLO.md). Legal and contractual questions are marked **[COUNSEL]**, unconfirmed vendor facts **[VERIFY]**.

## 1. What exists in code today (verified by reading the source)

| Piece | Where | What it does |
|---|---|---|
| Alert rules + anti-fatigue state machine | `supabase/functions/_shared/observability/alertRules.ts` | Volume gate, confirmations, hysteresis, cooldown, grouping, page budget (6/h; SEV1 never downgraded), maintenance mutes, inhibition. Severity → logical route: SEV1/SEV2 `page`, SEV3 `chat`, SEV4 `ticket`. |
| Alert cycle | `_shared/observability/alertRunner.ts`, `observability-alerts` (cron, every 2 min) | Evaluates real-traffic metrics and burn-rate SLOs, persists state in `observability_alert_state`, logs every delivery in `observability_alert_log`, retries a failed trigger next cycle. |
| **Routing (new)** | `_shared/observability/alertRouting.ts` | Vendor-neutral, webhook-based. Maps a notification to destinations. Config holds env var **names** only, never URLs or keys. |
| SLO definitions | `docs/SLO.md`, `slo-evaluate` | All PROPOSED, none measured. |

Not in the repo: who is on call, the paging vendor account, escalation timers enforced by a tool, and any published SLA.

## 2. Severity → paging mapping

Code uses SEV1–SEV4. [RUNBOOK.md](../../RUNBOOK.md) §6.1 uses P1–P3. Use this table to translate:

| Code | RUNBOOK §6.1 | Route (enforced in code) | Wakes a human? | PROPOSED acknowledge target | PROPOSED update cadence |
|---|---|---|---|---|---|
| SEV1 | P1 | `page` + chat mirror. Never downgraded by the page budget. | Yes, 24/7 | 15 min | every 30 min |
| SEV2 | P1/P2 | `page` + chat mirror. Downgrades to chat if more than 6 pages were already sent in the last hour. | Yes, 24/7 **[decide: or business hours only]** | 30 min | every 60 min |
| SEV3 | P2 | chat only | No | next business day | daily |
| SEV4 | P3 | ticket/digest | No | backlog | none |

A SEV2 that was downgraded by the page budget is **not** sent to any paging destination (`enforceEngineDecision`, tested). If a burst of SEV2 pages is happening, someone must read the chat channel, not wait for the pager.

Non-alert signals that are SEV1/SEV2 by policy even though no rule fires (page manually): suspected data exposure or cross-tenant leak, leaked service-role key, DR drill failed or missing (`platform_restore_drills`), double-charging.

## 3. Alert routing configuration

Default (no configuration needed beyond secrets) is `DEFAULT_ROUTING` in `alertRouting.ts`:

| Destination | Format | Activated by env var | Receives |
|---|---|---|---|
| `pager` | PagerDuty Events v2 (legacy, optional) | `PAGERDUTY_ROUTING_KEY` (+ optional `PAGERDUTY_EVENTS_URL`) | SEV1, SEV2 |
| `pager-webhook` | `generic` (`vireek.alert.v1`) | `ALERT_PAGER_WEBHOOK_URL` | SEV1, SEV2 |
| `chat` | Slack-compatible | `ALERT_SLACK_WEBHOOK_URL` | SEV1–SEV3 |
| `ticket` | Slack-compatible, falls back to `chat` | `ALERT_TICKET_WEBHOOK_URL` | SEV4 |

Any paging or automation tool that accepts an HTTPS webhook can sit behind `ALERT_PAGER_WEBHOOK_URL`. Payload:

```json
{ "schema": "vireek.alert.v1", "source": "vireek-voice", "event": "trigger|resolve|digest",
  "severity": "SEV1", "dedup_key": "obs:answer_rate_critical", "summary": "…",
  "runbook_url": "…", "scopes": [{ "scope": "eu", "value": 0.82, "samples": 40, "threshold": 0.9, "comparator": "lt" }] }
```

Use `dedup_key` to open/update/resolve one incident per rule. No customer data is included (metric values and scope names only).

**Override** (optional): set the secret `ALERT_ROUTING_JSON` to `{ "destinations": [...], "rules": [...] }`. Rules: `severities`, optional `ruleKeys`, `to`, optional `sendResolves`. Destinations reference env var *names* in `urlEnv`. Example, page a second receiver only for the webhook rule:

```json
{ "destinations": [
    { "name": "pager", "format": "generic", "urlEnv": "ALERT_PAGER_WEBHOOK_URL", "isPaging": true },
    { "name": "payments", "format": "generic", "urlEnv": "ALERT_PAYMENTS_WEBHOOK_URL", "isPaging": true },
    { "name": "chat", "format": "slack", "urlEnv": "ALERT_SLACK_WEBHOOK_URL" } ],
  "rules": [
    { "severities": ["SEV1", "SEV2"], "to": ["pager", "chat"] },
    { "severities": ["SEV2"], "ruleKeys": ["webhook_5xx_high"], "to": ["payments"] },
    { "severities": ["SEV3"], "to": ["chat"] } ] }
```

Safety properties (all unit-tested): an invalid override is rejected and the default is used, so a typo cannot silence alerting; a config where SEV1 reaches no paging destination is rejected; URLs must be `https` (http only for localhost); fallbacks are one hop; a page counts as delivered only if a **paging** destination accepted it, otherwise it is retried next cycle. The rejection is logged as `alert_routing_override_rejected`.

Setup: `supabase secrets set ALERT_PAGER_WEBHOOK_URL=… ALERT_SLACK_WEBHOOK_URL=…`, redeploy `observability-alerts`. **Then run the test in §8.** With no destination secret the function still evaluates and logs `delivered=false`; an unconfigured system looks quiet, so check `observability_alert_log` for `delivered=false` rows.

## 4. Rotation template

Fill in; do not leave a placeholder in production.

| Field | Value |
|---|---|
| Schedule | _TBD_ (PROPOSED: weekly, hand-off Monday 10:00 local) |
| Primary | _TBD_ |
| Secondary (backup) | _TBD_ |
| Escalation owner (EM / owner) | _TBD_ |
| Minimum rotation size | PROPOSED ≥ 3 people to keep load sustainable; with fewer, state the risk explicitly |
| Coverage hours | _TBD_ (24/7 for SEV1; SEV2 hours **[decide]**) |
| Contact methods | pager app + phone call; chat is not a pager |
| Compensation / time-off in lieu | _TBD_ **[COUNSEL]** (labour-law rules on stand-by differ by country) |
| Swap procedure | swap in the pager tool and post in chat before the shift starts |

| Week of | Primary | Secondary | Notes |
|---|---|---|---|
| _YYYY-MM-DD_ | | | |

## 5. Escalation ladder (PROPOSED timers)

1. **T+0** alert → primary (page).
2. **T+15 min** no acknowledgement (SEV1) / **T+30 min** (SEV2) → secondary.
3. **T+30 min** SEV1 not acknowledged or not mitigating → escalation owner.
4. **T+60 min** SEV1 unresolved → owner/founder; decide on maintenance mode ([RUNBOOK.md](../../RUNBOOK.md) §6.2) and status-page update.
5. Possible data exposure at any time → owner immediately, and **[COUNSEL]** for notification duties. Do not delete logs.

The repo cannot enforce these timers; the paging tool must (**[VERIFY]** the chosen tool supports acknowledgement timeouts). Until then escalation is manual: the person who acknowledged owns the incident until a named hand-over.

## 6. When you are paged

1. Acknowledge. Open the runbook link in the page. Note the start time in UTC.
2. Classify with [RUNBOOK.md](../../RUNBOOK.md) §6.1; check **last change** (deploy, migration, secret) and roll back first if it fits.
3. SEV1/SEV2: assign IC and scribe ([incident-response.md](incident-response.md)), update the status page within 15 min (SEV1), post updates on the cadence in §2.
4. Resolve only when the alert resolves *and* you verified the user-visible path. The engine auto-resolves after the confirmation window; do not close early.
5. Write a post-mortem for SEV1/SEV2 ([post-incident-template.md](post-incident-template.md)).

**Runbook gap:** alert rules link to runbooks that do not exist yet. Until they are written, use the interim target:

| Alert rule runbook (missing) | Rules | Interim use |
|---|---|---|
| `voice-answer-rate-drop.md` | `answer_rate_*`, `call_completion_low` | RUNBOOK §6.3 "Calls not appearing", [voice-resilience.md](voice-resilience.md), [voice-provider-outage.md](voice-provider-outage.md) |
| `voice-latency-high.md` | `turn_latency_*`, `ttfw_p95_high` | [voice-observability.md](voice-observability.md), [voice-provider-outage.md](voice-provider-outage.md) |
| `voice-tool-failures.md` | `tool_failure_high`, `booking_success_low` | [voice-observability.md](voice-observability.md); RUNBOOK §6.3 |
| `voice-webhook-errors.md` | `webhook_5xx_high` | RUNBOOK §6.3 "Calls not appearing" (Vapi secret, `--no-verify-jwt`) |

## 7. Handoff checklist (end of shift)

- [ ] Open incidents: owner, current status, next update time, link to the log
- [ ] Alerts firing or recently resolved (`observability_alert_state`, last 24 h of `observability_alert_log`); any `delivered=false`?
- [ ] Active maintenance windows (`observability_maintenance`, max 24 h each)
- [ ] Deploys, migrations and secret changes in the last 48 h and in the next 48 h
- [ ] Failing or late DR drill / backup (`platform_restore_drills`, `platform_backup_runs`)
- [ ] Mutes or temporary threshold changes that must be reverted
- [ ] Follow-ups from post-mortems that are due
- [ ] Pager contact details and the swap are confirmed by the incoming person (a test page was received)

## 8. Verifying the routing end to end

Unit level (no network): `npx vitest run supabase/functions/_shared/observability/alertRouting.test.ts`.

Real delivery has **not** been verified by the author of this document. Before relying on it: point `ALERT_PAGER_WEBHOOK_URL` at your paging tool's staging integration, insert a maintenance-free synthetic breach on staging (or temporarily lower a threshold there), confirm (a) the page arrives and acknowledges, (b) the resolve closes the same incident via `dedup_key`, (c) a `delivered=true` row exists, (d) with the secret removed, `delivered=false` and an `alert_destination_unconfigured` log line appear. Record the date and result in a drill log.

## 9. PROPOSED service level objectives from existing metrics

**PROPOSED. Not measured. Internal paging objectives, not an SLA and not for publication.** [../SLO.md](../SLO.md) holds the journey-level proposals backed by k6; this table only restates, for on-call purposes, objectives that already exist as code constants or rule thresholds, so nothing here is new data.

| Indicator | Source in code | Existing value | PROPOSED internal objective (30 d) | Pages when |
|---|---|---|---|---|
| Calls answered by the AI receptionist | `REAL_SLOS.answer` (`alertRunner.ts`) | objective 0.995 | 99.5 % (see budget note below) | `answer_rate` < 0.90 (SEV1), fast burn |
| Booking attempts that succeed | `REAL_SLOS.booking` | objective 0.90 | 90 % | `booking_success_rate` < 0.70 (SEV3, chat) |
| Webhook error rate | `webhook_5xx_high` | > 2 % / 10 min | < 2 % | SEV2 |
| Voice turn latency p95 | `turn_latency_p95_critical` | > 4000 ms / 15 min | p95 < 2500 ms (matches the warn threshold) | SEV2 above 4000 ms |
| Provider error rate | `provider_error_high` | > 5 % / 15 min | < 5 % per provider | SEV2 |

Note on the budget: a 99.5 % objective allows 0.5 % bad events, i.e. about 3.6 hours of full unavailability over 30 days if measured by time; the burn-rate rules (`REAL_BURN_RULES`: 14.4× over 1 h/15 min, 6× over 6 h/1 h) are what actually page. Revisit all numbers after one month of production data; discrepancies with `docs/SLO.md` (for example 99.99 % "never silent" vs. 99.5 % answered) are different indicators and need an owner decision before any number is published **[COUNSEL]** if it could become a contractual claim.

## 10. Known gaps

- No roster, vendor or tested paging path yet (§4, §8).
- Four alert runbooks are missing (§6).
- `ALERT_ROUTING_JSON` is parsed on every cycle and has no UI; changes require a secret update and redeploy of `observability-alerts`.
- Missing alert coverage listed in [../observability/ALERT_RULES.md](../observability/ALERT_RULES.md) (webhook lag, payment webhooks, connector sync) is unchanged.
