# Chief of Staff — Deployment & Verification Guide

## Deployment Order

1. Copy all files from this directory into the project, preserving their original directory structure.

2. Apply the three patches to existing files:
   ```bash
   git apply patches/App.tsx.patch patches/DashboardNav.tsx.patch patches/OperatorPanel.tsx.patch
   ```

3. Apply the database migration:
   ```bash
   supabase db push
   ```
   Migration file: `20280402000000_chief_of_staff.sql`. A manual rollback procedure is included at the end of the migration file.

4. Deploy the Edge Function:
   ```bash
   supabase functions deploy chief-of-staff --no-verify-jwt
   ```
   User-facing requests continue to be authenticated using JWT. The `--no-verify-jwt` flag is required only for the cron endpoint (`refresh_all`).

5. Configure background refresh (every 15 minutes):

   - Set the Edge Function secret:
     ```bash
     supabase secrets set CRON_SECRET=<random_secret_value>
     ```

   - Configure the database settings:
     ```sql
     alter database postgres set "app.settings.edge_function_base_url" = 'https://<ref>.supabase.co/functions/v1';

     alter database postgres set "app.settings.cos_cron_secret" = '<same_CRON_SECRET_value>';
     ```

   - If `pg_cron` and `pg_net` are not enabled, the migration safely skips scheduling without failing. In that case, schedule the event-retention cleanup job (`cos_prune_events`) manually.

6. Run the live database verification script (read-only):
   ```bash
   supabase/tests/manual/cos_verify_live.sql
   ```
   All returned rows must have `ok = true`.

## Test Commands

```bash
npm ci
npx tsc -p tsconfig.app.json --noEmit
npx vitest run
npm run lint:design
npm run i18n:keys
supabase test db
E2E_TEST_EMAIL=... E2E_TEST_PASSWORD=... npx playwright test e2e/chief-of-staff.spec.ts
```

## Intentionally Excluded Features

The following features have intentionally not been implemented, along with the reasons for their exclusion:

- **Operator "Hold Slot" Action:** The booking engine (`capacityEngine.ts`) calculates capacity independently using a pure computation model and does not call `get_capacity_status`. Implementing slot holds without integrating them into the booking engine and `book_capacity_slot()` would create a cosmetic feature with no actual booking impact. A proper implementation would require changes to the booking engine, the database booking function, and seven Operator-related files.

- **Direct One-Click Execution Beyond Page Navigation:** The Operator currently supports only rescheduling and reassignment. Sending a message is permitted only after one of these actions. Current recommendations (invoicing, estimates, and churn prevention) do not map to either supported action. Direct execution was therefore intentionally excluded.

- **Translation of Server-Generated Content:** Server-generated Operator plan summaries and `describeResult` messages are still in English and have not yet been localized.
