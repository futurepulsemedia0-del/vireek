/*
# Demo seed data — now a guarded no-op

This migration used to create demo@vireek.com with a password written in this file, in every project it
was applied to (including production). That is a known-credential account, so it no longer runs.

- Fresh environments: nothing is created. The statement below only prints a notice.
- Demo/staging data is created on purpose, by hand: DEMO_ENV=staging node scripts/demo/seed.mjs
  (random password, refuses to run without DEMO_ENV, see docs/LOCAL_SEED.md).
- Projects that already ran the old version: 20290307000000_neutralize_demo_account.sql disables the
  fixed demo user unless the database is marked as demo/staging (docs/runbooks/demo-account-audit.md).

The file and its version are kept on purpose: Supabase tracks migrations by version, and removing or renaming
it would break the history of environments that already applied it.

-- rollback: nothing to undo (this migration changes no data). The historical demo data is recreated with scripts/demo/seed.mjs in a demo/staging project only.
*/

DO $$
DECLARE
  env text := lower(coalesce(nullif(current_setting('app.settings.vireek_environment', true), ''), ''));
BEGIN
  IF env IN ('demo', 'staging') THEN
    RAISE NOTICE 'seed_demo_data: no-op. Seed demo data explicitly: DEMO_ENV=% node scripts/demo/seed.mjs', env;
  ELSE
    RAISE NOTICE 'seed_demo_data: no-op (no demo account is created by migrations).';
  END IF;
END
$$;
