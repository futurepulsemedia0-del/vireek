# Support operations

Internal playbook for Vireek support. **Not a customer contract.** Targets here are internal and configurable; nothing in this folder is a public promise. [COUNSEL] before any SLA, uptime or credit language is shown to customers.

| Doc | Purpose |
|---|---|
| [severity-matrix.md](severity-matrix.md) | S1–S4 definitions, examples, who may set them |
| [tier-model.md](tier-model.md) | T1 / T2 / T3 roles and hand-off rules |
| [escalation-to-engineering.md](escalation-to-engineering.md) | How a ticket reaches engineering and what it must contain |
| [response-time-targets.md](response-time-targets.md) | Internal targets and how to change them |
| [qa-checklist.md](qa-checklist.md) | Ticket QA rubric + verification checklist for the severity/overdue feature |

## What is implemented in code
- Tickets: `support_conversations` (`kind='ticket'`), staff inbox `/staff/support-inbox`, tenant page `/dashboard/support`.
- Severity S1–S4, internal clock and targets (`support_sla_targets`), staff-only view `support_overdue_tickets`: migration `20290305000000_support_severity_internal_sla.sql`.
## What is docs-only (no code yet)
- Tiers, escalation fields, paging, business-hours clocks, CSAT-by-tier. Names, roster and paging tool: **TBD** (not defined in the repo).
