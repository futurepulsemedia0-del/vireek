# Response-time targets (internal)

**PROPOSED defaults, founder to confirm.** Calendar time, not business hours. Internal only; not a public or contractual commitment. [COUNSEL] before publishing any SLA.

| Severity | First response | Resolution target |
|---|---|---|
| S1 | 30 min | 4 h |
| S2 | 2 h | 24 h |
| S3 | 8 h | 72 h |
| S4 | 24 h | 120 h |

## Where they live
`support_sla_targets` (one row per severity, minutes). Staff can edit the two minute columns; the key column is locked. Deadlines are computed live from `internal_clock_started_at` + current target, so a change applies to open tickets immediately and can move tickets in or out of the overdue view.

## How the clocks behave
- Start: server time at ticket creation (never the client-supplied `created_at`).
- First-response clock stops at the first staff reply (`first_response_at`).
- Resolution clock is considered paused while `awaiting_customer` is true; the deadline is **not** shifted when the customer replies.
- Closed tickets are never overdue.

## Overdue view
`support_overdue_tickets` (staff only): ticket, severity, which clock is overdue, seconds overdue. Shown as "Overdue only" in `/staff/support-inbox`.

## Known gaps
- No business-hours calendar. No automatic paging when a ticket goes overdue. No per-plan targets.
- The tenant dashboard still shows its own priority-based SLA labels (urgent 1h/8h, high 4h/24h, normal 8h/72h, low 24h/120h). Those are displayed to customers today; decide whether that is acceptable or should be hidden [COUNSEL].
