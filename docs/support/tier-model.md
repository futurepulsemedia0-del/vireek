# Tier model

Roster, names and on-call tool: **TBD** [VERIFY]. Roles below are functions, not job titles.

| Tier | Who | Owns | Hands off when |
|---|---|---|---|
| **T1 Frontline** | Support agent | Triage, severity confirmation, how-to, account/billing questions, known issues, first response | Needs data inspection, config repair, or a reproducible defect |
| **T2 Specialist** | Senior support / customer success | Integrations, billing disputes, data fixes via approved admin tools, reproduction and evidence gathering | Defect confirmed, data/security risk, or outside admin-tool reach |
| **T3 Engineering** | On-call engineer | Root cause and fix, hotfix/rollback, incident declaration | Fix shipped and customer informed |

## Rules
- The tier that holds a ticket owns the customer communication until a named owner takes over in writing.
- Hand-off notes are written for someone who has not read the thread (see escalation doc).
- Access to a customer's account follows the existing customer-approved, tenant-scoped staff-access flow [VERIFY exact flow before documenting steps].
- Closing a ticket: confirm with the customer, record cause and fix in one line.
