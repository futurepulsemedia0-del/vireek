# Runbook: audit and neutralize the legacy demo account

**Scope.** `supabase/migrations/20260821101216_seed_demo_data.sql` (old version) created `demo@vireek.com`, id
`a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11`, with a password written in the repository. Any project that ran it may still have a
known-credential account. This runbook finds out, then closes it. Nothing here was run against a real database by the author;
every result below must come from you.

**Status in this repository (code only):** the old migration is now a no-op, demo seeding moved to `scripts/demo/seed.mjs`,
and `20290307000000_neutralize_demo_account.sql` disables the fixed user unless the database is marked demo/staging.
Whether production is clean is **[VERIFY]** — only the queries below can tell.

---

## 1. Read-only audit (run in production first, before changing anything)

Run in `psql` (connection string from Dashboard → Project Settings → Database) or the Dashboard SQL editor. The transaction is
declared read-only, so a typo cannot change data. Column sets of the `auth` schema vary with the GoTrue version **[VERIFY]**; if a
query errors on a missing column or table, remove that column and re-run — do not skip the audit.

```sql
begin read only;

-- 1. Does the user exist, was it ever used, is it already disabled?
select
  id,
  email,
  created_at,
  last_sign_in_at,                                   -- NULL = never signed in
  banned_until,                                      -- 'infinity' = permanently banned
  email_confirmed_at is not null          as email_confirmed,
  (banned_until = 'infinity'::timestamptz
     and coalesce(encrypted_password, '') like '!disabled-%')   as neutralized,
  (coalesce(encrypted_password, '') like '$2%')    as has_bcrypt_password   -- true = a usable password hash is still set
from auth.users
where id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
   or lower(email) = 'demo@vireek.com';              -- also catches a different id with the same address

-- 2. Live sessions of that user
select count(*) as sessions, max(coalesce(refreshed_at, created_at)) as last_session_activity
from auth.sessions
where user_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

-- 3. Recent auth events for it (optional; table/columns depend on version)
select created_at, payload ->> 'action' as action, ip_address
from auth.audit_log_entries
where payload ->> 'actor_id' = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
order by created_at desc
limit 20;

-- 4. Profile and footprint: seeded rows vs. anything someone added later
select status, plan, onboarding_completed from profiles where id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
select
  (select count(*) from calls where user_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')                            as calls_total,
  (select count(*) from calls where user_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
     and id::text not like 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a0%')                                              as calls_not_from_seed,
  (select count(*) from leads where user_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
     and id::text not like 'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a0%')                                              as leads_not_from_seed,
  (select count(*) from jobs  where user_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
     and id::text not like 'd1eebc99-9c0b-4ef8-bb6d-6bb9bd380a0%')                                              as jobs_not_from_seed;

-- 5. Environment marker (empty/unset = production)
select current_setting('app.settings.vireek_environment', true) as marker,
       (select setconfig from pg_db_role_setting where setdatabase = (select oid from pg_database where datname = current_database()) and setrole = 0) as database_settings;

rollback;
```

### Reading the result

| Query 1 shows | Meaning | Action |
|---|---|---|
| no row | Never created here, or already deleted | Nothing to close. Still apply §2 so it cannot appear later. |
| row, `neutralized = true` | Already disabled | Record the evidence; no further action. |
| row, `last_sign_in_at` is NULL | Exists, never used | Neutralize (§2). |
| row, `last_sign_in_at` set | Someone signed in with a publicly known password | Neutralize (§2) **and** review query 3, and `*_not_from_seed` counts in query 4 for real use. Whether this is a reportable security event is **[COUNSEL]**; do not decide it from this document. |
| a row with email `demo@vireek.com` but a different `id` | Not the seeded user | The migration will not touch it. Review it by hand. |

Save the output (screenshot or text) in your evidence folder with the date. Do not paste passwords or hashes anywhere.

---

## 2. Neutralize

1. **Mark demo/staging databases first** (skip for production — leaving it unset *is* the production setting):
   ```sql
   ALTER DATABASE postgres SET app.settings.vireek_environment = 'staging';   -- or 'demo'
   ```
   Applies to new connections. Only the exact values `demo` and `staging` are honoured; anything else, including `production`, `prod`
   or a typo, is treated as production. Verify with `SHOW app.settings.vireek_environment;` in a new session. Hosted Supabase allows
   `ALTER DATABASE postgres SET …` for the `postgres` role **[VERIFY]**.
2. Apply migrations with your normal release process (`supabase db push`). `20290307000000_neutralize_demo_account.sql` runs once.
   Known migration-history problems (duplicate/invalid versions, RUNBOOK §3.3) can block `db push` **[VERIFY]**; fix them first rather than editing this file.
3. Re-run query 1 and 2. Expect `neutralized = true`, `has_bcrypt_password = false`, sessions `0`.
4. Access tokens that were already issued stay valid until they expire (JWT lifetime, 1 h by default). If that is too long, shorten the JWT expiry temporarily in Auth settings.

### What the migration does and does not do
Does: bans the fixed id forever, replaces its password hash with an unusable value, deletes its sessions, sets `profiles.status` to
`suspended` (if it was `active`), deletes the seeded demo rows by exact id.
Does not: delete the auth user or its profile/business profile (cascades are unsafe to enumerate), touch any other user, or touch
`value_events` and other rows created by `supabase/seed-*-demo.sql` (append-only ledger — review by hand **[VERIFY]**).

### Rollback / recovery
Reversible only deliberately, and the old password can never come back:
```sql
UPDATE auth.users SET banned_until = NULL WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
UPDATE profiles   SET status = 'active'  WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
```
then set a new password in the dashboard, or — in a demo/staging project only — run `scripts/demo/seed.mjs` (below), which also lifts the ban
and re-creates the demo rows. Do not restore the demo account in production.

---

## 3. Demo data on purpose (demo/staging only)

```bash
DEMO_ENV=staging \
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key from your secret store> \
DEMO_CONFIRM_PROJECT_REF=<ref> \
node scripts/demo/seed.mjs            # add --dry-run to print the plan without any network call
```
- Refuses to run unless `DEMO_ENV` is `demo` or `staging` **and** `DEMO_CONFIRM_PROJECT_REF` equals the project ref in `SUPABASE_URL`
  (set `DEMO_DENY_PROJECT_REFS=<prod-ref>` in your shell profile as a second belt). `NODE_ENV=production` is refused too.
- Prints a new random password once; it is not stored anywhere. Re-running rotates it.
- The GoTrue admin calls were written from the documented API and covered by a fake-fetch test only — run it once on a throw-away project **[VERIFY]**.

## 4. Tests
```bash
node --test scripts/demo/seed.test.mjs scripts/demo/migrations.test.mjs   # guard + static SQL checks
supabase test db                                                          # includes supabase/tests/database/demo_account_neutralized.test.sql (needs a local stack)
```
