# Escalation to engineering

## When
- S1 → **always**, immediately.
- S2 → when T2 cannot resolve or reproduce within half of the resolution target.
- S3/S4 → only for a confirmed defect, via the normal backlog (no paging).

## Path
1. T1 → T2 with a hand-off note.
2. T2 → T3 (engineering) only with the **escalation packet** below.
3. S1: T3 on-call opens an incident per `docs/runbooks/incident-response.md` (roles, first 15 minutes, communication templates). Paging tool and rota: **TBD** [VERIFY].
4. Engineering updates the ticket owner at the cadence in the incident runbook (SEV1: every 30 min). The ticket owner relays to the customer.
5. After the fix: owner confirms with the customer, closes the ticket, links the issue/post-mortem.

## Escalation packet (all required)
- Ticket reference (`VK-####`), severity, tenant account id (id only, no names or emails)
- Impact: who and what is affected, since when (UTC), workaround yes/no
- Repro steps or error/request ids; logs links (not pasted payloads)
- What has been tried; what is being asked of engineering
- Whether customer data or security is possibly involved (yes/no/unknown)

## Never
Paste secrets, tokens, call recordings or PII. Never promise a fix time or root cause before engineering confirms.
