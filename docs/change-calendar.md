# Business change calendar

Register of Vireek's OWN pricing, terms, SLA and policy changes: owner, approval, notice date, effective date, with an admin page and email reminders. Platform staff only. It is a reminder and record system: it does **not** send customer notices and does **not** decide how much notice is legally required **[COUNSEL]**.

Not duplicated: `price_change_notices` (plan-level customer notice, sent by `send-billing-notices`; an entry can point at one) and `docs/compliance/regulatory-calendar.json` (external regulation reviews).

| Piece | Where |
|---|---|
| Tables, RLS, RPCs | `supabase/migrations/20290311000000_change_calendar.sql` |
| Domain logic + tests | `src/lib/changeCalendar.ts`, `src/lib/changeCalendar.test.ts` |
| Admin page | `/staff/change-calendar` (`src/pages/StaffChangeCalendarPage.tsx`, behind `StaffRoute`) |
| Reminders | `supabase/functions/change-calendar-tick`, daily via `.github/workflows/change-calendar-tick.yml` |
| DB tests | `supabase/tests/database/change_calendar.test.sql` (pgTAP) |

## Lifecycle
`draft → pending_approval → approved → completed`; `rejected` returns to draft on edit; any open entry can be `cancelled` (reason required). Completed and cancelled are final. Entries are never deleted.
- The approver cannot be the requester, except when exactly one staff account exists (allowed, written to the audit trail).
- Editing the content of a pending or approved entry voids the approval (back to draft).
- "Record notice as sent" is a person saying a notice went out. Afterwards content is locked: cancel and create a new entry to change course.
- `min_notice_days` is optional and empty by default. No legal minimum is assumed. A recorded notice shorter than the value you set is shown as informational shortfall.

## Reminders (one email per entry and kind, to the owner)
`unapproved_past_notice` (notice date reached, not approved), `approval_needed` (≤7 days), `notice_overdue`, `notice_1d`, `notice_7d`, `completion_due` (effective date passed), `effective_7d`. At most one kind per entry per run, most urgent first. Changing the dates re-arms reminders. The SQL function `change_calendar_reminder_kind` and `reminderKind()` in TypeScript are twins, tested on the same cases.

## Setup [VERIFY each in your environment]
1. Run the migration. 2. Deploy: `supabase functions deploy change-calendar-tick --no-verify-jwt`. 3. Function secrets: `CHANGE_CALENDAR_CRON_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (optional `SITE_URL`, `SUPPORT_EMAIL` fallback recipient). 4. GitHub repo secrets: `SUPABASE_URL`, `CHANGE_CALENDAR_CRON_SECRET` (same value). 5. Staff accounts need `profiles.is_staff = true`.

Rollback: see the comment block at the end of the migration (destroys the register and its history).
