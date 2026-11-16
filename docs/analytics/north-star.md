# North Star metric tree

Status: v1, computed only from tables that already exist. **No figures are given in this document**; every number comes from the live database through the admin card (`/staff/growth`, top of page). Performance of the views is NOT MEASURED (no database was available when this was written).

Code: `supabase/migrations/20290305000000_north_star_metric_tree.sql` (counts), `src/lib/growth/northStar.ts` (ratios, maturity, tree), `src/components/staff/growth/NorthStarTreeCard.tsx` (card). Related: `docs/ANALYTICS_METRICS.md` (customer and founder KPIs; this file does not replace it).

## 1. The North Star

**Kept appointments from voice calls, per week.**

A *kept appointment* is a job that

1. is linked (`jobs.call_id`) to a call the voice agent handled (`calls.vapi_call_id IS NOT NULL`), and
2. reached `job_status = 'completed'`.

Why this and not the earlier proposal ("weekly active accounts with a booking", the text this change replaced in `growth/en.json`): an account-count does not grow when a customer gets more value, and a *booking* can be cancelled or never happen. A completed visit is the outcome the customer pays for and it is already recorded. Why not revenue: payments lag the visit and `invoice_payments` has no currency column.

Attribution is to the **week of the call** (UTC, Monday start), not the completion week. All inputs then describe the same cohort of calls and the tree multiplies out.

## 2. The tree

```
L0  Kept appointments (sum of the last 4 COMPLETE call-weeks)
 |   = calls x booking rate x jobs per booked call x kept per job
 |
 +-- L1  Handled calls                 demand; not directly controllable
 +-- L1  Booking rate                  booked calls / handled calls
 +-- L1  Keep rate                     completed / resolved jobs
 +-- L1  Account reach (latest week)   accounts with >=1 kept / accounts with handled calls
 Companion (not an input): payments recorded on kept jobs
```

The identity is exact when no job is pending. While recent jobs are unresolved, `kept` can still rise; the card shows the pending count. "Jobs per booked call" is not shown separately (it is close to 1 and `jobs_n` is in the weekly table).

## 3. Definitions and the view that computes each

All counts are integers. Ratios are ratio-of-sums over the window, never an average of weekly ratios. No denominator means `null` ("Insufficient data"), never 0. Fewer than `MIN_SAMPLE` rows in the denominator is labelled "low sample".

| Metric | Definition | Computed by |
| --- | --- | --- |
| Handled call | `calls` row with `vapi_call_id` set, `status` not `spam`, `is_voicemail` false, owner neither platform staff (`profiles.is_staff`) nor a synthetic probe tenant (`profiles.is_synthetic_tenant`) | `north_star_calls_v` |
| Handled calls | count of handled calls per call-week | `north_star_weekly_v.calls_n` |
| Booked call | handled call with at least one linked job (`jobs.call_id`, same `user_id`), excluding rework jobs (`jobs.is_rework`) | `north_star_jobs_v`, `north_star_weekly_account_v.booked_calls_n` |
| Booking rate | booked calls / handled calls | `booked_calls_n / calls_n` in `northStar.ts` |
| Resolved job | `completed`, `cancelled`, or `scheduled_datetime` more than 7 days ago | `north_star_jobs_v.is_resolved` |
| Pending job | linked job that is not resolved | `north_star_weekly_v.pending_n` |
| **Kept appointment (North Star)** | linked job with `job_status = 'completed'` | `north_star_jobs_v.is_kept`, `north_star_weekly_v.kept_n` |
| Keep rate | kept / resolved | `kept_n / resolved_n` in `northStar.ts` |
| Account reach | accounts with `kept_n > 0` / accounts with `calls_n > 0`, latest complete week only (accounts cannot be summed across weeks) | `north_star_weekly_v.active_accounts_n`, `accounts_with_calls_n` |
| Paid (companion) | sum of `invoice_payments.amount_cents` on non-void invoices of kept jobs | `north_star_jobs_v.paid_cents` |

A call-week is *partial* until its 7 days have elapsed (UTC); partial weeks are shown in the table and excluded from the headline.

Read access: only `staff_north_star_tree(p_weeks)` (1 to 52 weeks, staff only). The views read across all tenants, so all client privileges on them are revoked. The RPC returns aggregates only.

## 4. Caveats (documented, not hidden)

1. **Handled is not the same as "answered by Sarah alone".** `vapi_call_id` shows the voice stack handled the call; it does not say whether a human took over. [VERIFY] whether hand-offs keep the same `vapi_call_id`.
2. **`jobs.call_id` does not prove the agent made the booking.** `vapi-webhook` sets it when the agent books, but other flows may link a job to a call. `jobs.voice_idempotency_key` is the stricter signal but only exists on bookings made after migration `20281116000000_c2c_state_machine_foundation.sql`; the card shows the share of linked jobs carrying it. Using the key alone would silently drop older bookings, so v1 uses `call_id`.
3. **Stale statuses understate the keep rate.** A job still `scheduled`/`in_progress` more than 7 days after its scheduled time counts as resolved-not-kept. Accounts that do not update job status will look worse than they are. The 7 days is a constant in the view (`resolved_after_days` in the payload).
4. **Jobs without `scheduled_datetime`** that are not completed or cancelled stay pending indefinitely.
5. **Emergency calls are in the denominator** of the booking rate (they are handed off, not booked). Excluding them is a v2 decision; `calls.is_emergency` exists.
6. **Duplicate calls from one caller** each count as a call.
7. **Spam depends on `calls.status = 'spam'`**; unflagged spam depresses the booking rate.
8. **Paid revenue**: assumes USD (as in `ANALYTICS_METRICS.md`) [VERIFY]; refunds are not netted; payments recorded later still attach to the call-week, so recent weeks rise over time.
9. **Test accounts**: staff and synthetic tenants are excluded. Other demo or test tenants are not identifiable from the schema and are included [VERIFY].
10. Weekly buckets are UTC, not the customer's time zone.

## 5. Not computable from existing data (shown on the card, not estimated)

- **Answer speed**: `calls.answer_ms` exists but nothing populates it. The card shows how many handled calls have it (expected 0).
- **Unanswered-call coverage** (calls Vireek never picked up): no code writes `calls.status = 'missed'`, and a call that never reached the voice stack has no row. Coverage therefore cannot be measured, and the tree has no "answer rate" input. Adding it needs a source of truth for offered calls (carrier or Twilio logs).
- **No-show vs. reschedule vs. customer cancel**: all cancellations are `cancelled`.
- **Per-account entitlement or plan** is not used; an account on any plan counts.

## 6. Data checks on the card (last 90 days)

Handled vs all calls in `calls`; handled calls with `answer_ms`; linked jobs and how many carry the voice key; handled calls with `status = 'booked'` but no linked job (a non-zero value means `calls.status` and `jobs.call_id` disagree and the booking rate may be understated).

## 7. Deploy and verify

1. `supabase db push` (migration `20290305000000_north_star_metric_tree.sql`; idempotent, additive, no data written).
2. Frontend deploy. No flag; the card is inside `/staff/growth` (`StaffRoute`, and the RPC re-checks `is_vireek_staff`).
3. Sign in as staff, open `/staff/growth`. Sign in as a non-staff user and call `supabase.rpc('staff_north_star_tree')` (expect error `42501`).
4. Reconcile once by hand: pick one account and week and compare `north_star_weekly_account_v` with `select count(*) from jobs j join calls c on c.id = j.call_id where j.job_status='completed' and c.vapi_call_id is not null ...`.
5. If the RPC is slow, add the index named in the migration header, then record `EXPLAIN (ANALYZE, BUFFERS) select public.staff_north_star_tree(12);` here under "Measured".

Rollback: block at the top of the migration (views only; no stored data).

## 8. Changelog

- v1: initial definition; `definition_version` = 1 in the RPC payload. Bump it and add a line here when any rule above changes.
