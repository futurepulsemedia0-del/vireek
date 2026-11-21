# Runbook: owner-incapacity emergency access

Code: migration `20290306000100_owner_emergency_access.sql`; edge functions `emergency-access` (contact API) and `emergency-access-tick` (cron); shared `_shared/emergency-access/*`. Tests: `supabase/tests/database/owner_emergency_access.test.sql`, `_shared/emergency-access/emergencyAccess.test.ts`.

> Status: **DRAFT, not drilled.** The SQL and pgTAP files have **not been executed** (no database was available when they were written). Legal questions are marked **[COUNSEL]**, unconfirmed facts **[VERIFY]**. Nothing here is a compliance claim or legal advice.

## 1. What the feature is (and is not)

An account owner names up to 3 emergency contacts. If the owner cannot act, a contact may request **read-only** access to customers, invoices and jobs, and export them as CSV. It is **never** write access, **never** payment/bank access, and there is no scope for either (the scope list is a CHECK constraint, not a setting).

| Step | Who | What happens |
|---|---|---|
| 1 | Owner (the account owner only, not team members) | `emergency_contact_add` chooses contact e-mail, wait (48–720 h, default 72), access length (1–90 days, default 30), scopes. Invitation e-mail goes out via the outbox. |
| 2 | Contact | Signs in with the **verified** invited e-mail and accepts (`accept`). Owner is notified. |
| 3 | Contact | `request` with a reason (≥ 20 chars). An 8-digit code is e-mailed to the contact (30 min, max 5 tries, stored only as HMAC). **Owner is notified immediately.** |
| 4 | Contact | `verify` with the code. The waiting period starts. Owner gets a "countdown started" notice, a daily reminder and a final notice 24 h before the grant. |
| 5 | System | Every 5 min `emergency_tick()`: if the owner signed in since the clock started → request cancelled; else when the delay has fully elapsed → **grant** (the only place a grant is created). |
| 6 | Contact | `read` / `export` while the grant is open. Each call is audited; the owner is told on first access. |
| 7 | System | Grant expires on schedule. Owner may **deny/revoke at any time**, which ends access immediately. |

Guarantees enforced in the database (see the test file for each): delay can't be shortened (CHECK + single grant path + re-check on every read); owner sign-in cancels; owner denial wins and starts a 30-day cooldown; max 3 requests per contact per 24 h; the audit log is append-only and hash-chained and holds ids/counts only (no record contents, no e-mail addresses, no codes).

## 2. Setup (once per environment)

1. Apply the migration. Deploy both functions. `emergency-access-tick` needs `verify_jwt = false` (already added to `supabase/config.toml`); it authenticates with `CRON_SECRET`, fail-closed.
2. Secrets: `EMERGENCY_CODE_PEPPER` (random, ≥ 32 chars; **without it the feature refuses to issue codes**), `CRON_SECRET`, `RESEND_API_KEY` (existing), `APP_URL` **[VERIFY production URL; default in code is a guess]**.
3. Schedule: the migration creates `vireek-emergency-access-tick` only if `pg_cron` and `pg_net` exist. Set once:
   ```sql
   alter database postgres set app.settings.functions_url = 'https://<ref>.supabase.co/functions/v1';
   alter database postgres set app.settings.cron_secret   = '<CRON_SECRET value>';
   ```
   Check: `select * from cron.job where jobname = 'vireek-emergency-access-tick';`
4. **Rotating `EMERGENCY_CODE_PEPPER`** invalidates in-flight codes (≤ 30 min). Do it when no request is `pending_verification`.

## 3. Monitoring

```sql
-- anything open right now
select id, owner_id, status, verified_at, access_available_at, access_expires_at
from emergency_access_requests where status in ('pending_verification','waiting','granted') order by created_at;

-- notices that are not getting delivered
select kind, recipient, attempts, last_error, scheduled_for from emergency_notice_outbox where sent_at is null and scheduled_for < now() - interval '15 minutes';
```
Alert on: tick not running for > 15 min (waiting requests would sit past their time, grants would not expire), outbox backlog, any `granted` request whose `access_expires_at` is in the past.

## 4. Support playbook (admin)

Support staff **cannot** grant, shorten or extend access; there is deliberately no such function. What they can do:

- **Owner says "I did not set this up / this is not me":** tell the owner to sign in (this cancels any waiting request) and use *Deny*; then *Revoke* the contact. If they cannot sign in, treat as account-security incident (`incident-response.md`).
- **Contact says the code never arrived:** requests expire after 30 min; they file a new one (3 per 24 h). Check outbox/Resend delivery for the contact address. Never read a code to anyone; codes are not stored and cannot be retrieved.
- **Contact asks to skip the waiting period:** not possible. Explain the timeline from `access_available_at`. Any proposal to build an override needs a product and **[COUNSEL]** decision; do not run SQL against `emergency_access_requests` to force it (the CHECK constraint will refuse, and any bypass would be visible in the audit chain).
- **Family/legal pressure** (death, court order, power of attorney): this feature is not a substitute for legal process. Route to counsel **[COUNSEL]**; do not hand over data outside this flow.
- **Verify the log was not tampered with:** `select * from emergency_audit_verify_owner('<owner uuid>');` → `ok = true`, or `broken_at_seq`.

## 5. Owner death or permanent incapacity

Out of scope of the automated flow. After the access window ends the contact has nothing further. What happens to the account, its data and any continued access is a legal matter **[COUNSEL]**. Do not extend `access_days` beyond 90 by editing the CHECK to cover a single case.

## 6. Known gaps (as of this change)

- **No dashboard UI.** Owners designate/revoke/deny via the RPCs and contacts via the edge function; the screens (and their i18n/RTL strings) are not built. Notice e-mails are English-only and unreviewed **[COUNSEL]**.
- **Not executed.** pgTAP and SQL are unrun; only the TypeScript tests have been executed (under a local stand-in for Vitest). Run `supabase db reset && supabase test db` before release.
- **Owner-activity signal is `auth.users.last_sign_in_at`.** A token *refresh* on an old session is not a sign-in, so an incapacitated owner's still-logged-in device does not cancel the request, while any deliberate sign-in does. Whether this is the right signal **[VERIFY against Supabase Auth behaviour]**.
- **A single e-mail channel to the owner** (auth e-mail + in-app). No SMS, no secondary address, no notice to team admins. An owner whose mailbox is unattended will not see the notices; that is the reason for the long default delay.
- **`notifications.type = 'system'`** is assumed valid **[VERIFY no CHECK constraint rejects it]**; if it does, `emergency_claim_notices` will fail and must be adjusted.
- **Account deletion:** contacts and requests cascade-delete with the profile; the audit table intentionally has no FK and is retained. Retention/erasure of those rows is **[COUNSEL]**; `delete-account` does not purge them.
- **Export is capped at 20 000 rows per scope per export** and is built in memory in the edge function.
- Scopes are fixed at customers / invoices / jobs (columns whitelisted in `emergency_read`). Adding a scope needs a migration, the CSV column list and tests.
