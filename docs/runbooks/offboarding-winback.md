# Offboarding and win-back

What happens after an owner schedules a cancellation, who owns each step, and how to operate the opt-in win-back sequence.

## What exists (reused, not rebuilt)
| Need | Where it lives |
|---|---|
| Cancel flow, exit-survey reason, access-end date | `manage-subscription-cancellation`, `subscription_cancellations` |
| Save offers (pause / downgrade / discount) | `churn_save_*`, `/staff/churn-save` |
| Data export | `tenant-export` (full tar), CSV exports in `src/lib/cancellation.ts` |
| Deletion | `deletion_requests` (owner-initiated, 14-day cancellable grace, legal-hold block) executed by `data-retention-sweep` |

## What this feature adds
- `offboarding_cases`: one open case per cancellation (access end, reason, export started, outcome).
- `/dashboard/billing/offboarding`: guided page (timeline, export, optional deletion request, optional win-back opt-in).
- Win-back: at most **2** emails per case, opt-in only, unsubscribe in every message, kill switch OFF by default.
- Outcome tracking: `winback_events` (append-only) and `/staff/offboarding` (reasons, funnel, attributed vs organic returns).

## The timeline, honestly
1. Cancellation scheduled (Stripe `cancel_at_period_end`).
2. Access ends at the paid-period end. The hourly `offboarding-sweep` flips the case to `ended`.
3. Export is self-serve while the owner can sign in. [VERIFY] a suspended owner can still reach `/dashboard/billing/offboarding` and `tenant-export` (see checklist).
4. Deletion happens **only** if the owner files a deletion request (14-day grace, cancellable) — or if staff files one. There is **no automatic purge date**. Until then data is kept under `/data-retention`. [COUNSEL] decide whether a fixed post-cancellation deletion deadline must be promised and enforced; if yes it needs its own scheduled job, notice email and legal-hold check.

## Win-back rules (enforced in SQL, not only in the UI)
- Consent is explicit and versioned (`winback-v1`); never pre-ticked. Opting out or unsubscribing cancels every unsent message in the same transaction.
- `UNIQUE (case_id, seq)` + `CHECK (seq IN (1,2))` make a third message impossible. Message 2 is claimable only after message 1 was actually sent.
- Delivery is **at-most-once**: a claim that is never finished is parked as `failed` after 1 hour, never re-sent. Only a known provider failure is retried (max 3 attempts).
- Skipped (not sent) when: account gone, deletion requested, already paying again, no valid email.
- No discounts, deadlines or feature promises in the copy (tested).
- Fail-closed: no `WINBACK_POSTAL_ADDRESS` secret → the sweep reconciles outcomes but claims and sends nothing.

## Go-live checklist
1. Apply `20290307000000_offboarding_winback.sql`.
2. Deploy: `supabase functions deploy offboarding-sweep --no-verify-jwt`, `supabase functions deploy winback-unsubscribe --no-verify-jwt`, and redeploy `manage-subscription-cancellation`.
3. Secrets: `PUSH_DISPATCH_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SITE_URL`, `WINBACK_POSTAL_ADDRESS`, optional `SUPPORT_EMAIL`.
4. Cron: the migration schedules `vireek-offboarding-sweep` hourly when `pg_cron` exists; otherwise call `offboarding-sweep` hourly with header `x-push-dispatch-secret`.
5. [COUNSEL] approve the consent wording (`src/locales/en/offboarding.json`, `winback.*`), the email copy (`offboardingLogic.ts`), the sender identity, the postal address and per-country rules (CAN-SPAM, GDPR/ePrivacy, CASL, etc.). Do not enable until done.
6. Enable in `/staff/offboarding` → "Win-back sending enabled".

## Manual verification
- Cancel a test subscription: the case appears, the page shows the correct access-end date.
- Click "Keep my subscription": case becomes `withdrawn`, no message is sent.
- Opt in, move `access_ends_at` into the past, run the sweep: message 1 arrives with working unsubscribe; GET on the link must NOT unsubscribe (only the confirm button does).
- Unsubscribe: message 2 is `cancelled`; re-running the sweep sends nothing.
- Re-subscribe the test account after message 1: next sweep marks the case `reactivated` with `attributed_seq = 1`.
- Request deletion from the page: win-back messages are skipped (`deletion_requested`).
- Open the page as a suspended owner: it loads and the full export downloads.

## Known gaps
- Email copy is English only (the in-app UI falls back to English for locales without `offboarding.json`).
- `data-retention-sweep` erases data rows; [VERIFY] it also removes the login (auth user) at completion.
- Call recordings in storage buckets are not covered by the CSV/archive export.
