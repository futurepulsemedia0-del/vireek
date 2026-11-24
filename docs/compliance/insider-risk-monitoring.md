# Insider-risk monitoring and quarterly access review

> **DRAFT: not approved.** Owner: _to be assigned_ (`docs/OWNERS.md`, area `security`) · Approved by: _pending_. This document describes what the code in this repository does. It makes no compliance claim and is not evidence of a performed review (see `src/lib/trust/claims.ts`).

## 1. What exists and what this adds

| Capability | Where | Status |
|---|---|---|
| Append-only trail of staff actions (`account_view`, `impersonation_start/end/denied`, `explorer_list`) | `staff_audit_log`, migration `20270504000000_staff_account_explorer.sql` | existing, reused |
| Impersonation sessions (reason 15-500 chars, optional ticket, 30 min, max 10 per hour) | `staff_impersonation_sessions`, `supabase/functions/staff-impersonate` | existing, reused |
| Append-only log of sensitive reads and exports, with `impersonation_session_id` | `sensitive_read_log`, migration `20281103000000_sensitive_read_access_log.sql` | existing, reused |
| Anomaly alerts on **customer-side** actors (bulk scraping, off-hours, former employee, export volume) | `sensitive_read_alerts` | existing, unchanged |
| Alerts on **Vireek staff** actions | `staff_insider_alerts`, `detect_staff_insider_risk()` | **new** (migration `20290307000000_staff_insider_risk.sql`) |
| Quarterly staff access review report | `staff_access_review_report(year, quarter)` + `scripts/compliance/access-review-report.mjs` | **new** |
| Ethics / concerns channel | `docs/compliance/ethics-channel.md` | **new draft** |

Nothing is mocked: detection reads the real audit tables. Nothing is scheduled by the migration itself; see section 5.

## 2. Alert rules

All thresholds live in the singleton table `staff_insider_policy` (service role only) and can be changed without a deploy. Off-hours reuses `sensitive_read_policy.offhours_start_utc/end_utc` (default 22:00-06:00 **UTC**; staff in other time zones will see this window shift, which is a known limitation). Alerts carry counts and ids only: no reason text, ticket reference, customer name or content.

| Rule | Severity | Fires when (defaults) | Data source | `runbook_key` |
|---|---|---|---|---|
| `impersonation_volume` | high | one staff member starts >= 6 impersonation sessions in 24 h | `staff_audit_log` | `impersonation-volume` |
| `impersonation_breadth` | high | one staff member impersonates >= 4 different accounts in 24 h | `staff_audit_log` | `impersonation-breadth` |
| `impersonation_denied` | high | >= 3 refused impersonation attempts by one user in 1 h (includes non-staff callers the function logged) | `staff_audit_log` | `impersonation-denied` |
| `impersonation_no_ticket` | medium | >= 3 sessions without a ticket reference in 7 days | `staff_impersonation_sessions` | `impersonation-no-ticket` |
| `impersonation_off_hours` | medium | a session starts inside the off-hours window | `staff_audit_log` | `impersonation-off-hours` |
| `account_enumeration` | high | >= 25 different accounts opened in the staff explorer in 1 h | `staff_audit_log` | `account-enumeration` |
| `staff_bulk_read` | high | >= 100 records read by one staff member in 10 min, directly or inside an impersonation session | `sensitive_read_log` | `staff-bulk-read` |
| `staff_export` | critical | **any** export of customer data attributed to staff in 1 h | `sensitive_read_log` | `staff-export` |

The defaults are engineering starting points, not measured baselines. [VERIFY] Tune them after a few weeks of real staff activity; record each change and the reason.

Attribution: a sensitive read counts as staff activity when `actor_kind = 'staff'` (actor id taken as the staff id [VERIFY: confirm every writer sets it so]) or when it carries an `impersonation_session_id` (staff id taken from the session row). Rows that cannot be attributed are skipped, never guessed.

Behaviour guarantees (all covered by `supabase/tests/database/staff_insider_risk.test.sql`):

- One alert per rule, staff member and time bucket (`dedupe_key` UNIQUE plus an advisory lock), so overlapping cron runs and retries cannot double-alert.
- Alerts are append-only: no DELETE; UPDATE only for the one-way `open -> acknowledged | dismissed` transition, which requires a reviewer, a timestamp and a note.
- Separation of duties: nobody can acknowledge or dismiss an alert about themselves; review needs a recent step-up (`sensitive_read_stepup_ok()`; AAL2 when the reviewer has MFA) and a 10-500 character note.
- Clients have no table access. Staff use `list_staff_insider_alerts()` and `set_staff_insider_alert_status()`.
- A staff member **can see** that an alert about them exists (transparency), but cannot close it.

## 3. Runbook (per alert)

Whoever reviews is not the subject of the alert. With a single staff member this is impossible: record the alert, and have the owner or an external adviser review it from SQL (service role), noting that in the review note field.

1. Open the alert; read rule, window, observed vs. threshold, target account (if single).
2. Reconstruct from the source tables, with the `ticket_ref` and `reason` from `staff_impersonation_sessions`, whether a support ticket explains it. Do not contact the staff member about the substance until you have the facts.
3. Explained and legitimate: `acknowledged` with a note naming the ticket. Mistake or training issue: `acknowledged` plus a follow-up. Unexplained: leave **open** and escalate (step 4).
4. Unexplained or critical (`staff_export`, repeated `impersonation_denied`): treat as a security incident under `docs/compliance/policies/incident-response.md` and `RUNBOOK.md` section 6; preserve the rows (they are immutable); consider suspending staff access (`profiles.is_staff`) and rotating shared secrets (`RUNBOOK.md` section 7).
5. Customer notification duties and employment-law steps for a confirmed incident are **[COUNSEL]** decisions. This document does not state what is required.
6. Concerns about a person (rather than a data event) follow `docs/compliance/ethics-channel.md`.

### Review cadence
Open alerts should be looked at daily while staff activity exists; proposed target: critical same day, high within 2 working days, medium weekly. These are proposals for the owner to adopt, not commitments.

## 4. Quarterly access review

Purpose: once a quarter, a person who is not in scope confirms that every staff account is still needed, has MFA and is used.

```bash
# 1. Facts from the database (service role or a staff session with step-up)
psql "$DATABASE_URL" -At -c "select public.staff_access_review_report(2026, 4)" > review.json

# 2. Render (stdout, or --out to keep it with the evidence); --strict exits 1 when any flag is raised
node scripts/compliance/access-review-report.mjs review.json --out docs/compliance/access-reviews/2026-Q4.md
```

The report lists, per staff account: role and status, last sign-in, verified MFA factors, impersonation sessions (distinct accounts, missing tickets), audit actions by type, records read, export events, and alerts. The script adds flags (`no_verified_mfa`, `dormant`, `not_active`, `open_alerts`, `sessions_without_ticket`, `staff_exports`) and a decisions table and a **blank** sign-off block. It also embeds `compliance_access_summary()` (SCIM tokens, custom roles, profiles by role).

What it cannot see: GitHub, the hosting console, Supabase organisation members, Stripe, Twilio, Vapi and other provider consoles. Section 5 of the generated file is a manual checklist for these. A review is only evidence once a named reviewer has ticked what they really checked, signed, and stored the file. Where the signed copy lives is an owner decision [VERIFY: not yet defined; `docs/compliance/soc2/controls.json` control ACC-03 still records "no quarterly access-review sign-off has been performed"].

## 5. Operations checklist (nothing here is done by the migration)

- [ ] Apply the migration with the normal rehearsal flow; run `supabase/tests/database/staff_insider_risk.test.sql` against a non-production database.
- [ ] Schedule detection (SQL editor, `pg_cron` enabled): `select cron.schedule('staff-insider-detect', '*/5 * * * *', $$select public.detect_staff_insider_risk()$$);`
- [ ] Decide who reviews alerts and where they are told. **Gap:** there is no notification channel and no staff UI for these alerts yet; they are visible only through the two RPCs or SQL. Until one exists, put a recurring calendar task on the reviewer.
- [ ] Assign the `security` owner in `docs/OWNERS.md`.
- [ ] Decide retention for `staff_insider_alerts` (no retention job exists; rows are kept) [COUNSEL for employee-data retention limits].

## 6. Known limits

- Detection only sees what is logged. Staff with direct database or provider-console access (service role, Supabase dashboard) are outside these tables; that access is covered only by the manual part of the access review.
- Impersonation shows the customer's `audit_log` and the staff trail, but reads inside a session are attributed only if `log_sensitive_read` saw them.
- Thresholds are untuned defaults. Off-hours is UTC-based.
- Monitoring employees is subject to labour and data-protection law (notice, purpose limitation, works-council involvement where applicable). **[COUNSEL]** before relying on this for disciplinary action.
