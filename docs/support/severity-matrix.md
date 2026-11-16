# Severity matrix (S1–S4)

`S` = **support** severity of one ticket. `SEV1–SEV4` in `docs/runbooks/incident-response.md` = severity of a platform **incident**. An S1 ticket always triggers an incident assessment; it does not automatically mean SEV1.

| | Definition | Typical examples | Workaround? |
|---|---|---|---|
| **S1 Critical** | Customer's business is stopped or data/security is at risk | AI receptionist not answering calls; payments failing for all customers of the account; suspected cross-tenant data exposure; outage affecting several tenants | No |
| **S2 High** | A key workflow is broken for the account | Dispatch board won't load; invoices/QuickBooks sync stuck; wrong billing charge | Hard / partial |
| **S3 Medium** | Feature degraded or behaving unexpectedly | Report numbers look off; one integration flaky; how-to that blocks a task | Yes |
| **S4 Low** | Question, request or cosmetic | Feature request; copy/UI nit; general question | n/a |

## Rules
1. Customer picks **priority** (low/normal/high/urgent); staff owns **severity**.
2. New tickets get a **provisional** severity: urgent/high → S2, normal → S3, low → S4. **S1 is never provisional.**
3. T1 confirms or corrects severity during triage, inside the first-response window. Confirming is explicit (button in the staff inbox) and records who/when.
4. Upgrade immediately on new facts (more tenants affected, data risk). Downgrade only with a note in the ticket.
5. Any suspected data exposure or security issue: S1, stop and follow `SECURITY.md` and the incident runbook. Do not discuss details in the ticket thread.
6. Never paste secrets, JWTs, call recordings or customer PII into tickets, chat or public issues (see `SUPPORT.md`).
