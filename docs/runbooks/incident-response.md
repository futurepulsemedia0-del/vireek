# Incident response

Complements `RUNBOOK.md` §6 (triage, containment, playbooks). **DRAFT** — roster and paging tool are not defined in the repo; fill the TBD fields.

## Roles
| Role | Responsibility | Person |
|---|---|---|
| Incident commander (IC) | Owns decisions and timeline | TBD |
| Technical lead | Diagnoses and fixes | TBD |
| Communications lead | Customer/status/regulator messages | TBD |
| Scribe | Keeps the timeline | TBD |
Escalation: on-call → IC → owner. Paging tool and on-call rota: **TBD**.

## Severity (proposed)
| Level | Definition | Target response |
|---|---|---|
| SEV1 | Data exposure/cross-tenant leak, full outage, payments or call handling down for most tenants | start now, update every 30 min |
| SEV2 | Major feature or one provider down, failed DR drill, security finding with plausible exploitation | within 1 hour |
| SEV3 | Degraded feature, workaround exists | next business day |
| SEV4 | Cosmetic / minor | backlog |

## First 15 minutes
1. Open a channel and note start time; assign IC and scribe.
2. Check Vercel deploys, Supabase logs (Edge Functions/Postgres/Auth), provider webhook logs (Stripe/Vapi/Twilio) — RUNBOOK §6.1.
3. If a deploy caused it, roll back (RUNBOOK §4).
4. If a secret leaked, rotate (RUNBOOK §7) and revoke affected API/agent keys.
5. If tenant data may be exposed: preserve evidence (do not delete logs), contain, then involve the owner/legal for notification duties.

## Communication templates
**Internal:** `[SEV?] <short title> — impact: <who/what> — status: investigating/mitigated/resolved — next update: <time> — IC: <name>`
**Customer (status):** `We are investigating <symptom> affecting <feature>. Started <time UTC>. We will update by <time>.`
**Resolution:** `Resolved at <time UTC>. Cause: <one line>. Customer action needed: <none/steps>.`

## Post-mortem template (blameless, within 5 business days for SEV1/SEV2)
Summary · Impact (who, how long, data involved) · Timeline (UTC) · Root cause · What went well/badly · Detection gap · Action items (owner, due date) · Follow-up evidence link.
