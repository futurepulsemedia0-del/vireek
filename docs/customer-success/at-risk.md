# Playbook: at-risk

**Goal:** reach a drifting account before it goes quiet or cancels.

## Signal
`computeSuccessRisk()` in `src/lib/successTools.ts`, layered on `computeHealth()` (never recomputed).

| Level | Code-defined condition |
|---|---|
| `high` | health band `critical`, or blended score < 40, or fresh NPS detractor with score < 60 |
| `medium` | health band `at_risk`, or blended score < 60, or adoption stalled (adoption score < 30 and account age >= 30 days), or fresh NPS detractor |
| `low` / `new` / `churned` | no action; `new` goes to [onboarding](./onboarding.md) |

Health bands (`computeHealth`): healthy >= 75, watch 50-74, at_risk 25-49, critical < 25. Suspended accounts are capped at 20 and `critical`; canceled is `churned`. NPS is "fresh" for `NPS_FRESH_DAYS = 90`; detractor means score <= 6.

Health factors: activation 15, recent activity 25, call trend 20, bookings 15, billing 15, plan usage 10. `reasons` lists any factor under 40% of its points.

## Trigger
| Condition | Response time |
|---|---|
| `high` | [POLICY] first touch within 2 business days (matches the task due date). **[VERIFY]** |
| NPS detractor | Code action text: call within 2 business days |
| `medium` | [POLICY] check-in within 5 business days (matches the task due date). **[VERIFY]** |

## Owner
CS owner (staff role). Billing problems go to the billing/support owner first. **[VERIFY]**

## Actions (follow `risk.action`, which the code picks in this order)
1. Billing factor under 40%: fix billing first, then usage. Switch to [churn-save](./churn-save.md) if `dunning_stage` > 0.
2. Detractor: call, read the NPS comment (`nps_latest` in `staff_success_overview()`), ask what failed.
3. `high` and recency under 20%: reach out personally; the account has gone quiet.
4. Adoption under 50: offer a 20-minute guided session on the top unused features (`reasons` names them).
5. `medium` otherwise: check-in message pointing to the next activation playbook.
6. Record the outcome in your CS notes system (none exists in the repo). **[VERIFY]**

## Success metric
Share of accounts that leave `high`/`medium` within 30 days of first touch. Needs a stored risk history, which does not exist (see gap 2 in the [index](./README.md#known-gaps-honest-list)).

## Automation (flag-gated, default off)
Flag `cs_auto_tasks` (master `enabled` switch at `/staff/feature-flags`). While it is off nothing is written and the task list is hidden.

When on, opening the at-risk tab in `/staff/customers` sends every `high` / `medium` account to `staff_sync_cs_tasks()`, which creates one **active** task per account in the staff-only table `staff_cs_tasks` (partial unique index; repeat syncs only refresh it). Due date: 2 business days for `high`, 5 for `medium` (UTC weekdays). Staff work the list in `CsTasksPanel` (`staff_list_cs_tasks()`, `staff_update_cs_task()`: assign to me, start, done, dismiss). Closed tasks cannot be changed.

Why a separate table: `tasks` is tenant-visible and `notifications` pushes to tenant devices, so neither may hold internal churn notes.

Limits (by design, not hidden):
- Tasks are created **when a staff member opens the tab**, not by a background job; the risk level is computed in the browser (`computeSuccessRisk`) and staff are the trust boundary. A scheduled server-side job would need the risk logic ported to the server; not done.
- Tasks are never auto-closed when an account recovers; staff close them.
- Creation is audited in `staff_audit_log` (`explorer_list`, `metadata.view = 'cs_tasks_sync'`); updates use `'cs_task_update'`.
- Migration: `supabase/migrations/20290304000000_staff_cs_tasks.sql`.
